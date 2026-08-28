/**
 * Client REST typé. Le jeton est conservé en localStorage ('maestro_token').
 */
import type {
  AgentConfig,
  ConnectorInstallAgentRequest,
  ConnectorInstallPluginRequest,
  ConnectorInstallRequest,
  ConnectorSearchQuery,
  McpImportCandidate,
  McpPreset,
  McpProbeResult,
  McpServerDef,
  McpToolTrial,
  PluginInstall,
  RadarSnapshot,
  RagChunkView,
  RagCollection,
  RagDocument,
  RagMaintenanceReport,
  RagEmbeddingStatus,
  RagGraph,
  RagSearchResult,
  RemotePluginPreview,
  RemoteSkillPreview,
  RemoteSkillSearch,
  SkillConnector,
  AgentStats,
  AgentTemplate,
  Approval,
  CreateRoutineRequest,
  CreateTaskRequest,
  KanbanTask,
  MoveTaskRequest,
  OverviewResponse,
  Pipeline,
  PipelineRun,
  ResolveApprovalRequest,
  Routine,
  Run,
  RunWithEvents,
  WorkspaceChanges,
  CommitResult,
  Settings,
  SkillDef,
  StartRunRequest,
  TmuxSessionInfo,
  TokensByBucket,
  ToolCallDialectInfo,
  Trajectory,
  TrainingBatch,
  TrainingBatchSpec,
  TrainingExportPreview,
  TrainingExportRequest,
  TrainingItem,
  UpsertSkillRequest,
} from '@maestro/shared';

/**
 * Source d'une configuration MCP à importer.
 *
 * Un chemin sur la machine, ou un contenu collé. Le serveur relit la source au
 * moment de créer : les secrets du fichier ne transitent donc jamais par le
 * client entre la prévisualisation et l'import.
 */
export interface McpImportSource {
  path?: string;
  json?: string;
}

/** Corps accepté par l'API pour créer ou modifier un serveur MCP. */
export type McpServerInput = Omit<McpServerDef, 'id' | 'createdAt' | 'updatedAt'>;

/** Corps accepté pour créer ou modifier une collection RAG. */
export type RagCollectionInput = Pick<
  RagCollection,
  'slug' | 'name' | 'description' | 'chunkSize' | 'chunkOverlap'
>;

/** Corps d'une ingestion. Les champs utiles dépendent de `sourceKind`. */
export interface RagIngestInput {
  sourceKind: RagDocument['sourceKind'];
  title?: string;
  content?: string;
  source?: string;
}

/** Compte rendu d'ingestion, écarts compris. */
export interface RagIngestResponse {
  documents: RagDocument[];
  chunks: number;
  skipped: Array<{ source: string; reason: string }>;
}

const TOKEN_KEY = 'maestro_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event('maestro:unauthorized'));
    throw new ApiError(401, 'Jeton invalide');
  }
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? `Erreur HTTP ${res.status}`);
  }
  return data as T;
}

/** État de l'entretien : taille de la base, rétention, sauvegardes. */
export interface MaintenanceState {
  databaseBytes: number;
  retentionDays: number | null;
  backups: Array<{ name: string; bytes: number; createdAt: string }>;
}

export interface BackupReport {
  path: string;
  bytes: number;
  rotated: string[];
}

export interface PruneReport {
  applied: boolean;
  cutoff: string | null;
  deletedEvents: number;
  deletedLogs: number;
  bytesBefore: number;
  bytesAfter: number;
}

/** Corps accepté par l'API pour créer ou modifier un lot d'entraînement. */
export interface TrainingBatchInput {
  name: string;
  description?: string;
  spec: TrainingBatchSpec;
}

/**
 * Télécharge un jeu de données au format JSONL.
 *
 * Comme le patch d'un run : la réponse n'est pas du JSON, et un `<a href>`
 * n'emporterait pas l'en-tête d'authentification. D'où le POST puis le Blob.
 */
