/**
 * Protocole temps réel (WebSocket) et contrats d'API REST.
 *
 * Principe : les mutations passent par l'API REST ; le WebSocket est un flux
 * descendant (serveur → client) qui pousse l'état à jour. Le client s'abonne
 * une fois et met à jour son store local à réception.
 */

import type {
  AgentConfig,
  Approval,
  KanbanTask,
  LogLine,
  MetricsSnapshot,
  Pipeline,
  PipelineRun,
  McpServerDef,
  RadarSnapshot,
  RagCollection,
  Routine,
  Run,
  RunEvent,
  ServerInfo,
  SkillDef,
  TmuxSessionInfo,
} from './types.ts';
import type { ProviderAccount, ResiliencePolicy, RunAttempt, SessionHandoff } from './providers.ts';

// ---------------------------------------------------------------------------
// WebSocket : événements serveur → client
// ---------------------------------------------------------------------------

export type ServerEvent =
  | { type: 'hello'; payload: { server: ServerInfo; metrics: MetricsSnapshot } }
  | { type: 'agent.created'; payload: AgentConfig }
  | { type: 'agent.updated'; payload: AgentConfig }
  | { type: 'agent.deleted'; payload: { id: string } }
  | { type: 'run.created'; payload: Run }
  | { type: 'run.updated'; payload: Run }
  | { type: 'run.event'; payload: RunEvent }
  | { type: 'approval.requested'; payload: Approval }
  | { type: 'approval.resolved'; payload: Approval }
  | { type: 'task.created'; payload: KanbanTask }
  | { type: 'task.updated'; payload: KanbanTask }
  | { type: 'task.deleted'; payload: { id: string } }
  | { type: 'skill.changed'; payload: { skills: SkillDef[] } }
  | { type: 'routine.updated'; payload: Routine }
  | { type: 'routine.deleted'; payload: { id: string } }
  | { type: 'pipeline.updated'; payload: Pipeline }
  | { type: 'pipelineRun.updated'; payload: PipelineRun }
  | { type: 'tmux.updated'; payload: { sessions: TmuxSessionInfo[] } }
  | { type: 'radar.update'; payload: RadarSnapshot }
  | { type: 'mcp.updated'; payload: McpServerDef }
  | { type: 'mcp.deleted'; payload: { id: string } }
  | { type: 'rag.updated'; payload: RagCollection }
  | { type: 'rag.deleted'; payload: { id: string } }
  | { type: 'metrics.tick'; payload: MetricsSnapshot }
  | { type: 'provider.updated'; payload: ProviderAccount }
  | { type: 'provider.deleted'; payload: { id: string } }
  | { type: 'policy.updated'; payload: ResiliencePolicy }
  | { type: 'policy.deleted'; payload: { id: string } }
  /* La tentative est poussée séparément du run : c'est le seul moyen de voir
     une bascule *pendant* qu'elle se produit, et non après coup dans un
     historique. */
  | { type: 'run.attempt'; payload: RunAttempt }
  | { type: 'handoff.created'; payload: SessionHandoff }
  | { type: 'log'; payload: LogLine };

export type ServerEventType = ServerEvent['type'];

// ---------------------------------------------------------------------------
// REST : corps de requêtes
// ---------------------------------------------------------------------------

export interface StartRunRequest {
  agentId: string;
  prompt: string;
  skillId?: string | null;
  /** Reprendre la session Claude Code d'un run précédent. */
  resumeRunId?: string | null;
  /**
   * Force le moteur pour ce run seulement, sans toucher à la configuration de
   * l'agent. Les pipelines s'en servent : une session tmux interactive ne se
   * termine pas d'elle-même, un enchaînement a besoin de runs qui finissent.
   */
  engine?: 'sdk' | 'tmux' | null;
}

export interface ResolveApprovalRequest {
  decision: 'allow' | 'deny';
  note?: string;
}

export interface CreateTaskRequest {
  title: string;
  description?: string;
  column?: KanbanTask['column'];
  priority?: KanbanTask['priority'];
  labels?: string[];
  agentId?: string | null;
  autoRun?: boolean;
}

export interface MoveTaskRequest {
  column: KanbanTask['column'];
  position: number;
}

export interface UpsertSkillRequest {
  scope: SkillDef['scope'];
  agentId?: string | null;
  slug: string;
  name: string;
  description: string;
  content: string;
}

export interface CreateRoutineRequest {
  name: string;
  agentId: string;
  skillId?: string | null;
  prompt: string;
  cronExpr: string;
  enabled?: boolean;
  timeoutSec?: number | null;
  notify?: boolean;
}

export interface RunPipelineRequest {
  input: string;
}

export interface ConnectorSearchQuery {
  q?: string;
  category?: string;
  type?: string;
  featured?: boolean;
  sort?: 'stars' | 'newest';
  limit?: number;
  offset?: number;
}

export interface ConnectorPreviewRequest {
  ref: string;
}

export interface ConnectorInstallRequest {
  ref: string;
  /** Slug cible ; à défaut celui proposé par la prévisualisation. */
  slug?: string;
  /** Portée d'installation — 'agent' exige agentId. */
  scope?: 'global' | 'agent';
  agentId?: string | null;
}

/** Import d'un subagent distant en tant qu'agent Maestro. */
export interface ConnectorInstallAgentRequest {
  ref: string;
  name?: string;
  emoji?: string;
  color?: string;
  model?: string;
  engine?: 'sdk' | 'tmux';
  approvalPolicy?: 'auto' | 'ask' | 'guarded';
  parentAgentId?: string | null;
}

export interface ConnectorInstallPluginRequest {
  ref: string;
  slug?: string;
}

export interface CreateTmuxSessionRequest {
  agentId: string;
  prompt?: string;
}

// ---------------------------------------------------------------------------
// REST : réponses composées
// ---------------------------------------------------------------------------

export interface RunWithEvents {
  run: Run;
  events: RunEvent[];
}

export interface OverviewResponse {
  metrics: MetricsSnapshot;
  server: ServerInfo;
  recentLogs: LogLine[];
}

export interface ApiError {
  error: string;
  detail?: string;
}
