/**
 * Mission Control — tableau de bord temps réel : lancement rapide d'un run,
 * graphe force-directed des agents, inspecteur d'agent et journal d'événements.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Crosshair, Play, Robot } from '@phosphor-icons/react';
import {
  ACTIVE_RUN_STATUSES,
  type AgentConfig,
  type ApprovalPolicy,
  type LogLine,
  type PermissionMode,
  type Run,
  type RunEvent,
} from '@maestro/shared';
import AgentGraph from '../components/graph/AgentGraph';
import { AgentAvatar, EmptyState, ErrorText, Spinner, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { fmtDateTime, fmtTime } from '../lib/format';
import { useStore } from '../lib/store';

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: 'Permissions : défaut',
  acceptEdits: 'Éditions auto',
  plan: 'Mode plan',
  bypassPermissions: 'Sans permissions',
};

const APPROVAL_LABELS: Record<ApprovalPolicy, string> = {
  auto: 'Approbation auto',
  ask: 'Approbation manuelle',
  guarded: 'Approbation gardée',
};

const LAST_EVENT_MAX_CHARS = 180;

export default function MissionControl() {
  const navigate = useNavigate();
  const agents = useStore((s) => s.agents);
  const runs = useStore((s) => s.runs);
  const liveEvents = useStore((s) => s.liveEvents);
  const logs = useStore((s) => s.logs);

  const [launchAgentId, setLaunchAgentId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const promptRef = useRef<HTMLInputElement>(null);

  const effectiveAgentId = agents.some((a) => a.id === launchAgentId)
    ? launchAgentId
    : (agents[0]?.id ?? '');
  const selectedAgent = selectedId ? (agents.find((a) => a.id === selectedId) ?? null) : null;

  const activeAgentIds = useMemo(
    () => new Set(runs.filter((r) => ACTIVE_RUN_STATUSES.includes(r.status)).map((r) => r.agentId)),
    [runs],
  );

  const handleLaunch = async (e: FormEvent) => {
    e.preventDefault();
    const text = prompt.trim();
    if (!effectiveAgentId || !text || launching) return;
    setLaunching(true);
    setError(null);
    try {
      const run = await api.startRun({ agentId: effectiveAgentId, prompt: text });
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Échec du lancement du run');
    } finally {
      setLaunching(false);
    }
  };

  const handlePin = async (id: string, pinned: { x: number; y: number } | null) => {
    try {
      await api.updateAgent(id, { pinned });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de l'épinglage de l'agent");
    }
  };

  return (
    <div className="page fixed">
      {/* Lancement rapide : l'action première de la page tient sur une ligne. */}
      <form className="card row mc-launch" onSubmit={handleLaunch}>
        <select
          className="select w-lg"
          value={effectiveAgentId}
          onChange={(e) => setLaunchAgentId(e.target.value)}
          aria-label="Agent à lancer"
        >
          {agents.length === 0 && <option value="">Aucun agent</option>}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.emoji} {a.name}
            </option>
          ))}
        </select>
        <input
          ref={promptRef}
          className="input grow"
          placeholder="Prompt du run à lancer…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          aria-label="Prompt du run"
        />
        <button
          className="btn primary"
          type="submit"
          disabled={launching || !effectiveAgentId || !prompt.trim()}
        >
          {launching ? <Spinner /> : <Play />}
          Lancer
        </button>
      </form>

      {error && <ErrorText>{error}</ErrorText>}

      <div className="mc-layout">
        <div className="card mc-graph">
          {agents.length === 0 ? (
            <div className="overlay-center">
              <EmptyState
                icon={<Robot size={28} />}
                title="Aucun agent"
                hint="Crée un premier agent pour peupler le graphe."
              >
                <Link className="btn primary sm" to="/agents">
                  Créer un agent
                </Link>
              </EmptyState>
            </div>
          ) : (
            <AgentGraph
              agents={agents}
              activeAgentIds={activeAgentIds}
              selectedId={selectedId}
              liveEvents={liveEvents}
              onSelect={setSelectedId}
              onPin={handlePin}
            />
          )}
        </div>

        {/* Colonne droite : inspecteur puis journal. */}
        <div className="col panel-side min-0">
          <div className="card mc-inspector">
            <h3>Inspecteur</h3>
            {selectedAgent ? (
              <AgentInspector
                agent={selectedAgent}
                runs={runs}
                liveEvents={liveEvents}
                onNewRun={(id) => {
                  setLaunchAgentId(id);
                  promptRef.current?.focus();
                }}
              />
            ) : (
              <EmptyState
                compact
                icon={<Crosshair size={24} />}
                title="Aucun agent sélectionné"
                hint="Clique un nœud du graphe pour inspecter son activité."
              />
            )}
          </div>

          <div className="card fill stack">
            <h3>Journal</h3>
            <LogFeed logs={logs} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Inspecteur d'agent
 * ------------------------------------------------------------------------ */

