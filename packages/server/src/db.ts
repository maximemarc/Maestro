/**
 * Couche de persistance — SQLite natif (node:sqlite), zéro dépendance native.
 * Un seul point d'accès typé (Store) ; les colonnes complexes sont en JSON.
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  McpServerDef,
  RagCollection,
  RagDocument,
  AgentConfig,
  Approval,
  ApprovalResolver,
  ApprovalStatus,
  KanbanColumn,
  KanbanTask,
  LogLevel,
  LogLine,
  Pipeline,
  PipelineRun,
  PluginInstall,
  PluginInventory,
  Routine,
  Run,
  RunEvent,
  RunEventKind,
  RunEventPayload,
  RunStatus,
  Settings,
  AgentStats,
  TokensByBucket,
  OnboardingState,
  ProviderAccount,
  ProviderKind,
  ResiliencePolicy,
  ResilienceTarget,
  RunAttempt,
  SessionHandoff,
} from '@maestro/shared';
import { makeId, nowIso, safeJsonParse } from './util.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🤖',
  description TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'sonnet',
  engine TEXT NOT NULL DEFAULT 'sdk',
  permission_mode TEXT NOT NULL DEFAULT 'default',
  approval_policy TEXT NOT NULL DEFAULT 'guarded',
  system_prompt TEXT,
  cli_agent TEXT,
  parent_agent_id TEXT,
  plugin_ids TEXT NOT NULL DEFAULT '[]',
  workspace_dir TEXT NOT NULL,
  memory_enabled INTEGER NOT NULL DEFAULT 1,
  allowed_tools TEXT,
  disallowed_tools TEXT,
  max_turns INTEGER,
  timeout_sec INTEGER,
  token_budget INTEGER,
  color TEXT NOT NULL DEFAULT '#22d3ee',
  pinned TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  origin TEXT NOT NULL,
  origin_id TEXT,
  parent_run_id TEXT,
  prompt TEXT NOT NULL,
  skill_id TEXT,
  status TEXT NOT NULL,
  session_id TEXT,
  model TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'sdk',
  tmux_session TEXT,
  num_turns INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  result_text TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS run_git_base (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  head TEXT,
  branch TEXT,
  dirty TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  agent_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT 'null',
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_by TEXT,
  note TEXT,
  requested_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  column_name TEXT NOT NULL DEFAULT 'backlog',
  position REAL NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 1,
  labels TEXT NOT NULL DEFAULT '[]',
  agent_id TEXT,
  run_id TEXT,
  auto_run INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  skill_id TEXT,
  prompt TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  timeout_sec INTEGER,
  notify INTEGER NOT NULL DEFAULT 1,
  last_fired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '',
  current_step_index INTEGER NOT NULL DEFAULT 0,
  step_runs TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  agent_id TEXT,
  run_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(id DESC);

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version TEXT,
  repo TEXT,
  source_url TEXT,
  path TEXT NOT NULL,
  revision TEXT,
  inventory TEXT NOT NULL DEFAULT '{}',
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  transport TEXT,
  command TEXT,
  args TEXT NOT NULL DEFAULT '[]',
  env TEXT NOT NULL DEFAULT '{}',
  url TEXT,
  headers TEXT NOT NULL DEFAULT '{}',
  tools TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rag_collections (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  chunk_size INTEGER NOT NULL DEFAULT 1200,
  chunk_overlap INTEGER NOT NULL DEFAULT 150,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rag_documents (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES rag_collections(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rag_documents_collection ON rag_documents(collection_id);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES rag_collections(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  /* Vecteur d'embedding sérialisé en Float32 ; NULL tant qu'aucun moteur
     d'embeddings n'est configuré. */
  embedding BLOB,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_collection ON rag_chunks(collection_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_document ON rag_chunks(document_id);

/*
 * Index plein texte des morceaux.
 *
 * L'option unicode61 remove_diacritics 2 est indispensable : sans lui, « liasse
 * fiscale » ne retrouve pas « Liasse Fiscale », et « ecriture » ne retrouve pas
 * « écriture ». Sur un corpus francophone, c'est la différence entre un index
 * utile et un index qui ne trouve rien.
 *
 * La table garde sa propre copie du texte plutôt que de pointer sur rag_chunks.
 * Cela coûte de l'espace disque, et permet en échange de supprimer une entrée
 * par un DELETE ... WHERE chunk_id = ? ; avec une table externe, il faudrait
 * rejouer le contenu exact d'origine pour désindexer, ce qui casse dès qu'une
 * réindexation change la découpe.
 */
CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(
  content,
  chunk_id UNINDEXED,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS provider_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  auth_mode TEXT NOT NULL DEFAULT 'inherit',
  config_dir TEXT,
  api_key_env TEXT,
  base_url TEXT,
  api_flavor TEXT,
  model TEXT,
  command TEXT,
  args TEXT,
  env TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 100,
  daily_cost_limit_usd REAL,
  health TEXT NOT NULL DEFAULT 'unknown',
  cooldown_until TEXT,
  last_error TEXT,
  last_checked_at TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resilience_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  targets TEXT NOT NULL DEFAULT '[]',
  max_attempts_per_target INTEGER NOT NULL DEFAULT 2,
  max_total_attempts INTEGER NOT NULL DEFAULT 4,
  backoff_initial_ms INTEGER NOT NULL DEFAULT 2000,
  backoff_factor REAL NOT NULL DEFAULT 3,
  backoff_max_ms INTEGER NOT NULL DEFAULT 60000,
  backoff_jitter INTEGER NOT NULL DEFAULT 1,
  quota_wait_max_sec INTEGER NOT NULL DEFAULT 900,
  switch_on_error INTEGER NOT NULL DEFAULT 1,
  handoff_threshold_pct INTEGER NOT NULL DEFAULT 80,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

/*
 * Tentatives d'un run.
 *
 * Table à part plutôt que colonnes de la table runs : un run réussi du premier
 * coup n’a rien à porter, et un run qui a basculé trois fois ne tient pas dans
 * une ligne. C’est aussi la seule trace qui explique pourquoi un run a fini
 * ailleurs que là où il avait commencé.
 */
CREATE TABLE IF NOT EXISTS run_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  account_id TEXT,
  account_name TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  failure_class TEXT,
  error TEXT,
  waited_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_attempts_run ON run_attempts(run_id, idx);

CREATE TABLE IF NOT EXISTS session_handoffs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  summary TEXT NOT NULL,
  degraded INTEGER NOT NULL DEFAULT 0,
  source_kind TEXT NOT NULL,
  source_account_id TEXT,
  source_session_id TEXT,
  tokens_at_capture INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs_run ON session_handoffs(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_agent ON session_handoffs(agent_id, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const DEFAULT_SETTINGS: Settings = {
  instanceName: 'Maestro',
  telegramNotifyAllRuns: false,
  approvalTimeoutSec: 900,
  maxConcurrentRuns: 4,
  maxAgentDepth: 2,
  defaultResiliencePolicyId: null,
};

/**
 * État de l'assistant de configuration.
 *
 * Rangé dans la table `settings` sous une clé dédiée plutôt que dans `Settings` :
 * c'est un état de parcours, pas un réglage. Le mélanger aux réglages
 * l'exposerait à être réinitialisé par un formulaire qui n'en sait rien.
 */
const ONBOARDING_KEY = 'onboarding';

const DEFAULT_ONBOARDING: OnboardingState = {
  completed: false,
  step: 'welcome',
  completedAt: null,
  skipped: [],
};

// -- helpers de (dé)sérialisation ------------------------------------------

type SqlRow = Record<string, string | number | bigint | Buffer | null>;
type SqlValue = string | number | bigint | Buffer | null | undefined;

function num(v: SqlValue): number {
  return typeof v === 'bigint' ? Number(v) : (v as number);
}
function str(v: SqlValue): string {
  return v as string;
}
function strOrNull(v: SqlValue): string | null {
  return v === null || v === undefined ? null : (v as string);
}
function numOrNull(v: SqlValue): number | null {
  return v === null || v === undefined ? null : num(v);
}
function bool(v: SqlValue): boolean {
  return num(v) === 1;
}

function rowToAgent(r: SqlRow): AgentConfig {
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
    color: str(r.color),
    pinned: r.pinned === null ? null : safeJsonParse(str(r.pinned), null),
    archived: bool(r.archived),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function rowToProviderAccount(r: SqlRow): ProviderAccount {
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
    health: str(r.health) as ProviderAccount['health'],
    cooldownUntil: strOrNull(r.cooldown_until),
    lastError: strOrNull(r.last_error),
    lastCheckedAt: strOrNull(r.last_checked_at),
    detail: strOrNull(r.detail),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function rowToPolicy(r: SqlRow): ResiliencePolicy {
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
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function rowToAttempt(r: SqlRow): RunAttempt {
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

function rowToHandoff(r: SqlRow): SessionHandoff {
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

function rowToMcpServer(r: SqlRow): McpServerDef {
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
    env: safeJsonParse<Record<string, string>>(str(r.env ?? '{}'), {}),
    url: strOrNull(r.url),
    headers: safeJsonParse<Record<string, string>>(str(r.headers ?? '{}'), {}),
    tools: safeJsonParse<McpServerDef['tools']>(str(r.tools ?? '[]'), []),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function rowToRagCollection(r: SqlRow): RagCollection {
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

function rowToRagDocument(r: SqlRow): RagDocument {
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

function toFloat32(value: SqlValue): Float32Array | null {
  if (value === null || value === undefined) return null;
  const buf = value as Buffer;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function rowToStoredChunk(r: SqlRow): StoredChunk {
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

function rowToRun(r: SqlRow): Run {
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

function rowToTask(r: SqlRow): KanbanTask {
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

function rowToApproval(r: SqlRow): Approval {
  return {
    id: str(r.id),
    runId: str(r.run_id),
    agentId: str(r.agent_id),
    toolName: str(r.tool_name),
    input: safeJsonParse<unknown>(str(r.input), null),
    status: str(r.status) as ApprovalStatus,
    resolvedBy: strOrNull(r.resolved_by) as ApprovalResolver | null,
    note: strOrNull(r.note),
    requestedAt: str(r.requested_at),
    resolvedAt: strOrNull(r.resolved_at),
  };
}

function rowToRoutine(r: SqlRow): Routine {
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

function rowToPipeline(r: SqlRow): Pipeline {
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

function rowToPipelineRun(r: SqlRow): PipelineRun {
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

function rowToPlugin(r: SqlRow): PluginInstall {
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

function rowToLog(r: SqlRow): LogLine {
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

// ---------------------------------------------------------------------------

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Migrations additives idempotentes : CREATE TABLE IF NOT EXISTS ne fait rien
   * sur une table déjà présente, les colonnes ajoutées après coup doivent donc
   * l'être explicitement.
   */
  private migrate(): void {
    const added: Array<[table: string, column: string, ddl: string]> = [
      ['agents', 'cli_agent', 'ALTER TABLE agents ADD COLUMN cli_agent TEXT'],
      ['agents', 'parent_agent_id', 'ALTER TABLE agents ADD COLUMN parent_agent_id TEXT'],
      [
        'agents',
        'plugin_ids',
        "ALTER TABLE agents ADD COLUMN plugin_ids TEXT NOT NULL DEFAULT '[]'",
      ],
      [
        'agents',
        'mcp_server_ids',
        "ALTER TABLE agents ADD COLUMN mcp_server_ids TEXT NOT NULL DEFAULT '[]'",
      ],
      [
        'agents',
        'rag_collection_ids',
        "ALTER TABLE agents ADD COLUMN rag_collection_ids TEXT NOT NULL DEFAULT '[]'",
      ],
      /*
       * Le contenu d'origine du document.
       *
       * Il manquait, et cela rendait la réindexation impossible : seuls les
       * morceaux découpés étaient conservés, or le recouvrement interdit de
       * reconstituer le texte à partir d'eux. Changer la taille de découpe
       * obligeait donc à retrouver la source ailleurs, et pour un texte collé
       * il n'y en avait pas.
       */
      ['rag_documents', 'content', 'ALTER TABLE rag_documents ADD COLUMN content TEXT'],
      /*
       * Ce que l'utilisateur a désigné à l'ingestion, par opposition au chemin
       * de chaque fichier trouvé dedans. Sans cette racine, rafraîchir un
       * dossier ne peut relire que les fichiers déjà connus, et manque ceux
       * qui y ont été ajoutés depuis.
       */
      ['rag_documents', 'ingest_root', 'ALTER TABLE rag_documents ADD COLUMN ingest_root TEXT'],
      /*
       * Modèle qui a produit le vecteur.
       *
       * Deux fournisseurs ne rendent pas la même dimension (1024 pour Voyage,
       * 1536 pour OpenAI) : sans cette colonne, changer de fournisseur laissait
       * les anciens vecteurs en place, incomparables et silencieusement inutiles.
       */
      ['rag_chunks', 'embedding_model', 'ALTER TABLE rag_chunks ADD COLUMN embedding_model TEXT'],
      /*
       * Politique de résilience d'un agent : ordre des comptes, retries,
       * attente de quota. Nullable, et c'est voulu — un agent sans politique
       * garde exactement le comportement d'avant les fournisseurs multiples.
       */
      ['agents', 'resilience_policy_id', 'ALTER TABLE agents ADD COLUMN resilience_policy_id TEXT'],
      /*
       * Fournisseur et compte effectifs d'un run.
       *
       * Le défaut `claude-sdk` sur les lignes existantes n'est pas une
       * supposition : avant ce lot, Maestro ne savait exécuter que ça.
       */
      [
        'runs',
        'provider_kind',
        "ALTER TABLE runs ADD COLUMN provider_kind TEXT NOT NULL DEFAULT 'claude-sdk'",
      ],
      ['runs', 'account_id', 'ALTER TABLE runs ADD COLUMN account_id TEXT'],
      ['runs', 'account_name', 'ALTER TABLE runs ADD COLUMN account_name TEXT'],
      [
        'runs',
        'attempt_count',
        'ALTER TABLE runs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1',
      ],
    ];
    for (const [table, column, ddl] of added) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as SqlRow[];
      if (cols.some((c) => str(c.name) === column)) continue;
      this.db.exec(ddl);
    }
  }

  close(): void {
    this.db.close();
  }

  // -- Agents ---------------------------------------------------------------

  listAgents(includeArchived = false): AgentConfig[] {
    const sql = includeArchived
      ? 'SELECT * FROM agents ORDER BY created_at'
      : 'SELECT * FROM agents WHERE archived = 0 ORDER BY created_at';
    return (this.db.prepare(sql).all() as SqlRow[]).map(rowToAgent);
  }

  getAgent(id: string): AgentConfig | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as SqlRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  getAgentByName(name: string): AgentConfig | null {
    const row = this.db
      .prepare('SELECT * FROM agents WHERE LOWER(name) = LOWER(?) AND archived = 0')
      .get(name) as SqlRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  insertAgent(agent: AgentConfig): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, name, emoji, description, model, engine, permission_mode,
          approval_policy, system_prompt, cli_agent, parent_agent_id, plugin_ids, mcp_server_ids, rag_collection_ids, resilience_policy_id, workspace_dir,
          memory_enabled, allowed_tools, disallowed_tools, max_turns, timeout_sec, token_budget,
          color, pinned, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.id,
        agent.name,
        agent.emoji,
        agent.description,
        agent.model,
        agent.engine,
        agent.permissionMode,
        agent.approvalPolicy,
        agent.systemPrompt,
        agent.cliAgent,
        agent.parentAgentId,
        JSON.stringify(agent.pluginIds ?? []),
        JSON.stringify(agent.mcpServerIds ?? []),
        JSON.stringify(agent.ragCollectionIds ?? []),
        agent.resiliencePolicyId ?? null,
        agent.workspaceDir,
        agent.memoryEnabled ? 1 : 0,
        agent.allowedTools ? JSON.stringify(agent.allowedTools) : null,
        agent.disallowedTools ? JSON.stringify(agent.disallowedTools) : null,
        agent.maxTurns,
        agent.timeoutSec,
        agent.tokenBudget,
        agent.color,
        agent.pinned ? JSON.stringify(agent.pinned) : null,
        agent.archived ? 1 : 0,
        agent.createdAt,
        agent.updatedAt,
      );
  }

  updateAgent(agent: AgentConfig): void {
    this.db
      .prepare(
        `UPDATE agents SET name=?, emoji=?, description=?, model=?, engine=?, permission_mode=?,
          approval_policy=?, system_prompt=?, cli_agent=?, parent_agent_id=?, plugin_ids=?,
          mcp_server_ids=?, rag_collection_ids=?, resilience_policy_id=?,
          workspace_dir=?, memory_enabled=?, allowed_tools=?,
          disallowed_tools=?, max_turns=?, timeout_sec=?, token_budget=?, color=?, pinned=?,
          archived=?, updated_at=? WHERE id=?`,
      )
      .run(
        agent.name,
        agent.emoji,
        agent.description,
        agent.model,
        agent.engine,
        agent.permissionMode,
        agent.approvalPolicy,
        agent.systemPrompt,
        agent.cliAgent,
        agent.parentAgentId,
        JSON.stringify(agent.pluginIds ?? []),
        JSON.stringify(agent.mcpServerIds ?? []),
        JSON.stringify(agent.ragCollectionIds ?? []),
        agent.resiliencePolicyId ?? null,
        agent.workspaceDir,
        agent.memoryEnabled ? 1 : 0,
        agent.allowedTools ? JSON.stringify(agent.allowedTools) : null,
        agent.disallowedTools ? JSON.stringify(agent.disallowedTools) : null,
        agent.maxTurns,
        agent.timeoutSec,
        agent.tokenBudget,
        agent.color,
        agent.pinned ? JSON.stringify(agent.pinned) : null,
        agent.archived ? 1 : 0,
        nowIso(),
        agent.id,
      );
  }

  deleteAgent(id: string): void {
    this.db.prepare('DELETE FROM run_events WHERE agent_id = ?').run(id);
    this.db.prepare('DELETE FROM runs WHERE agent_id = ?').run(id);
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }

  // -- Runs -------------------------------------------------------------------

  insertRun(run: Run): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, agent_id, origin, origin_id, parent_run_id, prompt, skill_id,
          status, session_id, model, engine, tmux_session, provider_kind, account_id, account_name,
          attempt_count, num_turns, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, cost_usd, result_text, error, created_at,
          started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.agentId,
        run.origin,
        run.originId,
        run.parentRunId,
        run.prompt,
        run.skillId,
        run.status,
        run.sessionId,
        run.model,
        run.engine,
        run.tmuxSession,
        run.providerKind,
        run.accountId,
        run.accountName,
        run.attemptCount,
        run.numTurns,
        run.inputTokens,
        run.outputTokens,
        run.cacheReadTokens,
        run.cacheWriteTokens,
        run.costUsd,
        run.resultText,
        run.error,
        run.createdAt,
        run.startedAt,
        run.endedAt,
      );
  }

  updateRun(run: Run): void {
    this.db
      .prepare(
        `UPDATE runs SET status=?, session_id=?, tmux_session=?, provider_kind=?, account_id=?,
          account_name=?, attempt_count=?, num_turns=?, input_tokens=?,
          output_tokens=?, cache_read_tokens=?, cache_write_tokens=?, cost_usd=?, result_text=?,
          error=?, started_at=?, ended_at=? WHERE id=?`,
      )
      .run(
        run.status,
        run.sessionId,
        run.tmuxSession,
        run.providerKind,
        run.accountId,
        run.accountName,
        run.attemptCount,
        run.numTurns,
        run.inputTokens,
        run.outputTokens,
        run.cacheReadTokens,
        run.cacheWriteTokens,
        run.costUsd,
        run.resultText,
        run.error,
        run.startedAt,
        run.endedAt,
        run.id,
      );
  }

  /**
   * Point de référence git pris au démarrage d'un run.
   *
   * Table à part, et non colonnes de `runs` : cette donnée n'est lue que par la
   * vue des modifications, alors que `Run` est diffusé à chaque événement
   * WebSocket. Y ajouter une liste de fichiers aurait gonflé tous les messages
   * du flux pour un usage ponctuel.
   */
  saveRunGitBase(
    runId: string,
    base: { head: string | null; branch: string | null; dirty: string[] },
  ): void {
    this.db
      .prepare(
        `INSERT INTO run_git_base (run_id, head, branch, dirty) VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET head=excluded.head, branch=excluded.branch, dirty=excluded.dirty`,
      )
      .run(runId, base.head, base.branch, JSON.stringify(base.dirty));
  }

  getRunGitBase(
    runId: string,
  ): { head: string | null; branch: string | null; dirty: string[] } | null {
    const row = this.db.prepare('SELECT * FROM run_git_base WHERE run_id = ?').get(runId) as
      SqlRow | undefined;
    if (!row) return null;
    return {
      head: strOrNull(row.head),
      branch: strOrNull(row.branch),
      dirty: safeJsonParse<string[]>(str(row.dirty), []),
    };
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as SqlRow | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(opts: { agentId?: string; status?: RunStatus; limit?: number } = {}): Run[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.agentId) {
      clauses.push('agent_id = ?');
      params.push(opts.agentId);
    }
    if (opts.status) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT * FROM runs ${where} ORDER BY created_at DESC LIMIT ?`;
    params.push(opts.limit ?? 100);
    return (this.db.prepare(sql).all(...params) as SqlRow[]).map(rowToRun);
  }

  listActiveRuns(): Run[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM runs WHERE status IN ('queued','running','waiting_approval') ORDER BY created_at`,
        )
        .all() as SqlRow[]
    ).map(rowToRun);
  }

  /** Runs délégués encore actifs par un run parent (annulation en cascade). */
  listActiveChildRuns(parentRunId: string): Run[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM runs WHERE parent_run_id = ?
           AND status IN ('queued','running','waiting_approval') ORDER BY created_at`,
      )
      .all(parentRunId) as SqlRow[];
    return rows.map(rowToRun);
  }

  /** Marque interrompus les runs restés actifs après un crash/redémarrage. */
  failStaleActiveRuns(reason: string): number {
    const res = this.db
      .prepare(
        `UPDATE runs SET status='failed', error=?, ended_at=? WHERE status IN ('queued','running','waiting_approval')`,
      )
      .run(reason, nowIso());
    return Number(res.changes);
  }

  // -- Run events -------------------------------------------------------------

  insertRunEvent(
    runId: string,
    agentId: string,
    kind: RunEventKind,
    payload: RunEventPayload,
  ): RunEvent {
    const ts = nowIso();
    const res = this.db
      .prepare(
        'INSERT INTO run_events (run_id, agent_id, ts, kind, payload) VALUES (?, ?, ?, ?, ?)',
      )
      .run(runId, agentId, ts, kind, JSON.stringify(payload));
    return { id: Number(res.lastInsertRowid), runId, agentId, ts, kind, payload };
  }

  listRunEvents(runId: string, afterId = 0, limit = 5000): RunEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM run_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?')
      .all(runId, afterId, limit) as SqlRow[];
    return rows.map((r) => ({
      id: num(r.id),
      runId: str(r.run_id),
      agentId: str(r.agent_id),
      ts: str(r.ts),
      kind: str(r.kind) as RunEventKind,
      payload: safeJsonParse<RunEventPayload>(str(r.payload), {}),
    }));
  }

  // -- Approvals ---------------------------------------------------------------

  insertApproval(a: Approval): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, run_id, agent_id, tool_name, input, status, resolved_by, note,
          requested_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.runId,
        a.agentId,
        a.toolName,
        JSON.stringify(a.input ?? null),
        a.status,
        a.resolvedBy,
        a.note,
        a.requestedAt,
        a.resolvedAt,
      );
  }

  resolveApproval(
    id: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    resolvedBy: ApprovalResolver,
    note: string | null,
  ): Approval | null {
    this.db
      .prepare(
        "UPDATE approvals SET status=?, resolved_by=?, note=?, resolved_at=? WHERE id=? AND status='pending'",
      )
      .run(status, resolvedBy, note, nowIso(), id);
    return this.getApproval(id);
  }

  getApproval(id: string): Approval | null {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row ? rowToApproval(row) : null;
  }

  listApprovals(status?: ApprovalStatus, limit = 200): Approval[] {
    const rows = (
      status
        ? this.db
            .prepare('SELECT * FROM approvals WHERE status = ? ORDER BY requested_at DESC LIMIT ?')
            .all(status, limit)
        : this.db.prepare('SELECT * FROM approvals ORDER BY requested_at DESC LIMIT ?').all(limit)
    ) as SqlRow[];
    return rows.map(rowToApproval);
  }

  // -- Tasks (kanban) -----------------------------------------------------------

  listTasks(): KanbanTask[] {
    return (
      this.db.prepare('SELECT * FROM tasks ORDER BY column_name, position').all() as SqlRow[]
    ).map(rowToTask);
  }

  getTask(id: string): KanbanTask | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as SqlRow | undefined;
    return row ? rowToTask(row) : null;
  }

  insertTask(t: KanbanTask): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, description, column_name, position, priority, labels,
          agent_id, run_id, auto_run, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.id,
        t.title,
        t.description,
        t.column,
        t.position,
        t.priority,
        JSON.stringify(t.labels),
        t.agentId,
        t.runId,
        t.autoRun ? 1 : 0,
        t.createdAt,
        t.updatedAt,
      );
  }

  updateTask(t: KanbanTask): void {
    this.db
      .prepare(
        `UPDATE tasks SET title=?, description=?, column_name=?, position=?, priority=?, labels=?,
          agent_id=?, run_id=?, auto_run=?, updated_at=? WHERE id=?`,
      )
      .run(
        t.title,
        t.description,
        t.column,
        t.position,
        t.priority,
        JSON.stringify(t.labels),
        t.agentId,
        t.runId,
        t.autoRun ? 1 : 0,
        nowIso(),
        t.id,
      );
  }

  deleteTask(id: string): void {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  nextTaskPosition(column: KanbanColumn): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(position), 0) AS maxpos FROM tasks WHERE column_name = ?')
      .get(column) as SqlRow;
    return num(row.maxpos) + 10;
  }

  // -- Routines -------------------------------------------------------------------

  listRoutines(): Routine[] {
    return (this.db.prepare('SELECT * FROM routines ORDER BY created_at').all() as SqlRow[]).map(
      rowToRoutine,
    );
  }

  getRoutine(id: string): Routine | null {
    const row = this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row ? rowToRoutine(row) : null;
  }

  insertRoutine(r: Routine): void {
    this.db
      .prepare(
        `INSERT INTO routines (id, name, agent_id, skill_id, prompt, cron_expr, enabled,
          timeout_sec, notify, last_fired_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.id,
        r.name,
        r.agentId,
        r.skillId,
        r.prompt,
        r.cronExpr,
        r.enabled ? 1 : 0,
        r.timeoutSec,
        r.notify ? 1 : 0,
        r.lastFiredAt,
        r.createdAt,
        r.updatedAt,
      );
  }

  updateRoutine(r: Routine): void {
    this.db
      .prepare(
        `UPDATE routines SET name=?, agent_id=?, skill_id=?, prompt=?, cron_expr=?, enabled=?,
          timeout_sec=?, notify=?, last_fired_at=?, updated_at=? WHERE id=?`,
      )
      .run(
        r.name,
        r.agentId,
        r.skillId,
        r.prompt,
        r.cronExpr,
        r.enabled ? 1 : 0,
        r.timeoutSec,
        r.notify ? 1 : 0,
        r.lastFiredAt,
        nowIso(),
        r.id,
      );
  }

  deleteRoutine(id: string): void {
    this.db.prepare('DELETE FROM routines WHERE id = ?').run(id);
  }

  // -- Pipelines --------------------------------------------------------------------

  listPipelines(): Pipeline[] {
    return (this.db.prepare('SELECT * FROM pipelines ORDER BY created_at').all() as SqlRow[]).map(
      rowToPipeline,
    );
  }

  getPipeline(id: string): Pipeline | null {
    const row = this.db.prepare('SELECT * FROM pipelines WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row ? rowToPipeline(row) : null;
  }

  insertPipeline(p: Pipeline): void {
    this.db
      .prepare(
        'INSERT INTO pipelines (id, name, description, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(p.id, p.name, p.description, JSON.stringify(p.steps), p.createdAt, p.updatedAt);
  }

  updatePipeline(p: Pipeline): void {
    this.db
      .prepare('UPDATE pipelines SET name=?, description=?, steps=?, updated_at=? WHERE id=?')
      .run(p.name, p.description, JSON.stringify(p.steps), nowIso(), p.id);
  }

  deletePipeline(id: string): void {
    this.db.prepare('DELETE FROM pipelines WHERE id = ?').run(id);
  }

  insertPipelineRun(pr: PipelineRun): void {
    this.db
      .prepare(
        `INSERT INTO pipeline_runs (id, pipeline_id, status, input, current_step_index, step_runs,
          started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pr.id,
        pr.pipelineId,
        pr.status,
        pr.input,
        pr.currentStepIndex,
        JSON.stringify(pr.stepRuns),
        pr.startedAt,
        pr.endedAt,
      );
  }

  updatePipelineRun(pr: PipelineRun): void {
    this.db
      .prepare(
        'UPDATE pipeline_runs SET status=?, current_step_index=?, step_runs=?, ended_at=? WHERE id=?',
      )
      .run(pr.status, pr.currentStepIndex, JSON.stringify(pr.stepRuns), pr.endedAt, pr.id);
  }

  getPipelineRun(id: string): PipelineRun | null {
    const row = this.db.prepare('SELECT * FROM pipeline_runs WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row ? rowToPipelineRun(row) : null;
  }

  listPipelineRuns(pipelineId?: string, limit = 50): PipelineRun[] {
    const rows = (
      pipelineId
        ? this.db
            .prepare(
              'SELECT * FROM pipeline_runs WHERE pipeline_id = ? ORDER BY started_at DESC LIMIT ?',
            )
            .all(pipelineId, limit)
        : this.db.prepare('SELECT * FROM pipeline_runs ORDER BY started_at DESC LIMIT ?').all(limit)
    ) as SqlRow[];
    return rows.map(rowToPipelineRun);
  }

  // -- Plugins -----------------------------------------------------------------------

  listPlugins(): PluginInstall[] {
    return (this.db.prepare('SELECT * FROM plugins ORDER BY installed_at').all() as SqlRow[]).map(
      rowToPlugin,
    );
  }

  getPlugin(id: string): PluginInstall | null {
    const row = this.db.prepare('SELECT * FROM plugins WHERE id = ?').get(id) as SqlRow | undefined;
    return row ? rowToPlugin(row) : null;
  }

  getPluginBySlug(slug: string): PluginInstall | null {
    const row = this.db.prepare('SELECT * FROM plugins WHERE slug = ?').get(slug) as
      SqlRow | undefined;
    return row ? rowToPlugin(row) : null;
  }

  insertPlugin(p: PluginInstall): void {
    this.db
      .prepare(
        `INSERT INTO plugins (id, slug, name, description, version, repo, source_url, path,
          revision, inventory, installed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.slug,
        p.name,
        p.description,
        p.version,
        p.repo,
        p.sourceUrl,
        p.path,
        p.revision,
        JSON.stringify(p.inventory),
        p.installedAt,
        p.updatedAt,
      );
  }

  updatePlugin(p: PluginInstall): void {
    this.db
      .prepare(
        `UPDATE plugins SET name=?, description=?, version=?, revision=?, inventory=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        p.name,
        p.description,
        p.version,
        p.revision,
        JSON.stringify(p.inventory),
        nowIso(),
        p.id,
      );
  }

  deletePlugin(id: string): void {
    this.db.prepare('DELETE FROM plugins WHERE id = ?').run(id);
  }

  /** Retire un plugin désinstallé de la configuration des agents qui le chargeaient. */
  /**
   * Retire un serveur MCP de tous les agents qui le chargeaient.
   *
   * Sans cela, un identifiant supprimé resterait dans `mcpServerIds` et chaque
   * session tenterait de déclarer un serveur inexistant.
   */
  detachMcpServerFromAgents(mcpServerId: string): number {
    let touched = 0;
    for (const agent of this.listAgents(true)) {
      if (!agent.mcpServerIds.includes(mcpServerId)) continue;
      this.updateAgent({
        ...agent,
        mcpServerIds: agent.mcpServerIds.filter((id) => id !== mcpServerId),
      });
      touched++;
    }
    return touched;
  }

  /** Même principe pour une collection RAG supprimée. */
  detachRagCollectionFromAgents(collectionId: string): number {
    let touched = 0;
    for (const agent of this.listAgents(true)) {
      if (!agent.ragCollectionIds.includes(collectionId)) continue;
      this.updateAgent({
        ...agent,
        ragCollectionIds: agent.ragCollectionIds.filter((id) => id !== collectionId),
      });
      touched++;
    }
    return touched;
  }

  detachPluginFromAgents(pluginId: string): number {
    let touched = 0;
    for (const agent of this.listAgents(true)) {
      if (!agent.pluginIds.includes(pluginId)) continue;
      this.updateAgent({ ...agent, pluginIds: agent.pluginIds.filter((id) => id !== pluginId) });
      touched++;
    }
    return touched;
  }

  // -- Logs --------------------------------------------------------------------------

  insertLog(
    level: LogLevel,
    source: string,
    message: string,
    agentId: string | null,
    runId: string | null,
  ): LogLine {
    const ts = nowIso();
    const res = this.db
      .prepare(
        'INSERT INTO logs (ts, level, source, message, agent_id, run_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(ts, level, source, message, agentId, runId);
    return { id: Number(res.lastInsertRowid), ts, level, source, message, agentId, runId };
  }

  recentLogs(limit = 200): LogLine[] {
    const rows = this.db
      .prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?')
      .all(limit) as SqlRow[];
    return rows.map(rowToLog).reverse();
  }

  // -- Settings ------------------------------------------------------------------------

  getSettings(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as SqlRow[];
    const stored: Partial<Settings> = {};
    for (const row of rows) {
      const key = str(row.key) as keyof Settings;
      (stored as Record<string, unknown>)[key] = safeJsonParse(str(row.value), undefined);
    }
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  patchSettings(patch: Partial<Settings>): Settings {
    const stmt = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      stmt.run(key, JSON.stringify(value));
    }
    return this.getSettings();
  }

  getOnboarding(): OnboardingState {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(ONBOARDING_KEY) as
      SqlRow | undefined;
    if (!row) return { ...DEFAULT_ONBOARDING };
    return {
      ...DEFAULT_ONBOARDING,
      ...safeJsonParse<Partial<OnboardingState>>(str(row.value), {}),
    };
  }

  patchOnboarding(patch: Partial<OnboardingState>): OnboardingState {
    const next = { ...this.getOnboarding(), ...patch };
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(ONBOARDING_KEY, JSON.stringify(next));
    return next;
  }

  // -- Comptes de fournisseurs -----------------------------------------------

  listProviderAccounts(): ProviderAccount[] {
    return (
      this.db.prepare('SELECT * FROM provider_accounts ORDER BY priority, name').all() as SqlRow[]
    ).map(rowToProviderAccount);
  }

  getProviderAccount(id: string): ProviderAccount | null {
    const row = this.db.prepare('SELECT * FROM provider_accounts WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row ? rowToProviderAccount(row) : null;
  }

  insertProviderAccount(account: ProviderAccount): void {
    this.db
      .prepare(
        `INSERT INTO provider_accounts (id, name, kind, enabled, auth_mode, config_dir, api_key_env,
          base_url, api_flavor, model, command, args, env, priority, daily_cost_limit_usd, health,
          cooldown_until, last_error, last_checked_at, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        account.id,
        account.name,
        account.kind,
        account.enabled ? 1 : 0,
        account.authMode,
        account.configDir,
        account.apiKeyEnv,
        account.baseUrl,
        account.apiFlavor,
        account.model,
        account.command,
        account.args ? JSON.stringify(account.args) : null,
        JSON.stringify(account.env ?? {}),
        account.priority,
        account.dailyCostLimitUsd,
        account.health,
        account.cooldownUntil,
        account.lastError,
        account.lastCheckedAt,
        account.detail,
        account.createdAt,
        account.updatedAt,
      );
  }

  updateProviderAccount(account: ProviderAccount): void {
    this.db
      .prepare(
        `UPDATE provider_accounts SET name=?, kind=?, enabled=?, auth_mode=?, config_dir=?,
          api_key_env=?, base_url=?, api_flavor=?, model=?, command=?, args=?, env=?, priority=?,
          daily_cost_limit_usd=?, health=?, cooldown_until=?, last_error=?, last_checked_at=?,
          detail=?, updated_at=? WHERE id=?`,
      )
      .run(
        account.name,
        account.kind,
        account.enabled ? 1 : 0,
        account.authMode,
        account.configDir,
        account.apiKeyEnv,
        account.baseUrl,
        account.apiFlavor,
        account.model,
        account.command,
        account.args ? JSON.stringify(account.args) : null,
        JSON.stringify(account.env ?? {}),
        account.priority,
        account.dailyCostLimitUsd,
        account.health,
        account.cooldownUntil,
        account.lastError,
        account.lastCheckedAt,
        account.detail,
        nowIso(),
        account.id,
      );
  }

  deleteProviderAccount(id: string): void {
    this.db.prepare('DELETE FROM provider_accounts WHERE id = ?').run(id);
  }

  /**
   * Dépense du jour pour un compte, calculée depuis les tentatives.
   *
   * Depuis `run_attempts` et non `runs` : un run qui a basculé de compte a
   * dépensé sur plusieurs, et imputer la totalité au dernier fausserait le
   * plafond quotidien de celui-ci comme celui des autres.
   */
  accountCostToday(accountId: string, dayIsoPrefix: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM run_attempts
         WHERE account_id = ? AND started_at LIKE ?`,
      )
      .get(accountId, `${dayIsoPrefix}%`) as SqlRow | undefined;
    return row ? num(row.total) : 0;
  }

  // -- Politiques de résilience ----------------------------------------------

  listResiliencePolicies(): ResiliencePolicy[] {
    return (
      this.db.prepare('SELECT * FROM resilience_policies ORDER BY name').all() as SqlRow[]
    ).map(rowToPolicy);
  }

  getResiliencePolicy(id: string): ResiliencePolicy | null {
    const row = this.db.prepare('SELECT * FROM resilience_policies WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row ? rowToPolicy(row) : null;
  }

  insertResiliencePolicy(policy: ResiliencePolicy): void {
    this.db
      .prepare(
        `INSERT INTO resilience_policies (id, name, description, targets, max_attempts_per_target,
          max_total_attempts, backoff_initial_ms, backoff_factor, backoff_max_ms, backoff_jitter,
          quota_wait_max_sec, switch_on_error, handoff_threshold_pct, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        policy.id,
        policy.name,
        policy.description,
        JSON.stringify(policy.targets ?? []),
        policy.maxAttemptsPerTarget,
        policy.maxTotalAttempts,
        policy.backoffInitialMs,
        policy.backoffFactor,
        policy.backoffMaxMs,
        policy.backoffJitter ? 1 : 0,
        policy.quotaWaitMaxSec,
        policy.switchOnError ? 1 : 0,
        policy.handoffThresholdPct,
        policy.createdAt,
        policy.updatedAt,
      );
  }

  updateResiliencePolicy(policy: ResiliencePolicy): void {
    this.db
      .prepare(
        `UPDATE resilience_policies SET name=?, description=?, targets=?, max_attempts_per_target=?,
          max_total_attempts=?, backoff_initial_ms=?, backoff_factor=?, backoff_max_ms=?,
          backoff_jitter=?, quota_wait_max_sec=?, switch_on_error=?, handoff_threshold_pct=?,
          updated_at=? WHERE id=?`,
      )
      .run(
        policy.name,
        policy.description,
        JSON.stringify(policy.targets ?? []),
        policy.maxAttemptsPerTarget,
        policy.maxTotalAttempts,
        policy.backoffInitialMs,
        policy.backoffFactor,
        policy.backoffMaxMs,
        policy.backoffJitter ? 1 : 0,
        policy.quotaWaitMaxSec,
        policy.switchOnError ? 1 : 0,
        policy.handoffThresholdPct,
        nowIso(),
        policy.id,
      );
  }

  deleteResiliencePolicy(id: string): void {
    this.db.prepare('DELETE FROM resilience_policies WHERE id = ?').run(id);
  }

  /**
   * Retire un compte supprimé de toutes les politiques qui le citaient.
   *
   * Sans ce nettoyage, une politique garderait une cible fantôme : le routeur
   * la sauterait silencieusement, et l'opérateur croirait disposer d'un repli
   * qui n'existe plus.
   */
  detachAccountFromPolicies(accountId: string): number {
    let touched = 0;
    for (const policy of this.listResiliencePolicies()) {
      if (!policy.targets.some((t) => t.accountId === accountId)) continue;
      this.updateResiliencePolicy({
        ...policy,
        targets: policy.targets.filter((t) => t.accountId !== accountId),
      });
      touched++;
    }
    return touched;
  }

  // -- Tentatives ------------------------------------------------------------

  insertRunAttempt(attempt: Omit<RunAttempt, 'id'>): RunAttempt {
    const result = this.db
      .prepare(
        `INSERT INTO run_attempts (run_id, idx, account_id, account_name, provider_kind, model,
          status, failure_class, error, waited_ms, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, cost_usd, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.runId,
        attempt.index,
        attempt.accountId,
        attempt.accountName,
        attempt.providerKind,
        attempt.model,
        attempt.status,
        attempt.failureClass,
        attempt.error,
        attempt.waitedMs,
        attempt.inputTokens,
        attempt.outputTokens,
        attempt.cacheReadTokens,
        attempt.cacheWriteTokens,
        attempt.costUsd,
        attempt.startedAt,
        attempt.endedAt,
      );
    return { ...attempt, id: Number(result.lastInsertRowid) };
  }

  updateRunAttempt(attempt: RunAttempt): void {
    this.db
      .prepare(
        `UPDATE run_attempts SET status=?, failure_class=?, error=?, input_tokens=?, output_tokens=?,
          cache_read_tokens=?, cache_write_tokens=?, cost_usd=?, ended_at=? WHERE id=?`,
      )
      .run(
        attempt.status,
        attempt.failureClass,
        attempt.error,
        attempt.inputTokens,
        attempt.outputTokens,
        attempt.cacheReadTokens,
        attempt.cacheWriteTokens,
        attempt.costUsd,
        attempt.endedAt,
        attempt.id,
      );
  }

  listRunAttempts(runId: string): RunAttempt[] {
    return (
      this.db
        .prepare('SELECT * FROM run_attempts WHERE run_id = ? ORDER BY idx')
        .all(runId) as SqlRow[]
    ).map(rowToAttempt);
  }

  // -- Handoffs --------------------------------------------------------------

  insertHandoff(handoff: SessionHandoff): void {
    this.db
      .prepare(
        `INSERT INTO session_handoffs (id, run_id, agent_id, reason, summary, degraded, source_kind,
          source_account_id, source_session_id, tokens_at_capture, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        handoff.id,
        handoff.runId,
        handoff.agentId,
        handoff.reason,
        handoff.summary,
        handoff.degraded ? 1 : 0,
        handoff.sourceKind,
        handoff.sourceAccountId,
        handoff.sourceSessionId,
        handoff.tokensAtCapture,
        handoff.createdAt,
      );
  }

  /** Dernier résumé capturé pour un run — celui qui sert à la reprise. */
  latestHandoffForRun(runId: string): SessionHandoff | null {
    const row = this.db
      .prepare('SELECT * FROM session_handoffs WHERE run_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(runId) as SqlRow | undefined;
    return row ? rowToHandoff(row) : null;
  }

  listHandoffs(agentId?: string, limit = 50): SessionHandoff[] {
    const sql = agentId
      ? 'SELECT * FROM session_handoffs WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?'
      : 'SELECT * FROM session_handoffs ORDER BY created_at DESC LIMIT ?';
    const rows = (
      agentId ? this.db.prepare(sql).all(agentId, limit) : this.db.prepare(sql).all(limit)
    ) as SqlRow[];
    return rows.map(rowToHandoff);
  }

  getHandoff(id: string): SessionHandoff | null {
    const row = this.db.prepare('SELECT * FROM session_handoffs WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row ? rowToHandoff(row) : null;
  }

  // -- Métriques / agrégats --------------------------------------------------------------

  todayTotals(dayIsoPrefix: string): {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o,
          COALESCE(SUM(cost_usd),0) AS c FROM runs WHERE created_at >= ?`,
      )
      .get(dayIsoPrefix) as SqlRow;
    return { inputTokens: num(row.i), outputTokens: num(row.o), costUsd: num(row.c) };
  }

  agentStats(): AgentStats[] {
    const rows = this.db
      .prepare(
        `SELECT agent_id,
           COUNT(*) AS total,
           SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS ok,
           SUM(CASE WHEN status IN ('failed','timeout') THEN 1 ELSE 0 END) AS ko,
           COALESCE(SUM(input_tokens),0) AS i,
           COALESCE(SUM(output_tokens),0) AS o,
           COALESCE(SUM(cost_usd),0) AS c,
           COALESCE(AVG(CASE WHEN started_at IS NOT NULL AND ended_at IS NOT NULL
             THEN (julianday(ended_at) - julianday(started_at)) * 86400000 END), 0) AS avgdur,
           MAX(created_at) AS last
         FROM runs GROUP BY agent_id`,
      )
      .all() as SqlRow[];
    return rows.map((r) => ({
      agentId: str(r.agent_id),
      totalRuns: num(r.total),
      succeeded: num(r.ok),
      failed: num(r.ko),
      inputTokens: num(r.i),
      outputTokens: num(r.o),
      costUsd: num(r.c),
      avgDurationMs: num(r.avgdur),
      lastRunAt: strOrNull(r.last),
    }));
  }

  tokensBy(groupBy: 'day' | 'agent' | 'model', sinceIso: string): TokensByBucket[] {
    const bucketExpr =
      groupBy === 'day' ? 'substr(created_at, 1, 10)' : groupBy === 'agent' ? 'agent_id' : 'model';
    const rows = this.db
      .prepare(
        `SELECT ${bucketExpr} AS bucket,
           COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o,
           COALESCE(SUM(cache_read_tokens),0) AS cr, COALESCE(SUM(cost_usd),0) AS c,
           COUNT(*) AS n
         FROM runs WHERE created_at >= ? GROUP BY bucket ORDER BY bucket`,
      )
      .all(sinceIso) as SqlRow[];
    return rows.map((r) => ({
      bucket: str(r.bucket),
      inputTokens: num(r.i),
      outputTokens: num(r.o),
      cacheReadTokens: num(r.cr),
      costUsd: num(r.c),
      runs: num(r.n),
    }));
  }

  countPendingApprovals(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")
      .get() as SqlRow;
    return num(row.n);
  }

  // --- Serveurs MCP -------------------------------------------------------

  listMcpServers(): McpServerDef[] {
    return (this.db.prepare('SELECT * FROM mcp_servers ORDER BY name').all() as SqlRow[]).map(
      rowToMcpServer,
    );
  }

  getMcpServer(id: string): McpServerDef | null {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row ? rowToMcpServer(row) : null;
  }

  getMcpServerBySlug(slug: string): McpServerDef | null {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE slug = ?').get(slug) as
      SqlRow | undefined;
    return row ? rowToMcpServer(row) : null;
  }

  upsertMcpServer(def: McpServerDef): void {
    this.db
      .prepare(
        `INSERT INTO mcp_servers
           (id, slug, name, description, kind, enabled, transport, command, args, env,
            url, headers, tools, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           slug=excluded.slug, name=excluded.name, description=excluded.description,
           kind=excluded.kind, enabled=excluded.enabled, transport=excluded.transport,
           command=excluded.command, args=excluded.args, env=excluded.env,
           url=excluded.url, headers=excluded.headers, tools=excluded.tools,
           updated_at=excluded.updated_at`,
      )
      .run(
        def.id,
        def.slug,
        def.name,
        def.description,
        def.kind,
        def.enabled ? 1 : 0,
        def.transport,
        def.command,
        JSON.stringify(def.args),
        JSON.stringify(def.env),
        def.url,
        JSON.stringify(def.headers),
        JSON.stringify(def.tools),
        def.createdAt,
        def.updatedAt,
      );
  }

  deleteMcpServer(id: string): boolean {
    const res = this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    return num(res.changes) > 0;
  }

  // --- Collections RAG ----------------------------------------------------

  /**
   * Les compteurs sont calculés en sous-requêtes plutôt que stockés : une
   * colonne dénormalisée finit toujours par mentir après une suppression en
   * cascade, et le coût est négligeable sur des dizaines de collections.
   */
  private readonly ragCollectionSelect = `
    SELECT c.*,
      (SELECT COUNT(*) FROM rag_documents d WHERE d.collection_id = c.id) AS document_count,
      (SELECT COUNT(*) FROM rag_chunks k WHERE k.collection_id = c.id) AS chunk_count,
      (SELECT COUNT(*) FROM rag_chunks k
        WHERE k.collection_id = c.id AND k.embedding IS NOT NULL) AS embedded_chunk_count
    FROM rag_collections c`;

  /**
   * Morceaux dont le vecteur vient d'un autre modèle que celui configuré.
   *
   * Comptés à part de ceux qui n'ont aucun vecteur : les deux appellent une
   * revectorisation, mais seul ce cas-ci ment à l'utilisateur en apparaissant
   * comme « déjà vectorisé ».
   */
  countStaleEmbeddings(collectionId: string, model: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM rag_chunks
         WHERE collection_id = ? AND embedding IS NOT NULL
           AND (embedding_model IS NULL OR embedding_model != ?)`,
      )
      .get(collectionId, model) as SqlRow | undefined;
    return row ? num(row.n) : 0;
  }

  listRagCollections(): RagCollection[] {
    return (this.db.prepare(`${this.ragCollectionSelect} ORDER BY c.name`).all() as SqlRow[]).map(
      rowToRagCollection,
    );
  }

  getRagCollection(id: string): RagCollection | null {
    const row = this.db.prepare(`${this.ragCollectionSelect} WHERE c.id = ?`).get(id) as
      SqlRow | undefined;
    return row ? rowToRagCollection(row) : null;
  }

  getRagCollectionBySlug(slug: string): RagCollection | null {
    const row = this.db.prepare(`${this.ragCollectionSelect} WHERE c.slug = ?`).get(slug) as
      SqlRow | undefined;
    return row ? rowToRagCollection(row) : null;
  }

  upsertRagCollection(c: RagCollection): void {
    this.db
      .prepare(
        `INSERT INTO rag_collections
           (id, slug, name, description, chunk_size, chunk_overlap, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           slug=excluded.slug, name=excluded.name, description=excluded.description,
           chunk_size=excluded.chunk_size, chunk_overlap=excluded.chunk_overlap,
           updated_at=excluded.updated_at`,
      )
      .run(
        c.id,
        c.slug,
        c.name,
        c.description,
        c.chunkSize,
        c.chunkOverlap,
        c.createdAt,
        c.updatedAt,
      );
  }

  deleteRagCollection(id: string): boolean {
    /* L'index plein texte n'a pas de clé étrangère : il faut le nettoyer avant
       que la cascade ne fasse disparaître les morceaux qui le référencent. */
    this.db
      .prepare(
        'DELETE FROM rag_fts WHERE chunk_id IN (SELECT id FROM rag_chunks WHERE collection_id = ?)',
      )
      .run(id);
    const res = this.db.prepare('DELETE FROM rag_collections WHERE id = ?').run(id);
    return num(res.changes) > 0;
  }

  // --- Documents ----------------------------------------------------------

  listRagDocuments(collectionId: string): RagDocument[] {
    const rows = this.db
      .prepare(
        `SELECT d.*,
           (SELECT COUNT(*) FROM rag_chunks k WHERE k.document_id = d.id) AS chunk_count
         FROM rag_documents d WHERE d.collection_id = ? ORDER BY d.created_at DESC`,
      )
      .all(collectionId) as SqlRow[];
    return rows.map(rowToRagDocument);
  }

  getRagDocument(id: string): RagDocument | null {
    const row = this.db
      .prepare(
        `SELECT d.*,
           (SELECT COUNT(*) FROM rag_chunks k WHERE k.document_id = d.id) AS chunk_count
         FROM rag_documents d WHERE d.id = ?`,
      )
      .get(id) as SqlRow | undefined;
    return row ? rowToRagDocument(row) : null;
  }

  /** Cherche un document par son origine, pour réingérer sans dupliquer. */
  findRagDocumentBySource(collectionId: string, source: string): RagDocument | null {
    if (source === '') return null;
    const row = this.db
      .prepare(
        `SELECT d.*, 0 AS chunk_count FROM rag_documents d
         WHERE d.collection_id = ? AND d.source = ?`,
      )
      .get(collectionId, source) as SqlRow | undefined;
    return row ? rowToRagDocument(row) : null;
  }

  /**
   * Enregistre un document et son contenu d'origine.
   *
   * Le contenu est conservé pour permettre la réindexation : redécouper sans
   * lui obligerait à retrouver la source, ce qui est impossible pour un texte
   * collé.
   */
  insertRagDocument(doc: RagDocument, content: string): void {
    this.db
      .prepare(
        `INSERT INTO rag_documents
           (id, collection_id, title, source_kind, source, ingest_root, bytes, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        doc.id,
        doc.collectionId,
        doc.title,
        doc.sourceKind,
        doc.source,
        doc.ingestRoot,
        doc.bytes,
        content,
        doc.createdAt,
      );
  }

  /** Documents d'une collection avec leur contenu, pour une réindexation. */
  listRagDocumentsWithContent(
    collectionId: string,
  ): Array<{ doc: RagDocument; content: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT d.*, 0 AS chunk_count FROM rag_documents d
         WHERE d.collection_id = ? ORDER BY d.created_at`,
      )
      .all(collectionId) as SqlRow[];
    return rows.map((r) => ({ doc: rowToRagDocument(r), content: strOrNull(r.content) }));
  }

  /** Racines d'ingestion relisibles d'une collection, pour un rafraîchissement. */
  listRagIngestRoots(
    collectionId: string,
  ): Array<{ sourceKind: RagDocument['sourceKind']; ingestRoot: string }> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT source_kind, ingest_root FROM rag_documents
         WHERE collection_id = ? AND ingest_root IS NOT NULL AND ingest_root != ''
           AND source_kind IN ('file', 'directory', 'url', 'workspace')`,
      )
      .all(collectionId) as SqlRow[];
    return rows.map((r) => ({
      sourceKind: str(r.source_kind) as RagDocument['sourceKind'],
      ingestRoot: str(r.ingest_root),
    }));
  }

  /** Documents issus d'une racine donnée, pour repérer ceux qui ont disparu. */
  listRagDocumentsByRoot(collectionId: string, ingestRoot: string): RagDocument[] {
    const rows = this.db
      .prepare(
        `SELECT d.*, 0 AS chunk_count FROM rag_documents d
         WHERE d.collection_id = ? AND d.ingest_root = ?`,
      )
      .all(collectionId, ingestRoot) as SqlRow[];
    return rows.map(rowToRagDocument);
  }

  /** Tous les morceaux d'une collection, bornés, pour construire le graphe. */
  listChunksOfCollection(collectionId: string, limit: number): StoredChunk[] {
    const rows = this.db
      .prepare(
        `SELECT k.*, d.title AS document_title FROM rag_chunks k
         JOIN rag_documents d ON d.id = k.document_id
         WHERE k.collection_id = ?
         ORDER BY d.created_at, k.chunk_index LIMIT ?`,
      )
      .all(collectionId, limit) as SqlRow[];
    return rows.map(rowToStoredChunk);
  }

  /** Morceaux d'un document, pour inspecter le découpage. */
  listChunksOfDocument(documentId: string): StoredChunk[] {
    const rows = this.db
      .prepare(
        `SELECT k.*, d.title AS document_title FROM rag_chunks k
         JOIN rag_documents d ON d.id = k.document_id
         WHERE k.document_id = ? ORDER BY k.chunk_index`,
      )
      .all(documentId) as SqlRow[];
    return rows.map(rowToStoredChunk);
  }

  /**
   * Retire les morceaux d'un document, index compris.
   *
   * Séparé de la suppression du document : une réindexation remplace la découpe
   * sans toucher au document ni à son contenu.
   */
  deleteChunksOfDocument(documentId: string): void {
    this.db
      .prepare(
        'DELETE FROM rag_fts WHERE chunk_id IN (SELECT id FROM rag_chunks WHERE document_id = ?)',
      )
      .run(documentId);
    this.db.prepare('DELETE FROM rag_chunks WHERE document_id = ?').run(documentId);
  }

  deleteRagDocument(id: string): boolean {
    this.db
      .prepare(
        'DELETE FROM rag_fts WHERE chunk_id IN (SELECT id FROM rag_chunks WHERE document_id = ?)',
      )
      .run(id);
    const res = this.db.prepare('DELETE FROM rag_documents WHERE id = ?').run(id);
    return num(res.changes) > 0;
  }

  // --- Morceaux et index --------------------------------------------------

  /**
   * Insère les morceaux d'un document et les indexe dans le même mouvement.
   *
   * Une transaction : un morceau présent dans rag_chunks mais absent de
   * rag_fts serait invisible à la recherche sans qu'aucun compteur ne le
   * signale.
   */
  insertRagChunks(
    chunks: Array<{
      id: string;
      collectionId: string;
      documentId: string;
      chunkIndex: number;
      content: string;
    }>,
    createdAt: string,
  ): void {
    const insChunk = this.db.prepare(
      `INSERT INTO rag_chunks (id, collection_id, document_id, chunk_index, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insFts = this.db.prepare('INSERT INTO rag_fts (content, chunk_id) VALUES (?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const c of chunks) {
        insChunk.run(c.id, c.collectionId, c.documentId, c.chunkIndex, c.content, createdAt);
        insFts.run(c.content, c.id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  setChunkEmbedding(chunkId: string, vector: Float32Array, model: string): void {
    this.db
      .prepare('UPDATE rag_chunks SET embedding = ?, embedding_model = ? WHERE id = ?')
      .run(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), model, chunkId);
  }

  /**
   * Morceaux à (re)vectoriser : sans vecteur, ou vecteur produit par un autre
   * modèle que celui configuré aujourd'hui.
   */
  listChunksNeedingEmbedding(collectionId: string, model: string, limit: number): StoredChunk[] {
    const rows = this.db
      .prepare(
        `SELECT k.*, d.title AS document_title FROM rag_chunks k
         JOIN rag_documents d ON d.id = k.document_id
         WHERE k.collection_id = ?
           AND (k.embedding IS NULL OR k.embedding_model IS NULL OR k.embedding_model != ?)
         ORDER BY k.created_at LIMIT ?`,
      )
      .all(collectionId, model, limit) as SqlRow[];
    return rows.map(rowToStoredChunk);
  }

  /**
   * Parcourt les vecteurs d'une collection par lots.
   *
   * Charger la collection entière coûtait quatre kilo-octets par morceau, soit
   * deux cents mégaoctets à cinquante mille morceaux, à chaque requête. En
   * lisant par tranches et en ne gardant qu'un classement borné, l'appelant
   * garde le même résultat exact pour une empreinte mémoire constante.
   *
   * Seuls l'identifiant et le vecteur sont lus : le texte du morceau est
   * récupéré à la fin, pour les seuls passages retenus.
   */
  forEachEmbeddedChunk(
    collectionId: string,
    model: string,
    batchSize: number,
    visit: (chunkId: string, vector: Float32Array) => void,
  ): number {
    let offset = 0;
    let seen = 0;
    for (;;) {
      const rows = this.db
        .prepare(
          `SELECT id, embedding FROM rag_chunks
           WHERE collection_id = ? AND embedding IS NOT NULL AND embedding_model = ?
           ORDER BY rowid LIMIT ? OFFSET ?`,
        )
        .all(collectionId, model, batchSize, offset) as SqlRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        const vector = toFloat32(row.embedding);
        if (vector) {
          visit(str(row.id), vector);
          seen++;
        }
      }
      offset += rows.length;
      if (rows.length < batchSize) break;
    }
    return seen;
  }

  getChunksByIds(ids: string[]): StoredChunk[] {
    if (ids.length === 0) return [];
    const holes = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT k.*, d.title AS document_title FROM rag_chunks k
         JOIN rag_documents d ON d.id = k.document_id
         WHERE k.id IN (${holes})`,
      )
      .all(...ids) as SqlRow[];
    return rows.map(rowToStoredChunk);
  }

  /**
   * Recherche lexicale BM25 dans une collection.
   *
   * bm25() renvoie un score NÉGATIF, d'autant plus bas que le passage est
   * pertinent. On le retourne tel quel : c'est l'appelant qui fusionne, et
   * inverser ici masquerait la convention de SQLite.
   */
  searchRagLexical(
    collectionId: string,
    ftsQuery: string,
    limit: number,
  ): Array<{ chunkId: string; score: number }> {
    const rows = this.db
      .prepare(
        `SELECT f.chunk_id AS chunk_id, bm25(rag_fts) AS score
         FROM rag_fts f
         JOIN rag_chunks k ON k.id = f.chunk_id
         WHERE rag_fts MATCH ? AND k.collection_id = ?
         ORDER BY score LIMIT ?`,
      )
      .all(ftsQuery, collectionId, limit) as SqlRow[];
    return rows.map((r) => ({ chunkId: str(r.chunk_id), score: num(r.score) }));
  }

  expireOldApprovals(olderThanIso: string): Approval[] {
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE status = 'pending' AND requested_at < ?")
      .all(olderThanIso) as SqlRow[];
    const expired = rows.map(rowToApproval);
    for (const a of expired) {
      this.db
        .prepare(
          "UPDATE approvals SET status='expired', resolved_by='timeout', resolved_at=? WHERE id=?",
        )
        .run(nowIso(), a.id);
    }
    return expired.map((a) => ({
      ...a,
      status: 'expired' as const,
      resolvedBy: 'timeout' as const,
    }));
  }
}

export function createTaskId(): string {
  return makeId('task');
}
