/**
 * Couche de persistance — SQLite natif (node:sqlite), zéro dépendance native.
 * Un seul point d'accès typé (Store) ; les colonnes complexes sont en JSON.
 */
import { DatabaseSync } from 'node:sqlite';
import type {
  AccessToken,
  McpServerDef,
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
  Routine,
  Run,
  RunEvent,
  RunEventKind,
  RunEventPayload,
  RunStatus,
  Settings,
  AgentStats,
  RunStats,
  TokensByBucket,
  Beat,
  FederatedPeer,
  HeartbeatConfig,
  OnboardingState,
  ProviderAccount,
  ResiliencePolicy,
  RunAttempt,
  SessionHandoff,
  TrainingBatch,
  TrainingBatchSpec,
  TrainingItem,
  TrainingItemStatus,
} from '@maestro/shared';
import { HEARTBEAT_DEFAULTS } from '@maestro/shared';
import { encryptMap, passthroughBox, type SecretBox } from './secrets.ts';
import { makeId, nowIso, safeJsonParse } from './util.ts';
import { ADDED_COLUMNS, SCHEMA } from './db/schema.ts';
import { RagStore } from './db/rag.ts';
import {
  DEFAULT_ONBOARDING,
  DEFAULT_SETTINGS,
  HEARTBEAT_KEY,
  ONBOARDING_KEY,
} from './db/defaults.ts';
import {
  num,
  numOrNull,
  rowToAgent,
  rowToApproval,
  rowToAttempt,
  rowToBeat,
  rowToHandoff,
  rowToLog,
  rowToMcpServer,
  rowToPeer,
  rowToPipeline,
  rowToPipelineRun,
  rowToPlugin,
  rowToPolicy,
  rowToProviderAccount,
  rowToRoutine,
  rowToRun,
  rowToTask,
  str,
  strOrNull,
  type SqlRow,
} from './db/rows.ts';

/* `StoredChunk` était défini ici : les appelants continuent de l'y trouver. */
export type { StoredChunk } from './db/rows.ts';

// -- helpers de (dé)sérialisation ------------------------------------------

// ---------------------------------------------------------------------------

export class Store {
  private db: DatabaseSync;

  /**
   * Coffre à secrets.
   *
   * Injecte plutôt que construit : le Store ne connaît que son chemin de base,
   * pas le repertoire de donnees ou vit la cle. Absent, on retombe sur un coffre
   * neutre — c'est le cas des tests, qui travaillent en memoire.
   */
  private secrets: SecretBox;

  /**
   * Accès RAG, en sous-magasin.
   *
   * Premier domaine sorti de cette classe. Le critère n'était pas la taille
   * mais le **couplage** : ces méthodes ne touchaient que le handle SQLite, et
   * aucune des 125 autres ne les appelait. Un domaine qui se détache sans rien
   * casser est un domaine qui n'avait rien à faire ici.
   */
  readonly rag: RagStore;

  constructor(dbPath: string, secrets: SecretBox = passthroughBox()) {
    this.secrets = secrets;
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrate();
    /* Après les migrations : le sous-magasin suppose son schéma en place. */
    this.rag = new RagStore(this.db);
  }

