import { describe, expect, it } from 'vitest';
import type { TrainingBatch, TrainingItem } from '@maestro/shared';
import { SCORE_NOISE, compareBatches, summarise } from './training-compare.ts';

function batch(id: string): TrainingBatch {
  return {
    id,
    name: id,
    description: '',
    status: 'succeeded',
    spec: {
      agentIds: ['a1'],
      promptTemplates: [],
      variables: {},
      samples: 0,
      workers: 1,
      maxAttempts: 1,
      toolWeights: [],
      timeoutSec: null,
      skillId: null,
      grader: null,
    },
    counts: { pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0 },
    checkpointIndex: 0,
    error: null,
    createdAt: '2026-08-28T09:00:00.000Z',
    updatedAt: '2026-08-28T09:00:00.000Z',
    startedAt: null,
    endedAt: null,
  };
}

function item(patch: Partial<TrainingItem> & { prompt: string }): TrainingItem {
  return {
    id: `titem_${patch.prompt}`,
    batchId: 'b',
    index: 0,
    agentId: 'a1',
    runId: 'run_1',
    status: 'succeeded',
    attempts: 1,
    score: null,
    scoreSource: 'grader',
    toolCallCount: 0,
    totalTokens: 100,
    costUsd: 0.01,
    error: null,
    createdAt: '2026-08-28T09:00:00.000Z',
    endedAt: '2026-08-28T09:00:10.000Z',
    ...patch,
  };
}

function side(prompts: Array<[string, number | null]>, id: string) {
  return {
    batch: batch(id),
    items: prompts.map(([prompt, score]) => item({ prompt, score, batchId: id })),
  };
}

describe('refus de comparer', () => {
  it('refuse un lot comparé à lui-même', () => {
    const s = side([['a', 0.5]], 'b1');
    const result = compareBatches(s, s);
    expect(result.comparable).toBe(false);
    expect(result.reason).toContain('lui-même');
  });

  it('refuse deux lots vides', () => {
    const result = compareBatches(
      { batch: batch('b1'), items: [] },
      { batch: batch('b2'), items: [] },
    );
    expect(result.comparable).toBe(false);
  });

  /*
   * Comparer un cas à un autre cas est pire que ne pas comparer : on conclurait
   * à une régression là où l'on a simplement changé de question.
   */
  it('refuse deux lots qui ne posent pas les mêmes questions', () => {
    const result = compareBatches(side([['a', 0.9]], 'b1'), side([['b', 0.2]], 'b2'));
    expect(result.comparable).toBe(false);
    expect(result.reason).toContain('mêmes questions');
  });
});

describe('appariement', () => {
  /* Sur le prompt et non sur l'index : un lot relancé après modification de la
     liste n'alignerait rien de comparable. */
  it('apparie sur le prompt, quel que soit l’ordre', () => {
    const before = side(
      [
        ['question A', 0.4],
        ['question B', 0.8],
      ],
      'b1',
    );
    const after = side(
      [
        ['question B', 0.9],
        ['question A', 0.5],
      ],
      'b2',
    );
    const result = compareBatches(before, after);
    const casA = result.cases.find((c) => c.prompt === 'question A');
    expect(casA?.baseline?.score).toBe(0.4);
    expect(casA?.candidate?.score).toBe(0.5);
  });

  it('rapporte un cas présent d’un seul côté comme incomparable', () => {
    const result = compareBatches(
      side(
        [
          ['commun', 0.5],
          ['retiré', 0.5],
        ],
        'b1',
      ),
      side(
        [
          ['commun', 0.5],
          ['ajouté', 0.5],
        ],
        'b2',
      ),
    );
    expect(result.comparable).toBe(true);
    expect(result.summary.incomparable).toBe(2);
    expect(result.cases.find((c) => c.prompt === 'retiré')?.candidate).toBeNull();
    expect(result.cases.find((c) => c.prompt === 'ajouté')?.baseline).toBeNull();
  });
});

