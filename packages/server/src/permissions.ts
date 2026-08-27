/**
 * Broker d'approbations : matérialise chaque demande d'outil sensible en une
 * Approval persistée, la diffuse (web + Telegram), et suspend l'exécution du
 * run jusqu'à résolution humaine, politique ou expiration.
 */
import type { AgentConfig, Approval, ApprovalResolver } from '@maestro/shared';
import type { Bus } from './bus.ts';
import type { Store } from './db.ts';
import { makeId, nowIso, truncate } from './util.ts';

/** Outils en lecture seule, auto-approuvés en politique 'guarded'. */
const SAFE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'Task',
  'NotebookRead',
  'ListMcpResourcesTool',
  'AskUserQuestion',
]);

export type ApprovalDecision = 'allow' | 'deny';

interface PendingResolution {
  resolve: (decision: {
    decision: ApprovalDecision;
    resolvedBy: ApprovalResolver;
    note: string | null;
  }) => void;
  timer: NodeJS.Timeout;
}

export class ApprovalBroker {
  private pending = new Map<string, PendingResolution>();

  constructor(
    private store: Store,
    private bus: Bus,
    private approvalTimeoutSec: () => number,
  ) {}

  /**
   * Décision de politique locale, sans intervention humaine.
   * Retourne null si une approbation humaine est requise.
   */
  policyDecision(agent: AgentConfig, toolName: string): ApprovalDecision | null {
    // Les outils de contrôle Maestro sont le canal officiel de l'orchestrateur.
    if (toolName.startsWith('mcp__maestro__')) return 'allow';
    if (agent.approvalPolicy === 'auto') return 'allow';
    if (agent.approvalPolicy === 'guarded' && SAFE_TOOLS.has(toolName)) return 'allow';
    return null;
  }

  /** Suspend jusqu'à résolution (web, Telegram) ou expiration. */
  async requestHumanApproval(
    runId: string,
    agent: AgentConfig,
    toolName: string,
    input: unknown,
  ): Promise<{
    approval: Approval;
    decision: ApprovalDecision;
    resolvedBy: ApprovalResolver;
    note: string | null;
  }> {
    const approval: Approval = {
      id: makeId('apr'),
      runId,
      agentId: agent.id,
      toolName,
      input,
      status: 'pending',
      resolvedBy: null,
      note: null,
      requestedAt: nowIso(),
      resolvedAt: null,
    };
    this.store.insertApproval(approval);
    this.bus.publish({ type: 'approval.requested', payload: approval });
    this.bus.log(
      'warn',
      'permissions',
      `Approbation demandée : ${toolName} — ${truncate(JSON.stringify(input ?? {}), 120)}`,
      { agentId: agent.id, runId },
    );

    const outcome = await new Promise<{
      decision: ApprovalDecision;
      resolvedBy: ApprovalResolver;
      note: string | null;
    }>((resolve) => {
      const timeoutMs = Math.max(10, this.approvalTimeoutSec()) * 1000;
      const timer = setTimeout(() => {
        this.pending.delete(approval.id);
        this.store.resolveApproval(approval.id, 'expired', 'timeout', 'Expirée sans réponse');
        resolve({ decision: 'deny', resolvedBy: 'timeout', note: 'Expirée sans réponse' });
      }, timeoutMs);
      this.pending.set(approval.id, { resolve, timer });
    });

    const stored = this.store.getApproval(approval.id) ?? approval;
    this.bus.publish({ type: 'approval.resolved', payload: stored });
    this.bus.log(
      outcome.decision === 'allow' ? 'success' : 'warn',
      'permissions',
      `${toolName} ${outcome.decision === 'allow' ? 'autorisé' : 'refusé'} (${outcome.resolvedBy})`,
      { agentId: agent.id, runId },
    );
    return { approval: stored, ...outcome };
  }

  /** Appelé par l'API REST ou le bot Telegram. */
  resolve(
    approvalId: string,
    decision: ApprovalDecision,
    resolvedBy: ApprovalResolver,
    note: string | null,
  ): Approval | null {
    const waiting = this.pending.get(approvalId);
    const resolved = this.store.resolveApproval(
      approvalId,
      decision === 'allow' ? 'allowed' : 'denied',
      resolvedBy,
      note,
    );
    if (waiting) {
      clearTimeout(waiting.timer);
      this.pending.delete(approvalId);
      waiting.resolve({ decision, resolvedBy, note });
    }
    return resolved;
  }

  /** À l'arrêt d'un run : refuse les demandes encore suspendues. */
  cancelPendingForRun(runId: string): void {
    for (const [id, waiting] of this.pending) {
      const approval = this.store.getApproval(id);
      if (approval?.runId !== runId) continue;
      clearTimeout(waiting.timer);
      this.pending.delete(id);
      this.store.resolveApproval(id, 'denied', 'policy', 'Run interrompu');
      waiting.resolve({ decision: 'deny', resolvedBy: 'policy', note: 'Run interrompu' });
    }
  }
}
