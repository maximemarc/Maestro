/**
 * Lecture d'une ligne SQL vers le modèle de domaine.
 *
 * Sorti de `db.ts` avec le schéma : ce sont les deux faces d'une même chose,
 * et ils changent ensemble. Les garder à côté des 148 méthodes de `Store`
 * noyait la seule question qui compte ici — est-ce que chaque colonne est lue,
 * et lue dans le bon type ?
 *
 * Les convertisseurs sont **exportés** pour être testables directement. Un
 * champ oublié rend `undefined` sans rien casser à la compilation : c'est le
 * genre de défaut qui ne se voit qu'à l'écran, longtemps après.
 */
import type {
  AgentConfig,
  Approval,
  ApprovalResolver,
  ApprovalStatus,
  Beat,
  FederatedPeer,
  KanbanColumn,
  KanbanTask,
  LogLevel,
  LogLine,
  McpServerDef,
  Pipeline,
  PipelineRun,
  PluginInstall,
  PluginInventory,
  ProviderAccount,
  ProviderKind,
  RagCollection,
  RagDocument,
  ResiliencePolicy,
  ResilienceTarget,
  Routine,
  Run,
  RunAttempt,
  RunStatus,
  SessionHandoff,
} from '@maestro/shared';
import { decryptMap, type SecretBox } from '../secrets.ts';
import { safeJsonParse } from '../util.ts';

export type SqlRow = Record<string, string | number | bigint | Buffer | null>;
export type SqlValue = string | number | bigint | Buffer | null | undefined;

export function num(v: SqlValue): number {
  return typeof v === 'bigint' ? Number(v) : (v as number);
}
export function str(v: SqlValue): string {
  return v as string;
}
export function strOrNull(v: SqlValue): string | null {
  return v === null || v === undefined ? null : (v as string);
}
export function numOrNull(v: SqlValue): number | null {
  return v === null || v === undefined ? null : num(v);
}
export function bool(v: SqlValue): boolean {
  return num(v) === 1;
}

