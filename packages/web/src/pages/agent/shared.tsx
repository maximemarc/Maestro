/**
 * Socle commun aux onglets de la fiche agent : libellés, forme du formulaire
 * de configuration et petits utilitaires de saisie.
 *
 * Ce module existe parce que `AgentDetail` faisait 849 lignes pour cinq
 * onglets : on ne pouvait pas ouvrir l'un sans faire défiler les autres.
 */
import type { AgentConfig, AgentEngine, ApprovalPolicy, PermissionMode } from '@maestro/shared';

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Par défaut',
  acceptEdits: 'Accepter les éditions',
  plan: 'Plan',
  bypassPermissions: 'Contourner les permissions',
};

export const APPROVAL_POLICY_LABELS: Record<ApprovalPolicy, string> = {
  auto: 'Auto (tout approuvé)',
  ask: 'Demander (chaque outil sensible)',
  guarded: 'Gardé (lecture auto, écriture approuvée)',
};

export interface ConfigForm {
  name: string;
  emoji: string;
  description: string;
  model: string;
  engine: AgentEngine;
  permissionMode: PermissionMode;
  approvalPolicy: ApprovalPolicy;
  memoryEnabled: boolean;
  maxTurns: string;
  timeoutSec: string;
  tokenBudget: string;
  color: string;
  cliAgent: string;
  parentAgentId: string;
  pluginIds: string[];
  mcpServerIds: string[];
  ragCollectionIds: string[];
  allowedTools: string;
  disallowedTools: string;
}

export function toForm(agent: AgentConfig): ConfigForm {
  return {
    name: agent.name,
    emoji: agent.emoji,
    description: agent.description,
    model: agent.model,
    engine: agent.engine,
    permissionMode: agent.permissionMode,
    approvalPolicy: agent.approvalPolicy,
    memoryEnabled: agent.memoryEnabled,
    maxTurns: agent.maxTurns === null ? '' : String(agent.maxTurns),
    timeoutSec: agent.timeoutSec === null ? '' : String(agent.timeoutSec),
    tokenBudget: agent.tokenBudget === null ? '' : String(agent.tokenBudget),
    color: agent.color,
    cliAgent: agent.cliAgent ?? '',
    parentAgentId: agent.parentAgentId ?? '',
    pluginIds: agent.pluginIds ?? [],
    mcpServerIds: agent.mcpServerIds ?? [],
    ragCollectionIds: agent.ragCollectionIds ?? [],
    allowedTools: agent.allowedTools?.join('\n') ?? '',
    disallowedTools: agent.disallowedTools?.join('\n') ?? '',
  };
}

export function parseOptionalInt(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isNaN(n) ? null : n;
}

export function parseToolList(value: string): string[] | null {
  const lines = value
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  return lines.length > 0 ? lines : null;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Zone d'erreur d'un onglet.
 *
 * Elle reste dans la page — pas en notification transitoire : une erreur est ce
 * qu'il faut corriger, elle ne doit pas disparaître d'elle-même.
 */
export function TabError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="error-text mt-2" role="alert">
      {message}
    </div>
  );
}
