/**
 * Tests de l'accueil.
 *
 * Ce qui doit tenir : la file d'arbitrage rassemble bien les trois sources, et
 * elle n'inclut pas ce qui n'est plus une demande. Un accueil qui affiche des
 * échecs vieux d'une semaine cesse d'être lu, et un accueil qui oublie une
 * approbation en attente laisse un agent suspendu sans que personne le sache.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../lib/api';
import {
  RUN_INTERRUPTED_BY_RESTART,
  type AgentConfig,
  type Approval,
  type KanbanTask,
  type Run,
} from '@maestro/shared';
import { useStore } from '../lib/store';
import HomePage from './HomePage';

const AGENT = {
  id: 'agt_1',
  name: 'Comptabilité',
  emoji: '📊',
  color: '#22d3ee',
} as unknown as AgentConfig;

function run(overrides: Partial<Run>): Run {
  return {
    id: 'run_1',
    agentId: 'agt_1',
    prompt: 'Rapprocher les écritures bancaires',
    status: 'failed',
    error: 'Budget de tokens dépassé',
    createdAt: new Date().toISOString(),
    startedAt: new Date(Date.now() - 30_000).toISOString(),
    endedAt: new Date().toISOString(),
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    ...overrides,
  } as unknown as Run;
}

function seed(state: { approvals?: Approval[]; runs?: Run[]; tasks?: KanbanTask[] }): void {
  useStore.setState({
    agents: [AGENT],
    approvals: state.approvals ?? [],
    runs: state.runs ?? [],
    tasks: state.tasks ?? [],
    logs: [],
    metrics: null,
  });
}

function show() {
  render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>,
  );
}

/* La tendance est le seul appel réseau de la page. Par défaut il ne rend rien :
   chaque test qui s'y intéresse fournit sa propre série. */
beforeEach(() => {
  vi.spyOn(api, 'tokensBy').mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('file d’arbitrage', () => {
  it('annonce qu’il n’y a rien à décider quand tout est traité', () => {
    seed({});
    show();
    expect(screen.getByText(/Rien n'attend de décision/)).toBeDefined();
  });

  it('rassemble approbation, échec et carte en revue', () => {
    seed({
      approvals: [
        {
          id: 'apr_1',
          runId: 'run_9',
          agentId: 'agt_1',
          toolName: 'Bash',
          input: {},
          status: 'pending',
          resolvedBy: null,
          note: null,
          requestedAt: new Date().toISOString(),
          resolvedAt: null,
        },
      ],
      runs: [run({})],
      tasks: [
        {
          id: 'tsk_1',
          title: 'Export des liasses',
          column: 'review',
          agentId: 'agt_1',
          updatedAt: new Date().toISOString(),
        } as unknown as KanbanTask,
      ],
    });
    show();

    expect(screen.getByText('Bash')).toBeDefined();
    expect(screen.getByText(/Run en échec/)).toBeDefined();
    expect(screen.getByText('Export des liasses')).toBeDefined();
    // Le compteur est ce qu'on lit en premier : il doit refléter les trois.
    expect(screen.getByText('3')).toBeDefined();
  });

  it('écarte un échec plus vieux que la fenêtre de vingt-quatre heures', () => {
    const oldEnd = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    seed({ runs: [run({ endedAt: oldEnd })] });
    show();
    expect(screen.queryByText(/Run en échec/)).toBeNull();
    expect(screen.getByText(/Rien n'attend de décision/)).toBeDefined();
  });

  it('ignore une approbation déjà résolue', () => {
    seed({
      approvals: [
        {
          id: 'apr_2',
          runId: 'run_9',
          agentId: 'agt_1',
          toolName: 'Write',
          input: {},
          status: 'allowed',
          resolvedBy: 'web',
          note: null,
          requestedAt: new Date().toISOString(),
          resolvedAt: new Date().toISOString(),
        } as unknown as Approval,
      ],
    });
    show();
    expect(screen.queryByText('Write')).toBeNull();
  });

  it('n’affiche dans « en ce moment » que les runs vivants', () => {
    seed({
      runs: [
        run({ id: 'run_a', status: 'running', endedAt: null }),
        run({ id: 'run_b', status: 'succeeded', endedAt: new Date().toISOString() }),
      ],
    });
    show();
    expect(screen.getByText(/Rapprocher les écritures bancaires/)).toBeDefined();
    expect(screen.queryByText('Aucun run en cours.')).toBeNull();
  });
});

describe('bruit technique', () => {
  it('écarte un run clôturé par un redémarrage du serveur', () => {
    seed({ runs: [run({ error: RUN_INTERRUPTED_BY_RESTART })] });
    show();
    /* Ce run n'appelle aucune décision : l'afficher noyait les vrais échecs à
       chaque relance, et c'est ce que l'usage a montré en premier. */
    expect(screen.queryByText(/Run en échec/)).toBeNull();
    expect(screen.getByText(/Rien n'attend de décision/)).toBeDefined();
  });

  it('garde un vrai échec survenu dans la même fenêtre', () => {
    seed({ runs: [run({ error: 'Budget de tokens dépassé' })] });
    show();
    expect(screen.getByText(/Budget de tokens dépassé/)).toBeDefined();
  });
});

describe('chiffres de la journée', () => {
  it('compte les réussites, les échecs et le taux', () => {
    seed({
      runs: [
        run({ id: 'r1', status: 'succeeded', costUsd: 0.2 }),
        run({ id: 'r2', status: 'succeeded', costUsd: 0.1 }),
        run({ id: 'r3', status: 'failed', error: 'Timeout', costUsd: 0.05 }),
      ],
    });
    show();
    expect(screen.getByText('67 % de réussite')).toBeDefined();
    expect(screen.getByText(/1 échoué/)).toBeDefined();
  });

  it("n'impute pas au taux de réussite un run clôturé par un redémarrage", () => {
    seed({
      runs: [
        run({ id: 'r1', status: 'succeeded', costUsd: 0.2 }),
        run({ id: 'r2', status: 'failed', error: RUN_INTERRUPTED_BY_RESTART }),
      ],
    });
    show();
    // Deux runs du jour, un seul réussi, mais aucun échec imputable.
    expect(screen.queryByText(/échoué/)).toBeNull();
  });

  it('reste lisible sans aucun run du jour', () => {
    seed({});
    show();
    // Ni division par zéro, ni « NaN % » : les cases sans donnée le disent.
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('signale un coût qui dépasse la moyenne de la semaine', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    vi.spyOn(api, 'tokensBy').mockResolvedValue([
      {
        bucket: yesterday,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 1,
        runs: 2,
      },
    ]);
    seed({ runs: [run({ id: 'r1', status: 'succeeded', costUsd: 2 })] });
    show();
    await waitFor(() => expect(screen.getByText(/100 % vs moyenne 7 j/)).toBeDefined());
  });

  it("n'empêche pas l'affichage quand la tendance est indisponible", async () => {
    vi.spyOn(api, 'tokensBy').mockRejectedValue(new Error('hors ligne'));
    seed({ runs: [run({ id: 'r1', status: 'succeeded', costUsd: 0.5 })] });
    show();
    await waitFor(() => expect(screen.getByText('100 % de réussite')).toBeDefined());
    expect(screen.queryByText(/vs moyenne/)).toBeNull();
  });
});
