/**
 * Trajectoires : la forme canonique d'un run, prête à devenir une donnée
 * d'entraînement.
 *
 * Maestro conserve déjà tout ce qu'il faut — chaque run a sa suite
 * d'événements horodatés (texte, réflexion, appel d'outil, retour d'outil).
 * Reconstituer une trajectoire est donc une lecture, pas une capture : aucun
 * stockage supplémentaire, et les runs d'hier sont exploitables au même titre
 * que ceux de ce matin.
 */
import type {
  Run,
  RunEvent,
  Trajectory,
  TrajectoryCompression,
  TrajectoryToolCall,
  TrajectoryTurn,
} from '@maestro/shared';

export interface BuildTrajectoryOptions {
  agentName: string;
  /** Consigne système de l'agent, si on veut l'apprendre au modèle. */
  systemPrompt?: string | null;
  /** Conserve les blocs de réflexion. Faux par défaut : peu de formats les acceptent. */
  includeThinking?: boolean;
}

/**
 * Estimation du poids en tokens.
 *
 * Quatre caractères par token : l'approximation usuelle pour du texte latin.
 * Elle est délibérément grossière — la seule alternative honnête serait
 * d'embarquer le tokenizer du modèle cible, or il n'est pas connu ici, et deux
 * tokenizers ne s'accordent de toute façon pas. L'usage est un budget, pas une
 * facturation : une marge de 10 % ne change pas la décision de compresser.
 */
const CHARS_PER_TOKEN = 4;
/** Surcoût de balisage par tour (rôle, séparateurs de gabarit). */
const TURN_OVERHEAD_TOKENS = 4;

function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function turnTokens(turn: TrajectoryTurn): number {
  let total = TURN_OVERHEAD_TOKENS + textTokens(turn.content);
  if (turn.thinking) total += textTokens(turn.thinking);
  for (const call of turn.toolCalls ?? []) {
    total += textTokens(call.name) + textTokens(JSON.stringify(call.arguments ?? {}));
  }
  return total;
}

export function estimateTokens(turns: TrajectoryTurn[]): number {
  return turns.reduce((sum, turn) => sum + turnTokens(turn), 0);
}

/**
 * Vrai si le texte porte la marque d'une troncature.
 *
 * `truncate()` termine par une ellipse ; la capture des retours d'outils s'en
 * sert. Le signaler dans la trajectoire évite d'entraîner un modèle à
 * s'interrompre au milieu d'un résultat sans que personne ne le sache.
 */
function looksTruncated(text: string): boolean {
  return text.endsWith('…');
}

