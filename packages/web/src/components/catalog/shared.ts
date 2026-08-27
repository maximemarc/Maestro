/**
 * Socle du parcours d'import distant : constantes, formes de formulaire et
 * formateurs.
 *
 * Extrait de `SkillCatalog.tsx`, qui atteignait 981 lignes en mêlant deux
 * parcours d'exploration et trois cibles d'installation.
 */
import type { AgentEngine, ApprovalPolicy, ImportTarget, PluginInventory } from '@maestro/shared';

export const PAGE_SIZE = 20;
export const SEARCH_DEBOUNCE_MS = 400;

/** Type de composant interrogé au catalogue, par cible d'import. */
export const CATALOG_TYPE: Record<ImportTarget, string> = {
  skill: 'skill',
  agent: 'subagent',
  plugin: 'plugin',
};

export const MODAL_TITLE: Record<ImportTarget, string> = {
  skill: 'Importer une skill',
  agent: 'Importer un agent',
  plugin: 'Installer un plugin',
};

export const AGENT_MODELS = ['sonnet', 'opus', 'haiku'] as const;
export const DEFAULT_AGENT_COLOR = '#22d3ee';
export const DEFAULT_AGENT_EMOJI = '🤖';
/** `input type="color"` n'accepte que #rrggbb : tout autre format est ignoré. */
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Libellés français de l'inventaire d'un plugin, dans l'ordre d'affichage. */
export const INVENTORY_ENTRIES: ReadonlyArray<readonly [keyof PluginInventory, string]> = [
  ['skills', 'skills'],
  ['agents', 'agents'],
  ['commands', 'commandes'],
  ['hooks', 'hooks'],
  ['mcpServers', 'serveurs MCP'],
];

export type SortMode = 'stars' | 'newest';

/** Facettes et tri : tout ce qui, en changeant, relance une recherche. */
export interface SearchFilters {
  q: string;
  category: string;
  sort: SortMode;
  featured: boolean;
}

export const INITIAL_FILTERS: SearchFilters = {
  q: '',
  category: '',
  sort: 'stars',
  featured: false,
};

/** Brouillon d'agent issu d'un subagent distant, modifiable avant création. */
export interface AgentDraftForm {
  name: string;
  emoji: string;
  color: string;
  model: string;
  engine: AgentEngine;
  approvalPolicy: ApprovalPolicy;
  parentAgentId: string;
}

export const BLANK_AGENT_FORM: AgentDraftForm = {
  name: '',
  emoji: DEFAULT_AGENT_EMOJI,
  color: DEFAULT_AGENT_COLOR,
  model: 'sonnet',
  engine: 'sdk',
  approvalPolicy: 'guarded',
  parentAgentId: '',
};

export function fmtCount(n: number): string {
  return n.toLocaleString('fr-FR');
}

export function fmtStars(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} M`;
  if (n >= 1_000) return `${(n / 1_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} k`;
  return fmtCount(n);
}

export function fmtBytes(n: number): string {
  if (n >= 1_048_576)
    return `${(n / 1_048_576).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`;
  if (n >= 1_024) return `${(n / 1_024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Ko`;
  return `${fmtCount(n)} o`;
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function hexColorOr(value: string | null | undefined, fallback: string): string {
  return value && HEX_COLOR.test(value) ? value : fallback;
}

export function knownModelOr(value: string | null | undefined, fallback: string): string {
  return value && (AGENT_MODELS as readonly string[]).includes(value) ? value : fallback;
}
