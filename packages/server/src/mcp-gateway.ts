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
 * Sont hors périmètre, et pourquoi :
 *
 * - les outils de contrôle (`maestro_task_*`, `send_to_agent`, `memory_save`)
 *   exigent un `RunContext { runId, agent, depth }` qui n'existe pas hors run.
 *   Les exposer sans identité de run ferait agir un agent tiers dans l'angle
 *   mort de l'orchestrateur : invisible dans Mission Control, non comptabilisé,
 *   non annulable ;
 * - les serveurs MCP *externes* déclarés dans le registre ne sont pas relayés.
 *   Un client tiers sait les déclarer lui-même ; en faire un proxy ajouterait un
 *   saut réseau et une couche de pannes pour aucun gain ;
 * - les outils maison marqués `requiresApproval` sont **refusés**, pas exécutés.
 *   Un client tiers ne passe pas par `canUseTool` : l'exécuter reviendrait à
 *   contourner en silence une approbation que l'interface promet. Le refus est
 *   explicite, avec le motif — la levée viendra avec le broker côté serveur.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { AgentConfig, McpServerDef, RagCollection } from '@maestro/shared';
import type { AgentService } from './agents.ts';
import type { Bus } from './bus.ts';
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

/** Catalogue exposé au client, dans l'ordre où il est le plus utile à lire. */
export function listGatewayTools(scope: GatewayScope): ToolDescriptor[] {
  const tools: ToolDescriptor[] = [];

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
      const suffix = toolDef.requiresApproval
        ? ' [approbation humaine requise : appel refusé depuis un client externe]'
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
    return failure(
      `L'outil ${name} exige une approbation humaine, que Maestro ne peut pas demander pour un client externe. Passe par un agent Maestro pour cette action.`,
    );
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
        ? `Outils Maestro délégués au nom de l'agent « ${scope.agent.name} ».`
        : 'Outils Maestro : bases documentaires (RAG) et outils maison configurés dans Maestro.',
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listGatewayTools(scope),
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
