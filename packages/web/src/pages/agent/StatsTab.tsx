/**
 * Onglet Statistiques : volumes, réussite, coûts.
 */
import { useEffect, useState } from 'react';
import { ChartLine } from '@phosphor-icons/react';
import type { AgentStats } from '@maestro/shared';
import { api } from '../../lib/api';
import { fmtCost, fmtDateTime, fmtTokens } from '../../lib/format';
import { EmptyState, LoadingBlock } from '../../components/ui';
import { TabError, errorMessage } from './shared';

export function StatsTab({ agentId }: { agentId: string }) {
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .agentStats()
      .then((all) => {
        if (cancelled) return;
        setStats(all.find((s) => s.agentId === agentId) ?? null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  if (loading) {
    return (
      <div className="card">
        <LoadingBlock label="Chargement des statistiques…" rows={4} />
      </div>
    );
  }
  if (error) return <TabError message={error} />;
  if (!stats || stats.totalRuns === 0) {
    return (
      <EmptyState
        icon={<ChartLine size={28} />}
        title="Aucune statistique"
        hint="Cet agent n'a encore exécuté aucun run."
      />
    );
  }

  const successRate =
    stats.totalRuns > 0 ? Math.round((stats.succeeded / stats.totalRuns) * 100) : 0;
  const avgSec = Math.round(stats.avgDurationMs / 1000);
  const avgLabel = avgSec < 60 ? `${avgSec}s` : `${Math.floor(avgSec / 60)}m ${avgSec % 60}s`;

  return (
    <div className="col">
      <div className="grid cols-4">
        <div className="card">
          <h3>Runs totaux</h3>
          <div className="metric">{stats.totalRuns}</div>
          <div className="text-faint text-sm">
            {stats.succeeded} réussis · {stats.failed} échoués
          </div>
        </div>
        <div className="card">
          <h3>Taux de réussite</h3>
          <div className={`metric ${successRate >= 80 ? 'text-ok' : 'text-warn'}`}>
            {successRate}%
          </div>
        </div>
        <div className="card">
          <h3>Tokens</h3>
          <div className="metric">{fmtTokens(stats.inputTokens + stats.outputTokens)}</div>
          <div className="text-faint text-sm">
            {fmtTokens(stats.inputTokens)} entrée · {fmtTokens(stats.outputTokens)} sortie
          </div>
        </div>
        <div className="card">
          <h3>Coût total</h3>
          <div className="metric">{fmtCost(stats.costUsd)}</div>
        </div>
      </div>
      <div className="card">
        <dl className="kv">
          <dt>Durée moyenne</dt>
          <dd>{avgLabel}</dd>
          <dt>Dernier run</dt>
          <dd>{fmtDateTime(stats.lastRunAt)}</dd>
        </dl>
      </div>
    </div>
  );
}