export async function downloadTrainingExport(input: TrainingExportRequest): Promise<number> {
  const res = await fetch('/api/training/export', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, data?.error ?? `Erreur HTTP ${res.status}`);
  }
  const body = await res.text();
  const blob = new Blob([body], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `maestro-${input.format}.jsonl`;
  link.click();
  URL.revokeObjectURL(url);
  // Le nombre de lignes : sans lui, l'utilisateur ne sait pas si le fichier
  // téléchargé contient mille trajectoires ou aucune.
  return body ? body.trimEnd().split('\n').length : 0;
}

/**
 * Télécharge une skill au format ouvert SKILL.md.
 *
 * Comme le patch d'un run : la réponse n'est pas du JSON et un `<a href>` nu
 * n'emporterait pas l'en-tête d'authentification, le jeton vivant en
 * localStorage et non en cookie.
 */
export async function downloadSkill(id: string): Promise<void> {
  const res = await fetch(`/api/skills/export?id=${encodeURIComponent(id)}`, {
    headers: { ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}) },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, data?.error ?? `Erreur HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  /* Le nom vient de l'identifiant, pas de l'en-tête : lire content-disposition
     demanderait de le décoder à la main pour un gain nul. */
  link.download = `${id.split(':').pop() ?? 'skill'}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Télécharge le patch d'un run.
 *
 * Hors de `request` et hors d'un simple lien : la réponse n'est pas du JSON, et
 * un `<a href>` n'emporterait pas l'en-tête d'authentification — le jeton vit en
 * localStorage, pas en cookie. D'où le passage par un Blob.
 */
export async function downloadRunPatch(id: string): Promise<void> {
  const res = await fetch(`/api/runs/${id}/patch`, {
    headers: { ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}) },
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, data?.error ?? `Erreur HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `maestro-${id.slice(0, 8)}.patch`;
  link.click();
  URL.revokeObjectURL(url);
}

export const api = {
  // Vue d'ensemble
  overview: () => request<OverviewResponse>('GET', '/api/overview'),
  health: () => request<{ ok: boolean }>('GET', '/api/health'),

  // Agents
  listAgents: (archived = false) =>
    request<AgentConfig[]>('GET', `/api/agents${archived ? '?archived=1' : ''}`),
  getAgent: (id: string) => request<AgentConfig>('GET', `/api/agents/${id}`),
  createAgent: (input: Partial<AgentConfig>) => request<AgentConfig>('POST', '/api/agents', input),
  updateAgent: (id: string, patch: Partial<AgentConfig>) =>
    request<AgentConfig>('PATCH', `/api/agents/${id}`, patch),
  cloneAgent: (id: string, name?: string) =>
    request<AgentConfig>('POST', `/api/agents/${id}/clone`, { name }),
  deleteAgent: (id: string) => request<{ ok: boolean }>('DELETE', `/api/agents/${id}`),
  agentTemplates: () => request<AgentTemplate[]>('GET', '/api/agent-templates'),
  getMemory: (agentId: string) =>
    request<{ content: string }>('GET', `/api/agents/${agentId}/memory`),
  saveMemory: (agentId: string, content: string) =>
    request<{ ok: boolean }>('PUT', `/api/agents/${agentId}/memory`, { content }),

  // Runs
  startRun: (input: StartRunRequest) => request<Run>('POST', '/api/runs', input),
  listRuns: (params: { agentId?: string; status?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.agentId) q.set('agentId', params.agentId);
    if (params.status) q.set('status', params.status);
    if (params.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    return request<Run[]>('GET', `/api/runs${qs ? `?${qs}` : ''}`);
  },
  getRun: (id: string) => request<RunWithEvents>('GET', `/api/runs/${id}`),
  cancelRun: (id: string) => request<{ ok: boolean }>('POST', `/api/runs/${id}/cancel`),

  // Modifications produites dans le répertoire de l'agent
  runChanges: (id: string) => request<WorkspaceChanges>('GET', `/api/runs/${id}/changes`),
  runBranchName: (id: string) => request<{ branch: string }>('GET', `/api/runs/${id}/branch-name`),
  createRunBranch: (id: string, input: { branch: string; message?: string }) =>
    request<CommitResult>('POST', `/api/runs/${id}/branch`, input),

  // Approbations
  listApprovals: (status?: string) =>
    request<Approval[]>('GET', `/api/approvals${status ? `?status=${status}` : ''}`),
  resolveApproval: (id: string, body: ResolveApprovalRequest) =>
    request<Approval>('POST', `/api/approvals/${id}/resolve`, body),

  // Kanban
  listTasks: () => request<KanbanTask[]>('GET', '/api/tasks'),
  createTask: (input: CreateTaskRequest) => request<KanbanTask>('POST', '/api/tasks', input),
  updateTask: (id: string, patch: Partial<CreateTaskRequest>) =>
    request<KanbanTask>('PATCH', `/api/tasks/${id}`, patch),
  moveTask: (id: string, body: MoveTaskRequest) =>
    request<KanbanTask>('POST', `/api/tasks/${id}/move`, body),
  runTask: (id: string, agentId?: string) =>
    request<Run>('POST', `/api/tasks/${id}/run`, { agentId }),
  deleteTask: (id: string) => request<{ ok: boolean }>('DELETE', `/api/tasks/${id}`),

  // Skills
  listSkills: () => request<SkillDef[]>('GET', '/api/skills'),
  upsertSkill: (input: UpsertSkillRequest) => request<SkillDef>('PUT', '/api/skills', input),
  deleteSkill: (id: string) =>
    request<{ ok: boolean }>('DELETE', `/api/skills?id=${encodeURIComponent(id)}`),

  // Connecteurs de skills
  listConnectors: () => request<SkillConnector[]>('GET', '/api/connectors'),
  searchConnector: (connectorId: string, query: ConnectorSearchQuery) => {
    const q = new URLSearchParams();
    if (query.q) q.set('q', query.q);
    if (query.category) q.set('category', query.category);
    if (query.type) q.set('type', query.type);
    if (query.featured) q.set('featured', '1');
    if (query.sort) q.set('sort', query.sort);
    if (query.limit) q.set('limit', String(query.limit));
    if (query.offset) q.set('offset', String(query.offset));
    const qs = q.toString();
    return request<RemoteSkillSearch>(
      'GET',
      `/api/connectors/${connectorId}/search${qs ? `?${qs}` : ''}`,
    );
  },
  previewRemoteSkill: (connectorId: string, ref: string) =>
    request<RemoteSkillPreview>('POST', `/api/connectors/${connectorId}/preview`, { ref }),
  previewRemotePlugin: (connectorId: string, ref: string) =>
    request<RemotePluginPreview>('POST', `/api/connectors/${connectorId}/preview/plugin`, { ref }),
  installRemoteSkill: (connectorId: string, body: ConnectorInstallRequest) =>
    request<SkillDef>('POST', `/api/connectors/${connectorId}/install/skill`, body),
  installRemoteAgent: (connectorId: string, body: ConnectorInstallAgentRequest) =>
    request<AgentConfig>('POST', `/api/connectors/${connectorId}/install/agent`, body),
  installRemotePlugin: (connectorId: string, body: ConnectorInstallPluginRequest) =>
    request<PluginInstall>('POST', `/api/connectors/${connectorId}/install/plugin`, body),

  // Plugins installés
  listPlugins: () => request<PluginInstall[]>('GET', '/api/plugins'),
  // -- Serveurs MCP ---------------------------------------------------------

  listMcpServers: () => request<McpServerDef[]>('GET', '/api/mcp-servers'),
  createMcpServer: (body: McpServerInput) =>
    request<McpServerDef>('POST', '/api/mcp-servers', body),
  updateMcpServer: (id: string, body: McpServerInput) =>
    request<McpServerDef>('PATCH', `/api/mcp-servers/${id}`, body),
  deleteMcpServer: (id: string) => request<{ ok: boolean }>('DELETE', `/api/mcp-servers/${id}`),
  trialMcpTool: (id: string, tool: string, args: Record<string, unknown>) =>
    request<McpToolTrial>('POST', `/api/mcp-servers/${id}/trial`, { tool, args }),
  probeMcpServer: (id: string) => request<McpProbeResult>('POST', `/api/mcp-servers/${id}/probe`),
  exportMcpServer: (id: string) => request<McpServerInput>('GET', `/api/mcp-servers/${id}/export`),
  previewMcpImport: (source: McpImportSource) =>
    request<McpImportCandidate[]>('POST', '/api/mcp-servers/import/preview', source),
  runMcpImport: (source: McpImportSource, names: string[]) =>
    request<{ created: string[]; failed: Array<{ name: string; reason: string }> }>(
      'POST',
      '/api/mcp-servers/import',
      { ...source, names },
    ),

  // -- Collections RAG ------------------------------------------------------

  ragEmbeddingStatus: () => request<RagEmbeddingStatus>('GET', '/api/rag/embeddings'),
  listRagCollections: () => request<RagCollection[]>('GET', '/api/rag/collections'),
  createRagCollection: (body: RagCollectionInput) =>
    request<RagCollection>('POST', '/api/rag/collections', body),
  updateRagCollection: (id: string, body: RagCollectionInput) =>
    request<RagCollection>('PATCH', `/api/rag/collections/${id}`, body),
  deleteRagCollection: (id: string) =>
    request<{ ok: boolean }>('DELETE', `/api/rag/collections/${id}`),
  listRagDocuments: (id: string) =>
    request<RagDocument[]>('GET', `/api/rag/collections/${id}/documents`),
  ingestRagDocument: (id: string, body: RagIngestInput) =>
    request<RagIngestResponse>('POST', `/api/rag/collections/${id}/documents`, body),
  deleteRagDocument: (id: string, documentId: string) =>
    request<{ ok: boolean }>('DELETE', `/api/rag/collections/${id}/documents/${documentId}`),
  searchRag: (id: string, query: string, topK: number) =>
    request<RagSearchResult>('POST', `/api/rag/collections/${id}/search`, { query, topK }),
  embedRagCollection: (id: string) =>
    request<{ embedded: number }>('POST', `/api/rag/collections/${id}/embed`),
  reindexRagCollection: (id: string) =>
    request<RagMaintenanceReport>('POST', `/api/rag/collections/${id}/reindex`),
  refreshRagCollection: (id: string) =>
    request<RagMaintenanceReport>('POST', `/api/rag/collections/${id}/refresh`),
  ragGraph: (id: string) => request<RagGraph>('GET', `/api/rag/collections/${id}/graph`),
  listRagChunks: (id: string, documentId: string) =>
    request<RagChunkView[]>('GET', `/api/rag/collections/${id}/documents/${documentId}/chunks`),

  updatePlugin: (id: string) => request<PluginInstall>('POST', `/api/plugins/${id}/update`),
  deletePlugin: (id: string) => request<{ ok: boolean }>('DELETE', `/api/plugins/${id}`),

  // Routines
  listRoutines: () => request<Routine[]>('GET', '/api/routines'),
  createRoutine: (input: CreateRoutineRequest) => request<Routine>('POST', '/api/routines', input),
  updateRoutine: (id: string, patch: Partial<CreateRoutineRequest>) =>
    request<Routine>('PATCH', `/api/routines/${id}`, patch),
  deleteRoutine: (id: string) => request<{ ok: boolean }>('DELETE', `/api/routines/${id}`),
  runRoutineNow: (id: string) => request<{ ok: boolean }>('POST', `/api/routines/${id}/run-now`),

  // Pipelines
  listPipelines: () => request<Pipeline[]>('GET', '/api/pipelines'),
  createPipeline: (input: { name: string; description?: string; steps: unknown[] }) =>
    request<Pipeline>('POST', '/api/pipelines', input),
  updatePipeline: (id: string, patch: unknown) =>
    request<Pipeline>('PATCH', `/api/pipelines/${id}`, patch),
  deletePipeline: (id: string) => request<{ ok: boolean }>('DELETE', `/api/pipelines/${id}`),
  runPipeline: (id: string, input: string) =>
    request<PipelineRun>('POST', `/api/pipelines/${id}/run`, { input }),
  listPipelineRuns: (pipelineId?: string) =>
    request<PipelineRun[]>(
      'GET',
      `/api/pipeline-runs${pipelineId ? `?pipelineId=${pipelineId}` : ''}`,
    ),
  getPipelineRun: (id: string) => request<PipelineRun>('GET', `/api/pipeline-runs/${id}`),
  cancelPipelineRun: (id: string) =>
    request<{ ok: boolean }>('POST', `/api/pipeline-runs/${id}/cancel`),

  // tmux
  listTmuxSessions: () => request<TmuxSessionInfo[]>('GET', '/api/tmux/sessions'),
  killTmuxSession: (name: string) =>
    request<{ ok: boolean }>('DELETE', `/api/tmux/sessions/${name}`),

  // Radar de sessions
  getRadar: () => request<RadarSnapshot>('GET', '/api/radar'),
  sweepRadar: () => request<RadarSnapshot>('POST', '/api/radar/sweep'),

  // Métriques
  agentStats: () => request<AgentStats[]>('GET', '/api/metrics/agents'),
  tokensBy: (groupBy: 'day' | 'agent' | 'model', days = 30) =>
    request<TokensByBucket[]>('GET', `/api/metrics/tokens?groupBy=${groupBy}&days=${days}`),

  // Entretien de la base
  getMaintenance: () => request<MaintenanceState>('GET', '/api/maintenance'),
  runBackup: () => request<BackupReport>('POST', '/api/maintenance/backup'),
  runPrune: () => request<PruneReport>('POST', '/api/maintenance/prune'),

  // Catalogue MCP
  listMcpPresets: () => request<McpPreset[]>('GET', '/api/mcp-presets'),
  installMcpPreset: (slug: string, input: { env?: Record<string, string>; args?: string[] }) =>
    request<McpServerDef>('POST', `/api/mcp-presets/${slug}/install`, input),

  // Entraînement (MLOps)
  listToolCallDialects: () => request<ToolCallDialectInfo[]>('GET', '/api/training/dialects'),
  listTrainingBatches: () => request<TrainingBatch[]>('GET', '/api/training/batches'),
  createTrainingBatch: (input: TrainingBatchInput) =>
    request<TrainingBatch>('POST', '/api/training/batches', input),
  updateTrainingBatch: (id: string, patch: Partial<TrainingBatchInput>) =>
    request<TrainingBatch>('PATCH', `/api/training/batches/${id}`, patch),
  deleteTrainingBatch: (id: string) =>
    request<{ ok: boolean }>('DELETE', `/api/training/batches/${id}`),
  getTrainingBatch: (id: string) =>
    request<{ batch: TrainingBatch; items: TrainingItem[] }>('GET', `/api/training/batches/${id}`),
  startTrainingBatch: (id: string) =>
    request<TrainingBatch>('POST', `/api/training/batches/${id}/start`),
  pauseTrainingBatch: (id: string) =>
    request<{ ok: boolean }>('POST', `/api/training/batches/${id}/pause`),
  cancelTrainingBatch: (id: string) =>
    request<{ ok: boolean }>('POST', `/api/training/batches/${id}/cancel`),
  scoreTrainingItem: (id: string, score: number) =>
    request<TrainingItem>('POST', `/api/training/items/${id}/score`, { score }),
  getTrajectory: (runId: string, thinking = false) =>
    request<Trajectory>(
      'GET',
      `/api/training/runs/${runId}/trajectory${thinking ? '?thinking=1' : ''}`,
    ),
  previewTrainingExport: (input: TrainingExportRequest) =>
    request<TrainingExportPreview>('POST', '/api/training/export/preview', input),

  // Paramètres
  getSettings: () => request<Settings>('GET', '/api/settings'),
  patchSettings: (patch: Partial<Settings>) => request<Settings>('PATCH', '/api/settings', patch),
};
