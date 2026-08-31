/**
 * Application des événements temps réel.
 *
 * `applyEvent` est le point où l'état de l'interface diverge, ou non, de celui
 * du serveur. Un événement mal appliqué ne lève rien : la page affiche
 * simplement quelque chose de faux, et personne ne s'en aperçoit avant de
 * recharger.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TrainingBatch, TrainingItem } from '@maestro/shared';
import { useStore } from './store';

function batch(id: string, patch: Partial<TrainingBatch> = {}): TrainingBatch {
  return {
    id,
    name: id,
    description: '',
    status: 'running',
    spec: {
      agentIds: ['a1'],
      promptTemplates: ['x'],
      variables: {},
      samples: 1,
      workers: 1,
      maxAttempts: 1,
      toolWeights: [],
      timeoutSec: null,
      skillId: null,
      grader: null,
    },
    counts: { pending: 1, running: 0, succeeded: 0, failed: 0, skipped: 0, cancelled: 0 },
    checkpointIndex: 1,
    error: null,
    createdAt: '2026-08-28T09:00:00.000Z',
    updatedAt: '2026-08-28T09:00:00.000Z',
    startedAt: null,
    endedAt: null,
    ...patch,
  };
}

function item(id: string, batchId: string, patch: Partial<TrainingItem> = {}): TrainingItem {
  return {
    id,
    batchId,
    index: 0,
    agentId: 'a1',
    prompt: 'x',
    runId: null,
    status: 'pending',
    attempts: 0,
    score: null,
    scoreSource: null,
    toolCallCount: 0,
    totalTokens: 0,
    costUsd: 0,
    error: null,
    createdAt: '2026-08-28T09:00:00.000Z',
    endedAt: null,
    ...patch,
  };
}

beforeEach(() => {
  useStore.setState({
    trainingBatches: [],
    trainingItems: {},
    trainingItemsTruncated: {},
    runs: [],
    agents: [],
  });
});

describe('lots d’entraînement', () => {
  it('ajoute un lot inconnu', () => {
    useStore.getState().applyEvent({ type: 'trainingBatch.updated', payload: batch('b1') });
    expect(useStore.getState().trainingBatches).toHaveLength(1);
  });

  it('remplace un lot déjà connu au lieu de le dupliquer', () => {
    const apply = useStore.getState().applyEvent;
    apply({ type: 'trainingBatch.updated', payload: batch('b1') });
    apply({ type: 'trainingBatch.updated', payload: batch('b1', { status: 'succeeded' }) });

    const batches = useStore.getState().trainingBatches;
    expect(batches).toHaveLength(1);
    expect(batches[0]?.status).toBe('succeeded');
  });

  it('retire un lot supprimé, et ses échantillons avec lui', () => {
    const apply = useStore.getState().applyEvent;
    apply({ type: 'trainingBatch.updated', payload: batch('b1') });
    useStore.setState({ trainingItems: { b1: [item('i1', 'b1')] } });

    apply({ type: 'trainingBatch.deleted', payload: { id: 'b1' } });
    expect(useStore.getState().trainingBatches).toHaveLength(0);
    expect(useStore.getState().trainingItems.b1).toBeUndefined();
  });
});

describe('échantillons', () => {
  /*
   * Un lot de dix mille échantillons n'a pas à peupler le store parce qu'il
   * tourne quelque part : seuls les lots dont on a ouvert le détail sont tenus
   * à jour.
   */
  it('ignore un échantillon d’un lot non ouvert', () => {
    useStore.getState().applyEvent({ type: 'trainingItem.updated', payload: item('i1', 'b1') });
    expect(useStore.getState().trainingItems.b1).toBeUndefined();
  });

  it('met à jour un échantillon d’un lot ouvert', () => {
    useStore.setState({ trainingItems: { b1: [item('i1', 'b1')] } });
    useStore.getState().applyEvent({
      type: 'trainingItem.updated',
      payload: item('i1', 'b1', { status: 'succeeded', score: 0.8 }),
    });

    const items = useStore.getState().trainingItems.b1;
    expect(items).toHaveLength(1);
    expect(items?.[0]?.status).toBe('succeeded');
    expect(items?.[0]?.score).toBe(0.8);
  });

  it('n’altère pas les autres lots ouverts', () => {
    useStore.setState({
      trainingItems: { b1: [item('i1', 'b1')], b2: [item('i2', 'b2')] },
    });
    useStore.getState().applyEvent({
      type: 'trainingItem.updated',
      payload: item('i1', 'b1', { status: 'failed' }),
    });
    expect(useStore.getState().trainingItems.b2?.[0]?.status).toBe('pending');
  });
});
