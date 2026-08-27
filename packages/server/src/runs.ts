/**
 * Moteur d'exécution : chaque run est une session Claude Code, pilotée soit
 * par le Claude Agent SDK (streaming fin, permissions, MCP), soit dans une
 * session tmux attachable. File d'attente globale + sérialisation par agent,
 * garde-fous (tours, délai, budget tokens), reprise de session.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AgentConfig, Run, RunOrigin, RunStatus } from '@maestro/shared';
import type { AgentService } from './agents.ts';
import type { Bus } from './bus.ts';
import type { MaestroConfig } from './config.ts';
import type { Store } from './db.ts';
import type { TaskService } from './kanban.ts';
import { buildMaestroServer } from './mcp-control.ts';
import { buildCustomServer } from './mcp-custom.ts';
import { buildRagServer } from './mcp-rag.ts';
import type { ApprovalBroker } from './permissions.ts';
import type { McpRegistry } from './mcp-registry.ts';
import type { PluginService } from './plugins.ts';
import type { RagService } from './rag.ts';
import type { SkillRegistry } from './skills.ts';
import { TmuxBridge } from './tmux.ts';
import { makeId, nowIso, truncate } from './util.ts';

export interface StartRunInput {
  agentId: string;
  prompt: string;
  skillId?: string | null;
  origin: RunOrigin;
  originId?: string | null;
  parentRunId?: string | null;
  resumeSessionId?: string | null;
  /** Force le moteur pour ce run seulement (pipelines : 'sdk' pour des runs qui terminent). */
  engineOverride?: 'sdk' | 'tmux' | null;
  depth?: number;
  timeoutSecOverride?: number | null;
  /**
   * Exempte ce run du plafond global de concurrence — jamais de la sérialisation
   * par agent. Réservé aux délégations bloquantes (`send_to_agent` wait=true) :
   * le parent occupe un slot en attendant son enfant, l'enfant doit pouvoir
   * démarrer même plafond atteint. Une délégation non bloquante n'en a pas
   * besoin, ce qui borne naturellement le fan-out.
   */
  bypassConcurrencyCap?: boolean;
}

/** Paramètres d'un run en file, conservés jusqu'à son démarrage effectif. */
interface QueuedParams {
  depth: number;
  timeoutSecOverride: number | null;
  bypassConcurrencyCap: boolean;
}

interface ActiveRun {
  abort: AbortController;
  depth: number;
  report: string | null;
  cancelStatus: RunStatus | null;
  stderrTail: string;
  bypassConcurrencyCap: boolean;
}

export class RunEngine {
  private active = new Map<string, ActiveRun>();
  private queue: string[] = [];
  /**
   * Paramètres des runs en attente. Les porter ici plutôt que de les passer en
   * argument de pump() est indispensable : un run dépilé plus tard (agent occupé,
   * plafond atteint) perdrait sinon son délai maximal.
   */
  private queuedParams = new Map<string, QueuedParams>();
  private waiters = new Map<string, Array<(run: Run) => void>>();

  constructor(
    private store: Store,
    private bus: Bus,
    private config: MaestroConfig,
    private agents: AgentService,
    private skills: SkillRegistry,
    private approvals: ApprovalBroker,
    private tasks: TaskService,
    private tmux: TmuxBridge,
    private plugins: PluginService,
    private mcp: McpRegistry,
    private rag: RagService,
  ) {}

  // -- API publique -----------------------------------------------------------

  start(input: StartRunInput): Run {
    const agent = this.agents.get(input.agentId);
    if (!agent) throw new Error(`Agent introuvable : ${input.agentId}`);

    // Un agent occupé par un run dont celui-ci descend ne peut pas le prendre :
    // la sérialisation par agent ferait attendre l'enfant que le parent attend.
    const ancestor = this.activeAncestorOnAgent(input.parentRunId ?? null, agent.id);
    if (ancestor) {
      throw new Error(
        `L'agent « ${agent.name} » exécute déjà le run ${ancestor.id}, dont celui-ci descend : ` +
          `la délégation resterait bloquée. Confie la tâche à un autre agent.`,
      );
    }

    const run: Run = {
      id: makeId('run'),
      agentId: agent.id,
      origin: input.origin,
      originId: input.originId ?? null,
      parentRunId: input.parentRunId ?? null,
      prompt: input.prompt,
      skillId: input.skillId ?? null,
      status: 'queued',
      sessionId: input.resumeSessionId ?? null,
      model: agent.model,
      engine: input.engineOverride ?? agent.engine,
      tmuxSession: null,
      numTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      resultText: null,
      error: null,
      createdAt: nowIso(),
      startedAt: null,
      endedAt: null,
    };
    this.store.insertRun(run);
    this.bus.publish({ type: 'run.created', payload: run });
    this.bus.log('info', 'runs', `Run ${run.id} créé pour « ${agent.name} » (${input.origin})`, {
      agentId: agent.id,
      runId: run.id,
    });

    this.queuedParams.set(run.id, {
      depth: input.depth ?? 0,
      timeoutSecOverride: input.timeoutSecOverride ?? null,
      bypassConcurrencyCap: input.bypassConcurrencyCap ?? false,
    });
    this.queue.push(run.id);
    this.pump();
    return run;
  }

