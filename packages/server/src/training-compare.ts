/**
 * Comparaison de deux lots — le banc de non-régression.
 *
 * Modifier le CLAUDE.md d'un agent, changer son modèle ou lui retirer un outil
 * est aujourd'hui un acte de foi : rien ne dit si l'agent s'améliore. Or les
 * briques existent déjà — un lot est un jeu de prompts rejoué de façon
 * reproductible, et le juge attribue un score. Il manquait la comparaison.
 *
 * Le principe est donc volontairement mince : deux lots bâtis sur les mêmes
 * prompts, exécutés avec deux configurations, et une lecture cas par cas de ce
 * qui a bougé. Pas de nouveau moteur, pas de nouveau format.
 */
import type { TrainingBatch, TrainingItem } from '@maestro/shared';

/** Mesures d'un cas dans un lot. */
export interface CaseSide {
  status: TrainingItem['status'];
  score: number | null;
  toolCallCount: number;
  totalTokens: number;
  costUsd: number;
  runId: string | null;
}

export type CaseVerdict = 'amélioré' | 'dégradé' | 'stable' | 'incomparable';

export interface CaseComparison {
  index: number;
  prompt: string;
  baseline: CaseSide | null;
  candidate: CaseSide | null;
  /** Écart de score, positif quand le candidat fait mieux. */
  scoreDelta: number | null;
  verdict: CaseVerdict;
}

export interface ComparisonSummary {
  improved: number;
  regressed: number;
  unchanged: number;
  incomparable: number;
  baselineMean: number | null;
  candidateMean: number | null;
  meanDelta: number | null;
  /** Surcoût du candidat, en dollars. Négatif = moins cher. */
  costDelta: number;
  tokenDelta: number;
}

export interface BatchComparison {
  comparable: boolean;
  /** Pourquoi la comparaison n'a pas de sens, le cas échéant. */
  reason: string | null;
  cases: CaseComparison[];
  summary: ComparisonSummary;
}

/**
 * Écart en deçà duquel on parle de stabilité.
 *
 * Un juge est un modèle : il ne rend pas deux fois exactement la même note pour
 * la même trajectoire. Traiter 0,82 contre 0,80 comme une amélioration ferait
 * voir des progrès dans le bruit — et c'est précisément ce qu'un banc doit
 * éviter, puisqu'on s'en sert pour décider.
 */
export const SCORE_NOISE = 0.05;

const EMPTY_SUMMARY: ComparisonSummary = {
  improved: 0,
  regressed: 0,
  unchanged: 0,
  incomparable: 0,
  baselineMean: null,
  candidateMean: null,
  meanDelta: null,
  costDelta: 0,
  tokenDelta: 0,
};