describe('verdicts', () => {
  /*
   * Un juge est un modèle : il ne rend pas deux fois la même note. Traiter
   * 0,82 contre 0,80 comme une amélioration ferait voir des progrès dans le
   * bruit, et un banc sert justement à décider.
   */
  it('appelle stable un écart inférieur au bruit', () => {
    const result = compareBatches(side([['a', 0.8]], 'b1'), side([['a', 0.82]], 'b2'));
    expect(result.cases[0]?.verdict).toBe('stable');
    expect(result.summary.unchanged).toBe(1);
  });

  it('reconnaît une amélioration au-delà du bruit', () => {
    const result = compareBatches(side([['a', 0.5]], 'b1'), side([['a', 0.9]], 'b2'));
    expect(result.cases[0]?.verdict).toBe('amélioré');
    expect(result.cases[0]?.scoreDelta).toBeCloseTo(0.4);
  });

  it('reconnaît une régression', () => {
    const result = compareBatches(side([['a', 0.9]], 'b1'), side([['a', 0.3]], 'b2'));
    expect(result.cases[0]?.verdict).toBe('dégradé');
    expect(result.summary.regressed).toBe(1);
  });

  it('place la frontière exactement au seuil de bruit', () => {
    const juste = compareBatches(side([['a', 0.5]], 'b1'), side([['a', 0.5 + SCORE_NOISE]], 'b2'));
    expect(juste.cases[0]?.verdict).toBe('amélioré');
  });

  /* Un échantillon non noté ne se compare pas : le ranger dans « stable »
     masquerait la régression qu'on cherche. */
  it('n’invente pas de verdict pour un cas non noté', () => {
    const result = compareBatches(side([['a', null]], 'b1'), side([['a', 0.9]], 'b2'));
    expect(result.cases[0]?.verdict).toBe('incomparable');
    expect(result.cases[0]?.scoreDelta).toBeNull();
  });
});

describe('synthèse', () => {
  it('moyenne uniquement les cas comparables', () => {
    const result = compareBatches(
      side(
        [
          ['a', 0.4],
          ['b', null],
        ],
        'b1',
      ),
      side(
        [
          ['a', 0.8],
          ['b', 0.9],
        ],
        'b2',
      ),
    );
    expect(result.summary.baselineMean).toBeCloseTo(0.4);
    expect(result.summary.candidateMean).toBeCloseTo(0.8);
    expect(result.summary.meanDelta).toBeCloseTo(0.4);
  });

  /* Un agent qui gagne deux centièmes en doublant sa facture n'est pas une
     amélioration : le coût doit figurer dans le verdict. */
  it('rapporte l’écart de coût et de tokens', () => {
    const before = {
      batch: batch('b1'),
      items: [item({ prompt: 'a', score: 0.5, costUsd: 0.01, totalTokens: 100 })],
    };
    const after = {
      batch: batch('b2'),
      items: [item({ prompt: 'a', score: 0.6, costUsd: 0.03, totalTokens: 300 })],
    };
    const result = compareBatches(before, after);
    expect(result.summary.costDelta).toBeCloseTo(0.02);
    expect(result.summary.tokenDelta).toBe(200);
  });

  it('résume en une phrase exploitable', () => {
    const result = compareBatches(
      side(
        [
          ['a', 0.4],
          ['b', 0.9],
        ],
        'b1',
      ),
      side(
        [
          ['a', 0.9],
          ['b', 0.3],
        ],
        'b2',
      ),
    );
    const phrase = summarise(result);
    expect(phrase).toContain('1 cas amélioré');
    expect(phrase).toContain('1 dégradé');
  });

  it('dit clairement quand rien ne bouge', () => {
    const result = compareBatches(side([['a', 0.5]], 'b1'), side([['a', 0.5]], 'b2'));
    expect(summarise(result)).toContain('Aucun écart significatif');
    expect(summarise(result)).toContain('à coût égal');
  });

  it('reprend le motif du refus dans la synthèse', () => {
    const result = compareBatches(side([['a', 0.5]], 'b1'), side([['b', 0.5]], 'b2'));
    expect(summarise(result)).toContain('mêmes questions');
  });
});
