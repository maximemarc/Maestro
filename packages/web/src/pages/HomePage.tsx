/**
 * Accueil : ce qui attend une décision, ce qui tourne, ce que ça coûte.
 *
 * L'accueil était Mission Control, c'est-à-dire un graphe. Un graphe montre une
 * topologie ; il ne répond pas à la question qu'on se pose en ouvrant Maestro,
 * qui est « qu'est-ce qui m'attend ». L'attention humaine était par ailleurs
 * éparpillée sur quatre pages — approbations, runs en échec, cartes en revue,
 * plus les notifications Telegram — sans qu'aucune ne dise ce qui reste à faire.
 *
 * Cette page rassemble donc les demandes en attente, puis l'état courant, puis
 * les chiffres du jour. Rien n'y est recalculé côté serveur : tout est dérivé du
 * flux WebSocket déjà reçu, donc la page suit l'état en direct sans une requête
 * de plus.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CheckCircle,
  ClipboardText,
  Lightning,
  ShieldCheck,
  Warning,
} from '@phosphor-icons/react';
import {
  RUN_INTERRUPTED_BY_RESTART,
  type Approval,
  type KanbanTask,
  type Run,
  type TokensByBucket,
} from '@maestro/shared';
import { fmtCost, fmtDateTime, fmtDurationMs, fmtTokens } from '../lib/format';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { StackedBarChart, type ChartDatum } from '../components/charts';
import { AgentChip, EmptyState, StatusBadge } from '../components/ui';

/** Fenêtre au-delà de laquelle un échec n'est plus « à traiter maintenant ». */
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Profondeur de la frise : une semaine suffit à voir une dérive de coût. */
const TREND_DAYS = 7;

/** Écart relatif en dessous duquel une variation de coût n'est pas signalée. */
const TREND_NOISE = 0.1;

/** Nombre d'agents cités dans la répartition du budget. */
const TOP_AGENTS = 3;

type Pending =
  | { kind: 'approval'; id: string; approval: Approval }
  | { kind: 'failure'; id: string; run: Run }
  | { kind: 'review'; id: string; task: KanbanTask };