export function buildTrajectory(
  run: Run,
  events: RunEvent[],
  opts: BuildTrajectoryOptions,
): Trajectory {
  const turns: TrajectoryTurn[] = [];
  if (opts.systemPrompt?.trim()) {
    turns.push({ role: 'system', content: opts.systemPrompt.trim() });
  }
  turns.push({ role: 'user', content: run.prompt });

  /** Nom de l'outil par identifiant d'appel : un retour ne porte que l'id. */
  const toolNames = new Map<string, string>();
  const toolsUsed: string[] = [];
  let durationMs: number | null = null;

  /**
   * Tour assistant en cours de constitution.
   *
   * Le SDK émet un événement par bloc : deux textes et trois appels d'outils
   * appartenant au même message arrivent séparément. Les agréger reconstitue
   * le tour tel que le modèle l'a produit — c'est précisément ce qu'il doit
   * réapprendre à produire.
   */
  let pending: TrajectoryTurn | null = null;
  const flush = (): void => {
    if (!pending) return;
    if (pending.content.trim() || pending.thinking || (pending.toolCalls?.length ?? 0) > 0) {
      turns.push(pending);
    }
    pending = null;
  };
  const assistant = (): TrajectoryTurn => {
    pending ??= { role: 'assistant', content: '' };
    return pending;
  };

  for (const event of events) {
    const p = event.payload;
    switch (event.kind) {
      case 'assistant_text': {
        if (!p.text) break;
        const turn = assistant();
        turn.content = turn.content ? `${turn.content}\n${p.text}` : p.text;
        if (looksTruncated(p.text)) turn.truncated = true;
        break;
      }
      case 'thinking': {
        if (!p.text || !opts.includeThinking) break;
        const turn = assistant();
        turn.thinking = turn.thinking ? `${turn.thinking}\n${p.text}` : p.text;
        if (looksTruncated(p.text)) turn.truncated = true;
        break;
      }
      case 'tool_use': {
        if (!p.toolName) break;
        const turn = assistant();
        const call: TrajectoryToolCall = {
          id: p.toolUseId ?? `call_${turns.length}_${(turn.toolCalls?.length ?? 0) + 1}`,
          name: p.toolName,
          arguments: p.toolInput ?? {},
        };
        turn.toolCalls = [...(turn.toolCalls ?? []), call];
        toolNames.set(call.id, call.name);
        if (!toolsUsed.includes(call.name)) toolsUsed.push(call.name);
        break;
      }
      case 'tool_result': {
        flush();
        const content = p.text ?? '';
        turns.push({
          role: 'tool',
          content,
          toolCallId: p.toolUseId ?? '',
          toolName: p.toolUseId ? (toolNames.get(p.toolUseId) ?? 'unknown') : 'unknown',
          isError: p.isError ?? false,
          ...(looksTruncated(content) ? { truncated: true } : {}),
        });
        break;
      }
      case 'result': {
        durationMs = p.durationMs ?? null;
        break;
      }
      default:
        break;
    }
  }
  flush();

  /*
   * Le texte final du run fait foi.
   *
   * Un run peut se terminer sur un rapport transmis par l'outil de contrôle
   * plutôt que sur un bloc de texte, et le dernier tour serait alors un retour
   * d'outil : une trajectoire dont la cible d'apprentissage est une
   * observation, pas une réponse. On ajoute donc la réponse effective.
   */
  const last = turns.at(-1);
  if (run.resultText?.trim() && (!last || last.role !== 'assistant' || !last.content.trim())) {
    turns.push({ role: 'assistant', content: run.resultText.trim() });
  }

  return {
    runId: run.id,
    agentId: run.agentId,
    agentName: opts.agentName,
    model: run.model,
    status: run.status,
    turns,
    toolsUsed,
    estimatedTokens: estimateTokens(turns),
    usage: {
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cacheReadTokens: run.cacheReadTokens,
      cacheWriteTokens: run.cacheWriteTokens,
    },
    costUsd: run.costUsd,
    durationMs,
    createdAt: run.createdAt,
  };
}

/** Plancher d'un retour d'outil raccourci : en dessous, il n'apprend plus rien. */
const TOOL_RESULT_FLOOR = 160;
const TRUNCATION_MARK = ' …[tronqué]';

export const EMPTY_COMPRESSION: TrajectoryCompression = {
  applied: false,
  tokenBudget: null,
  tokensBefore: 0,
  tokensAfter: 0,
  droppedThinkingTurns: 0,
  truncatedToolResults: 0,
  droppedTurns: 0,
};

/**
 * Ramène une trajectoire sous un budget de tokens, du moins coûteux au plus
 * coûteux pour l'apprentissage.
 *
 * L'ordre des sacrifices n'est pas arbitraire. La réflexion part la première :
 * la plupart des formats de fine-tuning l'excluent déjà. Viennent ensuite les
 * retours d'outils, raccourcis par le plus long — un `ls` de 40 ko n'apprend
 * rien de plus que ses vingt premières lignes. En dernier recours seulement, on
 * retire des tours entiers, par le milieu : la première consigne et la réponse
 * finale sont la paire que le modèle doit apprendre, les perdre viderait
 * l'échantillon de son sens.
 *
 * La trajectoire d'entrée n'est pas modifiée.
 */
