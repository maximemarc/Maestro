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
  ArrowRight,
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
  type RunStats,
  type TokensByBucket,
} from '@maestro/shared';
import { fmtCost, fmtDateTime, fmtDurationMs, fmtTokens } from '../lib/format';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { StackedBarChart, type ChartDatum } from '../components/charts';
import { AgentChip, EmptyState, SkeletonRows, StatusBadge } from '../components/ui';

/** Fenêtre au-delà de laquelle un échec n'est plus « à traiter maintenant ». */
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Périodes proposées.
 *
 * Sept jours par défaut, et non la journée en cours : une instance dont la
 * journée est creuse affichait des zéros et des tirets alors que la semaine
 * contenait quinze runs. Un tableau de bord vide un jour sur deux n'est pas
 * consulté.
 */
const PERIODS = [
  { days: 1, label: '24 h' },
  { days: 7, label: '7 jours' },
  { days: 30, label: '30 jours' },
] as const;
const DEFAULT_DAYS = 7;

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
   * Chiffres de la période, calculés côté serveur.
   *
   * Trois appels, et non un calcul local sur les runs déjà reçus : l'interface
   * n'en garde que les deux cents derniers, ce qui suffit à une journée mais pas
   * à un mois. Un taux de réussite faux est pire qu'absent.
   */
  const [days, setDays] = useState<number>(DEFAULT_DAYS);
  const [stats, setStats] = useState<RunStats | null>(null);
  const [daily, setDaily] = useState<TokensByBucket[] | null>(null);
  const [byAgent, setByAgent] = useState<TokensByBucket[] | null>(null);
  const [statsError, setStatsError] = useState(false);

  useEffect(() => {
    let alive = true;
    setStatsError(false);
    Promise.all([api.runStats(days), api.tokensBy('day', days), api.tokensBy('agent', days)])
      .then(([runStats, perDay, perAgent]) => {
        if (!alive) return;
        setStats(runStats);
        setDaily(perDay);
        setByAgent(perAgent);
      })
      .catch(() => {
        /* Une analytique indisponible ne doit pas priver l'accueil de sa file
           d'arbitrage, qui est sa fonction première. */
        if (alive) setStatsError(true);
      });
    return () => {
      alive = false;
    };
  }, [days]);

  /** Cumuls de la période, dérivés de la série quotidienne. */
  const totals = useMemo(() => {
    const rows = daily ?? [];
    const cost = rows.reduce((sum, d) => sum + d.costUsd, 0);
    const cacheRead = rows.reduce((sum, d) => sum + d.cacheReadTokens, 0);
    const fresh = rows.reduce((sum, d) => sum + d.inputTokens, 0);
    const output = rows.reduce((sum, d) => sum + d.outputTokens, 0);
    return {
      cost,
      output,
      /* Part des jetons servis par le cache : la mesure qui dit si les prompts
         se réutilisent. Un cache bas sur beaucoup de runs signale des contextes
         reconstruits à chaque fois, donc payés plein tarif. */
      cacheShare: cacheRead + fresh > 0 ? cacheRead / (cacheRead + fresh) : null,
      /* Le coût d'un jour moyen situe le coût d'aujourd'hui : un nombre seul ne
         dit pas s'il est normal. */
      /* Moyenne par jour seulement à partir de deux jours actifs : avec un
         seul, elle répéterait le total juste au-dessus. */
      dailyAverage: rows.length > 1 ? cost / rows.length : null,
    };
  }, [daily]);

  /** Coût du jour en cours, pour le situer face au jour moyen de la période. */
  const todayCost = useMemo(() => {
    const key = new Date().toISOString().slice(0, 10);
    return (daily ?? []).find((d) => d.bucket === key)?.costUsd ?? 0;
  }, [daily]);

  const topAgents = useMemo(
    () =>
      [...(byAgent ?? [])]
        .filter((a) => a.costUsd > 0 || a.runs > 0)
        .sort((a, b) => b.costUsd - a.costUsd)
        .slice(0, TOP_AGENTS),
    [byAgent],
  );

  const costChart = useMemo<ChartDatum[]>(
    () =>
      (daily ?? []).map((d) => ({
        xLabel: d.bucket.slice(8, 10) + '/' + d.bucket.slice(5, 7),
        title: `${d.bucket} : ${fmtCost(d.costUsd)} sur ${d.runs} run(s)`,
        values: [d.costUsd],
      })),
    [daily],
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

        <section aria-label="Chiffres de la période" className="card">
          <div className="row justify-between wrap">
            <h3>Activité</h3>
            <div className="row gap-1" role="group" aria-label="Période analysée">
              {PERIODS.map((period) => (
                <button
                  key={period.days}
                  className={`btn sm${days === period.days ? ' primary' : ' ghost'}`}
                  onClick={() => setDays(period.days)}
                  aria-pressed={days === period.days}
                >
                  {period.label}
                </button>
              ))}
            </div>
          </div>

          {statsError ? (
            <p className="text-faint">Chiffres indisponibles pour l'instant.</p>
          ) : stats === null ? (
            <SkeletonRows rows={3} />
          ) : stats.total === 0 ? (
            <p className="text-faint">
              Aucun run sur cette période.
              {days < 30 && " Élargis la fenêtre pour voir l'activité plus ancienne."}
            </p>
          ) : (
            <>
              <dl className="home-stats">
                <div>
                  <dt>Coût de la période</dt>
                  <dd className="num">{fmtCost(totals.cost)}</dd>
                  {totals.dailyAverage !== null && (
                    <dd className="home-delta">{fmtCost(totals.dailyAverage)} par jour actif</dd>
                  )}
                </div>

                <div>
                  <dt>Runs</dt>
                  <dd className="num">
                    {stats.succeeded} réussi{stats.succeeded > 1 ? 's' : ''}
                    {stats.failed > 0 && (
                      <span className="home-fail"> / {stats.failed} échoué(s)</span>
                    )}
                  </dd>
                  <dd className="home-delta">
                    {Math.round((stats.succeeded / stats.total) * 100)} % de réussite sur{' '}
                    {stats.total}
                    {stats.cancelled > 0 ? `, ${stats.cancelled} annulé(s)` : ''}
                  </dd>
                </div>

                <div>
                  <dt>Servi par le cache</dt>
                  <dd className="num">
                    {totals.cacheShare === null ? '—' : `${Math.round(totals.cacheShare * 100)} %`}
                  </dd>
                  <dd className="home-delta">{fmtTokens(totals.output)} jetons produits</dd>
                </div>

                <div>
                  <dt>Durée médiane</dt>
                  <dd className="num">
                    {stats.medianDurationMs === null ? '—' : fmtDurationMs(stats.medianDurationMs)}
                  </dd>
                  <dd className="home-delta">
                    {todayCost > 0
                      ? `${fmtCost(todayCost)} dépensés aujourd'hui`
                      : "rien dépensé aujourd'hui"}
                  </dd>
                </div>
              </dl>

              {topAgents.length > 0 && (
                <>
                  <h4 className="home-subhead">Où part le budget</h4>
                  <ul className="home-list">
                    {topAgents.map((entry) => (
                      <li key={entry.bucket} className="row gap-2 wrap">
                        <AgentChip agent={agentById.get(entry.bucket)} />
                        <span className="grow text-xs text-faint num">{entry.runs} run(s)</span>
                        <span className="num">{fmtCost(entry.costUsd)}</span>
                        {totals.cost > 0 && (
                          <span className="text-xs text-faint num">
                            {Math.round((entry.costUsd / totals.cost) * 100)} %
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {costChart.length > 1 && (
                <>
                  <h4 className="home-subhead">Coût par jour</h4>
                  <StackedBarChart
                    data={costChart}
                    series={[{ name: 'Coût', color: 'var(--accent)' }]}
                    formatTick={(v) => fmtCost(v)}
                    height={140}
                  />
                </>
              )}
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
