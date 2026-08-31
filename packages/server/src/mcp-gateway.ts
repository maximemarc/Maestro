/**
 * Passerelle MCP : expose les outils Maestro aux clients MCP tiers.
 *
 * Le verrou levé ici. Les serveurs MCP de Maestro sont construits avec
 * `createSdkMcpServer()` : ils vivent dans la mémoire du processus, le temps
 * d'un run du SDK. Aucun client externe ne peut les joindre — il n'y a ni
 * processus ni endpoint à atteindre. Ce module fabrique le même périmètre
 * d'outils sur un serveur MCP *standard*, joignable en Streamable HTTP
 * (`POST /mcp`) ou en stdio (`bin/maestro-mcp.mjs`). Codex, OpenCode, Gemini
 * CLI, Goose, Cursor ou Zed déclarent Maestro comme n'importe quel serveur.
 *
 * Périmètre volontairement restreint à ce qui ne dépend pas d'un run :
 *
 * - **RAG** — les collections n'ont besoin que d'une liste d'autorisation ;
 * - **outils maison** — un appel HTTP paramétré, sans état de session.
 *
 * ## Ce que le lot A2 a changé
 *
 * Deux limitations assumées au départ sont levées, et une reste.
 *
 * - **Les outils de contrôle** (`task_create`, `task_update`, `send_to_agent`,
 *   `memory_save`) sont exposés dès qu'un agent est identifié. Le contexte de
 *   run qui leur manquait vient d'une **session externe** : un run d'origine
 *   `external` ouvert au premier geste, qui rend la session visible dans
 *   Mission Control, donne un parent aux délégations, et se laisse annuler.
 * - **Les outils sous approbation** ne sont plus refusés d'office : ils passent
 *   par le broker, exactement comme depuis un agent Maestro. L'appel attend une
 *   décision humaine, prise depuis le web ou Telegram. C'est plus lent qu'un
 *   refus, et c'est la seule façon de tenir la promesse de l'interface sans
 *   fermer la porte.
 * - **Les serveurs MCP externes** du registre ne sont toujours pas relayés : un
 *   client tiers sait les déclarer lui-même, et en faire un proxy ajouterait un
 *   saut réseau et une couche de pannes pour aucun gain.
 *
 * 🔒 Ce que la passerelle ne peut pas offrir, et qu'il ne faut pas laisser
 * croire : elle ne voit **que les appels qui lui sont adressés**. Un client
 * tiers qui lit et écrit des fichiers le fait avec ses propres outils, hors de
 * portée de Maestro. La gouvernance porte sur le canal Maestro, pas sur la
 * machine.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { KANBAN_COLUMNS } from '@maestro/shared';
import type { AgentConfig, KanbanColumn, McpServerDef, RagCollection } from '@maestro/shared';
import type { AgentService } from './agents.ts';
import type { Bus } from './bus.ts';
import {
  ActionError,
  createTask,
  delegate,
  MEMORY_SAVE_DESCRIPTION,
  saveMemory,
  SEND_TO_AGENT_DESCRIPTION,
  TASK_CREATE_DESCRIPTION,
  TASK_UPDATE_DESCRIPTION,
  updateTask,
  type ControlDeps,
} from './mcp-actions.ts';
import type { ExternalSessionService } from './mcp-external.ts';
import type { ApprovalBroker } from './permissions.ts';
import { runAction } from './mcp-registry.ts';
import {
  RAG_COLLECTIONS_DESCRIPTION,
  RAG_DEFAULT_TOP_K,
  RAG_MAX_TOP_K,
  RAG_SEARCH_DESCRIPTION,
  formatCollectionList,
  formatSearchResult,
} from './mcp-rag.ts';
import { toolJsonSchema } from './mcp-schema.ts';
import type { RagService } from './rag.ts';

/** Nom du serveur MCP vu par le client : les outils s'appellent `mcp__maestro__*`. */
export const GATEWAY_SERVER_NAME = 'maestro';

/** En-tête qui dit au nom de quel agent Maestro le client tiers agit. */
export const AGENT_HEADER = 'x-maestro-agent';

