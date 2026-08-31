/**
 * Sessions externes : un run Maestro pour ce qu'un client MCP tiers fait.
 *
 * Le problème que ça résout. Depuis la passerelle, un Codex ou un OpenCode peut
 * agir au nom d'un agent Maestro. Sans trace, ces actions se produisent dans
 * l'angle mort de l'orchestrateur : le kanban bouge sans qu'on sache qui l'a
 * bougé, une délégation part sans parent, rien n'apparaît dans Mission Control,
 * et rien n'est annulable. Un run d'origine `external` rend tout cela visible.
 *
 * ## Ce que ce run est, et ce qu'il n'est pas
 *
 * Il **n'exécute rien**. Le travail se fait chez le client tiers ; Maestro n'a
 * ni son transcript, ni ses tokens, ni son coût. Le run est le **journal de la
 * session** : il donne un parent aux runs délégués, une ligne dans Mission
 * Control, et une prise pour l'annulation.
 *
 * ## Pourquoi une session par agent, et non par appel
 *
 * Le transport Streamable HTTP de la passerelle est sans état — il n'y a pas
 * d'identifiant de session à suivre. Ouvrir un run par appel d'outil noierait
 * la liste des runs sous des dizaines de lignes d'une ligne. La session est
 * donc rattachée à l'agent au nom duquel le client agit, ouverte au premier
 * geste et refermée après un silence.
 *
 * ## Ce qu'annuler veut dire
 *
 * Annuler une session externe **annule en cascade les runs qu'elle a
 * délégués** — c'est le geste utile, et il fonctionne. Elle ne coupe pas le
 * client tiers, que Maestro ne pilote pas : un nouvel appel rouvrira une
 * session. Le dire est plus honnête que de laisser croire à un coupe-circuit.
 */
import type { AgentConfig, Run } from '@maestro/shared';
import type { Bus } from './bus.ts';
import type { Store } from './db.ts';
import { makeId, nowIso } from './util.ts';

/** Silence au-delà duquel une session est considérée terminée. */
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
/** Fréquence du balayage des sessions oisives. */
const SWEEP_INTERVAL_MS = 60 * 1000;

const PROMPT =
  'Session pilotée depuis un client MCP externe (Codex, OpenCode, Cursor…). ' +
  "Maestro n'exécute pas ce travail : ce run journalise les actions faites au " +
  "nom de l'agent et sert de parent aux délégations.";

export class ExternalSessionService {
  /** Dernière activité par run, pour repérer les sessions oisives. */
  private lastSeen = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private store: Store,
    private bus: Bus,
  ) {}

  /** Démarre le balayage périodique. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    // Le balayage ne doit pas retenir le processus à l'arrêt.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Rend la session ouverte de cet agent, en en ouvrant une au besoin.
   *
   * Appelé avant chaque action de contrôle : c'est ce qui garantit qu'aucune
   * action externe n'existe sans run pour la porter.
   */
  touch(agent: AgentConfig, nowMs = Date.now()): Run {
    const existing = this.openRunFor(agent.id);
    if (existing) {
      this.lastSeen.set(existing.id, nowMs);
      return existing;
    }

    const now = nowIso();
    const run: Run = {
      id: makeId('run'),
      agentId: agent.id,
      origin: 'external',
      originId: null,
      parentRunId: null,
      prompt: PROMPT,
      skillId: null,
      status: 'running',
      sessionId: null,
      model: agent.model,
      engine: 'sdk',
      tmuxSession: null,
      /* Le fournisseur réel est celui du client tiers, que Maestro ne connaît
         pas. Le nommer serait une invention ; `accountName` porte donc le fait
         intéressant — que la session vient de l'extérieur. */
      providerKind: 'claude-sdk',
      accountId: null,
      accountName: 'client MCP externe',
      attemptCount: 0,
      numTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      resultText: null,
      error: null,
      createdAt: now,
      startedAt: now,
      endedAt: null,
    };
    this.store.insertRun(run);
    this.lastSeen.set(run.id, nowMs);
    this.bus.publish({ type: 'run.created', payload: run });
    this.bus.log('info', 'mcp', `Session externe ouverte pour « ${agent.name} » (${run.id})`, {
      agentId: agent.id,
      runId: run.id,
    });
    return run;
  }

  /** Session externe encore ouverte pour cet agent, s'il y en a une. */
  openRunFor(agentId: string): Run | null {
    return (
      this.store
        .listRuns({ agentId, limit: 20 })
        .find((r) => r.origin === 'external' && !r.endedAt) ?? null
    );
  }

  /**
   * Journalise une action dans le transcript de la session.
   *
   * Le contenu des arguments n'est pas repris : un client tiers peut y passer
   * un prompt entier, et le flux d'événements est diffusé à tous les clients
   * connectés. Le nom de l'outil et son issue suffisent à savoir qui a fait
   * quoi.
   */
  record(run: Run, toolName: string, outcome: 'ok' | 'refusé' | 'échec', detail?: string): void {
    const event = this.store.insertRunEvent(run.id, run.agentId, 'tool_use', {
      toolName,
      text: detail ? `${outcome} — ${detail}` : outcome,
    });
    this.bus.publish({ type: 'run.event', payload: event });
  }

  /**
   * Referme les sessions silencieuses depuis trop longtemps.
   *
   * Sans ce balayage, une session externe resterait « en cours » indéfiniment :
   * le client tiers ne prévient pas qu'il s'arrête, et rien d'autre ne peut le
   * savoir.
   */
  sweep(nowMs = Date.now()): number {
    let closed = 0;
    for (const [runId, seen] of [...this.lastSeen]) {
      if (nowMs - seen < IDLE_TIMEOUT_MS) continue;
      this.lastSeen.delete(runId);
      const run = this.store.getRun(runId);
      if (!run || run.endedAt) continue;
      this.close(run, 'succeeded', 'Session externe close après inactivité.');
      closed++;
    }
    return closed;
  }

  /** Clôt une session, sans toucher aux runs qu'elle a délégués. */
  close(run: Run, status: Run['status'], reason: string): void {
    const closed: Run = {
      ...run,
      status,
      endedAt: nowIso(),
      resultText: run.resultText ?? reason,
    };
    this.store.updateRun(closed);
    this.lastSeen.delete(run.id);
    this.bus.publish({ type: 'run.updated', payload: closed });
  }

  /** Oublie une session close ailleurs (annulation depuis l'interface). */
  forget(runId: string): void {
    this.lastSeen.delete(runId);
  }
}
