/**
 * Page Radar — sessions d'agents de code détectées sur la machine, qu'elles
 * soient pilotées par Maestro ou lancées à la main dans un terminal.
 *
 * Le snapshot arrive en direct par WebSocket (`radar.update`, toutes les 10 s) :
 * la page ne fait donc aucun polling. Le chargement manuel ne sert qu'au premier
 * rendu, quand le store n'a encore rien reçu.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowsClockwise, Radio } from '@phosphor-icons/react';
import type {
  AgentToolKind,
  DetectedSession,
  DetectionSource,
  RadarSnapshot,
  SessionFreshness,
} from '@maestro/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { fmtDateTime, fmtDuration, fmtUptime } from '../lib/format';
import { EmptyState, ErrorText, Spinner } from '../components/ui';
import RadarScope, { TOOL_COLORS } from '../components/radar/RadarScope';

const FRESHNESS_LABELS: Record<SessionFreshness, string> = {
  active: 'active',
  idle: 'en veille',
  stale: 'inactive',
};

/* Réutilise les pastilles existantes du thème plutôt que d'ajouter du CSS :
   accent pulsant pour l'activité, ambre pour la veille, gris pour l'inactif. */
const FRESHNESS_DOT: Record<SessionFreshness, string> = {
  active: 'running',
  idle: 'queued',
  stale: 'cancelled',
};

const SOURCE_LABELS: Record<DetectionSource, string> = {
  transcript: 'transcript',
  process: 'processus',
  tmux: 'tmux',
};

const TOOL_LABELS: Record<AgentToolKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  aider: 'Aider',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  goose: 'Goose',
  other: 'Autre',
};

/** Longueur d'affichage d'un identifiant de session : au-delà, c'est du bruit. */
const SESSION_ID_CHARS = 18;

type FreshnessFilter = 'all' | 'active';