/**
 * Séparateur entre le slug du serveur maison et le nom de l'outil.
 *
 * Tout est aplati sur un seul serveur MCP, donc deux outils `search` venant de
 * deux définitions maison se heurteraient. Le double souligné reprend la
 * convention du SDK (`mcp__serveur__outil`) : un utilisateur qui lit
 * `mcp__maestro__crm__search` retrouve sa définition sans documentation.
 */
const NAME_SEPARATOR = '__';

export class GatewayError extends Error {}

export interface GatewayDeps {
  rag: RagService;
  agents: AgentService;
  bus: Bus;
  /** Définitions maison brutes (secrets non masqués) : `McpRegistry.listRaw`. */
  listServers: () => McpServerDef[];
  version: string;
  /**
   * Actions de contrôle et session externe.
   *
   * Optionnels : le pont stdio et les tests de périmètre construisent une
   * passerelle sans eux, et doivent continuer de fonctionner — sans ces
   * dépendances, les outils de contrôle ne sont simplement pas annoncés.
   */
  control?: ControlDeps;
  sessions?: ExternalSessionService;
  approvals?: ApprovalBroker;
}

/**
 * Ce qu'un client donné a le droit de voir.
 *
 * Sans en-tête d'agent, le périmètre est celui du jeton : tout ce qui est
 * activé. Ce n'est pas un élargissement de privilège — le même jeton ouvre déjà
 * l'API REST complète. Avec en-tête, le périmètre se réduit à celui de l'agent
 * nommé, ce qui permet de donner à un client tiers exactement le corpus d'un
 * agent Maestro, sans lui ouvrir le reste.
 */
export interface GatewayScope {
  agent: AgentConfig | null;
  collections: RagCollection[];
  servers: McpServerDef[];
}

/**
 * Forme comparable d'un nom d'agent : sans casse, sans diacritiques.
 *
 * Une configuration de client MCP écrite à la main porte rarement les accents,
 * et les agents Maestro s'appellent « Comptabilité » ou « Sécurité ». Comparer
 * les formes nues évite de renvoyer « agent inconnu » pour un accent manquant.
 */
function normaliseRef(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();
}

/**
 * Formes candidates d'une référence reçue en en-tête HTTP.
 *
 * La spécification HTTP ne connaît pas l'UTF-8 dans une valeur d'en-tête : ce
 * sont des octets latin-1. Un client qui écrit « Développeur » l'envoie donc en
 * UTF-8 brut, que Node relit en latin-1 — « DÃ©veloppeur ». Constaté en
 * conditions réelles, et fatal ici puisque tous les agents portent des noms
 * français. On tente donc aussi la lecture recodée avant de conclure.
 */
function refCandidates(ref: string): Set<string> {
  const forms = [ref];
  const recoded = Buffer.from(ref, 'latin1').toString('utf8');
  // Le caractère de remplacement signale un octet qui n'était pas de l'UTF-8 :
  // la valeur brute était déjà correcte, la recodée est du bruit.
  if (recoded !== ref && !recoded.includes('\uFFFD')) forms.push(recoded);
  return new Set(forms.map(normaliseRef));
}

/**
 * Résout le périmètre d'une requête.
 *
 * L'agent est cherché par identifiant puis par nom, à la casse et aux accents
 * près : une configuration de client écrite à la main porte plus volontiers
 * « Comptabilité » — ou « comptabilite » — qu'un UUID.
 */
export function resolveScope(deps: GatewayDeps, agentRef: string | null): GatewayScope {
  const customServers = deps.listServers().filter((def) => def.kind === 'custom' && def.enabled);

  if (!agentRef || agentRef.trim() === '') {
    return { agent: null, collections: deps.rag.list(), servers: customServers };
  }

  const ref = agentRef.trim();
  const candidates = refCandidates(ref);
  const agent =
    deps.agents.get(ref) ??
    deps.agents.list(true).find((a) => candidates.has(normaliseRef(a.name))) ??
    null;
  if (!agent) throw new GatewayError(`Agent inconnu : ${ref}`);

  const allowedServerIds = new Set(agent.mcpServerIds);
  return {
    agent,
    collections: deps.rag.collectionsForAgent(agent.ragCollectionIds),
    servers: customServers.filter((def) => allowedServerIds.has(def.id)),
  };
}

interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Outils de contrôle, annoncés seulement quand un agent est identifié.
 *
 * Sans en-tête d'agent, ils n'ont pas de sens : au nom de qui la carte serait
 * créée, dans quelle mémoire la note serait écrite ? Les annoncer quand même
 * ferait échouer chaque appel après coup, ce qui est la pire façon de dire non.
 */
function controlTools(): ToolDescriptor[] {
  const column = {
    type: 'string',
    enum: [...KANBAN_COLUMNS],
    description: 'Colonne du kanban.',
  };
  return [
    {
      name: 'task_create',
      description: TASK_CREATE_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string', maxLength: 4000 },
          column,
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
    {
      name: 'task_update',
      description: TASK_UPDATE_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          column,
          comment: { type: 'string', maxLength: 2000 },
        },
        required: ['taskId'],
        additionalProperties: false,
      },
    },
    {
      name: 'send_to_agent',
      description: SEND_TO_AGENT_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          agentName: { type: 'string' },
          prompt: { type: 'string', minLength: 1 },
          wait: { type: 'boolean', default: false },
        },
        required: ['agentName', 'prompt'],
        additionalProperties: false,
      },
    },
    {
      name: 'memory_save',
      description: MEMORY_SAVE_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: { content: { type: 'string', minLength: 1, maxLength: 4000 } },
        required: ['content'],
        additionalProperties: false,
      },
    },
  ];
}

const CONTROL_TOOL_NAMES = new Set(['task_create', 'task_update', 'send_to_agent', 'memory_save']);

/** Catalogue exposé au client, dans l'ordre où il est le plus utile à lire. */
export function listGatewayTools(scope: GatewayScope, deps?: GatewayDeps): ToolDescriptor[] {
  const tools: ToolDescriptor[] = [];

  if (scope.agent && deps?.control && deps.sessions) tools.push(...controlTools());

  /* Les outils RAG n'apparaissent que si au moins une collection est
     accessible : un outil qui ne peut que répondre « aucune base » coûte du
     contexte et invite le modèle à insister. */
  if (scope.collections.length > 0) {
    tools.push({
      name: 'rag_collections',
      description: RAG_COLLECTIONS_DESCRIPTION,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    });
    tools.push({
      name: 'rag_search',
      description: RAG_SEARCH_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          collection: {
            type: 'string',
            enum: scope.collections.map((c) => c.slug),
            description: 'Identifiant de la base, tel que rendu par rag_collections.',
          },
          query: { type: 'string', minLength: 2, description: 'Question ou mots-clés.' },
          topK: {
            type: 'integer',
            minimum: 1,
            maximum: RAG_MAX_TOP_K,
            default: RAG_DEFAULT_TOP_K,
            description: 'Nombre de passages souhaités.',
          },
        },
        required: ['collection', 'query'],
        additionalProperties: false,
      },
    });
  }

  for (const def of scope.servers) {
    for (const toolDef of def.tools) {
      /* L'outil sous approbation est annoncé, pas caché : le modèle doit
         pouvoir dire à l'utilisateur que l'action existe mais passe par
         Maestro, au lieu de conclure qu'elle est impossible. */
      /* L'annonce dit ce qui va se passer : l'appel n'est plus refusé, il
         attend une décision humaine. Le modèle doit le savoir avant d'appeler,
         sinon il conclura à une panne au bout de quelques minutes. */
      const suffix = toolDef.requiresApproval
        ? " [approbation humaine requise : l'appel attend une décision dans Maestro]"
        : '';
      tools.push({
        name: `${def.slug}${NAME_SEPARATOR}${toolDef.name}`,
        description: `${def.name} — ${toolDef.description}${suffix}`,
        inputSchema: toolJsonSchema(toolDef) as unknown as Record<string, unknown>,
      });
    }
  }

  return tools;
}

