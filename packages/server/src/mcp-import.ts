/**
 * Import de serveurs MCP depuis une configuration existante.
 *
 * Les serveurs MCP se déclarent partout de la même façon : un objet
 * `mcpServers` dont chaque clé est un nom et chaque valeur un transport. C'est
 * le format de `.mcp.json`, de la configuration de Claude Code et de celle de
 * Claude Desktop. Les retaper dans Maestro n'apporte rien, et introduit des
 * fautes de frappe dans des commandes qui marchaient.
 *
 * 🔒 L'import se fait en deux temps. Une prévisualisation d'abord, qui montre ce
 * qui serait créé avec les secrets masqués ; la création ensuite, sur les seuls
 * noms retenus. Le client ne voit donc jamais les jetons présents dans le
 * fichier, et rien n'est écrit sans un choix explicite.
 */
import { readFileSync } from 'node:fs';
import type { McpImportCandidate, McpServerDef } from '@maestro/shared';
import { McpError, type McpServerInput, slugify } from './mcp-registry.ts';

/** Taille maximale d'un fichier de configuration accepté. */
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

interface RawStdio {
  command?: string;
  args?: unknown;
  env?: unknown;
  type?: string;
}

interface RawRemote {
  url?: string;
  headers?: unknown;
  type?: string;
}

type RawServer = RawStdio & RawRemote;

function asStringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[key] = raw;
    else if (typeof raw === 'number' || typeof raw === 'boolean') out[key] = String(raw);
  }
  return out;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * Localise l'objet `mcpServers` dans une configuration.
 *
 * Selon l'outil, il est à la racine, ou sous un projet. On accepte les deux, et
 * pour une configuration multi-projets on fusionne : l'utilisateur choisira
 * ensuite ce qu'il importe, ce qui vaut mieux que de lui demander quel projet
 * regarder alors qu'il ne sait pas ce qu'il y a dedans.
 */
function collectServers(config: unknown): Record<string, RawServer> {
  if (config === null || typeof config !== 'object') return {};
  const root = config as Record<string, unknown>;
  const found: Record<string, RawServer> = {};

  const merge = (value: unknown) => {
    if (value === null || typeof value !== 'object') return;
    for (const [name, raw] of Object.entries(value as Record<string, unknown>)) {
      if (raw !== null && typeof raw === 'object' && !(name in found)) {
        found[name] = raw as RawServer;
      }
    }
  };

  merge(root.mcpServers);
  const projects = root.projects;
  if (projects !== null && typeof projects === 'object') {
    for (const project of Object.values(projects as Record<string, unknown>)) {
      if (project !== null && typeof project === 'object') {
        merge((project as Record<string, unknown>).mcpServers);
      }
    }
  }
  return found;
}

/** Traduit une entrée de configuration en définition Maestro. */
function toInput(name: string, raw: RawServer): McpServerInput | null {
  const declared = typeof raw.type === 'string' ? raw.type.toLowerCase() : null;
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  const command = typeof raw.command === 'string' ? raw.command.trim() : '';

  /* Le champ `type` est facultatif dans la plupart des fichiers : la présence
     d'une url ou d'une commande tranche. */
  const transport =
    declared === 'sse'
      ? 'sse'
      : declared === 'http' || url !== ''
        ? 'http'
        : command !== ''
          ? 'stdio'
          : null;
  if (transport === null) return null;

  return {
    slug: slugify(name),
    name,
    description: '',
    kind: 'external',
    enabled: true,
    transport,
    command: transport === 'stdio' ? command : null,
    args: transport === 'stdio' ? asStringArray(raw.args) : [],
    env: transport === 'stdio' ? asStringRecord(raw.env) : {},
    url: transport === 'stdio' ? null : url,
    headers: transport === 'stdio' ? {} : asStringRecord(raw.headers),
    tools: [],
  };
}

/** Lit une configuration, depuis un chemin ou un contenu collé. */
export function readConfig(source: { path?: string; json?: string }): unknown {
  if (source.json !== undefined && source.json.trim() !== '') {
    try {
      return JSON.parse(source.json);
    } catch (err) {
      throw new McpError(
        `Le contenu collé n'est pas du JSON valide : ${err instanceof Error ? err.message : ''}`,
      );
    }
  }
  const path = source.path?.trim();
  if (!path) throw new McpError('Indique un chemin de fichier ou colle une configuration.');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new McpError(`Fichier illisible : ${path}`);
  }
  if (raw.length > MAX_CONFIG_BYTES) {
    throw new McpError('Fichier trop volumineux pour être une configuration MCP.');
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new McpError(
      `${path} n'est pas du JSON valide : ${err instanceof Error ? err.message : ''}`,
    );
  }
}

/**
 * Analyse une configuration et décrit ce qui pourrait être importé.
 *
 * Rien n'est écrit. Chaque candidat dit son transport, ce qu'il lancerait ou
 * appellerait, et le nombre de secrets qu'il porte — sans leur valeur.
 */
export function previewImport(config: unknown, existing: McpServerDef[]): McpImportCandidate[] {
  const known = new Set(existing.map((s) => s.slug));
  const candidates: McpImportCandidate[] = [];

  for (const [name, raw] of Object.entries(collectServers(config))) {
    const input = toInput(name, raw);
    if (!input) {
      candidates.push({
        name,
        slug: slugify(name),
        transport: null,
        summary: 'entrée ignorée : ni commande ni URL reconnaissable',
        secretCount: 0,
        alreadyPresent: false,
        importable: false,
      });
      continue;
    }
    const secretCount = Object.keys(input.env).length + Object.keys(input.headers).length;
    candidates.push({
      name,
      slug: input.slug,
      transport: input.transport,
      summary:
        input.transport === 'stdio' ? [input.command, ...input.args].join(' ') : (input.url ?? ''),
      secretCount,
      alreadyPresent: known.has(input.slug),
      importable: true,
    });
  }

  return candidates.sort((a, b) => a.name.localeCompare(b.name));
}

/** Retourne les définitions à créer pour les noms retenus. */
export function selectForImport(config: unknown, names: string[]): McpServerInput[] {
  const wanted = new Set(names);
  const out: McpServerInput[] = [];
  for (const [name, raw] of Object.entries(collectServers(config))) {
    if (!wanted.has(name)) continue;
    const input = toInput(name, raw);
    if (input) out.push(input);
  }
  return out;
}