function ellipsis(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Nom lisible d'une session. Pour une session pilotée, `project` ne vaut que le
 * nom technique du répertoire de workspace : l'agent est plus parlant.
 */
function sessionTitle(session: DetectedSession): string {
  if (session.managed) return `${session.managed.agentEmoji} ${session.managed.agentName}`;
  return session.project ?? '-';
}

function ToolBadge({ tool, label }: { tool: AgentToolKind; label: string }) {
  return (
    <span className="badge" style={{ borderColor: TOOL_COLORS[tool], color: TOOL_COLORS[tool] }}>
      {label}
    </span>
  );
}

function Freshness({ freshness }: { freshness: SessionFreshness }) {
  return (
    <span className="row gap-2">
      <span className={`status-dot ${FRESHNESS_DOT[freshness]}`} />
      {FRESHNESS_LABELS[freshness]}
    </span>
  );
}

export default function RadarPage() {
  const storeRadar = useStore((s) => s.radar);
  /* Snapshot chargé (ou balayé) par la page. Le store n'expose pas de setter :
     on garde donc le résultat en local et on affiche le plus récent des deux. */
  const [localRadar, setLocalRadar] = useState<RadarSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FreshnessFilter>('all');
  const [sweeping, setSweeping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const radar = useMemo<RadarSnapshot | null>(() => {
    if (!storeRadar) return localRadar;
    if (!localRadar) return storeRadar;
    return localRadar.scannedAt > storeRadar.scannedAt ? localRadar : storeRadar;
  }, [storeRadar, localRadar]);

  useEffect(() => {
    /* Une seule fois au montage, et seulement si le WebSocket n'a rien poussé :
       les snapshots suivants viendront de lui. Aucune dépendance, donc aucune boucle. */
    if (useStore.getState().radar) return;
    let cancelled = false;
    api
      .getRadar()
      .then((snapshot) => {
        if (!cancelled) setLocalRadar(snapshot);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Radar indisponible.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sessions = radar?.sessions ?? [];
  const activeCount = sessions.reduce((n, s) => (s.freshness === 'active' ? n + 1 : n), 0);
  /* Le serveur trie déjà par fraîcheur : on se contente de filtrer. */
  const visible = filter === 'active' ? sessions.filter((s) => s.freshness === 'active') : sessions;
  const selected = visible.find((s) => s.id === selectedId) ?? null;
  const installed = radar?.toolsInstalled ?? [];

  const handleSweep = async () => {
    setSweeping(true);
    setError(null);
    try {
      setLocalRadar(await api.sweepRadar());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Balayage impossible.');
    } finally {
      setSweeping(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Radar</h1>
        <span className="badge accent">
          {activeCount} session{activeCount > 1 ? 's' : ''} active{activeCount > 1 ? 's' : ''}
        </span>
        <span className="badge">
          {sessions.length} détectée{sessions.length > 1 ? 's' : ''}
        </span>
        <span className="spacer" />
        <span className="text-muted text-sm">
          Dernier balayage {fmtDateTime(radar?.scannedAt)} · {radar?.scanDurationMs ?? 0} ms
        </span>
        <button className="btn" onClick={handleSweep} disabled={sweeping}>
          {sweeping ? <Spinner /> : <ArrowsClockwise />}
          Balayer maintenant
        </button>
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      <div className="tabs">
        <button
          className={`tab${filter === 'all' ? ' active' : ''}`}
          onClick={() => setFilter('all')}
        >
          Toutes ({sessions.length})
        </button>
        <button
          className={`tab${filter === 'active' ? ' active' : ''}`}
          onClick={() => setFilter('active')}
        >
          Actives ({activeCount})
        </button>
      </div>

      {radar === null ? (
        <EmptyState
          icon={<Radio size={28} />}
          title="Balayage en cours…"
          hint="Le premier snapshot arrive."
        />
      ) : (
        <div className="radar-layout">
          {/* Scope : carré, il occupe la place restante. */}
          <div className="card radar-scope">
            <RadarScope sessions={visible} selectedId={selectedId} onSelect={setSelectedId} />
          </div>

          <div className="col panel-side-wide gap-4">
            {selected ? (
              <SessionDetail session={selected} onBack={() => setSelectedId(null)} />
            ) : (
              <SessionList sessions={visible} onSelect={setSelectedId} />
            )}

            <div className="card text-faint text-xs">
              La détection croise les transcripts de session laissés sur le disque et la liste des
              processus (plus tmux quand il est disponible). Seules des métadonnées sont lues :
              chemin de travail, branche git, version, horodatage.{' '}
              <b className="text-muted">Jamais le contenu des messages</b>.
              <div className="mt-2">
                Outils surveillés : Claude Code, Codex, Gemini, Aider, Cursor, OpenCode, Goose.
              </div>
              <div className="mt-2">
                Détectés sur cette machine :{' '}
                {installed.length === 0
                  ? 'aucun binaire trouvé.'
                  : `${installed.map((tool) => TOOL_LABELS[tool]).join(', ')}.`}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Liste des sessions
 * ------------------------------------------------------------------------ */

function SessionList(props: { sessions: DetectedSession[]; onSelect: (id: string) => void }) {
  if (props.sessions.length === 0) {
    return (
      <div className="card">
        <EmptyState
          icon={<Radio size={28} />}
          title="Aucune session détectée"
          hint="Lance un agent, ou ouvre un outil de code dans un terminal."
        />
      </div>
    );
  }

  return (
    <div className="card flush clip">
      <table className="table">
        <thead>
          <tr>
            <th>Outil</th>
            <th>Session</th>
            <th>Fraîcheur</th>
          </tr>
        </thead>
        <tbody>
          {props.sessions.map((session) => (
            <tr key={session.id} className="clickable" onClick={() => props.onSelect(session.id)}>
              <td>
                <ToolBadge tool={session.tool} label={session.toolLabel} />
              </td>
              <td>
                <div className="text-strong">{ellipsis(sessionTitle(session), 24)}</div>
                {/* Branche, pid et version sur une ligne secondaire : une colonne
                    par champ serait illisible dans 420 px. */}
                <div className="text-faint text-xs">
                  {session.gitBranch ?? 'branche inconnue'}
                  {session.pid !== null && ` · pid ${session.pid}`}
                  {session.version !== null && ` · v${session.version}`}
                </div>
              </td>
              <td>
                <Freshness freshness={session.freshness} />
                <div className="text-faint text-xs">
                  {session.lastActivityAt === null
                    ? '-'
                    : `il y a ${fmtDuration(session.lastActivityAt, null)}`}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Détail d'une session
 * ------------------------------------------------------------------------ */

function SessionDetail(props: { session: DetectedSession; onBack: () => void }) {
  const session = props.session;
  return (
    <div className="card">
      <div className="row mb-3">
        <h2 className="grow">{ellipsis(sessionTitle(session), 22)}</h2>
        <button className="btn ghost sm" onClick={props.onBack}>
          <ArrowLeft />
          Liste
        </button>
      </div>

      <dl className="kv">
        <dt>Outil</dt>
        <dd>
          <ToolBadge tool={session.tool} label={session.toolLabel} />
        </dd>

        <dt>Fraîcheur</dt>
        <dd>
          <Freshness freshness={session.freshness} />
        </dd>

        <dt>Identifiant</dt>
        <dd className="mono" title={session.sessionId ?? undefined}>
          {session.sessionId === null ? '-' : ellipsis(session.sessionId, SESSION_ID_CHARS)}
        </dd>

        <dt>Répertoire</dt>
        <dd className="break-all">{session.cwd === null ? '-' : <code>{session.cwd}</code>}</dd>

        <dt>Branche git</dt>
        <dd>{session.gitBranch ?? '-'}</dd>

        <dt>Version</dt>
        <dd>{session.version ?? '-'}</dd>

        <dt>Lancement</dt>
        <dd>{session.entrypoint ?? '-'}</dd>

        <dt>PID</dt>
        <dd>{session.pid ?? '-'}</dd>

        <dt>CPU</dt>
        <dd>{session.cpuPercent === null ? '-' : `${session.cpuPercent.toFixed(1)} %`}</dd>

        <dt>Ancienneté</dt>
        <dd>{session.uptimeSec === null ? '-' : fmtUptime(session.uptimeSec)}</dd>

        <dt>Dernière activité</dt>
        <dd>
          {session.lastActivityAt === null
            ? '-'
            : `${fmtDateTime(session.lastActivityAt)} (il y a ${fmtDuration(session.lastActivityAt, null)})`}
        </dd>

        <dt>Détection</dt>
        <dd className="row gap-2 wrap">
          {session.sources.length === 0
            ? '-'
            : session.sources.map((source) => (
                <span key={source} className="badge">
                  {SOURCE_LABELS[source]}
                </span>
              ))}
        </dd>

        <dt>Pilotage</dt>
        <dd>
          {session.managed === null ? (
            <span className="badge">session externe</span>
          ) : (
            <span className="row gap-2 wrap">
              <Link to={`/agents/${session.managed.agentId}`}>
                {session.managed.agentEmoji} {session.managed.agentName}
              </Link>
              {session.managed.runId !== null && (
                <Link to={`/runs/${session.managed.runId}`}>voir le run</Link>
              )}
            </span>
          )}
        </dd>
      </dl>
    </div>
  );
}