export interface GatewayToolResult {
  /* L'index ouvert reprend celui de `CallToolResult` du SDK : le protocole
     autorise des champs supplémentaires, et sans lui le résultat n'est pas
     assignable au type de retour attendu par le gestionnaire. */
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function text(message: string): GatewayToolResult {
  return { content: [{ type: 'text', text: message }] };
}

function failure(message: string): GatewayToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Exécute un appel d'outil dans les limites du périmètre.
 *
 * Aucune erreur ne remonte en exception : le protocole veut un résultat
 * `isError`, qui laisse le modèle corriger sa requête. Une exception, elle,
 * casserait la session côté client.
 */
export async function callGatewayTool(
  deps: GatewayDeps,
  scope: GatewayScope,
  name: string,
  args: Record<string, unknown>,
): Promise<GatewayToolResult> {
  if (CONTROL_TOOL_NAMES.has(name)) return await callControlTool(deps, scope, name, args);

  if (name === 'rag_collections') {
    if (scope.collections.length === 0) return failure('Aucune base documentaire accessible.');
    return text(formatCollectionList(scope.collections));
  }

  if (name === 'rag_search') {
    const slug = typeof args.collection === 'string' ? args.collection : '';
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const collection = scope.collections.find((c) => c.slug === slug);
    if (!collection) return failure(`Base inconnue ou non autorisée : ${slug || '(vide)'}`);
    if (query.length < 2) return failure('Requête trop courte : deux caractères au minimum.');

    const topK = Math.min(
      RAG_MAX_TOP_K,
      Math.max(1, Math.round(Number(args.topK ?? RAG_DEFAULT_TOP_K)) || RAG_DEFAULT_TOP_K),
    );
    try {
      const result = await deps.rag.search(collection.id, query, topK);
      return text(formatSearchResult(collection, query, result));
    } catch (err) {
      return failure(err instanceof Error ? err.message : String(err));
    }
  }

  const separator = name.indexOf(NAME_SEPARATOR);
  if (separator <= 0) return failure(`Outil inconnu : ${name}`);
  const slug = name.slice(0, separator);
  const toolName = name.slice(separator + NAME_SEPARATOR.length);

  const def = scope.servers.find((s) => s.slug === slug);
  if (!def) return failure(`Outil inconnu ou non autorisé : ${name}`);
  const toolDef = def.tools.find((t) => t.name === toolName);
  if (!toolDef) return failure(`Outil inconnu : ${name}`);

  if (toolDef.requiresApproval) {
    /*
     * L'approbation passe par le même broker que pour un agent Maestro : même
     * file, même historique, même résolution web ou Telegram. Ce qu'il faut
     * pour cela, c'est une identité et un run — d'où le refus quand la session
     * externe n'est pas disponible. Exécuter sans elle contournerait en silence
     * une garantie affichée dans l'interface.
     */
    if (!scope.agent || !deps.approvals || !deps.sessions) {
      return failure(
        `L'outil ${name} exige une approbation humaine. Déclare l'agent au nom duquel tu agis (en-tête ${AGENT_HEADER}) pour que Maestro puisse la demander.`,
      );
    }
    const session = deps.sessions.touch(scope.agent);
    const { decision, resolvedBy, note } = await deps.approvals.requestHumanApproval(
      session.id,
      scope.agent,
      name,
      args,
    );
    deps.sessions.record(
      session,
      name,
      decision === 'allow' ? 'ok' : 'refusé',
      `par ${resolvedBy}`,
    );
    if (decision !== 'allow') {
      return failure(note ?? `Refusé par l'opérateur (${resolvedBy}).`);
    }
  }

  try {
    const output = await runAction(toolDef, args);
    return text(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    /* Même journalisation que pour un agent interne : un outil qui échoue en
       boucle depuis Codex doit être visible dans les journaux Maestro, sinon
       le propriétaire du serveur cherche la panne côté client. */
    deps.bus.log('warn', 'mcp', `Passerelle : ${slug}.${toolName} en échec — ${message}`);
    return failure(`Échec de l'outil : ${message}`);
  }
}

/**
 * Exécute un outil de contrôle au nom de l'agent identifié.
 *
 * L'ordre compte : la session externe est ouverte **avant** l'action, jamais
 * après. C'est elle qui donne son parent à une délégation ; l'ouvrir ensuite
 * laisserait un run orphelin, non annulable en cascade — exactement le trou que
 * ce lot est censé combler.
 */
async function callControlTool(
  deps: GatewayDeps,
  scope: GatewayScope,
  name: string,
  args: Record<string, unknown>,
): Promise<GatewayToolResult> {
  if (!scope.agent) {
    return failure(
      `L'outil ${name} agit au nom d'un agent Maestro : déclare-le avec l'en-tête ${AGENT_HEADER}.`,
    );
  }
  if (!deps.control || !deps.sessions) {
    return failure(`L'outil ${name} n'est pas disponible sur cette passerelle.`);
  }

  const session = deps.sessions.touch(scope.agent);
  /* Profondeur 0 : une session externe est une racine de délégation, au même
     titre qu'un run lancé à la main. Les garde-fous anti-cascade s'appliquent
     ensuite normalement aux runs qu'elle engendre. */
  const ctx = { runId: session.id, agent: scope.agent, depth: 0 };

  try {
    let output: string;
    switch (name) {
      case 'task_create':
        output = createTask(deps.control, ctx, {
          title: String(args.title ?? ''),
          description: typeof args.description === 'string' ? args.description : '',
          column: asColumn(args.column),
        });
        break;
      case 'task_update':
        output = updateTask(deps.control, ctx, {
          taskId: String(args.taskId ?? ''),
          column: asColumn(args.column),
          comment: typeof args.comment === 'string' ? args.comment : undefined,
        });
        break;
      case 'send_to_agent':
        output = await delegate(deps.control, ctx, {
          agentName: String(args.agentName ?? ''),
          prompt: String(args.prompt ?? ''),
          wait: args.wait === true,
        });
        break;
      case 'memory_save':
        output = saveMemory(deps.control, ctx, { content: String(args.content ?? '') });
        break;
      default:
        return failure(`Outil inconnu : ${name}`);
    }
    deps.sessions.record(session, name, 'ok');
    return text(output);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.sessions.record(session, name, 'échec', message);
    /* Une erreur métier revient au modèle pour qu'il corrige ; une panne est
       journalisée côté Maestro, sinon le propriétaire du serveur cherchera le
       problème chez le client. */
    if (!(err instanceof ActionError)) {
      deps.bus.log('warn', 'mcp', `Passerelle : ${name} en échec — ${message}`);
    }
    return failure(message);
  }
}

/** Colonne de kanban reçue d'un client tiers, ou `undefined` si elle n'en est pas une. */
function asColumn(value: unknown): KanbanColumn | undefined {
  return typeof value === 'string' && (KANBAN_COLUMNS as readonly string[]).includes(value)
    ? (value as KanbanColumn)
    : undefined;
}

/**
 * Construit un serveur MCP standard pour un périmètre donné.
 *
 * Un serveur par requête HTTP : c'est le mode sans état du transport Streamable
 * HTTP. Le coût est négligeable (deux gestionnaires enregistrés) et le gain
 * important — le périmètre est recalculé à chaque appel, donc un agent dont on
 * retire une collection la perd immédiatement, sans redémarrage.
 */
export function createGatewayServer(deps: GatewayDeps, scope: GatewayScope): Server {
  const server = new Server(
    { name: GATEWAY_SERVER_NAME, version: deps.version },
    {
      capabilities: { tools: {} },
      instructions: scope.agent
        ? `Outils Maestro délégués au nom de l'agent « ${scope.agent.name} ». Les actions de contrôle (kanban, délégation, mémoire) sont journalisées dans une session visible dans Mission Control.`
        : 'Outils Maestro : bases documentaires (RAG) et outils maison configurés dans Maestro. Déclare un agent (en-tête x-maestro-agent) pour accéder au kanban, à la délégation et à la mémoire.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listGatewayTools(scope, deps),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> =>
    callGatewayTool(
      deps,
      scope,
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
    ),
  );

  return server;
}
