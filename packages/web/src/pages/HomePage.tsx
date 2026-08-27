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
import { useMemo } from 'react';
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
} from '@maestro/shared';
import { fmtCost, fmtDateTime, fmtTokens } from '../lib/format';
import { useStore } from '../lib/store';
import { AgentChip, EmptyState, StatusBadge } from '../components/ui';

/** Fenêtre au-delà de laquelle un échec n'est plus « à traiter maintenant ». */
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

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

        <section aria-label="Consommation du jour" className="card">
          <h3>Aujourd'hui</h3>
          <dl className="home-stats">
            <div>
              <dt>Coût</dt>
              <dd className="num">{fmtCost(metrics?.todayCostUsd ?? 0)}</dd>
            </div>
            <div>
              <dt>Tokens entrants</dt>
              <dd className="num">{fmtTokens(metrics?.todayInputTokens ?? 0)}</dd>
            </div>
            <div>
              <dt>Tokens sortants</dt>
              <dd className="num">{fmtTokens(metrics?.todayOutputTokens ?? 0)}</dd>
            </div>
            <div>
              <dt>Agents</dt>
              <dd className="num">{agents.length}</dd>
            </div>
          </dl>
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