export default function HomePage() {
  const metrics = useStore((s) => s.metrics);
  const agents = useStore((s) => s.agents);
  const runs = useStore((s) => s.runs);
  const tasks = useStore((s) => s.tasks);
  const approvals = useStore((s) => s.approvals);
  const logs = useStore((s) => s.logs);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  /*
   * File d'arbitrage.
   *
   * Trois sources, un seul ordre de lecture : d'abord ce qui bloque un agent
   * (une approbation suspend un run en cours), puis ce qui a échoué, puis ce qui
   * attend une relecture. Un échec vieux de trois jours n'est plus une demande,
   * c'est de l'historique : la fenêtre de 24 h évite que la file devienne un
   * cimetière qu'on cesse de lire.
   */
  const pending = useMemo<Pending[]>(() => {
    const now = Date.now();
    const waiting = approvals
      .filter((a) => a.status === 'pending')
      .map((approval): Pending => ({ kind: 'approval', id: approval.id, approval }));

    const failed = runs
      .filter(
        (r) =>
          r.status === 'failed' &&
          r.endedAt &&
          now - Date.parse(r.endedAt) < FAILURE_WINDOW_MS &&
          /* Un run clôturé par un redémarrage n'a pas échoué au sens utile : il
             n'y a rien à décider ni à corriger, et l'afficher noyait les vrais
             échecs à chaque relance du serveur. */
          r.error !== RUN_INTERRUPTED_BY_RESTART,
      )
      .map((run): Pending => ({ kind: 'failure', id: run.id, run }));

    const review = tasks
      .filter((t) => t.column === 'review')
      .map((task): Pending => ({ kind: 'review', id: task.id, task }));

    return [...waiting, ...failed, ...review];
  }, [approvals, runs, tasks]);

  /*
   * Tendance des sept derniers jours.
   *
   * Seul appel réseau de la page, et il se justifie : le flux temps réel porte
   * l'état courant, jamais l'historique. Sans cette série, un coût du jour est
   * un nombre sans échelle — on ne sait pas s'il est normal ou s'il dérape.
   */
  const [trend, setTrend] = useState<TokensByBucket[] | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .tokensBy('day', TREND_DAYS)
      .then((rows) => {
        if (alive) setTrend(rows);
      })
      .catch(() => {
        // Une tendance indisponible ne doit pas priver l'accueil du reste.
        if (alive) setTrend([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  /*
   * Runs de la journée, au sens du fuseau local.
   *
   * Calculés sur les runs déjà reçus plutôt que par un appel dédié : le store
   * porte les deux cents derniers, ce qui couvre une journée dans tout usage
   * réaliste, et l'accueil suit alors le direct sans requête supplémentaire.
   */
  const today = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const startMs = start.getTime();
    const ofDay = runs.filter((r) => Date.parse(r.createdAt) >= startMs);

    const succeeded = ofDay.filter((r) => r.status === 'succeeded');
    /* Les runs clôturés par un redémarrage ne comptent pas comme des échecs :
       ils fausseraient un taux de réussite qui sert à juger les agents. */
    const failed = ofDay.filter(
      (r) => r.status === 'failed' && r.error !== RUN_INTERRUPTED_BY_RESTART,
    );

    const durations = ofDay
      .filter((r) => r.startedAt && r.endedAt)
      .map((r) => Date.parse(r.endedAt as string) - Date.parse(r.startedAt as string))
      .sort((a, b) => a - b);
    /* Médiane et non moyenne : un seul run d'une heure suffit à rendre une
       moyenne mensongère sur une dizaine de runs. */
    const median = durations.length ? (durations[Math.floor(durations.length / 2)] ?? 0) : null;

    const cost = ofDay.reduce((sum, r) => sum + r.costUsd, 0);
    const cacheRead = ofDay.reduce((sum, r) => sum + r.cacheReadTokens, 0);
    const fresh = ofDay.reduce((sum, r) => sum + r.inputTokens, 0);

    const byAgent = new Map<string, { cost: number; runs: number }>();
    for (const r of ofDay) {
      const entry = byAgent.get(r.agentId) ?? { cost: 0, runs: 0 };
      entry.cost += r.costUsd;
      entry.runs += 1;
      byAgent.set(r.agentId, entry);
    }
    const topAgents = [...byAgent.entries()]
      .map(([agentId, v]) => ({ agentId, ...v }))
      .sort((a, b) => b.cost - a.cost)
      .slice(0, TOP_AGENTS);

    return {
      total: ofDay.length,
      succeeded: succeeded.length,
      failed: failed.length,
      median,
      cost,
      /* Part des jetons servis par le cache. C'est la mesure qui dit si les
         prompts se réutilisent : un cache bas sur beaucoup de runs signale des
         contextes reconstruits à chaque fois, donc payés plein tarif. */
      cacheShare: cacheRead + fresh > 0 ? cacheRead / (cacheRead + fresh) : null,
      topAgents,
    };
  }, [runs]);

  /*
   * Écart du coût du jour à la moyenne des jours précédents.
   *
   * Le jour courant est exclu de la moyenne, sans quoi il se comparerait en
   * partie à lui-même et tout écart serait amorti.
   */
  const costTrend = useMemo(() => {
    if (!trend || trend.length === 0) return null;
    const todayKey = new Date().toISOString().slice(0, 10);
    const previous = trend.filter((d) => d.bucket !== todayKey);
    if (previous.length === 0) return null;
    const average = previous.reduce((sum, d) => sum + d.costUsd, 0) / previous.length;
    if (average <= 0) return null;
    return { average, ratio: today.cost / average - 1 };
  }, [today.cost, trend]);

  const costChart = useMemo<ChartDatum[]>(
    () =>
      (trend ?? []).map((d) => ({
        xLabel: d.bucket.slice(8, 10) + '/' + d.bucket.slice(5, 7),
        title: `${d.bucket} : ${fmtCost(d.costUsd)} sur ${d.runs} run(s)`,
        values: [d.costUsd],
      })),
    [trend],
  );

  const activeRuns = useMemo(
    () => runs.filter((r) => r.status === 'running' || r.status === 'waiting_approval'),
    [runs],
  );

  return (
    <div className="page">
      <div className="page-header">
        <h1>Accueil</h1>
        <span className="spacer" />
        <Link className="btn" to="/mission-control">
          Mission Control
          <ArrowRight />
        </Link>
      </div>
      <p className="page-lede">
        Ce qui attend une décision, ce qui tourne en ce moment, ce que la journée a coûté.
      </p>

      <section aria-label="Demandes en attente">
        <div className="row justify-between wrap">
          <h3>À toi de jouer</h3>
          {pending.length > 0 && <span className="badge warn num">{pending.length}</span>}
        </div>

        {pending.length === 0 ? (
          <EmptyState
            icon={<CheckCircle size={28} />}
            title="Rien n'attend de décision"
            hint="Les approbations, les runs en échec et les cartes en revue apparaissent ici."
            compact
          />
        ) : (
          <ul className="home-queue">
            {pending.map((item) => {
              if (item.kind === 'approval') {
                return (
                  <li key={item.id} className="home-queue-item">
                    <ShieldCheck className="home-queue-icon warn" />
                    <span className="grow">
                      <strong>{item.approval.toolName}</strong> attend une autorisation
                    </span>
                    <AgentChip agent={agentById.get(item.approval.agentId)} />
                    <span className="text-xs text-faint">
                      {fmtDateTime(item.approval.requestedAt)}
                    </span>
                    <Link className="btn sm" to="/approvals">
                      Arbitrer
                    </Link>
                  </li>
                );
              }
              if (item.kind === 'failure') {
                const firstLine = item.run.error?.split('\n')[0]?.slice(0, 80);
                return (
                  <li key={item.id} className="home-queue-item">
                    <Warning className="home-queue-icon danger" />
                    <span className="grow ellipsis">
                      Run en échec{firstLine ? ` : ${firstLine}` : ''}
                    </span>
                    <AgentChip agent={agentById.get(item.run.agentId)} />
                    <span className="text-xs text-faint">{fmtDateTime(item.run.endedAt)}</span>
                    <Link className="btn sm" to={`/runs/${item.run.id}`}>
                      Ouvrir
                    </Link>
                  </li>
                );
              }
              const agent = item.task.agentId ? agentById.get(item.task.agentId) : null;
              return (
                <li key={item.id} className="home-queue-item">
                  <ClipboardText className="home-queue-icon" />
                  <span className="grow ellipsis">
                    <strong>{item.task.title}</strong> attend une relecture
                  </span>
                  {agent && <AgentChip agent={agent} />}
                  <span className="text-xs text-faint">{fmtDateTime(item.task.updatedAt)}</span>
                  <Link className="btn sm" to="/kanban">
                    Voir la carte
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="grid cols-2 mt-4">
        <section aria-label="Runs en cours" className="card">
          <div className="row justify-between wrap">
            <h3>En ce moment</h3>
            <span className="text-xs text-faint num">
              {metrics?.activeRuns ?? 0} actif(s), {metrics?.queuedRuns ?? 0} en file
            </span>
          </div>
          {activeRuns.length === 0 ? (
            <p className="text-faint">Aucun run en cours.</p>
          ) : (
            <ul className="home-list">
              {activeRuns.slice(0, 6).map((run) => (
                <li key={run.id} className="row gap-2 wrap">
                  <AgentChip agent={agentById.get(run.agentId)} />
                  <Link className="grow ellipsis" to={`/runs/${run.id}`}>
                    {run.prompt.split('\n')[0]?.slice(0, 70) || run.id}
                  </Link>
                  <StatusBadge status={run.status} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Chiffres de la journée" className="card">
          <div className="row justify-between wrap">
            <h3>Aujourd'hui</h3>
            {today.total > 0 && (
              <span className="text-xs text-faint num">{today.total} run(s)</span>
            )}
          </div>

          <dl className="home-stats">
            <div>
              <dt>Coût</dt>
              <dd className="num">{fmtCost(today.cost)}</dd>
              {costTrend && Math.abs(costTrend.ratio) >= TREND_NOISE ? (
                /* L'écart n'est affiché qu'au-delà du bruit : signaler « +3 % »
                   chaque jour apprendrait à ignorer l'indicateur. */
                <dd className={`home-delta${costTrend.ratio > 0 ? ' up' : ' down'}`}>
                  {costTrend.ratio > 0 ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                  {Math.abs(Math.round(costTrend.ratio * 100))} % vs moyenne 7 j
                </dd>
              ) : (
                costTrend && <dd className="home-delta">dans la moyenne 7 j</dd>
              )}
            </div>

            <div>
              <dt>Runs réussis</dt>
              <dd className="num">
                {today.succeeded}
                {today.failed > 0 && <span className="home-fail"> / {today.failed} échoué(s)</span>}
              </dd>
              {today.total > 0 && (
                <dd className="home-delta">
                  {Math.round((today.succeeded / today.total) * 100)} % de réussite
                </dd>
              )}
            </div>

            <div>
              <dt>Servi par le cache</dt>
              <dd className="num">
                {today.cacheShare === null ? '—' : `${Math.round(today.cacheShare * 100)} %`}
              </dd>
              <dd className="home-delta">
                {fmtTokens(metrics?.todayInputTokens ?? 0)} entrants,{' '}
                {fmtTokens(metrics?.todayOutputTokens ?? 0)} sortants
              </dd>
            </div>

            <div>
              <dt>Durée médiane</dt>
              <dd className="num">{today.median === null ? '—' : fmtDurationMs(today.median)}</dd>
              <dd className="home-delta">sur {today.total} run(s) du jour</dd>
            </div>
          </dl>

          {today.topAgents.length > 0 && today.cost > 0 && (
            <>
              <h4 className="home-subhead">Où part le budget</h4>
              <ul className="home-list">
                {today.topAgents.map((entry) => (
                  <li key={entry.agentId} className="row gap-2 wrap">
                    <AgentChip agent={agentById.get(entry.agentId)} />
                    <span className="grow text-xs text-faint num">{entry.runs} run(s)</span>
                    <span className="num">{fmtCost(entry.cost)}</span>
                    <span className="text-xs text-faint num">
                      {Math.round((entry.cost / today.cost) * 100)} %
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {costChart.length > 1 && (
            <>
              <h4 className="home-subhead">Coût des {TREND_DAYS} derniers jours</h4>
              <StackedBarChart
                data={costChart}
                series={[{ name: 'Coût', color: 'var(--accent)' }]}
                formatTick={(v) => fmtCost(v)}
                height={140}
              />
            </>
          )}

          <Link className="btn sm ghost" to="/analytics">
            Détail par agent et par modèle
            <ArrowRight />
          </Link>
        </section>
      </div>

      <section aria-label="Activité récente" className="mt-4">
        <div className="row justify-between wrap">
          <h3>Activité récente</h3>
          <Link className="btn sm ghost" to="/mission-control">
            <Lightning />
            Journal complet
          </Link>
        </div>
        {logs.length === 0 ? (
          <p className="text-faint">Aucun événement pour l'instant.</p>
        ) : (
          <ul className="home-list">
            {logs.slice(0, 8).map((line) => (
              <li key={line.id} className="row gap-2 wrap">
                <span
                  className={`badge${line.level === 'error' ? ' danger' : line.level === 'warn' ? ' warn' : ''}`}
                >
                  {line.source}
                </span>
                <span className="grow ellipsis">{line.message}</span>
                <span className="text-xs text-faint">{fmtDateTime(line.ts)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
