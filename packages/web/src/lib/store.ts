/**
 * Store global (zustand) : hydraté par l'API au démarrage, tenu à jour en
 * continu par les ServerEvent du WebSocket via applyEvent().
 */
import { create } from 'zustand';
import type {
  AgentConfig,
  Approval,
  KanbanTask,
  LogLine,
  McpServerDef,
  MetricsSnapshot,
  Pipeline,
  PipelineRun,
  Routine,
  Run,
  RadarSnapshot,
  RagCollection,
  RunEvent,
  ServerEvent,
  ServerInfo,
  SkillDef,
} from '@maestro/shared';
import { api } from './api';

const MAX_LIVE_EVENTS = 250;
/** Au-delà, les notifications les plus anciennes cèdent la place. */
const MAX_TOASTS = 4;
const MAX_LOGS = 400;
const MAX_RUNS = 300;

/**
 * Notification transitoire.
 *
 * Elle existe parce que plusieurs actions réussissaient en silence : cloner un
 * agent, mettre à jour un plugin, tuer une session tmux. Rien ne bougeait à
 * l'écran, et l'utilisateur relançait l'action en doutant qu'elle ait pris.
 * Une erreur, elle, reste affichée en place dans la page : un message qui
 * disparaît tout seul n'est pas le bon support pour ce qu'il faut corriger.
 */
export interface Toast {
  id: string;
  message: string;
  tone: 'ok' | 'info';
}

let toastSeq = 0;

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const idx = list.findIndex((x) => x.id === item.id);
  if (idx === -1) return [item, ...list];
  const copy = list.slice();
  copy[idx] = item;
  return copy;
}

export interface MaestroStore {
  connected: boolean;
  bootstrapped: boolean;
  server: ServerInfo | null;
  metrics: MetricsSnapshot | null;
  agents: AgentConfig[];
  runs: Run[];
  /** Flux global d'événements de runs (Mission Control). */
  liveEvents: RunEvent[];
  /** Événements par run, alimentés en direct pour les transcripts ouverts. */
  runEvents: Record<string, RunEvent[]>;
  tasks: KanbanTask[];
  approvals: Approval[];
  skills: SkillDef[];
  routines: Routine[];
  pipelines: Pipeline[];
  pipelineRuns: PipelineRun[];
  logs: LogLine[];
  /** Dernier balayage du radar de sessions (poussé par le serveur). */
  radar: RadarSnapshot | null;
  /** Serveurs MCP déclarés, secrets masqués par le serveur. */
  mcpServers: McpServerDef[];
  /** Collections RAG, avec leurs compteurs de documents et de morceaux. */
  ragCollections: RagCollection[];
  /** Notifications transitoires, rendues par ToastHost. */
  toasts: Toast[];

  setConnected: (connected: boolean) => void;
  bootstrap: () => Promise<void>;
  applyEvent: (event: ServerEvent) => void;
  /** Charge l'historique d'événements d'un run (transcript). */
  loadRunEvents: (runId: string) => Promise<void>;
  /** Signale une action réussie. Les échecs restent affichés dans la page. */
  notify: (message: string, tone?: Toast['tone']) => void;
  dismissToast: (id: string) => void;
}