function AgentInspector(props: {
  agent: AgentConfig;
  runs: Run[];
  liveEvents: RunEvent[];
  onNewRun: (agentId: string) => void;
}) {
  const { agent, runs, liveEvents } = props;

  const recentRuns = useMemo(
    () => runs.filter((r) => r.agentId === agent.id).slice(0, 5),
    [runs, agent.id],
  );

  const lastEvent = useMemo(() => {
    for (let i = liveEvents.length - 1; i >= 0; i--) {
      const ev = liveEvents[i];
      if (ev && ev.agentId === agent.id) return ev;
    }
    return null;
  }, [liveEvents, agent.id]);

  return (
    <div className="col">
      <div className="row">
        <AgentAvatar agent={agent} size={40} />
        <div className="min-0">
          <div className="text-strong ellipsis">{agent.name}</div>
          <div className="mono text-muted text-xs ellipsis">{agent.model}</div>
        </div>
      </div>

      <div className="row gap-2 wrap">
        <span className="badge violet">{agent.engine === 'tmux' ? 'tmux' : 'SDK'}</span>
        <span className="badge">{PERMISSION_LABELS[agent.permissionMode]}</span>
        <span className="badge warn">{APPROVAL_LABELS[agent.approvalPolicy]}</span>
      </div>

      <div>
        <div className="section-label">Runs récents</div>
        {recentRuns.length === 0 ? (
          <div className="text-faint text-sm">Aucun run pour cet agent.</div>
        ) : (
          <div className="col gap-1">
            {recentRuns.map((run) => (
              <div className="row gap-2 justify-between" key={run.id}>
                <StatusBadge status={run.status} />
                <Link to={`/runs/${run.id}`} className="mono text-xs">
                  {run.id.slice(0, 8)}
                </Link>
                <span className="text-faint text-xs nowrap">{fmtDateTime(run.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {lastEvent && (
        <div>
          <div className="section-label">Dernier événement</div>
          <div className="mono text-muted text-xs break-word">
            {fmtTime(lastEvent.ts)} · {shorten(describeEvent(lastEvent), LAST_EVENT_MAX_CHARS)}
          </div>
        </div>
      )}

      <div className="row">
        <button className="btn primary sm" onClick={() => props.onNewRun(agent.id)}>
          Nouveau run
        </button>
        <Link className="btn sm" to={`/agents/${agent.id}`}>
          Détail
        </Link>
      </div>
    </div>
  );
}

function describeEvent(ev: RunEvent): string {
  const p = ev.payload;
  switch (ev.kind) {
    case 'init':
      return `session initialisée (${p.model ?? '?'})`;
    case 'assistant_text':
      return p.text ?? '';
    case 'thinking':
      return `réflexion · ${p.text ?? ''}`;
    case 'tool_use':
      return `outil ${p.toolName ?? '?'}`;
    case 'tool_result':
      return `résultat outil ${p.toolName ?? '?'}${p.isError ? ' (erreur)' : ''}`;
    case 'permission_request':
      return `permission demandée · ${p.toolName ?? '?'}`;
    case 'permission_result':
      return `permission ${p.decision === 'allowed' ? 'accordée' : 'refusée'}`;
    case 'result':
      return `résultat · ${p.text ?? ''}`;
    case 'error':
      return `erreur · ${p.text ?? ''}`;
    case 'info':
      return p.text ?? '';
    default:
      return ev.kind;
  }
}

/** Coupe un texte trop long en conservant son début. */
function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/* --------------------------------------------------------------------------
 * Journal d'événements
 * ------------------------------------------------------------------------ */

const STICK_TO_BOTTOM_PX = 40;

function LogFeed({ logs }: { logs: LogLine[] }) {
  const feedRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  /* Auto-scroll vers le bas, sauf si l'utilisateur a remonté le fil. */
  useEffect(() => {
    const el = feedRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const handleScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_PX;
  };

  if (logs.length === 0) {
    return <div className="text-faint text-sm">Aucun événement pour l'instant.</div>;
  }

  return (
    <div className="log-feed fill" ref={feedRef} onScroll={handleScroll}>
      {logs.map((line) => (
        <div key={line.id} className={`log-line ${line.level}`}>
          <span className="ts">{fmtTime(line.ts)}</span>
          <span className="src">{line.source}</span>
          <span className="msg">{line.message}</span>
        </div>
      ))}
    </div>
  );
}
