/**
 * Registre des serveurs MCP déclarés par l'utilisateur.
 *
 * Deux natures dans une seule table :
 *
 * - `external` : un serveur MCP qui existe déjà, que Maestro se contente de
 *   déclarer au SDK (stdio, http ou sse).
 * - `custom` : des outils décrits dans l'interface, que Maestro assemble en
 *   serveur MCP in-process. C'est le « MCP simplifié » : aucun dépôt à écrire,
 *   aucun processus à faire tourner.
 *
 * 🔒 Secrets. Les valeurs d'environnement et d'en-têtes peuvent porter des
 * jetons. Elles sont stockées, mais jamais renvoyées au client : `redact()`
 * remplace chaque valeur par un marqueur, et la fusion ne réécrit une valeur
 * que si le client en envoie une nouvelle, non masquée. Un aller-retour dans
 * l'interface ne peut donc ni afficher ni effacer un secret par accident.
 */
import { z } from 'zod';
import type {
  McpAction,
  McpServerDef,
  McpToolDef,
  McpToolParam,
  McpToolTrial,
} from '@maestro/shared';
import type { Bus } from './bus.ts';
import type { Store } from './db.ts';
import { toolSchema } from './mcp-schema.ts';
import { makeId, nowIso, truncate } from './util.ts';

export class McpError extends Error {}

/** Marqueur rendu à la place d'une valeur sensible déjà enregistrée. */
export const SECRET_MASK = '••••••••';

/** Plafond de la réponse d'un appel HTTP remise à l'agent. */
const HTTP_RESPONSE_MAX_CHARS = 20_000;
const HTTP_TIMEOUT_DEFAULT_MS = 15_000;
const HTTP_TIMEOUT_MAX_MS = 120_000;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
/** Le SDK nomme les outils `mcp__<serveur>__<outil>` : pas de séparateur ici. */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,48}$/;
const PARAM_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,30}$/;

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Remplace chaque valeur par un marqueur, en conservant les clés. */
function redactMap(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(map)) out[key] = SECRET_MASK;
  return out;
}

/**
 * Fusionne une carte reçue du client avec celle en base.
 *
 * Une valeur égale au marqueur signifie « inchangée » : on reprend l'existante.
 * Une clé absente de l'entrée est une suppression volontaire.
 */
function mergeSecrets(
  incoming: Record<string, string>,
  existing: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    out[key] = value === SECRET_MASK ? (existing[key] ?? '') : value;
  }
  return out;
}