  /**
   * Migrations additives idempotentes : CREATE TABLE IF NOT EXISTS ne fait rien
   * sur une table déjà présente, les colonnes ajoutées après coup doivent donc
   * l'être explicitement.
   */
  private migrate(): void {
    const added = ADDED_COLUMNS;
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
          sandbox, color, pinned, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        agent.sandbox ? JSON.stringify(agent.sandbox) : null,
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
          disallowed_tools=?, max_turns=?, timeout_sec=?, token_budget=?, sandbox=?, color=?, pinned=?,
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
        agent.sandbox ? JSON.stringify(agent.sandbox) : null,
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
    /** Nom du jeton qui a tranché. Nul pour une résolution automatique. */
    resolvedByLabel: string | null = null,
  ): Approval | null {
    this.db
      .prepare(
        "UPDATE approvals SET status=?, resolved_by=?, resolved_by_label=?, note=?, resolved_at=? WHERE id=? AND status='pending'",
      )
      .run(status, resolvedBy, resolvedByLabel, note, nowIso(), id);
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
    /*
     * Reprise de l'ancienne clé.
     *
     * `telegramNotifyAllRuns` datait de l'époque où Telegram était le seul
     * canal. Renommer sans reprendre l'ancienne valeur aurait remis
     * silencieusement à « non » le réglage de qui l'avait activé — le pire des
     * cas, puisque rien ne l'aurait signalé.
     */
    const legacy = (stored as Record<string, unknown>).telegramNotifyAllRuns;
    if (stored.notifyAllRuns === undefined && typeof legacy === 'boolean') {
      stored.notifyAllRuns = legacy;
    }
    delete (stored as Record<string, unknown>).telegramNotifyAllRuns;

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

  // -- Pairs fédérés ---------------------------------------------------------

  listPeers(): FederatedPeer[] {
    return (this.db.prepare('SELECT * FROM federated_peers ORDER BY name').all() as SqlRow[]).map(
      rowToPeer,
    );
  }

  getPeer(id: string): FederatedPeer | null {
    const row = this.db.prepare('SELECT * FROM federated_peers WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row ? rowToPeer(row) : null;
  }

  /** Recherche par nom, insensible à la casse : c'est ainsi qu'un agent le cite. */
  getPeerByName(name: string): FederatedPeer | null {
    const row = this.db
      .prepare('SELECT * FROM federated_peers WHERE LOWER(name) = LOWER(?)')
      .get(name.trim()) as SqlRow | undefined;
    return row ? rowToPeer(row) : null;
  }

  insertPeer(peer: FederatedPeer): void {
    this.db
      .prepare(
        `INSERT INTO federated_peers (id, name, base_url, token_env, enabled, max_concurrent,
          health, open_until, last_error, last_checked_at, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        peer.id,
        peer.name,
        peer.baseUrl,
        peer.tokenEnv,
        peer.enabled ? 1 : 0,
        peer.maxConcurrent,
        peer.health,
        peer.openUntil,
        peer.lastError,
        peer.lastCheckedAt,
        peer.detail,
        peer.createdAt,
        peer.updatedAt,
      );
  }

  updatePeer(peer: FederatedPeer): void {
    this.db
      .prepare(
        `UPDATE federated_peers SET name=?, base_url=?, token_env=?, enabled=?, max_concurrent=?,
          health=?, open_until=?, last_error=?, last_checked_at=?, detail=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        peer.name,
        peer.baseUrl,
        peer.tokenEnv,
        peer.enabled ? 1 : 0,
        peer.maxConcurrent,
        peer.health,
        peer.openUntil,
        peer.lastError,
        peer.lastCheckedAt,
        peer.detail,
        nowIso(),
        peer.id,
      );
  }

  deletePeer(id: string): void {
    this.db.prepare('DELETE FROM federated_peers WHERE id = ?').run(id);
  }

  // -- Battement de cœur -----------------------------------------------------

  getHeartbeatConfig(): HeartbeatConfig {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(HEARTBEAT_KEY) as
      SqlRow | undefined;
    if (!row) return { ...HEARTBEAT_DEFAULTS };
    return {
      ...HEARTBEAT_DEFAULTS,
      ...safeJsonParse<Partial<HeartbeatConfig>>(str(row.value), {}),
    };
  }

  patchHeartbeatConfig(patch: Partial<HeartbeatConfig>): HeartbeatConfig {
    const next: HeartbeatConfig = { ...this.getHeartbeatConfig(), ...patch, updatedAt: nowIso() };
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(HEARTBEAT_KEY, JSON.stringify(next));
    return next;
  }

  insertBeat(beat: Omit<Beat, 'id'>): Beat {
    const result = this.db
      .prepare(
        'INSERT INTO heartbeat_beats (at, outcome, reason, run_id, summary) VALUES (?, ?, ?, ?, ?)',
      )
      .run(beat.at, beat.outcome, beat.reason, beat.runId, beat.summary);
    return { ...beat, id: Number(result.lastInsertRowid) };
  }

  /** Renseigne le compte rendu d'un battement, une fois son run terminé. */
  completeBeat(id: number, outcome: Beat['outcome'], summary: string | null): void {
    this.db
      .prepare('UPDATE heartbeat_beats SET outcome = ?, summary = ? WHERE id = ?')
      .run(outcome, summary, id);
  }

  listBeats(limit = 20): Beat[] {
    return (
      this.db
        .prepare('SELECT * FROM heartbeat_beats ORDER BY at DESC LIMIT ?')
        .all(limit) as SqlRow[]
    ).map(rowToBeat);
  }

  /** Battements du jour, pour appliquer le plafond quotidien. */
  countBeatsSince(sinceIso: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM heartbeat_beats WHERE at >= ?')
      .get(sinceIso) as SqlRow | undefined;
    return row ? num(row.n) : 0;
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
          base_url, api_flavor, model, command, args, env, priority, daily_cost_limit_usd,
          usage_window_sec, window_token_limit, learned_token_limit, learned_at, health,
          cooldown_until, last_error, last_checked_at, detail, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        account.usageWindowSec,
        account.windowTokenLimit,
        account.learnedTokenLimit,
        account.learnedAt,
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
          daily_cost_limit_usd=?, usage_window_sec=?, window_token_limit=?, learned_token_limit=?,
          learned_at=?, health=?, cooldown_until=?, last_error=?, last_checked_at=?,
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
        account.usageWindowSec,
        account.windowTokenLimit,
        account.learnedTokenLimit,
        account.learnedAt,
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

  /**
   * Consommation d'un compte depuis un instant donné, vue par les tentatives.
   *
   * Source de repli pour les comptes sans transcript (API HTTP) : elle ne voit
   * que ce que Maestro a lancé, ce qui suffit puisque rien d'autre n'utilise
   * cette clé au nom de Maestro.
   */
  accountUsageSince(
    accountId: string,
    sinceIso: string,
  ): {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    sessions: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
                COALESCE(SUM(cost_usd), 0) AS cost_usd,
                COUNT(DISTINCT run_id) AS sessions
         FROM run_attempts WHERE account_id = ? AND started_at >= ?`,
      )
      .get(accountId, sinceIso) as SqlRow | undefined;
    return {
      inputTokens: row ? num(row.input_tokens) : 0,
      outputTokens: row ? num(row.output_tokens) : 0,
      cacheReadTokens: row ? num(row.cache_read_tokens) : 0,
      cacheWriteTokens: row ? num(row.cache_write_tokens) : 0,
      costUsd: row ? num(row.cost_usd) : 0,
      sessions: row ? num(row.sessions) : 0,
    };
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
          quota_wait_max_sec, switch_on_error, handoff_threshold_pct, quota_pressure_pct,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        policy.quotaPressurePct,
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
          quota_pressure_pct=?, updated_at=? WHERE id=?`,
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
        policy.quotaPressurePct,
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

  /**
   * Bilan d'exécution depuis un instant donné.
   *
   * La médiane est calculée ici plutôt qu'en SQL : SQLite n'a pas de fonction
   * de médiane, et l'émuler en SQL coûterait deux sous-requêtes pour un gain
   * nul sur les volumes en jeu.
   */
  runStats(sinceIso: string, restartError: string): RunStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
           COALESCE(SUM(status = 'succeeded'), 0) AS ok,
           COALESCE(SUM(status = 'failed' AND (error IS NULL OR error <> ?)), 0) AS ko,
           COALESCE(SUM(status = 'cancelled'), 0) AS ann
         FROM runs WHERE created_at >= ?`,
      )
      .get(restartError, sinceIso) as SqlRow;

    const durations = (
      this.db
        .prepare(
          `SELECT (julianday(ended_at) - julianday(started_at)) * 86400000.0 AS ms
           FROM runs
           WHERE created_at >= ? AND started_at IS NOT NULL AND ended_at IS NOT NULL
           ORDER BY ms`,
        )
        .all(sinceIso) as SqlRow[]
    ).map((r) => num(r.ms));

    return {
      total: num(row.n),
      succeeded: num(row.ok),
      failed: num(row.ko),
      cancelled: num(row.ann),
      medianDurationMs: durations.length
        ? Math.round(durations[Math.floor(durations.length / 2)] ?? 0)
        : null,
    };
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
    return (this.db.prepare('SELECT * FROM mcp_servers ORDER BY name').all() as SqlRow[]).map((r) =>
      rowToMcpServer(r, this.secrets),
    );
  }

  getMcpServer(id: string): McpServerDef | null {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row ? rowToMcpServer(row, this.secrets) : null;
  }

  getMcpServerBySlug(slug: string): McpServerDef | null {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE slug = ?').get(slug) as
      SqlRow | undefined;
    return row ? rowToMcpServer(row, this.secrets) : null;
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
        // 🔒 Chiffré à l'écriture : la base ne contient plus les clés en clair.
        JSON.stringify(encryptMap(this.secrets, def.env)),
        def.url,
        JSON.stringify(encryptMap(this.secrets, def.headers)),
        JSON.stringify(def.tools),
        def.createdAt,
        def.updatedAt,
      );
  }

  deleteMcpServer(id: string): boolean {
    const res = this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    return num(res.changes) > 0;
  }

  // -- Jetons d'accès --------------------------------------------------------

  listAccessTokens(): AccessToken[] {
    const rows = this.db
      .prepare('SELECT * FROM access_tokens ORDER BY created_at DESC')
      .all() as SqlRow[];
    return rows.map(rowToAccessToken);
  }

  insertAccessToken(token: AccessToken, hash: string): void {
    this.db
      .prepare(
        `INSERT INTO access_tokens (id, label, token_hash, preview, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        token.id,
        token.label,
        hash,
        token.preview,
        token.createdAt,
        token.lastUsedAt,
        token.revokedAt,
      );
  }

  /**
   * Retrouve un jeton actif par son empreinte.
   *
   * Un jeton révoqué est traité comme inexistant : la révocation doit prendre
   * effet immédiatement, sans redémarrage ni expiration de cache.
   */
  findActiveAccessToken(hash: string): AccessToken | null {
    const row = this.db
      .prepare('SELECT * FROM access_tokens WHERE token_hash = ? AND revoked_at IS NULL')
      .get(hash) as SqlRow | undefined;
    return row ? rowToAccessToken(row) : null;
  }

  touchAccessToken(id: string, at: string): void {
    this.db.prepare('UPDATE access_tokens SET last_used_at = ? WHERE id = ?').run(at, id);
  }

  /**
   * Révoque un jeton sans l'effacer.
   *
   * La ligne reste : c'est elle qui permet de dire, six mois plus tard, quel
   * jeton avait approuvé quoi. Supprimer effacerait la trace en même temps que
   * l'accès.
   */
  revokeAccessToken(id: string, at: string): boolean {
    const res = this.db
      .prepare('UPDATE access_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(at, id);
    return Number(res.changes) > 0;
  }

  // -- Maintenance ----------------------------------------------------------

  /**
   * Purge les événements des runs terminés avant une date.
   *
   * Par `ended_at` du run et non par horodatage de l'événement : un run long
   * démarré il y a trois mois et encore actif garderait sinon ses premiers
   * événements effacés sous ses pieds, et son transcript deviendrait un trou.
   * Les runs en cours ne sont jamais touchés.
   */
  pruneRunEvents(endedBeforeIso: string): number {
    const res = this.db
      .prepare(
        `DELETE FROM run_events WHERE run_id IN (
           SELECT id FROM runs WHERE ended_at IS NOT NULL AND ended_at < ?
         )`,
      )
      .run(endedBeforeIso);
    return Number(res.changes);
  }

  /** Purge le journal applicatif par âge. */
  pruneLogs(beforeIso: string): number {
    const res = this.db.prepare('DELETE FROM logs WHERE ts < ?').run(beforeIso);
    return Number(res.changes);
  }

  /** Comptages bruts, pour l'exposition de métriques. */
  countRows(table: 'runs' | 'agents'): number {
    // Table choisie parmi une union fermée : aucune valeur externe n'atteint
    // cette interpolation.
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as SqlRow | undefined;
    return row ? num(row.n) : 0;
  }

  /** Taille du fichier de base, en octets, telle que SQLite la voit. */
  databaseBytes(): number {
    const row = this.db
      .prepare(
        'SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()',
      )
      .get() as SqlRow | undefined;
    return row ? num(row.bytes) : 0;
  }

  /**
   * Compacte le fichier après une purge.
   *
   * SQLite ne rend pas l'espace au système : sans cela, purger un gigaoctet
   * d'événements laisse le fichier à sa taille d'avant, et la purge paraît sans
   * effet. `VACUUM` réécrit la base, il n'est donc lancé qu'après une purge qui
   * a réellement supprimé quelque chose.
   */
  vacuum(): void {
    this.db.exec('VACUUM');
  }

  /**
   * Sauvegarde à chaud vers un fichier.
   *
   * `VACUUM INTO` produit une copie cohérente et compactée sans interrompre les
   * écritures en cours — contrairement à une copie du fichier, qui attrape un
   * état intermédiaire quand le journal WAL n'est pas replié.
   */
  backupTo(path: string): void {
    // Le chemin est construit par le serveur, jamais reçu d'un client ; le
    // doublement des apostrophes protège malgré tout d'un répertoire de données
    // au nom exotique.
    this.db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
  }

  // -- Lots d'entraînement --------------------------------------------------

  /**
   * Compteurs par statut, calculés en base.
   *
   * Les tenir dans une colonne du lot aurait exigé de les maintenir à chaque
   * transition d'échantillon, avec le risque de dérive que cela suppose. Un
   * GROUP BY sur un index les rend exacts par construction.
   */
  private trainingCounts(batchId: string): Record<TrainingItemStatus, number> {
    const counts: Record<TrainingItemStatus, number> = {
      pending: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      cancelled: 0,
    };
    const rows = this.db
      .prepare(
        'SELECT status, COUNT(*) AS n FROM training_items WHERE batch_id = ? GROUP BY status',
      )
      .all(batchId) as SqlRow[];
    for (const row of rows) {
      const status = str(row.status) as TrainingItemStatus;
      if (status in counts) counts[status] = num(row.n);
    }
    return counts;
  }

  private rowToTrainingBatch(r: SqlRow): TrainingBatch {
    const id = str(r.id);
    return {
      id,
      name: str(r.name),
      description: str(r.description),
      status: str(r.status) as TrainingBatch['status'],
      spec: safeJsonParse<TrainingBatchSpec>(str(r.spec ?? '{}'), {
        agentIds: [],
        promptTemplates: [],
        variables: {},
        samples: 0,
        workers: 1,
        maxAttempts: 1,
        toolWeights: [],
        timeoutSec: null,
        skillId: null,
        grader: null,
      }),
      counts: this.trainingCounts(id),
      checkpointIndex: num(r.checkpoint_index),
      error: strOrNull(r.error),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
      startedAt: strOrNull(r.started_at),
      endedAt: strOrNull(r.ended_at),
    };
  }

  listTrainingBatches(): TrainingBatch[] {
    const rows = this.db
      .prepare('SELECT * FROM training_batches ORDER BY created_at DESC')
      .all() as SqlRow[];
    return rows.map((r) => this.rowToTrainingBatch(r));
  }

  getTrainingBatch(id: string): TrainingBatch | null {
    const row = this.db.prepare('SELECT * FROM training_batches WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row ? this.rowToTrainingBatch(row) : null;
  }

  insertTrainingBatch(batch: TrainingBatch): void {
    this.db
      .prepare(
        `INSERT INTO training_batches (id, name, description, status, spec, checkpoint_index,
          error, created_at, updated_at, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        batch.id,
        batch.name,
        batch.description,
        batch.status,
        JSON.stringify(batch.spec),
        batch.checkpointIndex,
        batch.error,
        batch.createdAt,
        batch.updatedAt,
        batch.startedAt,
        batch.endedAt,
      );
  }

  updateTrainingBatch(batch: TrainingBatch): void {
    this.db
      .prepare(
        `UPDATE training_batches SET name=?, description=?, status=?, spec=?, checkpoint_index=?,
          error=?, updated_at=?, started_at=?, ended_at=? WHERE id=?`,
      )
      .run(
        batch.name,
        batch.description,
        batch.status,
        JSON.stringify(batch.spec),
        batch.checkpointIndex,
        batch.error,
        batch.updatedAt,
        batch.startedAt,
        batch.endedAt,
        batch.id,
      );
  }

  deleteTrainingBatch(id: string): boolean {
    if (!this.getTrainingBatch(id)) return false;
    this.db.prepare('DELETE FROM training_items WHERE batch_id = ?').run(id);
    this.db.prepare('DELETE FROM training_batches WHERE id = ?').run(id);
    return true;
  }

  insertTrainingItems(items: TrainingItem[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO training_items (id, batch_id, idx, agent_id, prompt, run_id, status, attempts,
        score, score_source, tool_call_count, total_tokens, cost_usd, error, created_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of items) {
      stmt.run(
        item.id,
        item.batchId,
        item.index,
        item.agentId,
        item.prompt,
        item.runId,
        item.status,
        item.attempts,
        item.score,
        item.scoreSource,
        item.toolCallCount,
        item.totalTokens,
        item.costUsd,
        item.error,
        item.createdAt,
        item.endedAt,
      );
    }
  }

  updateTrainingItem(item: TrainingItem): void {
    this.db
      .prepare(
        `UPDATE training_items SET agent_id=?, prompt=?, run_id=?, status=?, attempts=?, score=?,
          score_source=?, tool_call_count=?, total_tokens=?, cost_usd=?, error=?, ended_at=?
         WHERE id=?`,
      )
      .run(
        item.agentId,
        item.prompt,
        item.runId,
        item.status,
        item.attempts,
        item.score,
        item.scoreSource,
        item.toolCallCount,
        item.totalTokens,
        item.costUsd,
        item.error,
        item.endedAt,
        item.id,
      );
  }

  listTrainingItems(batchId: string, limit = 2000): TrainingItem[] {
    const rows = this.db
      .prepare('SELECT * FROM training_items WHERE batch_id = ? ORDER BY idx LIMIT ?')
      .all(batchId, limit) as SqlRow[];
    return rows.map(rowToTrainingItem);
  }

  getTrainingItem(id: string): TrainingItem | null {
    const row = this.db.prepare('SELECT * FROM training_items WHERE id = ?').get(id) as
      SqlRow | undefined;
    return row ? rowToTrainingItem(row) : null;
  }

  /** Échantillons encore à faire, dans l'ordre, pour alimenter les workers. */
  listPendingTrainingItems(batchId: string, limit: number): TrainingItem[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM training_items WHERE batch_id = ? AND status = 'pending' ORDER BY idx LIMIT ?",
      )
      .all(batchId, limit) as SqlRow[];
    return rows.map(rowToTrainingItem);
  }

  /**
   * Remet en attente les échantillons restés « running ».
   *
   * Appelé au démarrage : le processus qui les portait est mort, leur run est
   * clôturé par `failStaleActiveRuns`, et personne ne viendra plus les
   * terminer. Sans cette remise à zéro, une reprise de lot les compterait
   * indéfiniment comme en cours.
   */
  resetRunningTrainingItems(): number {
    const res = this.db
      .prepare(
        "UPDATE training_items SET status='pending', run_id=NULL, ended_at=NULL WHERE status='running'",
      )
      .run();
    return Number(res.changes);
  }

  /** Runs et scores d'un lot, dans l'ordre — matière première de l'export. */
  listTrainingRunRefs(batchId: string): Array<{ runId: string; score: number | null }> {
    const rows = this.db
      .prepare(
        'SELECT run_id, score FROM training_items WHERE batch_id = ? AND run_id IS NOT NULL ORDER BY idx',
      )
      .all(batchId) as SqlRow[];
    return rows.map((r) => ({ runId: str(r.run_id), score: numOrNull(r.score) }));
  }

  /** Score déjà attribué à un run, s'il appartient à un lot noté. */
  scoreForRun(runId: string): number | null {
    const row = this.db
      .prepare('SELECT score FROM training_items WHERE run_id = ? AND score IS NOT NULL LIMIT 1')
      .get(runId) as SqlRow | undefined;
    return row ? numOrNull(row.score) : null;
  }
}

function rowToAccessToken(r: SqlRow): AccessToken {
  return {
    id: str(r.id),
    label: str(r.label),
    preview: str(r.preview),
    createdAt: str(r.created_at),
    lastUsedAt: strOrNull(r.last_used_at),
    revokedAt: strOrNull(r.revoked_at),
  };
}

function rowToTrainingItem(r: SqlRow): TrainingItem {
  return {
    id: str(r.id),
    batchId: str(r.batch_id),
    index: num(r.idx),
    agentId: str(r.agent_id),
    prompt: str(r.prompt),
    runId: strOrNull(r.run_id),
    status: str(r.status) as TrainingItemStatus,
    attempts: num(r.attempts),
    score: numOrNull(r.score),
    scoreSource: strOrNull(r.score_source) as TrainingItem['scoreSource'],
    toolCallCount: num(r.tool_call_count),
    totalTokens: num(r.total_tokens),
    costUsd: num(r.cost_usd),
    error: strOrNull(r.error),
    createdAt: str(r.created_at),
    endedAt: strOrNull(r.ended_at),
  };
}

export function createTaskId(): string {
  return makeId('task');
}
