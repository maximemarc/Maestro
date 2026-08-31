/**
 * Moteur d'exécution : chaque run est une session Claude Code, pilotée soit
 * par le Claude Agent SDK (streaming fin, permissions, MCP), soit dans une
 * session tmux attachable. File d'attente globale + sérialisation par agent,
 * garde-fous (tours, délai, budget tokens), reprise de session.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import {
  PROVIDER_CAPABILITIES,
  PROVIDER_LABELS,
  type AgentConfig,
  type FailureClass,
  type FailureVerdict,
  type ProviderAccount,
  type ProviderKind,
  type ResiliencePolicy,
  type Run,
  type RunAttempt,
  type RunOrigin,
  type RunStatus,
  type SessionHandoff,
} from '@maestro/shared';
import { ZERO_USAGE, type AttemptOutcome, type UsageDelta } from './providers/adapter.ts';
import { classifyFailure, classifySilentSuccess, FAILURE_LABELS } from './providers/failure.ts';
import { HandoffService } from './providers/handoff.ts';
import {
  formatDuration,
  planFirstAttempt,
  planRecovery,
  type AttemptPlan,
} from './providers/policy.ts';
import type { ProviderService } from './providers/registry.ts';
import type { AgentService } from './agents.ts';
import type { Bus } from './bus.ts';
import type { MaestroConfig } from './config.ts';
import type { Store } from './db.ts';
import type { TaskService } from './kanban.ts';
import type { ControlDeps } from './mcp-actions.ts';
import { buildMaestroServer } from './mcp-control.ts';
import { buildCustomServer } from './mcp-custom.ts';
import { snapshot as gitSnapshot } from './workspace-git.ts';
import { buildRagServer } from './mcp-rag.ts';
import type { ApprovalBroker } from './permissions.ts';
import type { McpRegistry } from './mcp-registry.ts';
import type { PluginService } from './plugins.ts';
import type { RagService } from './rag.ts';
import { buildSandboxSettings, describeSandbox } from './sandbox.ts';
import type { SkillRegistry } from './skills.ts';
import { TmuxBridge } from './tmux.ts';
import { makeId, nowIso, truncate } from './util.ts';

/** Longueurs de capture d'un transcript destiné à la lecture. */
const TOOL_RESULT_LIMIT = 1500;
const THINKING_LIMIT = 2000;
/** Et celles d'une capture destinée à l'entraînement (voir Settings). */
const FULL_TOOL_RESULT_LIMIT = 60_000;
const FULL_THINKING_LIMIT = 20_000;

/**
 * Priorité d'un run dans la file.
 *
 * Elle ne vient pas d'un réglage mais de l'origine, parce que c'est l'origine
 * qui dit si quelqu'un attend devant son écran. Un lot d'entraînement de mille
 * échantillons occupait sinon les quatre places du plafond pendant des heures,
 * et un run lancé à la main restait derrière lui sans explication.
 */
export type RunPriority = 'interactive' | 'normal' | 'background';

/**
 * Origines derrière lesquelles un humain attend une réponse.
 *
 * Le kanban en fait partie : on y confie une carte et on regarde la colonne
 * bouger. Une routine cron, non — personne n'est devant.
 */
const INTERACTIVE_ORIGINS: readonly RunOrigin[] = [
  'manual',
  'telegram',
  'discord',
  'slack',
  'kanban',
];

export function priorityForOrigin(origin: RunOrigin): RunPriority {
  if (INTERACTIVE_ORIGINS.includes(origin)) return 'interactive';
  // Un échantillon de lot est du travail de fond par définition : il en existe
  // des milliers, et aucun n'est attendu individuellement.
  if (origin === 'training') return 'background';
  return 'normal';
}

const PRIORITY_RANK: Record<RunPriority, number> = {
  interactive: 0,
  normal: 1,
  background: 2,
};

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
  /**
   * Politique de résilience imposée à ce run, qui l'emporte sur celle de
   * l'agent. Les étapes de pipeline s'en servent pour router une étape vers un
   * autre fournisseur sans dupliquer l'agent.
   */
  resiliencePolicyId?: string | null;
  /**
   * Sauts entre machines déjà effectués par la chaîne de délégation qui a mené
   * à ce run. Renseigné par la fédération, propagé aux délégations suivantes.
   */
  federationHops?: number;
  /** Force la priorité ; par défaut elle se déduit de l'origine. */
  priority?: RunPriority;
}

/** Paramètres d'un run en file, conservés jusqu'à son démarrage effectif. */
interface QueuedParams {
  depth: number;
  timeoutSecOverride: number | null;
  bypassConcurrencyCap: boolean;
  policyOverride: string | null;
  federationHops: number;
  priority: RunPriority;
}