/** Vue publique d'un serveur : identique, secrets masqués. */
export function redact(def: McpServerDef): McpServerDef {
  return {
    ...def,
    env: redactMap(def.env),
    headers: redactMap(def.headers),
    tools: def.tools.map((tool) =>
      tool.action.kind === 'http'
        ? { ...tool, action: { ...tool.action, headers: redactMap(tool.action.headers) } }
        : tool,
    ),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Vérifie qu'une URL gabarit a une origine littérale.
 *
 * 🔒 C'est la garantie centrale du modèle « HTTP paramétrable ». Si l'hôte
 * pouvait venir d'un paramètre, l'agent choisirait sa cible : il suffirait
 * qu'il appelle l'outil avec un hôte d'infrastructure interne pour l'atteindre.
 * En figeant schéma, hôte et port à la création, l'humain décide de la cible une
 * fois pour toutes, et l'agent ne pilote que le chemin, la requête et le corps.
 */
export function assertLiteralOrigin(urlTemplate: string): URL {
  const trimmed = urlTemplate.trim();
  if (trimmed === '') throw new McpError("L'URL de l'outil est obligatoire.");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new McpError(`URL invalide : ${truncate(trimmed, 80)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new McpError('Seuls http et https sont acceptés.');
  }
  const origin = `${parsed.protocol}//${parsed.host}`;
  if (origin.includes('{{')) {
    throw new McpError(
      "L'hôte de l'URL ne peut pas contenir de paramètre : seuls le chemin, la requête et le corps sont paramétrables.",
    );
  }
  return parsed;
}

function validateParam(param: McpToolParam): void {
  if (!PARAM_NAME_RE.test(param.name)) {
    throw new McpError(
      `Nom de paramètre invalide : « ${param.name} ». Lettres, chiffres et tirets bas, en commençant par une lettre.`,
    );
  }
  if (param.enumValues.length > 0 && param.type !== 'string') {
    throw new McpError(
      `Le paramètre « ${param.name} » restreint ses valeurs alors qu'il n'est pas de type texte.`,
    );
  }
}

function validateAction(action: McpAction, toolName: string): void {
  if (action.kind === 'text') {
    if (action.template.trim() === '') {
      throw new McpError(`L'outil « ${toolName} » ne renvoie aucun texte.`);
    }
    return;
  }
  assertLiteralOrigin(action.urlTemplate);
  if (action.timeoutMs < 1000 || action.timeoutMs > HTTP_TIMEOUT_MAX_MS) {
    throw new McpError(
      `Délai de l'outil « ${toolName} » hors bornes : entre 1000 et ${HTTP_TIMEOUT_MAX_MS} ms.`,
    );
  }
}

export function validateTool(tool: McpToolDef): void {
  if (!TOOL_NAME_RE.test(tool.name)) {
    throw new McpError(
      `Nom d'outil invalide : « ${tool.name} ». Minuscules, chiffres et tirets bas, en commençant par une lettre.`,
    );
  }
  if (tool.description.trim() === '') {
    throw new McpError(
      `L'outil « ${tool.name} » n'a pas de description. C'est elle qui dit au modèle quand l'appeler : sans elle, l'outil est inutilisable.`,
    );
  }
  const seen = new Set<string>();
  for (const param of tool.params) {
    if (seen.has(param.name)) {
      throw new McpError(`Paramètre en double dans « ${tool.name} » : ${param.name}`);
    }
    seen.add(param.name);
    validateParam(param);
  }
  validateAction(tool.action, tool.name);
}

// ---------------------------------------------------------------------------
// Interpolation
// ---------------------------------------------------------------------------

/**
 * Remplace les `{{paramètre}}` d'un gabarit par les arguments de l'appel.
 *
 * `encode` est vrai pour une URL : sans encodage, un argument contenant `&` ou
 * `?` réécrirait la chaîne de requête. Un paramètre inconnu est laissé tel
 * quel : le supprimer silencieusement produirait une URL plausible mais fausse,
 * plus difficile à diagnostiquer qu'un gabarit resté visible.
 */
export function interpolate(
  template: string,
  args: Record<string, unknown>,
  encode: boolean,
): string {
  return template.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (whole, name: string) => {
    if (!(name in args)) return whole;
    const value = args[name];
    const text = value === null || value === undefined ? '' : String(value);
    return encode ? encodeURIComponent(text) : text;
  });
}

/** Extrait un chemin pointé d'une réponse JSON. Vide = réponse entière. */
export function pluck(value: unknown, path: string): unknown {
  if (path.trim() === '') return value;
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (segment === '') continue;
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// ---------------------------------------------------------------------------
// Exécution d'une action
// ---------------------------------------------------------------------------

/**
 * Nombre de tentatives d'un appel HTTP.
 *
 * Un seul réessai, et seulement sur une panne qui a des chances de passer au
 * coup suivant : erreur serveur ou délai dépassé. Sans lui, un 502 passager
 * remonte au modèle, qui réessaie à l'aveugle en consommant un tour de
 * conversation à chaque fois. Sur une erreur 4xx, en revanche, réessayer ne
 * peut rien changer : c'est l'appel qui est mauvais.
 */
const HTTP_ATTEMPTS = 2;
const HTTP_RETRY_DELAY_MS = 400;

/** Vrai si l'échec a des chances de ne pas se reproduire. */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  return /HTTP 5\d\d/.test(err.message) || /HTTP 429/.test(err.message);
}

/** Exécute l'action d'un outil maison et retourne le texte remis à l'agent. */
export async function runAction(tool: McpToolDef, args: Record<string, unknown>): Promise<string> {
  if (tool.action.kind === 'text') {
    return interpolate(tool.action.template, args, false);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= HTTP_ATTEMPTS; attempt++) {
    try {
      return await callHttp(tool.action, args);
    } catch (err) {
      lastError = err;
      if (attempt === HTTP_ATTEMPTS || !isRetryable(err)) break;
      await new Promise((resolve) => setTimeout(resolve, HTTP_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

async function callHttp(
  action: Extract<McpAction, { kind: 'http' }>,
  args: Record<string, unknown>,
): Promise<string> {
  /* Revalidation à l'appel : le gabarit a été vérifié à l'enregistrement, mais
     c'est l'URL finale qui part sur le réseau. */
  assertLiteralOrigin(action.urlTemplate);
  const url = interpolate(action.urlTemplate, args, true);

  const hasBody = action.method !== 'GET' && action.method !== 'DELETE';
  const body = hasBody ? interpolate(action.bodyTemplate, args, false) : undefined;

  const controller = new AbortController();
  const timeoutMs = action.timeoutMs || HTTP_TIMEOUT_DEFAULT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: action.method,
      headers: {
        ...(hasBody && body ? { 'content-type': 'application/json' } : {}),
        ...action.headers,
      },
      ...(body ? { body } : {}),
      signal: controller.signal,
      redirect: 'follow',
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} : ${truncate(raw, 500)}`);
    }
    if (action.responsePath.trim() === '') return truncate(raw, HTTP_RESPONSE_MAX_CHARS);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `La réponse n'est pas du JSON, alors qu'un chemin « ${action.responsePath} » est demandé.`,
      );
    }
    const picked = pluck(parsed, action.responsePath);
    if (picked === undefined) {
      throw new Error(`Chemin « ${action.responsePath} » absent de la réponse.`);
    }
    const text = typeof picked === 'string' ? picked : JSON.stringify(picked, null, 2);
    return truncate(text, HTTP_RESPONSE_MAX_CHARS);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Délai dépassé (${timeoutMs} ms) sur ${truncate(url, 120)}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type McpServerInput = Omit<McpServerDef, 'id' | 'createdAt' | 'updatedAt'>;

export class McpRegistry {
  constructor(
    private store: Store,
    private bus: Bus,
  ) {}

  /** Liste destinée au client : secrets masqués. */
  list(): McpServerDef[] {
    return this.store.listMcpServers().map(redact);
  }

  /** Liste interne : valeurs réelles, pour la construction des sessions. */
  listRaw(): McpServerDef[] {
    return this.store.listMcpServers();
  }

  get(id: string): McpServerDef | null {
    const def = this.store.getMcpServer(id);
    return def ? redact(def) : null;
  }

  getRaw(id: string): McpServerDef | null {
    return this.store.getMcpServer(id);
  }

  create(input: McpServerInput): McpServerDef {
    const def = this.normalise(input, null);
    if (this.store.getMcpServerBySlug(def.slug)) {
      throw new McpError(`Un serveur MCP porte déjà l'identifiant « ${def.slug} ».`);
    }
    this.store.upsertMcpServer(def);
    this.bus.log('info', 'mcp', `Serveur MCP « ${def.name} » créé (${def.kind})`);
    const view = redact(def);
    this.bus.publish({ type: 'mcp.updated', payload: view });
    return view;
  }

  update(id: string, input: McpServerInput): McpServerDef {
    const existing = this.store.getMcpServer(id);
    if (!existing) throw new McpError('Serveur MCP introuvable.');
    const def = this.normalise(input, existing);
    const clash = this.store.getMcpServerBySlug(def.slug);
    if (clash && clash.id !== id) {
      throw new McpError(`Un serveur MCP porte déjà l'identifiant « ${def.slug} ».`);
    }
    this.store.upsertMcpServer(def);
    const view = redact(def);
    this.bus.publish({ type: 'mcp.updated', payload: view });
    return view;
  }

  remove(id: string): void {
    const existing = this.store.getMcpServer(id);
    if (!existing) throw new McpError('Serveur MCP introuvable.');
    this.store.detachMcpServerFromAgents(id);
    this.store.deleteMcpServer(id);
    this.bus.log('warn', 'mcp', `Serveur MCP « ${existing.name} » supprimé`);
    this.bus.publish({ type: 'mcp.deleted', payload: { id } });
  }

  /**
   * Valide, complète et fige une définition.
   *
   * `existing` sert au report des secrets : sans lui, enregistrer un serveur
   * depuis l'interface effacerait les jetons que le client n'a jamais vus.
   */
  private normalise(input: McpServerInput, existing: McpServerDef | null): McpServerDef {
    const name = input.name.trim();
    if (name === '') throw new McpError('Le nom du serveur est obligatoire.');
    const slug = slugify(input.slug.trim() === '' ? name : input.slug);
    if (!SLUG_RE.test(slug)) {
      throw new McpError(
        `Identifiant invalide : « ${slug} ». Minuscules, chiffres et tirets, 2 à 40 caractères.`,
      );
    }

    const env = mergeSecrets(input.env, existing?.env ?? {});
    const headers = mergeSecrets(input.headers, existing?.headers ?? {});

    let transport = input.transport;
    let command = input.command?.trim() || null;
    let url = input.url?.trim() || null;
    let tools: McpToolDef[] = [];

    if (input.kind === 'external') {
      if (transport === null) throw new McpError('Le transport est obligatoire.');
      if (transport === 'stdio') {
        if (!command) throw new McpError('Un transport stdio exige une commande.');
        url = null;
      } else {
        if (!url) throw new McpError(`Un transport ${transport} exige une URL.`);
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw new McpError(`URL invalide : ${truncate(url, 80)}`);
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new McpError('Seuls http et https sont acceptés.');
        }
        command = null;
      }
    } else {
      /* Un serveur maison n'a ni transport ni point d'entrée : il vit dans le
         processus du serveur Maestro. */
      transport = null;
      command = null;
      url = null;
      if (input.tools.length === 0) {
        throw new McpError('Un serveur maison doit déclarer au moins un outil.');
      }
      const names = new Set<string>();
      for (const tool of input.tools) {
        validateTool(tool);
        if (names.has(tool.name)) throw new McpError(`Outil en double : ${tool.name}`);
        names.add(tool.name);
      }
      /* Report des en-têtes secrets outil par outil, sur le même principe. */
      const previous = new Map(existing?.tools.map((t) => [t.name, t]) ?? []);
      tools = input.tools.map((tool) => {
        if (tool.action.kind !== 'http') return tool;
        const before = previous.get(tool.name);
        const beforeHeaders =
          before?.action.kind === 'http' ? before.action.headers : ({} as Record<string, string>);
        return {
          ...tool,
          action: {
            ...tool.action,
            headers: mergeSecrets(tool.action.headers, beforeHeaders),
            timeoutMs: tool.action.timeoutMs || HTTP_TIMEOUT_DEFAULT_MS,
          },
        };
      });
    }

    const now = nowIso();
    return {
      id: existing?.id ?? makeId('mcp'),
      slug,
      name,
      description: input.description.trim(),
      kind: input.kind,
      enabled: input.enabled,
      transport,
      command,
      args: input.args.map((a) => a.trim()).filter((a) => a !== ''),
      env,
      url,
      headers,
      tools,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  /**
   * Exécute un outil maison hors session, pour l'essai depuis l'interface.
   *
   * Essayer un outil avant de l'ouvrir aux agents est la seule façon de savoir
   * qu'il marche : autrement, la première exécution réelle a lieu au milieu du
   * run d'un agent, où le diagnostic coûte bien plus cher.
   */
  async trial(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpToolTrial> {
    const def = this.store.getMcpServer(serverId);
    if (!def) throw new McpError('Serveur MCP introuvable.');
    if (def.kind !== 'custom') {
      throw new McpError("Seuls les outils d'un serveur maison peuvent être essayés ici.");
    }
    const tool = def.tools.find((t) => t.name === toolName);
    if (!tool) throw new McpError(`Outil introuvable : ${toolName}`);

    /*
     * Les arguments sont validés avec le schéma réellement exposé au modèle :
     * un essai qui accepterait ce que le SDK refuse donnerait une fausse
     * assurance, et l'erreur ne surgirait qu'au milieu d'un run.
     */
    const started = Date.now();
    let checked: Record<string, unknown>;
    try {
      checked = z.object(toolSchema(tool)).parse(args) as Record<string, unknown>;
    } catch (err) {
      return {
        ok: false,
        output:
          err instanceof z.ZodError
            ? err.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join('\n')
            : String(err),
        durationMs: Date.now() - started,
      };
    }

    try {
      const output = await runAction(tool, checked);
      return {
        ok: true,
        output: truncate(output, HTTP_RESPONSE_MAX_CHARS),
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      };
    }
  }
}