function toSide(item: TrainingItem): CaseSide {
  return {
    status: item.status,
    score: item.score,
    toolCallCount: item.toolCallCount,
    totalTokens: item.totalTokens,
    costUsd: item.costUsd,
    runId: item.runId,
  };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Compare deux lots, cas par cas.
 *
 * L'appariement se fait sur le prompt et non sur l'index : deux lots bâtis sur
 * les mêmes gabarits mais dont l'un a été relancé après une modification de la
 * liste n'alignerait rien de comparable. Comparer un cas à un autre cas est
 * pire que ne pas comparer — on conclurait à une régression là où l'on a
 * simplement changé de question.
 */
export function compareBatches(
  baseline: { batch: TrainingBatch; items: TrainingItem[] },
  candidate: { batch: TrainingBatch; items: TrainingItem[] },
): BatchComparison {
  if (baseline.batch.id === candidate.batch.id) {
    return {
      comparable: false,
      reason: 'Un lot comparé à lui-même ne dit rien.',
      cases: [],
      summary: EMPTY_SUMMARY,
    };
  }

  const baselineByPrompt = new Map(baseline.items.map((i) => [i.prompt, i]));
  const candidateByPrompt = new Map(candidate.items.map((i) => [i.prompt, i]));

  const prompts = [...new Set([...baselineByPrompt.keys(), ...candidateByPrompt.keys()])];
  if (prompts.length === 0) {
    return {
      comparable: false,
      reason: 'Aucun échantillon dans l’un des deux lots.',
      cases: [],
      summary: EMPTY_SUMMARY,
    };
  }

  const shared = prompts.filter((p) => baselineByPrompt.has(p) && candidateByPrompt.has(p));
  if (shared.length === 0) {
    return {
      comparable: false,
      reason:
        'Les deux lots ne partagent aucun prompt : ils ne posent pas les mêmes questions, ' +
        'et rien ne peut en être conclu.',
      cases: [],
      summary: EMPTY_SUMMARY,
    };
  }

  const cases: CaseComparison[] = [];
  let index = 0;
  for (const prompt of prompts) {
    const before = baselineByPrompt.get(prompt);
    const after = candidateByPrompt.get(prompt);
    const baseSide = before ? toSide(before) : null;
    const candSide = after ? toSide(after) : null;

    /*
     * Un cas n'est comparable que si les deux côtés ont un score. Un
     * échantillon en échec ou non noté ne se compare pas à un autre : le
     * ranger dans « stable » masquerait justement la régression qu'on cherche.
     */
    const comparable =
      baseSide?.score !== null &&
      baseSide?.score !== undefined &&
      candSide?.score !== null &&
      candSide?.score !== undefined;

    const delta = comparable ? (candSide.score ?? 0) - (baseSide.score ?? 0) : null;
    const verdict: CaseVerdict = !comparable
      ? 'incomparable'
      : Math.abs(delta ?? 0) < SCORE_NOISE
        ? 'stable'
        : (delta ?? 0) > 0
          ? 'amélioré'
          : 'dégradé';

    cases.push({
      index: index++,
      prompt,
      baseline: baseSide,
      candidate: candSide,
      scoreDelta: delta,
      verdict,
    });
  }

  const scored = cases.filter((c) => c.verdict !== 'incomparable');
  const baselineMean = mean(scored.map((c) => c.baseline?.score ?? 0));
  const candidateMean = mean(scored.map((c) => c.candidate?.score ?? 0));

  return {
    comparable: true,
    reason: null,
    cases,
    summary: {
      improved: cases.filter((c) => c.verdict === 'amélioré').length,
      regressed: cases.filter((c) => c.verdict === 'dégradé').length,
      unchanged: cases.filter((c) => c.verdict === 'stable').length,
      incomparable: cases.filter((c) => c.verdict === 'incomparable').length,
      baselineMean,
      candidateMean,
      meanDelta:
        baselineMean !== null && candidateMean !== null ? candidateMean - baselineMean : null,
      /* Le coût compte autant que le score : un agent qui gagne deux centièmes
         en doublant sa facture n'est pas une amélioration. */
      costDelta:
        candidate.items.reduce((sum, i) => sum + i.costUsd, 0) -
        baseline.items.reduce((sum, i) => sum + i.costUsd, 0),
      tokenDelta:
        candidate.items.reduce((sum, i) => sum + i.totalTokens, 0) -
        baseline.items.reduce((sum, i) => sum + i.totalTokens, 0),
    },
  };
}

/**
 * Verdict d'ensemble, en une phrase.
 *
 * Un banc dont on doit interpréter soi-même les chiffres ne sert à rien : il
 * doit dire s'il faut garder le changement.
 */
export function summarise(comparison: BatchComparison): string {
  if (!comparison.comparable) return comparison.reason ?? 'Comparaison impossible.';
  const { improved, regressed, unchanged, meanDelta, costDelta } = comparison.summary;

  const cout =
    Math.abs(costDelta) < 0.0001
      ? 'à coût égal'
      : costDelta > 0
        ? `pour $${costDelta.toFixed(4)} de plus`
        : `pour $${Math.abs(costDelta).toFixed(4)} de moins`;

  if (regressed === 0 && improved === 0) {
    return `Aucun écart significatif sur ${unchanged} cas, ${cout}.`;
  }
  const sens =
    meanDelta === null ? '' : ` Score moyen ${meanDelta >= 0 ? '+' : ''}${meanDelta.toFixed(3)}.`;
  return `${improved} cas amélioré(s), ${regressed} dégradé(s), ${unchanged} stable(s), ${cout}.${sens}`;
}