interface ActiveRun {
  abort: AbortController;
  depth: number;
  priority: RunPriority;
  report: string | null;
  cancelStatus: RunStatus | null;
  stderrTail: string;
  bypassConcurrencyCap: boolean;
  policyOverride: string | null;
  /** Sauts entre machines hérités, transmis aux outils de contrôle. */
  federationHops: number;
  /**
   * Nature d'échec déjà connue de Maestro (budget, annulation), qui prime sur
   * l'analyse du message : reclasser une décision interne en incident
   * fournisseur ferait basculer un run qu'on vient volontairement d'arrêter.
   */
  failureHint: FailureClass | null;
}

/** Ce qui distingue une tentative d'une autre : compte, modèle, prompt, session. */
interface AttemptSetup {
  account: ProviderAccount | null;
  model: string;
  prompt: string;
  resumeSessionId: string | null;
  env: NodeJS.ProcessEnv;
  /** Appelé à chaque tour avec le cumul de tokens — alimente le seuil de handoff. */
  onProgress: (tokens: number) => void;
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
    private providers: ProviderService,
    private handoffs: HandoffService,
    /**
     * Délégation vers une autre instance.
     *
     * Injectée après construction plutôt qu'au constructeur : la fédération a
     * besoin du moteur pour rien, mais le moteur en a besoin pour ses outils de
     * contrôle. Un paramètre créerait une dépendance circulaire à l'assemblage.
     */
    private federation?: ControlDeps['federation'],
  ) {}

  /** Branche la fédération après coup, une fois les deux services construits. */
  attachFederation(federation: ControlDeps['federation']): void {
    this.federation = federation;
  }

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
      /* Renseignés pour de bon au démarrage de la première tentative : à la
         création, la politique n'a pas encore été résolue. */
      providerKind: 'claude-sdk',
      accountId: null,
      accountName: null,
      attemptCount: 0,
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
      policyOverride: input.resiliencePolicyId ?? null,
      federationHops: input.federationHops ?? 0,
      priority: input.priority ?? priorityForOrigin(input.origin),
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
      activeEntry.failureHint = 'cancelled';
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

    /*
     * Run actif que le moteur ne pilote pas : une session externe, menée par un
     * client MCP tiers. Elle ne s'interrompt pas — Maestro ne tient pas ce
     * client — mais l'annulation reste utile : la cascade ci-dessus a déjà
     * arrêté les runs qu'elle avait délégués, et la clore retire la session de
     * Mission Control. Sans ce cas, un tel run restait « en cours » à vie, sans
     * aucune prise.
     */
    if (!run.endedAt) {
      this.finalize(run, 'cancelled', {
        error:
          run.origin === 'external'
            ? "Session externe close depuis Maestro. Le client tiers n'est pas interrompu : il rouvrira une session à son prochain appel."
            : 'Annulé',
      });
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
      entry.failureHint = 'cancelled';
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
      let backgroundActive = 0;
      for (const [activeId, entry] of this.active) {
        const activeRun = this.store.getRun(activeId);
        if (!activeRun) continue;
        busyAgents.add(activeRun.agentId);
        if (!entry.bypassConcurrencyCap) cappedActive++;
        if (entry.priority === 'background') backgroundActive++;
      }
      const slotAvailable = cappedActive < settings.maxConcurrentRuns;

      /*
       * Une place est tenue hors de portée du travail de fond.
       *
       * Un lot d'entraînement de mille échantillons occupait sinon les quatre
       * places du plafond pendant des heures : un run lancé à la main attendait
       * derrière lui, sans que rien n'explique pourquoi. Le fond ne peut donc
       * jamais prendre la dernière place. Sur un plafond de 1, ce garde-fou est
       * neutralisé — sinon aucun lot ne démarrerait jamais.
       */
      const backgroundCap = Math.max(1, settings.maxConcurrentRuns - 1);
      const backgroundAllowed = backgroundActive < backgroundCap;

      const eligible = (runId: string): boolean => {
        const run = this.store.getRun(runId);
        if (!run || busyAgents.has(run.agentId)) return false;
        const params = this.queuedParams.get(runId);
        if (params?.bypassConcurrencyCap) return true;
        if (!slotAvailable) return false;
        return params?.priority === 'background' ? backgroundAllowed : true;
      };

      /*
       * À égalité d'éligibilité, la priorité tranche — et l'ordre d'arrivée
       * départage. `findIndex` seul servait le premier arrivé quelle que soit
       * son urgence, ce qui plaçait un échantillon de lot devant une demande
       * humaine.
       */
      let idx = -1;
      let bestRank = Number.POSITIVE_INFINITY;
      for (let i = 0; i < this.queue.length; i++) {
        const runId = this.queue[i];
        if (!runId || !eligible(runId)) continue;
        const rank = PRIORITY_RANK[this.queuedParams.get(runId)?.priority ?? 'normal'];
        if (rank < bestRank) {
          bestRank = rank;
          idx = i;
          if (rank === 0) break; // rien ne passe devant l'interactif
        }
      }
      if (idx === -1) return; // agents occupés, plafond atteint, ou place réservée
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
    const {
      depth,
      timeoutSecOverride,
      bypassConcurrencyCap,
      policyOverride,
      federationHops,
      priority,
    } = params ?? {
      depth: 0,
      timeoutSecOverride: null,
      bypassConcurrencyCap: false,
      policyOverride: null,
      federationHops: 0,
      priority: 'normal' as const,
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
      priority,
      report: null,
      cancelStatus: null,
      stderrTail: '',
      bypassConcurrencyCap,
      policyOverride,
      federationHops,
      failureHint: null,
    };
    this.active.set(run.id, entry);

    run.status = 'running';
    run.startedAt = nowIso();
    this.store.updateRun(run);
    await this.captureGitBase(run, agent);
    this.bus.publish({ type: 'run.updated', payload: run });
    if (run.origin === 'kanban' && run.originId) {
      this.tasks.onRunLifecycle(run.originId, run.id, 'started');
    }

    try {
      if (run.engine === 'tmux') {
        /* Le moteur tmux reste hors du mécanisme de repli : une session
           interactive attachable ne se rejoue pas ailleurs, et un opérateur
           attaché à un terminal ne veut pas voir sa session déplacée sous ses
           pieds. */
        await this.executeTmux(run, agent, entry, timeoutSecOverride);
      } else {
        await this.executeWithFallback(run, agent, entry, timeoutSecOverride);
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

  /**
   * Boucle de tentatives : exécute, classe l'échec, décide, recommence.
   *
   * Toute la valeur du multi-fournisseurs tient ici. Le run n'est finalisé
   * qu'une fois — à la réussite, ou quand le routeur renonce — pour que
   * l'extérieur (kanban, pipelines, Telegram) ne voie jamais un échec
   * intermédiaire comme un échec définitif.
   */
  private async executeWithFallback(
    run: Run,
    agent: AgentConfig,
    entry: ActiveRun,
    timeoutSecOverride: number | null,
  ): Promise<void> {
    const policy = this.providers.effectivePolicy(agent, entry.policyOverride);
    const resolved = policy
      ? this.providers.withinBudget(this.providers.resolveTargets(policy))
      : [];
    const routed = policy !== null && resolved.length > 0;

    if (policy && resolved.length === 0) {
      this.bus.log(
        'warn',
        'runs',
        `Politique « ${policy.name} » : aucun compte utilisable — repli sur l'environnement ambiant`,
        { runId: run.id, agentId: agent.id },
      );
    }

    const basePrompt = this.buildPrompt(run);
    let handoff: SessionHandoff | null = null;
    let thresholdCaptured = false;
    let attemptIndex = 0;
    let attemptsOnCurrent = 0;
    let lastOutcome: AttemptOutcome | null = null;
    let lastVerdict: FailureVerdict | null = null;

    let plan: AttemptPlan = routed
      ? planFirstAttempt({
          policy: policy!,
          targets: resolved,
          nowMs: Date.now(),
          underPressure: this.providers.underPressure(policy!),
        })
      : {
          action: 'retry_same',
          target: null,
          waitMs: 0,
          requiresHandoff: false,
          reason: 'environnement ambiant du serveur, sans repli',
        };

    while (plan.action !== 'give_up') {
      if (entry.abort.signal.aborted) break;

      if (plan.waitMs > 0) {
        this.emitEvent(run, 'info', {
          text: `Attente de ${formatDuration(plan.waitMs)} — ${plan.reason}`,
        });
        run.status = 'queued';
        this.store.updateRun(run);
        this.bus.publish({ type: 'run.updated', payload: run });
        const slept = await this.sleep(plan.waitMs, entry.abort.signal);
        if (!slept) break;
        run.status = 'running';
        this.store.updateRun(run);
        this.bus.publish({ type: 'run.updated', payload: run });
      }

      /* Une session appartient au compte qui l'a créée : dès qu'on change de
         cible, l'identifiant de reprise ne vaut plus rien et c'est le résumé
         qui prend le relais. */
      if (plan.requiresHandoff && !entry.abort.signal.aborted) {
        handoff = await this.handoffs.capture({
          run,
          agent,
          reason:
            lastVerdict?.klass === 'context'
              ? 'context'
              : lastVerdict?.klass === 'quota'
                ? 'quota'
                : 'switch',
          tokensAtCapture: run.inputTokens + run.outputTokens,
          /* Sur le chemin d'un blocage, tenter un résumé raisonné retarderait
             la bascule pour un appel qui échouera probablement aussi. */
          allowModel: lastVerdict?.klass !== 'quota',
        });
        run.sessionId = null;
      }

      const account = plan.target?.account ?? null;
      const kind = account?.kind ?? 'claude-sdk';
      const model = plan.target?.target.model ?? account?.model ?? agent.model;
      const label = account?.name ?? 'environnement ambiant';

      attemptIndex++;
      attemptsOnCurrent = plan.action === 'switch_account' ? 1 : attemptsOnCurrent + 1;

      run.providerKind = kind;
      run.accountId = account?.id ?? null;
      run.accountName = account?.name ?? null;
      run.attemptCount = attemptIndex;
      run.model = model;
      this.store.updateRun(run);
      this.bus.publish({ type: 'run.updated', payload: run });

      const attemptRow = this.store.insertRunAttempt({
        runId: run.id,
        index: attemptIndex,
        accountId: account?.id ?? null,
        accountName: label,
        providerKind: kind,
        model,
        status: 'running',
        failureClass: null,
        error: null,
        waitedMs: plan.waitMs,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        startedAt: nowIso(),
        endedAt: null,
      });
      this.bus.publish({ type: 'run.attempt', payload: attemptRow });
      if (attemptIndex > 1) {
        this.emitEvent(run, 'info', {
          text: `Tentative ${attemptIndex} — ${plan.reason}`,
        });
      } else if (plan.target && plan.target.index > 0) {
        /* Premier essai ailleurs que sur le compte de tête : c'est le cas
           surprenant. Le taire laisserait l'opérateur devant un run exécuté par
           un compte qu'il n'avait pas mis en premier, sans explication. */
        this.emitEvent(run, 'info', { text: `Démarrage sur le ${plan.reason}` });
      }

      this.warnIfPermissionsUnenforced(run, agent, kind);

      const prompt = handoff ? `${HandoffService.preamble(handoff)}\n${basePrompt}` : basePrompt;
      const env = this.providers.envForAccount(account);
      const setup: AttemptSetup = {
        account,
        model,
        prompt,
        resumeSessionId: run.sessionId,
        env,
        onProgress: (tokens) => {
          if (thresholdCaptured || !policy || policy.handoffThresholdPct <= 0) return;
          if (!this.overHandoffThreshold(agent, policy, tokens, account?.id ?? null)) return;
          thresholdCaptured = true;
          /* Capture anticipée, volontairement non attendue : bloquer le flux
             du transcript pour rédiger un résumé rendrait l'interface muette
             pendant tout l'appel. */
          void this.handoffs
            .capture({ run, agent, reason: 'threshold', tokensAtCapture: tokens, allowModel: true })
            .then((captured) => {
              handoff = captured;
            })
            .catch(() => {
              /* Échec sans conséquence : le filet de sécurité recapturera au
                 moment du blocage, en mode mécanique. */
            });
        },
      };

      const outcome = await this.runOneAttempt(run, agent, entry, timeoutSecOverride, setup, kind);
      lastOutcome = outcome;
      this.applyUsage(run, outcome);

      /* La classification précède l'enregistrement : la tentative n'est écrite
         qu'une fois, avec sa classe d'échec. L'écrire d'abord sans, puis la
         corriger, laissait passer un état intermédiaire faux dans la base et
         dans tout ce qui l'observe. */
      const verdict =
        outcome.status === 'succeeded'
          ? null
          : classifyFailure({
              message: outcome.error ?? 'échec sans message',
              status: outcome.failureSignal?.status ?? null,
              headers: outcome.failureSignal?.headers ?? null,
              code: outcome.failureSignal?.code ?? null,
              hint: outcome.failureSignal?.hint ?? null,
            });

      const settled: RunAttempt = {
        ...attemptRow,
        status: outcome.status,
        failureClass: verdict?.klass ?? null,
        error: outcome.error,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        cacheReadTokens: outcome.usage.cacheReadTokens,
        cacheWriteTokens: outcome.usage.cacheWriteTokens,
        costUsd: outcome.usage.costUsd,
        endedAt: nowIso(),
      };
      this.store.updateRunAttempt(settled);
      /* Diffusé, et pas seulement enregistré : sans cet événement, un transcript
         ouvert gardait la tentative sur « en cours » jusqu'au rechargement de
         la page — y compris après la fin du run. */
      this.bus.publish({ type: 'run.attempt', payload: settled });

      if (outcome.status === 'succeeded' || !verdict) {
        this.providers.markSuccess(account?.id ?? null);
        this.finalize(run, 'succeeded', { resultText: outcome.resultText });
        return;
      }

      lastVerdict = verdict;
      this.emitEvent(run, 'error', {
        text: `Tentative ${attemptIndex} sur « ${label} » : ${FAILURE_LABELS[verdict.klass]} — ${verdict.message}`,
      });
      this.providers.markFailure(account?.id ?? null, verdict);

      if (verdict.klass === 'cancelled' || entry.abort.signal.aborted) break;

      if (!routed || !policy) {
        plan = {
          action: 'give_up',
          target: null,
          waitMs: 0,
          requiresHandoff: false,
          reason: FAILURE_LABELS[verdict.klass],
        };
        break;
      }

      plan = planRecovery({
        policy,
        targets: this.providers.withinBudget(this.providers.resolveTargets(policy)),
        verdict,
        currentAccountId: account?.id ?? null,
        attemptsOnCurrent,
        totalAttempts: attemptIndex,
        nowMs: Date.now(),
      });
      if (plan.action !== 'give_up') {
        this.bus.log('info', 'runs', `Run ${run.id} — ${plan.reason}`, {
          runId: run.id,
          agentId: agent.id,
        });
      }
    }

    /*
     * Filet de sécurité : un run qui s'arrête sur une limite d'usage ou un
     * contexte saturé laisse un travail en cours. Le résumer maintenant, même
     * mécaniquement, est la seule façon de pouvoir le reprendre ailleurs plus
     * tard — c'est précisément le moment où plus aucun modèle n'est joignable.
     */
    if (lastVerdict && (lastVerdict.klass === 'quota' || lastVerdict.klass === 'context')) {
      await this.handoffs
        .capture({
          run,
          agent,
          reason: lastVerdict.klass === 'context' ? 'context' : 'quota',
          tokensAtCapture: run.inputTokens + run.outputTokens,
          allowModel: false,
        })
        .catch(() => undefined);
    }

    const status: RunStatus = entry.cancelStatus ?? 'failed';
    const reason = plan.action === 'give_up' && plan.reason ? plan.reason : null;
    this.finalize(run, status, {
      error:
        status === 'cancelled'
          ? 'Annulé'
          : status === 'timeout'
            ? 'Délai maximal dépassé'
            : [lastOutcome?.error, reason].filter(Boolean).join(' — ') || 'Échec',
      resultText: lastOutcome?.resultText ?? entry.report,
    });
  }

  /** Aiguille vers le SDK Claude ou vers un adaptateur externe. */
  private async runOneAttempt(
    run: Run,
    agent: AgentConfig,
    entry: ActiveRun,
    timeoutSecOverride: number | null,
    setup: AttemptSetup,
    kind: ProviderKind,
  ): Promise<AttemptOutcome> {
    if (kind === 'claude-sdk') {
      return await this.executeSdk(run, agent, entry, timeoutSecOverride, setup);
    }
    const adapter = this.providers.adapterFor(kind);
    if (!adapter) {
      return {
        status: 'failed',
        sessionId: null,
        resultText: null,
        error: `Fournisseur « ${kind} » sans adaptateur`,
        failureSignal: { hint: 'fatal' },
        usage: { ...ZERO_USAGE },
      };
    }
    /*
     * Contrôleur propre à la tentative, relié à celui du run.
     *
     * L'annulation descend (le run coupe la tentative), elle ne remonte pas.
     * Passer directement le contrôleur du run rendait le repli inopérant : un
     * adaptateur qui abandonne sur son propre délai maximal annulait le
     * contrôleur partagé, et la boucle s'arrêtait aussitôt sur
     * `entry.abort.signal.aborted` — sans jamais essayer le compte suivant.
     * Le garde-fou d'une tentative désarmait le mécanisme entier.
     */
    const attemptAbort = new AbortController();
    const relay = (): void => attemptAbort.abort();
    if (entry.abort.signal.aborted) attemptAbort.abort();
    else entry.abort.signal.addEventListener('abort', relay, { once: true });

    try {
      return await adapter.execute({
        run,
        agent,
        account: setup.account,
        model: setup.model,
        prompt: setup.prompt,
        resumeSessionId: setup.resumeSessionId,
        workspaceDir: agent.workspaceDir,
        timeoutSec: timeoutSecOverride ?? agent.timeoutSec,
        abort: attemptAbort,
        env: setup.env,
        emit: (eventKind, payload) => this.emitEvent(run, eventKind, payload),
        onUsage: () => undefined,
      });
    } finally {
      // Sans ce retrait, chaque tentative laisserait un écouteur derrière elle.
      entry.abort.signal.removeEventListener('abort', relay);
    }
  }

  /**
   * Cumule la consommation d'une tentative sur le run.
   *
   * Additif, et non remplaçant : un run qui a basculé deux fois a réellement
   * consommé sur deux comptes, et n'afficher que la dernière tentative
   * sous-estimerait la facture.
   */
  private applyUsage(run: Run, outcome: AttemptOutcome): void {
    run.inputTokens += outcome.usage.inputTokens;
    run.outputTokens += outcome.usage.outputTokens;
    run.cacheReadTokens += outcome.usage.cacheReadTokens;
    run.cacheWriteTokens += outcome.usage.cacheWriteTokens;
    run.costUsd += outcome.usage.costUsd;
    run.numTurns += outcome.usage.numTurns;
    if (outcome.sessionId) run.sessionId = outcome.sessionId;
    this.store.updateRun(run);
  }

  /**
   * Seuil de capture anticipée.
   *
   * Deux jauges possibles — budget de tokens, nombre de tours — et aucune n'est
   * obligatoire. Sans garde-fou configuré, il n'existe aucune notion de « fin
   * proche » : la capture anticipée est alors simplement inactive, et le filet
   * de sécurité reste seul en poste.
   */
  private overHandoffThreshold(
    agent: AgentConfig,
    policy: ResiliencePolicy,
    tokens: number,
    accountId: string | null,
  ): boolean {
    if (
      agent.tokenBudget &&
      agent.tokenBudget > 0 &&
      (tokens / agent.tokenBudget) * 100 >= policy.handoffThresholdPct
    ) {
      return true;
    }
    /*
     * Seconde jauge : la fenêtre du compte lui-même.
     *
     * C'est celle qui compte vraiment, et la seule qui existe quand l'agent n'a
     * pas de budget déclaré — le cas courant. Elle permet de capturer le résumé
     * pendant qu'un modèle répond encore, au lieu d'attendre le refus et de
     * devoir se rabattre sur une reconstruction mécanique.
     */
    if (!accountId) return false;
    const usage = this.providers.usageFor(accountId);
    if (!usage || usage.pressure === null) return false;
    return usage.pressure * 100 >= policy.handoffThresholdPct;
  }

  /**
   * Prévient quand la politique d'approbation devient déclarative.
   *
   * Un agent en `guarded` ou `ask` exécuté par un CLI tiers n'est plus protégé
   * par le broker : le dire dans le transcript est le minimum, le taire serait
   * une fausse assurance de sécurité.
   */
  private warnIfPermissionsUnenforced(run: Run, agent: AgentConfig, kind: ProviderKind): void {
    if (PROVIDER_CAPABILITIES[kind].interceptsPermissions) return;
    if (agent.approvalPolicy === 'auto') return;
    const text =
      `⚠ Politique d'approbation « ${agent.approvalPolicy} » non applicable sur ${PROVIDER_LABELS[kind]} : ` +
      `ce moteur n'expose pas d'interception d'outils. Les garde-fous de Maestro sont déclaratifs pour cette tentative.`;
    this.emitEvent(run, 'info', { text });
    this.bus.log('warn', 'runs', text, { runId: run.id, agentId: agent.id });
  }

  /** Attente interruptible ; rend faux si le run a été annulé pendant. */
  private sleep(ms: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      }, ms);
      function onAbort(): void {
        clearTimeout(timer);
        resolve(false);
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
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

  /**
   * Enregistre l'état git du répertoire de l'agent avant que le run n'écrive.
   *
   * Sans ce point de référence, impossible de distinguer ensuite ce que l'agent
   * a produit de ce qui traînait déjà — et imputer à une machine le travail en
   * cours d'un humain est la pire façon de présenter un diff.
   *
   * Un échec est silencieux au niveau du run : la plupart des répertoires
   * d'agents ne sont pas des dépôts, et ce n'est pas une anomalie. Le run n'a
   * aucune raison d'échouer parce que git n'a rien à dire.
   */
  private async captureGitBase(run: Run, agent: AgentConfig): Promise<void> {
    try {
      const base = await gitSnapshot(agent.workspaceDir);
      if (base) this.store.saveRunGitBase(run.id, base);
    } catch (err) {
      /* `snapshot` rend null sans lever quand le répertoire n'est pas un dépôt :
         ce cas normal ne passe donc pas ici. Ce qui arrive ici est une vraie
         anomalie — git absent, dépôt corrompu, permissions — et mérite le
         journal. */
      this.bus.log(
        'warn',
        'runs',
        `Suivi git impossible pour ${agent.name} : ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Une tentative sur le fournisseur Claude Code.
   *
   * Rend un résultat, ne finalise pas : c'est `executeWithFallback` qui décide
   * si l'échec vaut un nouvel essai, une bascule ou un abandon. Une méthode qui
   * clôturerait le run ici rendrait tout repli impossible.
   */
  private async executeSdk(
    run: Run,
    agent: AgentConfig,
    entry: ActiveRun,
    timeoutSecOverride: number | null,
    attempt: AttemptSetup,
  ): Promise<AttemptOutcome> {
    const settings = this.store.getSettings();
    const maestroServer = buildMaestroServer(
      {
        tasks: this.tasks,
        agents: this.agents,
        bus: this.bus,
        engine: this,
        skills: this.skills,
        maxAgentDepth: () => settings.maxAgentDepth,
        federation: this.federation,
      },
      /* Les sauts entre machines voyagent avec le run : sans cela, un run créé
         par une voisine repartirait de zéro et un aller-retour A→B→A ne serait
         borné par rien. */
      { runId: run.id, agent, depth: entry.depth, federationHops: entry.federationHops },
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

    const sandboxSettings = buildSandboxSettings(agent.sandbox, { dataDir: this.config.dataDir });
    const sandboxNote = describeSandbox(sandboxSettings);
    if (sandboxNote) {
      // Un confinement actif change ce que l'agent peut faire : le taire rendrait
      // incompréhensible une commande qui échoue faute de réseau.
      this.bus.log('info', 'runs', `Run ${run.id} : ${sandboxNote}`, {
        agentId: agent.id,
        runId: run.id,
      });
    }

    // Note : les outils mcp__maestro__* ne sont PAS mis dans allowedTools — une
    // entrée nue y court-circuiterait canUseTool ; le broker les autorise déjà.
    const options: Options = {
      cwd: agent.workspaceDir,
      model: attempt.model,
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
      /*
       * Confinement, quand l'agent en a un.
       *
       * Étalé conditionnellement et non passé à `undefined` : un agent sans bac
       * à sable doit produire exactement les options d'avant, sans clé
       * supplémentaire dont le SDK pourrait un jour tirer un comportement.
       */
      ...(sandboxSettings ? { sandbox: sandboxSettings } : {}),
      /*
       * La session à reprendre appartient à la **tentative**, pas au run.
       *
       * C'est la différence qu'introduit le repli multi-comptes : une seconde
       * tentative s'exécute sur un autre compte, donc une autre session. Passer
       * `run.sessionId` ferait reprendre chez B une session ouverte chez A, que
       * B ne connaît pas — et la reprise échouerait sans dire pourquoi.
       */
      ...(attempt.resumeSessionId ? { resume: attempt.resumeSessionId } : {}),
      abortController: entry.abort,
      stderr: (data: string) => {
        entry.stderrTail = (entry.stderrTail + data).slice(-4000);
      },
      canUseTool: async (toolName, input): Promise<PermissionResult> =>
        this.handlePermission(run.id, agent, toolName, input, forcedApproval),
      env: { ...attempt.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'maestro/0.1.0' },
    };

    /*
     * Longueurs de capture.
     *
     * Le transcript sert d'abord à être lu à l'écran, d'où des retours d'outils
     * raccourcis. Mais ces mêmes événements sont la matière première des
     * trajectoires d'entraînement, et une observation coupée y devient une
     * erreur d'étiquetage : le modèle apprend à s'arrêter au milieu d'un
     * résultat. Le réglage lève donc la limite, sans la supprimer — une borne
     * haute reste indispensable, un `find /` produit des mégaoctets.
     */
    const fullCapture = settings.fullTrajectoryCapture;
    const toolResultLimit = fullCapture ? FULL_TOOL_RESULT_LIMIT : TOOL_RESULT_LIMIT;
    const thinkingLimit = fullCapture ? FULL_THINKING_LIMIT : THINKING_LIMIT;

    let cumulatedTokens = 0;
    let gotResult = false;
    const usage: UsageDelta = { ...ZERO_USAGE };

    try {
      for await (const message of query({ prompt: attempt.prompt, options })) {
        if (message.type === 'system' && message.subtype === 'init') {
          run.sessionId = message.session_id;
          this.store.updateRun(run);
          this.emitEvent(run, 'init', {
            sessionId: message.session_id,
            model: message.model,
            tools: message.tools,
          });
        } else if (message.type === 'assistant') {
          const turnUsage = message.message.usage;
          if (turnUsage) {
            cumulatedTokens += (turnUsage.input_tokens ?? 0) + (turnUsage.output_tokens ?? 0);
            attempt.onProgress(cumulatedTokens);
            if (agent.tokenBudget && cumulatedTokens > agent.tokenBudget) {
              entry.cancelStatus = 'failed';
              entry.failureHint = 'budget';
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
              this.emitEvent(run, 'thinking', { text: truncate(block.thinking, thinkingLimit) });
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
                  text: truncate(textPart, toolResultLimit),
                });
              }
            }
          }
        } else if (message.type === 'result') {
          gotResult = true;
          run.sessionId = message.session_id;
          usage.numTurns = message.num_turns;
          usage.costUsd = message.total_cost_usd;
          usage.inputTokens = message.usage.input_tokens ?? 0;
          usage.outputTokens = message.usage.output_tokens ?? 0;
          usage.cacheReadTokens = message.usage.cache_read_input_tokens ?? 0;
          usage.cacheWriteTokens = message.usage.cache_creation_input_tokens ?? 0;
          this.emitEvent(run, 'result', {
            usage: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
            },
            costUsd: usage.costUsd,
            numTurns: usage.numTurns,
            durationMs: message.duration_ms,
          });
          if (message.subtype === 'success') {
            /* Un « succès » qui n'a consommé aucun token n'a pas été produit
               par un modèle : c'est un message d'erreur du CLI présenté comme
               une réponse. Le prendre au mot clôturerait le run en vert sans
               jamais tenter le compte suivant. */
            const consumed =
              usage.inputTokens +
              usage.outputTokens +
              usage.cacheReadTokens +
              usage.cacheWriteTokens;
            const disguised = classifySilentSuccess(message.result, consumed);
            if (disguised) {
              return {
                status: 'failed',
                sessionId: run.sessionId,
                resultText: null,
                error: message.result,
                failureSignal: { hint: disguised },
                usage,
              };
            }
            return {
              status: 'succeeded',
              sessionId: run.sessionId,
              resultText: entry.report ?? message.result,
              error: null,
              usage,
            };
          }
          const reason =
            message.subtype === 'error_max_turns'
              ? 'Nombre de tours maximum atteint'
              : message.subtype === 'error_max_budget_usd'
                ? 'Budget maximal (USD) atteint'
                : `Erreur d'exécution${'errors' in message && message.errors.length ? ` : ${message.errors.join(' ; ')}` : ''}`;
          /* Tours et budget sont des garde-fous configurés, pas des incidents
             fournisseur : les rejouer ailleurs redonnerait le même verdict. */
          const guardrail =
            message.subtype === 'error_max_turns' || message.subtype === 'error_max_budget_usd';
          return {
            status: 'failed',
            sessionId: run.sessionId,
            resultText: entry.report,
            error: reason,
            failureSignal: guardrail ? { hint: 'budget' } : {},
            usage,
          };
        }
      }
      /* Le flux s'est tari sans message `result` : ni succès ni erreur nommée.
         C'est anormal, et le taire ferait passer un run vide pour une réussite. */
      if (!gotResult) {
        return {
          status: 'failed',
          sessionId: run.sessionId,
          resultText: entry.report,
          error: 'La session s’est terminée sans résultat',
          failureSignal: { hint: entry.failureHint },
          usage,
        };
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const stderrHint = entry.stderrTail
        ? `\n--- stderr ---\n${entry.stderrTail.slice(-1500)}`
        : '';
      const cancelled = entry.cancelStatus === 'cancelled';
      const timedOut = entry.cancelStatus === 'timeout';
      return {
        status: 'failed',
        sessionId: run.sessionId,
        resultText: entry.report,
        error: cancelled ? 'Annulé' : timedOut ? 'Délai maximal dépassé' : `${detail}${stderrHint}`,
        failureSignal: {
          code: (err as NodeJS.ErrnoException)?.code ?? null,
          /* Un délai dépassé est un garde-fou Maestro, comme le budget : le
             rejouer ailleurs relancerait la même course contre le même
             chronomètre. */
          hint: cancelled ? 'cancelled' : timedOut ? 'budget' : entry.failureHint,
        },
        usage,
      };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }

    return {
      status: 'failed',
      sessionId: run.sessionId,
      resultText: entry.report,
      error: 'Session interrompue',
      failureSignal: { hint: entry.failureHint },
      usage,
    };
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
