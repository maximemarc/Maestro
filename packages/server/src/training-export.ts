/**
 * Export de trajectoires vers les formats de fine-tuning.
 *
 * Un seul artefact en sortie : du JSONL, une trajectoire par ligne. C'est ce
 * qu'attendent Axolotl, LLaMA-Factory, Unsloth et l'API de fine-tuning
 * d'OpenAI ; produire un tableau JSON unique obligerait à charger le jeu de
 * données entier en mémoire, ce qui ruine l'intérêt d'en générer des milliers.
 */
import type {
  Trajectory,
  TrainingExportFormat,
  TrainingExportPreview,
  TrajectoryCompression,
  ToolCallDialect,
} from '@maestro/shared';
import { renderToolCalls, renderToolResult } from './training-parsers.ts';
import { EMPTY_COMPRESSION, compressTrajectory, mergeCompression } from './training-trajectory.ts';

export interface ExportInput {
  trajectory: Trajectory;
  /** Récompense associée, quand le lot a été noté. */
  score: number | null;
}

export interface ExportOptions {
  format: TrainingExportFormat;
  dialect: ToolCallDialect;
  tokenBudget: number | null;
  onlySucceeded: boolean;
  requireToolCalls: boolean;
}

export interface ExportResult {
  lines: string[];
  preview: TrainingExportPreview;
}

/** Nombre de lignes montrées en aperçu — de quoi juger la forme, pas le volume. */
const SAMPLE_LINES = 2;

/**
 * Correspondance des rôles ShareGPT.
 *
 * `observation` pour un retour d'outil : c'est la convention de
 * LLaMA-Factory, la plus répandue des variantes outillées de ShareGPT. Les
 * appels d'outils, eux, sont rendus dans le texte du tour `gpt` selon le
 * dialecte choisi — c'est tout l'objet du dialecte.
 */
const SHAREGPT_ROLES: Record<Trajectory['turns'][number]['role'], string> = {
  system: 'system',
  user: 'human',
  assistant: 'gpt',
  tool: 'observation',
};

function toShareGpt(trajectory: Trajectory, dialect: ToolCallDialect): unknown {
  const conversations = trajectory.turns.map((turn) => {
    let value = turn.content;
    if (turn.role === 'assistant' && turn.toolCalls?.length) {
      const rendered = renderToolCalls(dialect, turn.toolCalls);
      value = value.trim() ? `${value}\n${rendered}` : rendered;
    }
    if (turn.role === 'tool') {
      value = renderToolResult(
        dialect,
        turn.toolName ?? 'unknown',
        turn.content,
        turn.isError ?? false,
      );
    }
    return { from: SHAREGPT_ROLES[turn.role], value };
  });
  return { conversations };
}

function toOpenAiMessages(trajectory: Trajectory): unknown[] {
  return trajectory.turns.map((turn) => {
    if (turn.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: turn.toolCallId ?? '',
        name: turn.toolName ?? 'unknown',
        content: turn.content,
      };
    }
    if (turn.role === 'assistant' && turn.toolCalls?.length) {
      return {
        role: 'assistant',
        content: turn.content || null,
        tool_calls: turn.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        })),
      };
    }
    return { role: turn.role, content: turn.content };
  });
}

/**
 * Rollout scoré, pour l'apprentissage par renforcement.
 *
 * Forme volontairement plate : une conversation au format OpenAI, un score
 * scalaire, et la métadonnée qui permet de remonter au run d'origine. C'est ce
 * qu'attend un environnement Atropos côté chargement de données — pas son API
 * interne à granularité de token, qui suppose le tokenizer du modèle cible et
 * n'a donc rien à faire ici.
 *
 * Un rollout sans score est inutilisable en renforcement : le service écarte
 * ces trajectoires en amont plutôt que d'inventer une récompense.
 */
function toAtropos(input: ExportInput): unknown {
  const { trajectory, score } = input;
  return {
    messages: toOpenAiMessages(trajectory),
    score,
    metadata: {
      run_id: trajectory.runId,
      agent: trajectory.agentName,
      model: trajectory.model,
      status: trajectory.status,
      tools_used: trajectory.toolsUsed,
      estimated_tokens: trajectory.estimatedTokens,
      cost_usd: trajectory.costUsd,
      created_at: trajectory.createdAt,
    },
  };
}

function serialize(
  format: TrainingExportFormat,
  dialect: ToolCallDialect,
  input: ExportInput,
): unknown {
  switch (format) {
    case 'sharegpt':
      return toShareGpt(input.trajectory, dialect);
    case 'openai':
      return { messages: toOpenAiMessages(input.trajectory) };
    case 'atropos':
      return toAtropos(input);
    case 'raw':
      return input.trajectory;
  }
}

export function buildExport(options: ExportOptions, inputs: ExportInput[]): ExportResult {
  const skipped: Array<{ runId: string; reason: string }> = [];
  const lines: string[] = [];
  let compression = { ...EMPTY_COMPRESSION, tokenBudget: options.tokenBudget };
  let totalEstimatedTokens = 0;

  for (const input of inputs) {
    const { trajectory } = input;
    if (options.onlySucceeded && trajectory.status !== 'succeeded') {
      skipped.push({ runId: trajectory.runId, reason: `run ${trajectory.status}` });
      continue;
    }
    if (options.requireToolCalls && trajectory.toolsUsed.length === 0) {
      skipped.push({ runId: trajectory.runId, reason: 'aucun appel d’outil' });
      continue;
    }
    if (options.format === 'atropos' && input.score === null) {
      skipped.push({ runId: trajectory.runId, reason: 'aucun score (requis en renforcement)' });
      continue;
    }

    const compressed = compressTrajectory(trajectory, options.tokenBudget);
    /*
     * Une trajectoire réduite à la seule consigne n'apprend rien : la coupe a
     * emporté la réponse. Mieux vaut l'écarter en le disant que la laisser
     * diluer le jeu de données.
     */
    if (!compressed.trajectory.turns.some((t) => t.role === 'assistant')) {
      skipped.push({ runId: trajectory.runId, reason: 'vidée par la compression' });
      continue;
    }
    compression = mergeCompression(compression, compressed.compression);
    totalEstimatedTokens += compressed.trajectory.estimatedTokens;
    lines.push(
      JSON.stringify(
        serialize(options.format, options.dialect, {
          ...input,
          trajectory: compressed.trajectory,
        }),
      ),
    );
  }

  return {
    lines,
    preview: {
      format: options.format,
      dialect: options.dialect,
      count: lines.length,
      skipped,
      totalEstimatedTokens,
      compression: { ...compression, tokenBudget: options.tokenBudget },
      sample: lines.slice(0, SAMPLE_LINES),
    },
  };
}

/** Corps du fichier téléchargé : JSONL, saut de ligne final compris. */
export function toJsonl(lines: string[]): string {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

/** Compte rendu vide, quand aucune trajectoire n'a été retenue. */
export function emptyCompression(tokenBudget: number | null): TrajectoryCompression {
  return { ...EMPTY_COMPRESSION, tokenBudget };
}
