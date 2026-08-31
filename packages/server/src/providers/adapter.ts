/**
 * Contrat d'un adaptateur de fournisseur.
 *
 * Une tentative rend un **résultat**, elle ne finalise pas le run : c'est le
 * moteur qui décide, au vu du verdict, s'il réessaie, bascule ou abandonne. Un
 * adaptateur qui clôturerait lui-même le run rendrait tout repli impossible.
 *
 * Note d'implémentation assumée : le fournisseur `claude-sdk` **n'est pas** un
 * adaptateur de ce fichier, il reste dans `runs.ts`. Son exécution est tissée
 * avec les serveurs MCP in-process, les plugins, les skills et le broker
 * d'approbation — la déplacer derrière cette interface obligerait à faire
 * transiter la moitié du moteur en paramètre. Il respecte le même type de
 * sortie (`AttemptOutcome`), ce qui suffit à la boucle de repli ; l'interface
 * ci-dessous sert aux fournisseurs *externes*, qui n'ont besoin que d'un
 * prompt, d'un répertoire et d'un environnement.
 */
import type {
  AgentConfig,
  FailureClass,
  ProviderAccount,
  ProviderKind,
  ProviderProbe,
  Run,
  RunEventKind,
  RunEventPayload,
} from '@maestro/shared';

/** Consommation remontée au fil de l'eau, pour le garde-fou de budget. */
export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  numTurns: number;
}

export const ZERO_USAGE: UsageDelta = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  numTurns: 0,
};

export interface AttemptContext {
  run: Run;
  agent: AgentConfig;
  /** null = environnement ambiant du serveur (compat avant les comptes). */
  account: ProviderAccount | null;
  model: string;
  /** Prompt final : préambule de skill, carte kanban et handoff déjà intégrés. */
  prompt: string;
  /** Reprise de session — jamais renseignée après une bascule de compte. */
  resumeSessionId: string | null;
  workspaceDir: string;
  timeoutSec: number | null;
  abort: AbortController;
  /** Environnement à passer au processus fils, comptes déjà appliqués. */
  env: NodeJS.ProcessEnv;
  emit: (kind: RunEventKind, payload: RunEventPayload) => void;
  onUsage: (delta: UsageDelta) => void;
}

/**
 * Indices bruts laissés à la classification. L'adaptateur ne classe pas
 * lui-même : il rapporte ce qu'il a vu (statut, en-têtes, code système), la
 * décision se prend en un seul endroit.
 */
export interface FailureSignal {
  status?: number | null;
  headers?: Record<string, string> | null;
  code?: string | null;
  hint?: FailureClass | null;
}

export interface AttemptOutcome {
  status: 'succeeded' | 'failed';
  /** Identifiant de session du fournisseur, s'il en rend un. */
  sessionId: string | null;
  resultText: string | null;
  error: string | null;
  failureSignal?: FailureSignal;
  usage: UsageDelta;
}

export interface ProviderAdapter {
  kind: ProviderKind;
  /** Disponibilité sur cette machine — binaire, version, profils, clés. */
  probe(account?: ProviderAccount | null): Promise<ProviderProbe>;
  execute(ctx: AttemptContext): Promise<AttemptOutcome>;
}

/** Remplace {{prompt}}, {{model}} et {{cwd}} dans un gabarit d'arguments. */
export function renderArgs(
  template: readonly string[],
  vars: { prompt: string; model: string; cwd: string },
): string[] {
  return template.map((arg) =>
    arg
      .replaceAll('{{prompt}}', vars.prompt)
      .replaceAll('{{model}}', vars.model)
      .replaceAll('{{cwd}}', vars.cwd),
  );
}