export function rowToAgent(r: SqlRow): AgentConfig {
  return {
    id: str(r.id),
    name: str(r.name),
    emoji: str(r.emoji),
    description: str(r.description),
    model: str(r.model),
    engine: str(r.engine) as AgentConfig['engine'],
    permissionMode: str(r.permission_mode) as AgentConfig['permissionMode'],
    approvalPolicy: str(r.approval_policy) as AgentConfig['approvalPolicy'],
    systemPrompt: strOrNull(r.system_prompt),
    cliAgent: strOrNull(r.cli_agent),
    parentAgentId: strOrNull(r.parent_agent_id),
    pluginIds: safeJsonParse<string[]>(str(r.plugin_ids ?? '[]'), []),
    mcpServerIds: safeJsonParse<string[]>(str(r.mcp_server_ids ?? '[]'), []),
    ragCollectionIds: safeJsonParse<string[]>(str(r.rag_collection_ids ?? '[]'), []),
    resiliencePolicyId: strOrNull(r.resilience_policy_id ?? null),
    workspaceDir: str(r.workspace_dir),
    memoryEnabled: bool(r.memory_enabled),
    allowedTools:
      r.allowed_tools === null ? null : safeJsonParse<string[]>(str(r.allowed_tools), []),
    disallowedTools:
      r.disallowed_tools === null ? null : safeJsonParse<string[]>(str(r.disallowed_tools), []),
    maxTurns: numOrNull(r.max_turns),
    timeoutSec: numOrNull(r.timeout_sec),
    tokenBudget: numOrNull(r.token_budget),
    sandbox:
      r.sandbox === null || r.sandbox === undefined
        ? null
        : safeJsonParse<AgentConfig['sandbox']>(str(r.sandbox), null),
    color: str(r.color),
    pinned: r.pinned === null ? null : safeJsonParse(str(r.pinned), null),
    archived: bool(r.archived),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function rowToPeer(r: SqlRow): FederatedPeer {
  return {
    id: str(r.id),
    name: str(r.name),
    baseUrl: str(r.base_url),
    tokenEnv: str(r.token_env),
    enabled: bool(r.enabled),
    maxConcurrent: num(r.max_concurrent),
    health: str(r.health) as FederatedPeer['health'],
    openUntil: strOrNull(r.open_until),
    lastError: strOrNull(r.last_error),
    lastCheckedAt: strOrNull(r.last_checked_at),
    detail: strOrNull(r.detail),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function rowToBeat(r: SqlRow): Beat {
  return {
    id: num(r.id),
    at: str(r.at),
    outcome: str(r.outcome) as Beat['outcome'],
    reason: strOrNull(r.reason),
    runId: strOrNull(r.run_id),
    summary: strOrNull(r.summary),
  };
}

export function rowToProviderAccount(r: SqlRow): ProviderAccount {
  return {
    id: str(r.id),
    name: str(r.name),
    kind: str(r.kind) as ProviderAccount['kind'],
    enabled: bool(r.enabled),
    authMode: str(r.auth_mode) as ProviderAccount['authMode'],
    configDir: strOrNull(r.config_dir),
    apiKeyEnv: strOrNull(r.api_key_env),
    baseUrl: strOrNull(r.base_url),
    apiFlavor: strOrNull(r.api_flavor) as ProviderAccount['apiFlavor'],
    model: strOrNull(r.model),
    command: strOrNull(r.command),
    args: r.args === null ? null : safeJsonParse<string[]>(str(r.args), []),
    env: safeJsonParse<Record<string, string>>(str(r.env ?? '{}'), {}),
    priority: num(r.priority),
    dailyCostLimitUsd: numOrNull(r.daily_cost_limit_usd),
    usageWindowSec: r.usage_window_sec === undefined ? 18000 : num(r.usage_window_sec),
    windowTokenLimit: numOrNull(r.window_token_limit ?? null),
    learnedTokenLimit: numOrNull(r.learned_token_limit ?? null),
    learnedAt: strOrNull(r.learned_at ?? null),
    health: str(r.health) as ProviderAccount['health'],
    cooldownUntil: strOrNull(r.cooldown_until),
    lastError: strOrNull(r.last_error),
    lastCheckedAt: strOrNull(r.last_checked_at),
    detail: strOrNull(r.detail),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function rowToPolicy(r: SqlRow): ResiliencePolicy {
  return {
    id: str(r.id),
    name: str(r.name),
    description: str(r.description),
    targets: safeJsonParse<ResilienceTarget[]>(str(r.targets ?? '[]'), []),
    maxAttemptsPerTarget: num(r.max_attempts_per_target),
    maxTotalAttempts: num(r.max_total_attempts),
    backoffInitialMs: num(r.backoff_initial_ms),
    backoffFactor: num(r.backoff_factor),
    backoffMaxMs: num(r.backoff_max_ms),
    backoffJitter: bool(r.backoff_jitter),
    quotaWaitMaxSec: num(r.quota_wait_max_sec),
    switchOnError: bool(r.switch_on_error),
    handoffThresholdPct: num(r.handoff_threshold_pct),
    quotaPressurePct: r.quota_pressure_pct === undefined ? 85 : num(r.quota_pressure_pct),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function rowToAttempt(r: SqlRow): RunAttempt {
  return {
    id: num(r.id),
    runId: str(r.run_id),
    index: num(r.idx),
    accountId: strOrNull(r.account_id),
    accountName: str(r.account_name),
    providerKind: str(r.provider_kind) as RunAttempt['providerKind'],
    model: str(r.model),
    status: str(r.status) as RunAttempt['status'],
    failureClass: strOrNull(r.failure_class) as RunAttempt['failureClass'],
    error: strOrNull(r.error),
    waitedMs: num(r.waited_ms),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_tokens),
    cacheWriteTokens: num(r.cache_write_tokens),
    costUsd: num(r.cost_usd),
    startedAt: str(r.started_at),
    endedAt: strOrNull(r.ended_at),
  };
}

export function rowToHandoff(r: SqlRow): SessionHandoff {
  return {
    id: str(r.id),
    runId: str(r.run_id),
    agentId: str(r.agent_id),
    reason: str(r.reason) as SessionHandoff['reason'],
    summary: str(r.summary),
    degraded: bool(r.degraded),
    sourceKind: str(r.source_kind) as SessionHandoff['sourceKind'],
    sourceAccountId: strOrNull(r.source_account_id),
    sourceSessionId: strOrNull(r.source_session_id),
    tokensAtCapture: num(r.tokens_at_capture),
    createdAt: str(r.created_at),
  };
}

/**
 * Deserialise un serveur MCP.
 *
 * Prend le coffre en argument : les valeurs sensibles sont chiffrees en base,
 * et une valeur heritee en clair traverse inchangee.
 */
export function rowToMcpServer(r: SqlRow, secrets: SecretBox): McpServerDef {
  return {
    id: str(r.id),
    slug: str(r.slug),
    name: str(r.name),
    description: str(r.description),
    kind: str(r.kind) as McpServerDef['kind'],
    enabled: bool(r.enabled),
    transport: strOrNull(r.transport) as McpServerDef['transport'],
    command: strOrNull(r.command),
    args: safeJsonParse<string[]>(str(r.args ?? '[]'), []),
    env: decryptMap(secrets, safeJsonParse<Record<string, string>>(str(r.env ?? '{}'), {})),
    url: strOrNull(r.url),
    headers: decryptMap(secrets, safeJsonParse<Record<string, string>>(str(r.headers ?? '{}'), {})),
    tools: safeJsonParse<McpServerDef['tools']>(str(r.tools ?? '[]'), []),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function rowToRagCollection(r: SqlRow): RagCollection {
  return {
    id: str(r.id),
    slug: str(r.slug),
    name: str(r.name),
    description: str(r.description),
    chunkSize: num(r.chunk_size),
    chunkOverlap: num(r.chunk_overlap),
    documentCount: num(r.document_count ?? 0),
    chunkCount: num(r.chunk_count ?? 0),
    embeddedChunkCount: num(r.embedded_chunk_count ?? 0),
    /* Rempli par le service RAG : la base ne connaît pas le modèle courant. */
    staleChunkCount: 0,
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function rowToRagDocument(r: SqlRow): RagDocument {
  return {
    id: str(r.id),
    collectionId: str(r.collection_id),
    title: str(r.title),
    sourceKind: str(r.source_kind) as RagDocument['sourceKind'],
    source: str(r.source),
    ingestRoot: strOrNull(r.ingest_root),
    bytes: num(r.bytes),
    chunkCount: num(r.chunk_count ?? 0),
    createdAt: str(r.created_at),
  };
}

/** Morceau tel qu'il est manipulé en interne, vecteur compris. */
export interface StoredChunk {
  id: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  embedding: Float32Array | null;
  /** Modèle qui a produit le vecteur, pour détecter un changement. */
  embeddingModel: string | null;
}

export function toFloat32(value: SqlValue): Float32Array | null {
  if (value === null || value === undefined) return null;
  const buf = value as Buffer;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function rowToStoredChunk(r: SqlRow): StoredChunk {
  return {
    id: str(r.id),
    documentId: str(r.document_id),
    documentTitle: str(r.document_title ?? ''),
    chunkIndex: num(r.chunk_index),
    content: str(r.content),
    embedding: toFloat32(r.embedding),
    embeddingModel: strOrNull(r.embedding_model),
  };
}

export function rowToRun(r: SqlRow): Run {
  return {
    id: str(r.id),
    agentId: str(r.agent_id),
    origin: str(r.origin) as Run['origin'],
    originId: strOrNull(r.origin_id),
    parentRunId: strOrNull(r.parent_run_id),
    prompt: str(r.prompt),
    skillId: strOrNull(r.skill_id),
    status: str(r.status) as RunStatus,
    sessionId: strOrNull(r.session_id),
    model: str(r.model),
    engine: str(r.engine) as Run['engine'],
    tmuxSession: strOrNull(r.tmux_session),
    providerKind: (strOrNull(r.provider_kind ?? null) ?? 'claude-sdk') as ProviderKind,
    accountId: strOrNull(r.account_id ?? null),
    accountName: strOrNull(r.account_name ?? null),
    attemptCount: r.attempt_count === undefined ? 1 : num(r.attempt_count),
    numTurns: num(r.num_turns),
    inputTokens: num(r.input_tokens),
    outputTokens: num(r.output_tokens),
    cacheReadTokens: num(r.cache_read_tokens),
    cacheWriteTokens: num(r.cache_write_tokens),
    costUsd: num(r.cost_usd),
    resultText: strOrNull(r.result_text),
    error: strOrNull(r.error),
    createdAt: str(r.created_at),
    startedAt: strOrNull(r.started_at),
    endedAt: strOrNull(r.ended_at),
  };
}

export function rowToTask(r: SqlRow): KanbanTask {
  return {
    id: str(r.id),
    title: str(r.title),
    description: str(r.description),
    column: str(r.column_name) as KanbanColumn,
    position: num(r.position),
    priority: num(r.priority) as KanbanTask['priority'],
    labels: safeJsonParse<string[]>(str(r.labels), []),
    agentId: strOrNull(r.agent_id),
    runId: strOrNull(r.run_id),
    autoRun: bool(r.auto_run),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function rowToApproval(r: SqlRow): Approval {
  return {
    id: str(r.id),
    runId: str(r.run_id),
    agentId: str(r.agent_id),
    toolName: str(r.tool_name),
    input: safeJsonParse<unknown>(str(r.input), null),
    status: str(r.status) as ApprovalStatus,
    resolvedBy: strOrNull(r.resolved_by) as ApprovalResolver | null,
    resolvedByLabel: strOrNull(r.resolved_by_label),
    note: strOrNull(r.note),
    requestedAt: str(r.requested_at),
    resolvedAt: strOrNull(r.resolved_at),
  };
}

export function rowToRoutine(r: SqlRow): Routine {
  return {
    id: str(r.id),
    name: str(r.name),
    agentId: str(r.agent_id),
    skillId: strOrNull(r.skill_id),
    prompt: str(r.prompt),
    cronExpr: str(r.cron_expr),
    enabled: bool(r.enabled),
    timeoutSec: numOrNull(r.timeout_sec),
    notify: bool(r.notify),
    lastFiredAt: strOrNull(r.last_fired_at),
    nextFireAt: null, // calculé par le scheduler, pas persisté
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function rowToPipeline(r: SqlRow): Pipeline {
  return {
    id: str(r.id),
    name: str(r.name),
    description: str(r.description),
    /* Les étapes enregistrées avant l'arrivée des politiques n'ont pas le
       champ : le normaliser ici évite un `undefined` qui traverserait l'API
       jusqu'au formulaire du front. */
    steps: safeJsonParse<Pipeline['steps']>(str(r.steps), []).map((step) => ({
      ...step,
      resiliencePolicyId: step.resiliencePolicyId ?? null,
    })),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export function rowToPipelineRun(r: SqlRow): PipelineRun {
  return {
    id: str(r.id),
    pipelineId: str(r.pipeline_id),
    status: str(r.status) as PipelineRun['status'],
    input: str(r.input),
    currentStepIndex: num(r.current_step_index),
    stepRuns: safeJsonParse(str(r.step_runs), []),
    startedAt: str(r.started_at),
    endedAt: strOrNull(r.ended_at),
  };
}

export function rowToPlugin(r: SqlRow): PluginInstall {
  return {
    id: str(r.id),
    slug: str(r.slug),
    name: str(r.name),
    description: str(r.description),
    version: strOrNull(r.version),
    repo: strOrNull(r.repo),
    sourceUrl: strOrNull(r.source_url),
    path: str(r.path),
    revision: strOrNull(r.revision),
    inventory: safeJsonParse<PluginInventory>(str(r.inventory), {
      skills: 0,
      agents: 0,
      commands: 0,
      hooks: 0,
      mcpServers: 0,
    }),
    installedAt: str(r.installed_at),
    updatedAt: str(r.updated_at),
  };
}

export function rowToLog(r: SqlRow): LogLine {
  return {
    id: num(r.id),
    ts: str(r.ts),
    level: str(r.level) as LogLevel,
    source: str(r.source),
    message: str(r.message),
    agentId: strOrNull(r.agent_id),
    runId: strOrNull(r.run_id),
  };
}