export const useStore = create<MaestroStore>((set, get) => ({
  connected: false,
  bootstrapped: false,
  server: null,
  toasts: [],
  mcpServers: [],
  ragCollections: [],
  metrics: null,
  agents: [],
  runs: [],
  liveEvents: [],
  runEvents: {},
  tasks: [],
  approvals: [],
  skills: [],
  routines: [],
  pipelines: [],
  pipelineRuns: [],
  logs: [],
  radar: null,

  setConnected: (connected) => set({ connected }),

  bootstrap: async () => {
    const [
      overview,
      agents,
      runs,
      tasks,
      approvals,
      skills,
      routines,
      pipelines,
      pipelineRuns,
      mcpServers,
      ragCollections,
    ] = await Promise.all([
      api.overview(),
      api.listAgents(),
      api.listRuns({ limit: 200 }),
      api.listTasks(),
      api.listApprovals(),
      api.listSkills(),
      api.listRoutines(),
      api.listPipelines(),
      api.listPipelineRuns(),
      api.listMcpServers(),
      api.listRagCollections(),
    ]);
    set({
      bootstrapped: true,
      server: overview.server,
      metrics: overview.metrics,
      logs: overview.recentLogs,
      agents,
      runs,
      tasks,
      approvals,
      skills,
      routines,
      pipelines,
      pipelineRuns,
      mcpServers,
      ragCollections,
    });
  },

  notify: (message, tone = 'ok') => {
    toastSeq += 1;
    const toast: Toast = { id: `toast-${toastSeq}`, message, tone };
    set((state) => ({ toasts: [...state.toasts, toast].slice(-MAX_TOASTS) }));
  },

  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  loadRunEvents: async (runId) => {
    const { events } = await api.getRun(runId);
    set((state) => ({ runEvents: { ...state.runEvents, [runId]: events } }));
  },

  applyEvent: (event) => {
    const state = get();
    switch (event.type) {
      case 'hello':
        set({ server: event.payload.server, metrics: event.payload.metrics });
        break;
      case 'metrics.tick':
        set({ metrics: event.payload });
        break;
      case 'agent.created':
      case 'agent.updated':
        set({ agents: upsertById(state.agents, event.payload).filter((a) => !a.archived) });
        break;
      case 'agent.deleted':
        set({ agents: state.agents.filter((a) => a.id !== event.payload.id) });
        break;
      case 'run.created':
      case 'run.updated':
        set({ runs: upsertById(state.runs, event.payload).slice(0, MAX_RUNS) });
        break;
      case 'run.event': {
        const re = event.payload;
        const next: Partial<MaestroStore> = {
          liveEvents: [...state.liveEvents.slice(-MAX_LIVE_EVENTS + 1), re],
        };
        if (state.runEvents[re.runId]) {
          next.runEvents = {
            ...state.runEvents,
            [re.runId]: [...(state.runEvents[re.runId] ?? []), re],
          };
        }
        set(next);
        break;
      }
      case 'approval.requested':
      case 'approval.resolved':
        set({ approvals: upsertById(state.approvals, event.payload) });
        break;
      case 'task.created':
      case 'task.updated':
        set({ tasks: upsertById(state.tasks, event.payload) });
        break;
      case 'task.deleted':
        set({ tasks: state.tasks.filter((t) => t.id !== event.payload.id) });
        break;
      case 'skill.changed':
        set({ skills: event.payload.skills });
        break;
      case 'routine.updated':
        set({ routines: upsertById(state.routines, event.payload) });
        break;
      case 'routine.deleted':
        set({ routines: state.routines.filter((r) => r.id !== event.payload.id) });
        break;
      case 'pipeline.updated':
        set({ pipelines: upsertById(state.pipelines, event.payload) });
        break;
      case 'pipelineRun.updated':
        set({ pipelineRuns: upsertById(state.pipelineRuns, event.payload) });
        break;
      case 'log':
        set({ logs: [...state.logs.slice(-MAX_LOGS + 1), event.payload] });
        break;
      case 'radar.update':
        set({ radar: event.payload });
        break;
      /* Les serveurs MCP et les collections RAG arrivent par événement comme le
         reste : une modification faite depuis un autre onglet, ou une
         vectorisation qui se termine en tâche de fond, met la liste à jour sans
         relecture. */
      case 'mcp.updated':
        set((state) => ({ mcpServers: upsertById(state.mcpServers, event.payload) }));
        break;
      case 'mcp.deleted':
        set((state) => ({
          mcpServers: state.mcpServers.filter((m) => m.id !== event.payload.id),
        }));
        break;
      case 'rag.updated':
        set((state) => ({ ragCollections: upsertById(state.ragCollections, event.payload) }));
        break;
      case 'rag.deleted':
        set((state) => ({
          ragCollections: state.ragCollections.filter((c) => c.id !== event.payload.id),
        }));
        break;
      case 'tmux.updated':
        break;
    }
  },
}));

/**
 * Sélecteurs pratiques.
 * ⚠️ Ne jamais passer à useStore un sélecteur qui retourne un tableau/objet
 * NEUF à chaque snapshot (filter/map/littéral) : boucle de rendu infinie.
 * S'abonner à la collection brute, puis dériver avec useMemo dans le composant.
 */
export const selectAgent = (id: string | null | undefined) => (s: MaestroStore) =>
  id ? (s.agents.find((a) => a.id === id) ?? null) : null;

/** Helpers de dérivation — à appeler sur une collection déjà lue, PAS dans useStore. */
export const pendingApprovals = (approvals: Approval[]) =>
  approvals.filter((a) => a.status === 'pending');

export const activeRuns = (runs: Run[]) =>
  runs.filter(
    (r) => r.status === 'running' || r.status === 'queued' || r.status === 'waiting_approval',
  );
