/**
 * Analytique — tokens & coûts par jour, par agent, par modèle, et
 * performance des agents. Données chargées via l'API (hors store temps réel).
 */
import { useEffect, useMemo, useState } from 'react';
import type { AgentStats, TokensByBucket } from '@maestro/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { fmtCost, fmtDateTime, fmtTokens } from '../lib/format';
import { ArrowsClockwise, ChartLine } from '@phosphor-icons/react';
import { AgentChip, EmptyState, Spinner } from '../components/ui';
import { StackedBarChart, type ChartDatum } from '../components/charts';

const PERIODS = [7, 30, 90] as const;

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="metric">{value}</div>
      <div className="text-muted text-sm">{label}</div>
    </div>
  );
}

/** « YYYY-MM-DD » → « jj/mm ». */
function dayLabel(bucket: string): string {
  return `${bucket.slice(8, 10)}/${bucket.slice(5, 7)}`;
}

function fmtInt(n: number): string {
  return n.toLocaleString('fr-FR');
}

export default function AnalyticsPage() {
  const agents = useStore((s) => s.agents);

  const [days, setDays] = useState<number>(30);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [byDay, setByDay] = useState<TokensByBucket[]>([]);
  const [byAgent, setByAgent] = useState<TokensByBucket[]>([]);
  const [byModel, setByModel] = useState<TokensByBucket[]>([]);
  const [stats, setStats] = useState<AgentStats[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      api.tokensBy('day', days),
      api.tokensBy('agent', days),
      api.tokensBy('model', days),
      api.agentStats(),
    ])
      .then(([day, agent, model, agentStats]) => {
        if (cancelled) return;
        setByDay(day);
        setByAgent(agent);
        setByModel(model);
        setStats(agentStats);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Erreur de chargement');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, refreshKey]);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const totals = useMemo(
    () =>
      byDay.reduce(
        (acc, b) => ({
          input: acc.input + b.inputTokens,
          output: acc.output + b.outputTokens,
          cost: acc.cost + b.costUsd,
          runs: acc.runs + b.runs,
        }),
        { input: 0, output: 0, cost: 0, runs: 0 },
      ),
    [byDay],
  );

  /** Série continue sur la période (jours sans activité = zéro, pas de barre). */
  const dayRange = useMemo(() => {
    const map = new Map(byDay.map((b) => [b.bucket, b]));
    const out: { bucket: string; input: number; output: number; cost: number }[] = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}`;
      const b = map.get(key);
      out.push({
        bucket: key,
        input: b?.inputTokens ?? 0,
        output: b?.outputTokens ?? 0,
        cost: b?.costUsd ?? 0,
      });
    }
    return out;
  }, [byDay, days]);

  const tokensChart = useMemo<ChartDatum[]>(
    () =>
      dayRange.map((d) => ({
        xLabel: dayLabel(d.bucket),
        title: `${dayLabel(d.bucket)} · Entrée : ${fmtInt(d.input)} · Sortie : ${fmtInt(d.output)}`,
        values: [d.input, d.output],
      })),
    [dayRange],
  );

  const costChart = useMemo<ChartDatum[]>(
    () =>
      dayRange.map((d) => ({
        xLabel: dayLabel(d.bucket),
        title: `${dayLabel(d.bucket)} · Coût : ${fmtCost(d.cost)}`,
        values: [d.cost],
      })),
    [dayRange],
  );

  const agentRows = useMemo(() => byAgent.slice().sort((a, b) => b.costUsd - a.costUsd), [byAgent]);
  const modelRows = useMemo(() => byModel.slice().sort((a, b) => b.costUsd - a.costUsd), [byModel]);
  const statRows = useMemo(() => stats.slice().sort((a, b) => b.costUsd - a.costUsd), [stats]);

  const hasPeriodData = totals.runs > 0 || totals.input > 0 || totals.output > 0 || totals.cost > 0;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Analytique</h1>
        <div className="row gap-1">
          {PERIODS.map((p) => (
            <button
              key={p}
              className={`btn sm${days === p ? ' primary' : ' ghost'}`}
              onClick={() => setDays(p)}
            >
              {p} jours
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setRefreshKey((k) => k + 1)} disabled={loading}>
          {loading ? <Spinner /> : <ArrowsClockwise />}
          Actualiser
        </button>
      </div>

      {error && (
        <div className="error-box mb-4" role="alert">
          Erreur de chargement : {error}
        </div>
      )}

      <div className="grid cols-4 mb-4">
        <StatCard label={`Tokens entrée (${days} j)`} value={fmtTokens(totals.input)} />
        <StatCard label={`Tokens sortie (${days} j)`} value={fmtTokens(totals.output)} />
        <StatCard label={`Coût total (${days} j)`} value={fmtCost(totals.cost)} />
        <StatCard label={`Runs (${days} j)`} value={fmtInt(totals.runs)} />
      </div>

      {!hasPeriodData && !loading && !error ? (
        <EmptyState
          icon={<ChartLine size={28} />}
          title="Aucune donnée sur la période"
          hint="Lancez des runs pour voir apparaître les tokens et les coûts ici."
        />
      ) : (
        <>
          <div className="card mb-4">
            <h2>Tokens par jour</h2>
            <StackedBarChart
              data={tokensChart}
              series={[
                { name: 'Entrée', color: 'var(--accent)' },
                { name: 'Sortie', color: 'var(--violet)' },
              ]}
              formatTick={fmtTokens}
            />
          </div>

          <div className="card mb-4">
            <h2>Coût par jour</h2>
            <StackedBarChart
              data={costChart}
              series={[{ name: 'Coût ($)', color: 'var(--ok)' }]}
              formatTick={fmtCost}
            />
          </div>

          <div className="grid cols-2 mb-4">
            <div className="card">
              <h2>Par agent</h2>
              {agentRows.length === 0 ? (
                <div className="text-faint">Aucune activité d'agent sur la période.</div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th className="num">Entrée</th>
                      <th className="num">Sortie</th>
                      <th className="num">Coût</th>
                      <th className="num">Runs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agentRows.map((r) => (
                      <tr key={r.bucket}>
                        <td>
                          <AgentChip agent={agentById.get(r.bucket)} />
                        </td>
                        <td className="num">{fmtTokens(r.inputTokens)}</td>
                        <td className="num">{fmtTokens(r.outputTokens)}</td>
                        <td className="num">{fmtCost(r.costUsd)}</td>
                        <td className="num">{r.runs}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card">
              <h2>Par modèle</h2>
              {modelRows.length === 0 ? (
                <div className="text-faint">Aucun modèle utilisé sur la période.</div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Modèle</th>
                      <th className="num">Entrée</th>
                      <th className="num">Sortie</th>
                      <th className="num">Coût</th>
                      <th className="num">Runs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelRows.map((r) => (
                      <tr key={r.bucket}>
                        <td className="mono">{r.bucket}</td>
                        <td className="num">{fmtTokens(r.inputTokens)}</td>
                        <td className="num">{fmtTokens(r.outputTokens)}</td>
                        <td className="num">{fmtCost(r.costUsd)}</td>
                        <td className="num">{r.runs}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}

      <div className="card">
        <h2>Performance des agents</h2>
        {statRows.length === 0 ? (
          <div className="text-faint">Aucune statistique disponible.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th className="num">Runs</th>
                <th className="num">Réussite</th>
                <th className="num">Tokens</th>
                <th className="num">Coût</th>
                <th className="num">Durée moy.</th>
                <th>Dernier run</th>
              </tr>
            </thead>
            <tbody>
              {statRows.map((s) => {
                const pct = s.totalRuns > 0 ? Math.round((s.succeeded / s.totalRuns) * 100) : null;
                return (
                  <tr key={s.agentId}>
                    <td>
                      <AgentChip agent={agentById.get(s.agentId)} />
                    </td>
                    <td className="num">{s.totalRuns}</td>
                    <td className="num">
                      {pct === null ? (
                        <span className="text-faint">-</span>
                      ) : (
                        <span className={`badge ${pct >= 80 ? 'ok' : 'warn'}`}>{pct} %</span>
                      )}
                    </td>
                    <td className="num">{fmtTokens(s.inputTokens + s.outputTokens)}</td>
                    <td className="num">{fmtCost(s.costUsd)}</td>
                    <td className="num">{(s.avgDurationMs / 1000).toFixed(1)} s</td>
                    <td>{fmtDateTime(s.lastRunAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