export function compressTrajectory(
  trajectory: Trajectory,
  tokenBudget: number | null,
): { trajectory: Trajectory; compression: TrajectoryCompression } {
  const before = trajectory.estimatedTokens;
  const compression: TrajectoryCompression = {
    ...EMPTY_COMPRESSION,
    tokenBudget,
    tokensBefore: before,
    tokensAfter: before,
  };
  if (!tokenBudget || tokenBudget <= 0 || before <= tokenBudget) {
    return { trajectory, compression };
  }

  let turns: TrajectoryTurn[] = trajectory.turns.map((t) => ({ ...t }));
  const overBudget = (): boolean => estimateTokens(turns) > tokenBudget;

  // 1. La réflexion.
  for (const turn of turns) {
    if (!overBudget()) break;
    if (!turn.thinking) continue;
    delete turn.thinking;
    compression.droppedThinkingTurns++;
  }

  /*
   * 2. Les retours d'outils, en attaquant toujours le plus long.
   *
   * `exhausted` n'est pas une optimisation mais la condition d'arrêt : un
   * retour déjà au plancher ne peut plus rétrécir, et le marqueur de troncature
   * ajoute lui-même quelques caractères. Sans cette liste, un retour d'une
   * longueur voisine du plancher serait réécrit indéfiniment à la même taille.
   */
  const shortened = new Set<TrajectoryTurn>();
  const exhausted = new Set<TrajectoryTurn>();
  while (overBudget()) {
    let longest: TrajectoryTurn | null = null;
    for (const turn of turns) {
      if (turn.role !== 'tool' || exhausted.has(turn)) continue;
      if (turn.content.length <= TOOL_RESULT_FLOOR) continue;
      if (!longest || turn.content.length > longest.content.length) longest = turn;
    }
    if (!longest) break;
    const target = Math.max(TOOL_RESULT_FLOOR, Math.floor(longest.content.length / 2));
    const next = longest.content.slice(0, target) + TRUNCATION_MARK;
    if (next.length >= longest.content.length) {
      exhausted.add(longest);
      continue;
    }
    longest.content = next;
    longest.truncated = true;
    shortened.add(longest);
  }
  compression.truncatedToolResults = shortened.size;

  // 3. Des tours entiers, par le milieu.
  while (overBudget() && turns.length > 3) {
    const firstAssistant = turns.findIndex((t) => t.role === 'assistant');
    const start = firstAssistant > 0 ? firstAssistant + 1 : 1;
    const end = turns.length - 1;
    if (start >= end) break;
    const middle = Math.floor((start + end) / 2);
    turns = [...turns.slice(0, middle), ...turns.slice(middle + 1)];
    compression.droppedTurns++;
  }

  /*
   * Un tour outil orphelin est retiré.
   *
   * Retirer un tour par le milieu peut laisser un retour d'outil sans l'appel
   * qui l'a provoqué. Une trajectoire dans cet état est invalide pour la
   * plupart des chargeurs de jeu de données, qui exigent l'appariement.
   */
  const knownCallIds = new Set(
    turns.flatMap((t) => (t.toolCalls ?? []).map((c) => c.id)).filter(Boolean),
  );
  const kept = turns.filter((t) => t.role !== 'tool' || knownCallIds.has(t.toolCallId ?? ''));
  compression.droppedTurns += turns.length - kept.length;
  turns = kept;

  /*
   * Un appel sans retour l'est aussi.
   *
   * Symétrique du cas précédent : la coupe peut avoir emporté l'observation
   * d'un appel conservé, et un modèle entraîné là-dessus apprendrait à appeler
   * un outil dont il n'attend jamais la réponse.
   */
  const answeredCallIds = new Set(
    turns.filter((t) => t.role === 'tool').map((t) => t.toolCallId ?? ''),
  );
  for (const turn of turns) {
    if (!turn.toolCalls?.length) continue;
    const answered = turn.toolCalls.filter((c) => answeredCallIds.has(c.id));
    if (answered.length === turn.toolCalls.length) continue;
    if (answered.length === 0) delete turn.toolCalls;
    else turn.toolCalls = answered;
  }
  turns = turns.filter(
    (t) => t.role !== 'assistant' || t.content.trim() || (t.toolCalls?.length ?? 0) > 0,
  );

  const after = estimateTokens(turns);
  compression.applied = true;
  compression.tokensAfter = after;
  const toolsUsed = [...new Set(turns.flatMap((t) => (t.toolCalls ?? []).map((c) => c.name)))];

  return {
    trajectory: { ...trajectory, turns, toolsUsed, estimatedTokens: after },
    compression,
  };
}

/** Somme deux comptes rendus : un export en agrège un par trajectoire. */
export function mergeCompression(
  a: TrajectoryCompression,
  b: TrajectoryCompression,
): TrajectoryCompression {
  return {
    applied: a.applied || b.applied,
    tokenBudget: b.tokenBudget ?? a.tokenBudget,
    tokensBefore: a.tokensBefore + b.tokensBefore,
    tokensAfter: a.tokensAfter + b.tokensAfter,
    droppedThinkingTurns: a.droppedThinkingTurns + b.droppedThinkingTurns,
    truncatedToolResults: a.truncatedToolResults + b.truncatedToolResults,
    droppedTurns: a.droppedTurns + b.droppedTurns,
  };
}
