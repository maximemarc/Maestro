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

/*
 * jsdom n'implémente pas ResizeObserver, dont le graphique se sert pour
 * s'adapter à la largeur disponible. Le manque appartient à l'environnement de
 * test, pas au code : tous les navigateurs visés l'exposent. Sans ce
 * comblement, le montage du graphique fait tomber l'arbre React entier.
 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

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
  vi.spyOn(api, 'runStats').mockResolvedValue({
    total: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    medianDurationMs: null,
  });
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

describe('chiffres de la période', () => {
  it('affiche les chiffres de la semaine, pas ceux du jour', async () => {
    // Cas réel qui a motivé la refonte : rien aujourd'hui, quinze runs sur la
    // semaine. La section doit montrer la semaine, pas des zéros.
    vi.spyOn(api, 'runStats').mockResolvedValue({
      total: 15,
      succeeded: 7,
      failed: 0,
      cancelled: 6,
      medianDurationMs: 719_000,
    });
    vi.spyOn(api, 'tokensBy').mockResolvedValue([
      {
        bucket: '2026-08-25',
        inputTokens: 6000,
        outputTokens: 2000,
        cacheReadTokens: 185427,
        costUsd: 0.2471,
        runs: 7,
      },
      {
        bucket: '2026-08-26',
        inputTokens: 6000,
        outputTokens: 2000,
        cacheReadTokens: 200000,
        costUsd: 0.3,
        runs: 8,
      },
    ]);
    seed({});
    show();

    await waitFor(() => expect(screen.getByText('7 réussis')).toBeDefined());

    /* Le libellé est découpé entre plusieurs nœuds JSX : on interroge le texte
       de la section entière, ce qui résiste aussi à un futur retour à la ligne. */
    const section = screen.getByLabelText('Chiffres de la période').textContent ?? '';
    expect(section).toContain('47 % de réussite');
    expect(section).toContain('6 annulé');
    // Total de la période, et non le chiffre d'un seul jour.
    expect(section).toContain('$0.5471');
    expect(section).toContain('par jour actif');
    expect(section).toContain('97 %');
    expect(section).toContain('11m 59s');
    expect(section).toContain("rien dépensé aujourd'hui");
  });

  it('invite à élargir la fenêtre quand la période est vide', async () => {
    seed({});
    show();
    await waitFor(() => expect(screen.getByText(/Aucun run sur cette période/)).toBeDefined());
    expect(screen.getByText(/Élargis la fenêtre/)).toBeDefined();
  });

  it("n'empêche pas l'affichage de la file quand les chiffres échouent", async () => {
    vi.spyOn(api, 'runStats').mockRejectedValue(new Error('hors ligne'));
    seed({});
    show();
    await waitFor(() => expect(screen.getByText(/Chiffres indisponibles/)).toBeDefined());
    expect(screen.getByText(/Rien n'attend de décision/)).toBeDefined();
  });
});
