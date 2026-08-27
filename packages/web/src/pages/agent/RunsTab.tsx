/**
 * Onglet Runs : historique des exécutions de cet agent.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Lightning } from '@phosphor-icons/react';
import { fmtCost, fmtDateTime, fmtDuration, ORIGIN_LABELS } from '../../lib/format';
import { useStore } from '../../lib/store';
import { EmptyState, StatusBadge } from '../../components/ui';

export function RunsTab({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const runs = useStore((s) => s.runs);
  const agentRuns = useMemo(() => runs.filter((r) => r.agentId === agentId), [runs, agentId]);

  if (agentRuns.length === 0) {
    return (
      <EmptyState
        icon={<Lightning size={28} />}
        title="Aucun run pour cet agent"
        hint="Lancez un run depuis l'en-tête de la fiche."
      />
    );
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Statut</th>
            <th>Origine</th>
            <th>Prompt</th>
            <th className="num">Tours</th>
            <th className="num">Coût</th>
            <th className="num">Durée</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {agentRuns.map((run) => (
            <tr key={run.id} className="clickable" onClick={() => navigate(`/runs/${run.id}`)}>
              <td>
                <StatusBadge status={run.status} />
              </td>
              <td>{ORIGIN_LABELS[run.origin] ?? run.origin}</td>
              <td className="cell-clip">
                <span title={run.prompt}>{run.prompt}</span>
              </td>
              <td className="num">{run.numTurns}</td>
              <td className="num">{fmtCost(run.costUsd)}</td>
              <td className="num">{fmtDuration(run.startedAt, run.endedAt)}</td>
              <td>{fmtDateTime(run.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