  /**
   * Annule un run et, en cascade, les runs qu'il a délégués : sans cela un
   * enfant continue à consommer des tokens et à écrire alors que plus personne
   * n'attend son résultat.
   */
  cancel(runId: string, visited: Set<string> = new Set()): boolean {
    if (visited.has(runId)) return false;
    visited.add(runId);
    for (const child of this.store.listActiveChildRuns(runId)) {
      this.cancel(child.id, visited);
    }

    const run = this.store.getRun(runId);
    if (!run) return false;
    const activeEntry = this.active.get(runId);
    if (activeEntry) {
      activeEntry.cancelStatus = 'cancelled';
      activeEntry.abort.abort();
      this.approvals.cancelPendingForRun(runId);
      if (run.tmuxSession) void this.tmux.kill(run.tmuxSession);
      return true;
    }
    // Encore en file d'attente ?
    const idx = this.queue.indexOf(runId);
    if (idx >= 0 && (run.status === 'queued' || run.status === 'waiting_approval')) {
      this.queue.splice(idx, 1);
      this.queuedParams.delete(runId);
      this.finalize(run, 'cancelled', { error: 'Annulé avant démarrage' });
      return true;
    }
    return false;
  }

  setRunReport(runId: string, summary: string): void {
    const entry = this.active.get(runId);
    if (entry) entry.report = summary;
  }

