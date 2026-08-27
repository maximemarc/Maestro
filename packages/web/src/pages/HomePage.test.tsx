/**
 * Tests de l'accueil.
 *
 * Ce qui doit tenir : la file d'arbitrage rassemble bien les trois sources, et
 * elle n'inclut pas ce qui n'est plus une demande. Un accueil qui affiche des
 * échecs vieux d'une semaine cesse d'être lu, et un accueil qui oublie une
 * approbation en attente laisse un agent suspendu sans que personne le sache.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentConfig, Approval, KanbanTask, Run } from '@maestro/shared';
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
    endedAt: new Date().toISOString(),
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

afterEach(cleanup);

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