  /** Attend la fin d'un run (résolution immédiate s'il est déjà terminé). */
  waitForRun(runId: string, timeoutMs: number): Promise<Run | null> {
    const current = this.store.getRun(runId);
    if (!current) return Promise.resolve(null);
    if (current.endedAt) return Promise.resolve(current);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.store.getRun(runId)), timeoutMs);
      const list = this.waiters.get(runId) ?? [];
      list.push((run) => {
        clearTimeout(timer);
        resolve(run);
      });
      this.waiters.set(runId, list);
    });
  }

  activeCount(): number {
    return this.active.size;
  }

  queuedCount(): number {
    return this.queue.length;
  }

  /** À l'arrêt du serveur : interrompt proprement toutes les sessions. */
  shutdown(): void {
    for (const [runId, entry] of this.active) {
      entry.cancelStatus = 'cancelled';
      entry.abort.abort();
      this.approvals.cancelPendingForRun(runId);
    }
  }

  // -- File d'attente ------------------------------------------------------------

  /**
   * Dépile tant qu'un run peut démarrer. Deux garde-fous, distincts :
   * un agent n'exécute jamais deux runs à la fois (même workspace), et le
   * plafond global ne compte que les runs non exemptés.
   */
  private pump(): void {
    const settings = this.store.getSettings();
    for (;;) {
      if (this.queue.length === 0) return;

      const busyAgents = new Set<string>();
      let cappedActive = 0;
      for (const [activeId, entry] of this.active) {
        const activeRun = this.store.getRun(activeId);
        if (!activeRun) continue;
        busyAgents.add(activeRun.agentId);
        if (!entry.bypassConcurrencyCap) cappedActive++;
      }
      const slotAvailable = cappedActive < settings.maxConcurrentRuns;

      const idx = this.queue.findIndex((runId) => {
        const run = this.store.getRun(runId);
        if (!run || busyAgents.has(run.agentId)) return false;
        return slotAvailable || (this.queuedParams.get(runId)?.bypassConcurrencyCap ?? false);
      });
      if (idx === -1) return; // agents occupés, ou plafond atteint
      const runId = this.queue.splice(idx, 1)[0];
      if (!runId) return;
      // execute() renseigne this.active de façon synchrone avant tout await :
      // l'itération suivante voit donc l'état à jour.
      void this.execute(runId);
    }
  }

  /**
   * Remonte la chaîne des parents à la recherche d'un run encore actif porté par
   * `agentId`. Sert à refuser une délégation qui s'auto-bloquerait.
   */
  private activeAncestorOnAgent(parentRunId: string | null, agentId: string): Run | null {
    const seen = new Set<string>();
    let cursor = parentRunId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const run = this.store.getRun(cursor);
      if (!run) return null;
      if (run.agentId === agentId && !run.endedAt) return run;
      cursor = run.parentRunId;
    }
    return null;
  }

  // -- Exécution -------------------------------------------------------------------

  private async execute(runId: string): Promise<void> {
    const params = this.queuedParams.get(runId);
    this.queuedParams.delete(runId);
    const { depth, timeoutSecOverride, bypassConcurrencyCap } = params ?? {
      depth: 0,
      timeoutSecOverride: null,
      bypassConcurrencyCap: false,
    };

    const run = this.store.getRun(runId);
    if (!run || run.status !== 'queued') return;
    const agent = this.agents.get(run.agentId);
    if (!agent) {
      this.finalize(run, 'failed', { error: 'Agent supprimé avant exécution' });
      return;
    }

    const entry: ActiveRun = {
      abort: new AbortController(),
      depth,
      report: null,
      cancelStatus: null,
      stderrTail: '',
      bypassConcurrencyCap,
    };
    this.active.set(run.id, entry);

    run.status = 'running';
    run.startedAt = nowIso();
    this.store.updateRun(run);
    this.bus.publish({ type: 'run.updated', payload: run });
    if (run.origin === 'kanban' && run.originId) {
      this.tasks.onRunLifecycle(run.originId, run.id, 'started');
    }

    try {
      if (run.engine === 'tmux') {
        await this.executeTmux(run, agent, entry, timeoutSecOverride);
      } else {
        await this.executeSdk(run, agent, entry, timeoutSecOverride);
      }
    } catch (err) {
      const fresh = this.store.getRun(run.id);
      if (fresh && !fresh.endedAt) {
        const status = entry.cancelStatus ?? 'failed';
        const detail = err instanceof Error ? err.message : String(err);
        const stderrHint = entry.stderrTail
          ? `\n--- stderr ---\n${entry.stderrTail.slice(-1500)}`
          : '';
        this.finalize(fresh, status, {
          error: status === 'cancelled' ? 'Annulé' : `${detail}${stderrHint}`,
        });
      }
    } finally {
      this.active.delete(run.id);
      this.pump();
    }
  }

  private buildPrompt(run: Run): string {
    const parts: string[] = [];
    if (run.skillId) {
      const preamble = this.skills.promptPreamble(run.skillId);
      if (preamble) parts.push(preamble);
    }
    if (run.origin === 'kanban' && run.originId) {
      const task = this.tasks.get(run.originId);
      if (task) {
        parts.push(
          `# Carte kanban confiée\n\nIdentifiant : ${task.id}\nTitre : ${task.title}\n` +
            (task.description ? `Description :\n${task.description}\n` : '') +
            `\nQuand ton travail est prêt à être relu, passe cette carte en "review" via maestro_task_update.\n\n---\n`,
        );
      }
    }
    parts.push(run.prompt);
    return parts.join('\n');
  }

  private async executeSdk(
    run: Run,
    agent: AgentConfig,
    entry: ActiveRun,
    timeoutSecOverride: number | null,
  ): Promise<void> {
    const settings = this.store.getSettings();
    const maestroServer = buildMaestroServer(
      {
        tasks: this.tasks,
        agents: this.agents,
        bus: this.bus,
        engine: this,
        maxAgentDepth: () => settings.maxAgentDepth,
      },
      { runId: run.id, agent, depth: entry.depth },
    );

    // Garde-fou de délai.
    const timeoutSec = timeoutSecOverride ?? agent.timeoutSec;
    let timeoutTimer: NodeJS.Timeout | null = null;
    if (timeoutSec && timeoutSec > 0) {
      timeoutTimer = setTimeout(() => {
        entry.cancelStatus = 'timeout';
        entry.abort.abort();
        this.approvals.cancelPendingForRun(run.id);
      }, timeoutSec * 1000);
    }

    const pluginPaths = this.plugins.pathsForAgent(agent);

    /*
     * Serveurs MCP de la session.
     *
     * « maestro » est toujours là : c'est le canal de contrôle de
     * l'orchestrateur. S'y ajoutent les serveurs activés sur l'agent, et le
     * serveur « rag » si des collections lui sont confiées.
     *
     * Un serveur désactivé dans le registre est ignoré sans avertissement :
     * c'est précisément l'intérêt de l'interrupteur, pouvoir le neutraliser
     * globalement sans le retirer de chaque agent.
     */
    const mcpServers: Options['mcpServers'] = { maestro: maestroServer };

    /*
     * Outils qui exigent une approbation quoi qu'il arrive.
     *
     * Le nom est celui que verra le SDK : `mcp__<serveur>__<outil>`. Calculer
     * cet ensemble ici, une fois, évite d'interroger le registre à chaque
     * demande de permission au milieu d'un run.
     */
    const forcedApproval = new Set<string>();

    for (const id of agent.mcpServerIds) {
      const def = this.mcp.getRaw(id);
      if (!def || !def.enabled) continue;
      if (def.kind === 'custom') {
        mcpServers[def.slug] = buildCustomServer(def, this.bus);
        for (const tool of def.tools) {
          if (tool.requiresApproval) forcedApproval.add(`mcp__${def.slug}__${tool.name}`);
        }
        continue;
      }
      if (def.transport === 'stdio' && def.command) {
        mcpServers[def.slug] = {
          type: 'stdio',
          command: def.command,
          args: def.args,
          ...(Object.keys(def.env).length > 0 ? { env: def.env } : {}),
        };
      } else if ((def.transport === 'http' || def.transport === 'sse') && def.url) {
        mcpServers[def.slug] = {
          type: def.transport,
          url: def.url,
          ...(Object.keys(def.headers).length > 0 ? { headers: def.headers } : {}),
        };
      }
    }

    const ragServer = buildRagServer(
      this.rag,
      this.rag.collectionsForAgent(agent.ragCollectionIds),
    );
    if (ragServer) mcpServers.rag = ragServer;

    // Note : les outils mcp__maestro__* ne sont PAS mis dans allowedTools — une
    // entrée nue y court-circuiterait canUseTool ; le broker les autorise déjà.
    const options: Options = {
      cwd: agent.workspaceDir,
      model: agent.model,
      permissionMode: agent.permissionMode,
      ...(agent.permissionMode === 'bypassPermissions'
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      // 'user' est nécessaire pour que ~/.claude/{agents,skills} soit lu : la
      // définition d'agent native, et la skill native éventuellement demandée.
      settingSources:
        agent.cliAgent || run.skillId?.startsWith('native:') ? ['user', 'project'] : ['project'],
      ...(agent.cliAgent ? { agent: agent.cliAgent } : {}),
      mcpServers,
      ...(pluginPaths.length > 0
        ? { plugins: pluginPaths.map((path) => ({ type: 'local' as const, path })) }
        : {}),
      ...(agent.allowedTools && agent.allowedTools.length > 0
        ? { allowedTools: agent.allowedTools }
        : {}),
      ...(agent.disallowedTools && agent.disallowedTools.length > 0
        ? { disallowedTools: agent.disallowedTools }
        : {}),
      ...(agent.maxTurns ? { maxTurns: agent.maxTurns } : {}),
      ...(run.sessionId ? { resume: run.sessionId } : {}),
      abortController: entry.abort,
      stderr: (data: string) => {
        entry.stderrTail = (entry.stderrTail + data).slice(-4000);
      },
      canUseTool: async (toolName, input): Promise<PermissionResult> =>
        this.handlePermission(run.id, agent, toolName, input, forcedApproval),
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'maestro/0.1.0' },
    };

    let cumulatedTokens = 0;
    let gotResult = false;

    try {
      for await (const message of query({ prompt: this.buildPrompt(run), options })) {
        if (message.type === 'system' && message.subtype === 'init') {
          run.sessionId = message.session_id;
          this.store.updateRun(run);
          this.emitEvent(run, 'init', {
            sessionId: message.session_id,
            model: message.model,
            tools: message.tools,
          });
        } else if (message.type === 'assistant') {
          const usage = message.message.usage;
          if (usage) {
            cumulatedTokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
            if (agent.tokenBudget && cumulatedTokens > agent.tokenBudget) {
              entry.cancelStatus = 'failed';
              this.emitEvent(run, 'error', {
                text: `Budget de tokens dépassé (${cumulatedTokens} > ${agent.tokenBudget})`,
              });
              entry.abort.abort();
            }
          }
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              this.emitEvent(run, 'assistant_text', { text: block.text });
            } else if (block.type === 'thinking' && block.thinking.trim()) {
              this.emitEvent(run, 'thinking', { text: truncate(block.thinking, 2000) });
            } else if (block.type === 'tool_use') {
              this.emitEvent(run, 'tool_use', {
                toolName: block.name,
                toolInput: block.input,
                toolUseId: block.id,
              });
            }
          }
        } else if (message.type === 'user') {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === 'object' && block !== null && block.type === 'tool_result') {
                const raw = block.content;
                const textPart = Array.isArray(raw)
                  ? raw
                      .map((c) =>
                        typeof c === 'object' && c !== null && 'text' in c ? String(c.text) : '',
                      )
                      .join('')
                  : typeof raw === 'string'
                    ? raw
                    : '';
                this.emitEvent(run, 'tool_result', {
                  toolUseId: block.tool_use_id,
                  isError: block.is_error ?? false,
                  text: truncate(textPart, 1500),
                });
              }
            }
          }
        } else if (message.type === 'result') {
          gotResult = true;
          run.sessionId = message.session_id;
          run.numTurns = message.num_turns;
          run.costUsd = message.total_cost_usd;
          run.inputTokens = message.usage.input_tokens ?? 0;
          run.outputTokens = message.usage.output_tokens ?? 0;
          run.cacheReadTokens = message.usage.cache_read_input_tokens ?? 0;
          run.cacheWriteTokens = message.usage.cache_creation_input_tokens ?? 0;
          this.emitEvent(run, 'result', {
            usage: {
              inputTokens: run.inputTokens,
              outputTokens: run.outputTokens,
              cacheReadTokens: run.cacheReadTokens,
              cacheWriteTokens: run.cacheWriteTokens,
            },
            costUsd: run.costUsd,
            numTurns: run.numTurns,
            durationMs: message.duration_ms,
          });
          if (message.subtype === 'success') {
            this.finalize(run, 'succeeded', { resultText: entry.report ?? message.result });
          } else {
            const reason =
              message.subtype === 'error_max_turns'
                ? 'Nombre de tours maximum atteint'
                : message.subtype === 'error_max_budget_usd'
                  ? 'Budget maximal (USD) atteint'
                  : `Erreur d'exécution${'errors' in message && message.errors.length ? ` : ${message.errors.join(' ; ')}` : ''}`;
            this.finalize(run, 'failed', { error: reason, resultText: entry.report });
          }
        }
      }
    } catch (err) {
      // query() lève après un résultat d'erreur déjà traité : ne pas re-finaliser.
      if (!gotResult) {
        const fresh = this.store.getRun(run.id);
        if (fresh && !fresh.endedAt) {
          const status = entry.cancelStatus ?? 'failed';
          const detail = err instanceof Error ? err.message : String(err);
          const stderrHint = entry.stderrTail
            ? `\n--- stderr ---\n${entry.stderrTail.slice(-1500)}`
            : '';
          this.finalize({ ...fresh, sessionId: run.sessionId }, status, {
            error:
              status === 'cancelled'
                ? 'Annulé'
                : status === 'timeout'
                  ? 'Délai maximal dépassé'
                  : `${detail}${stderrHint}`,
            resultText: entry.report,
          });
        }
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
  }

  private async executeTmux(
    run: Run,
    agent: AgentConfig,
    entry: ActiveRun,
    timeoutSecOverride: number | null,
  ): Promise<void> {
    if (!(await this.tmux.available())) {
      this.finalize(run, 'failed', { error: 'tmux indisponible sur ce serveur' });
      return;
    }
    const name = this.tmux.sessionName(run.id);
    run.tmuxSession = name;
    this.store.updateRun(run);
    const logFile = await this.tmux.createRunSession(
      name,
      agent.workspaceDir,
      this.buildPrompt(run),
      {
        cliAgent: agent.cliAgent,
        model: agent.model,
        permissionMode: agent.permissionMode,
        pluginDirs: this.plugins.pathsForAgent(agent),
      },
    );
    this.emitEvent(run, 'init', {
      text: `Session tmux « ${name} » démarrée — attache-toi avec : tmux attach -t ${name}`,
    });
    this.bus.publish({ type: 'run.updated', payload: run });

    const startedAt = Date.now();
    const timeoutSec = timeoutSecOverride ?? agent.timeoutSec;

    // Boucle de surveillance : le run vit tant que la session tmux existe.
    while (await this.tmux.isAlive(name)) {
      if (entry.abort.signal.aborted) {
        await this.tmux.kill(name);
        break;
      }
      if (timeoutSec && Date.now() - startedAt > timeoutSec * 1000) {
        entry.cancelStatus = 'timeout';
        await this.tmux.kill(name);
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    const tail = await this.tmux.readLogTail(logFile);
    const status: RunStatus = entry.cancelStatus ?? 'succeeded';
    this.finalize(run, status, {
      resultText: tail,
      error:
        status === 'timeout' ? 'Délai maximal dépassé' : status === 'cancelled' ? 'Annulé' : null,
    });
  }

  // -- Permissions ---------------------------------------------------------------

  private async handlePermission(
    runId: string,
    agent: AgentConfig,
    toolName: string,
    input: Record<string, unknown>,
    forcedApproval: ReadonlySet<string> = new Set(),
  ): Promise<PermissionResult> {
    const policy = this.approvals.policyDecision(agent, toolName);
    /*
     * L'outil peut exiger une approbation de lui-même. On ne surcharge que le
     * cas « autorisé » : un refus par politique reste un refus, sinon un outil
     * pourrait s'accorder un droit que l'agent n'a pas.
     */
    const forced = forcedApproval.has(toolName);
    if (policy === 'allow' && !forced) return { behavior: 'allow', updatedInput: input };
    if (policy === 'deny')
      return { behavior: 'deny', message: 'Refusé par la politique de l’agent' };

    const run = this.store.getRun(runId);
    if (!run) return { behavior: 'deny', message: 'Run introuvable' };

    this.emitEvent(run, 'permission_request', { toolName, toolInput: input });
    run.status = 'waiting_approval';
    this.store.updateRun(run);
    this.bus.publish({ type: 'run.updated', payload: run });

    const { decision, resolvedBy, note } = await this.approvals.requestHumanApproval(
      runId,
      agent,
      toolName,
      input,
    );

    const fresh = this.store.getRun(runId);
    if (fresh && !fresh.endedAt) {
      fresh.status = 'running';
      this.store.updateRun(fresh);
      this.bus.publish({ type: 'run.updated', payload: fresh });
    }
    this.emitEvent(run, 'permission_result', {
      toolName,
      decision: decision === 'allow' ? 'allowed' : 'denied',
      resolvedBy,
    });

    return decision === 'allow'
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: note ?? 'Refusé par l’opérateur' };
  }

  // -- Finalisation -----------------------------------------------------------------

  private emitEvent(
    run: Run,
    kind: Parameters<Store['insertRunEvent']>[2],
    payload: Parameters<Store['insertRunEvent']>[3],
  ): void {
    const event = this.store.insertRunEvent(run.id, run.agentId, kind, payload);
    this.bus.publish({ type: 'run.event', payload: event });
  }

  private finalize(
    run: Run,
    status: RunStatus,
    extra: { error?: string | null; resultText?: string | null },
  ): void {
    run.status = status;
    run.endedAt = nowIso();
    if (extra.error !== undefined) run.error = extra.error;
    if (extra.resultText !== undefined && extra.resultText !== null)
      run.resultText = extra.resultText;
    this.store.updateRun(run);
    this.bus.publish({ type: 'run.updated', payload: run });

    if (run.origin === 'kanban' && run.originId) {
      this.tasks.onRunLifecycle(
        run.originId,
        run.id,
        status === 'succeeded' ? 'succeeded' : 'failed',
      );
    }

    const agent = this.agents.get(run.agentId);
    const label = agent?.name ?? run.agentId;
    if (status === 'succeeded') {
      this.bus.log(
        'success',
        'runs',
        `Run ${run.id} (« ${label} ») terminé — ${run.numTurns} tours, $${run.costUsd.toFixed(4)}`,
        {
          agentId: run.agentId,
          runId: run.id,
        },
      );
    } else {
      this.bus.log(
        'error',
        'runs',
        `Run ${run.id} (« ${label} ») : ${status}${run.error ? ` — ${truncate(run.error, 200)}` : ''}`,
        {
          agentId: run.agentId,
          runId: run.id,
        },
      );
    }

    const waiters = this.waiters.get(run.id);
    if (waiters) {
      this.waiters.delete(run.id);
      for (const w of waiters) w(run);
    }
  }
}
