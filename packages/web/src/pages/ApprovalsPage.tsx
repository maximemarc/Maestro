/**
 * Centre d'approbations : demandes en attente + historique des décisions.
 * Le store est alimenté en temps réel (approval.requested / approval.resolved),
 * aucun refetch nécessaire après une mutation.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, Check, ShieldCheck, X } from '@phosphor-icons/react';
import type { Approval, ApprovalResolver, ApprovalStatus } from '@maestro/shared';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useStore } from '../lib/store';
import { AgentChip, EmptyState, Spinner } from '../components/ui';

const HISTORY_LIMIT = 50;

const RESOLVER_LABELS: Record<ApprovalResolver, string> = {
  web: 'Web',
  telegram: 'Telegram',
  policy: 'Politique',
  timeout: 'Expiration',
};

const STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: 'En attente',
  allowed: 'Autorisé',
  denied: 'Refusé',
  expired: 'Expiré',
};

function statusTone(status: ApprovalStatus): string {
  if (status === 'allowed') return 'ok';
  if (status === 'denied') return 'danger';
  return '';
}

function fmtInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

export default function ApprovalsPage() {
  const approvals = useStore((s) => s.approvals);
  const agents = useStore((s) => s.agents);

  const [notes, setNotes] = useState<Record<string, string>>({});
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pending = useMemo(
    () =>
      approvals
        .filter((a) => a.status === 'pending')
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt)),
    [approvals],
  );

  const history = useMemo(
    () =>
      approvals
        .filter((a) => a.status !== 'pending')
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
        .slice(0, HISTORY_LIMIT),
    [approvals],
  );

  const agentOf = (agentId: string) => agents.find((a) => a.id === agentId);

  const resolve = async (approval: Approval, decision: 'allow' | 'deny') => {
    setResolvingId(approval.id);
    setError(null);
    try {
      const note = notes[approval.id]?.trim();
      await api.resolveApproval(approval.id, {
        decision,
        ...(note ? { note } : {}),
      });
      // La résolution arrive par l'événement approval.resolved — pas de refetch.
      setNotes((prev) => {
        const next = { ...prev };
        delete next[approval.id];
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue lors de la résolution');
    } finally {
      setResolvingId(null);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Approbations</h1>
        {/* Le compte change sans action de l'utilisateur : il est annoncé. */}
        <span className={`badge ${pending.length > 0 ? 'warn' : ''}`} role="status">
          {pending.length} en attente
        </span>
      </div>
      <p className="page-lede">
        Un agent qui demande un outil sensible attend ici. Autoriser ou refuser débloque son run
        immédiatement.
      </p>

      {error && (
        <div className="error-box mb-4" role="alert">
          {error}
        </div>
      )}

      <h2>En attente</h2>
      {pending.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck size={28} />}
          title="Rien à approuver"
          hint="Les demandes d'outils apparaissent ici en temps réel."
        />
      ) : (
        <div className="col mb-4">
          {pending.map((a) => {
            const busy = resolvingId === a.id;
            return (
              <div key={a.id} className="card attention">
                <div className="row wrap">
                  <AgentChip agent={agentOf(a.agentId)} />
                  <code>{a.toolName}</code>
                  <span className="text-muted text-sm">{fmtDateTime(a.requestedAt)}</span>
                  <span className="spacer grow" />
                  <Link to={`/runs/${a.runId}`}>Voir le run</Link>
                </div>

                <pre className="scroll-box break-word mt-3 mb-3">{fmtInput(a.input)}</pre>

                <div className="row wrap">
                  <input
                    className="input grow"
                    placeholder="Note (optionnelle)…"
                    aria-label="Note accompagnant la décision"
                    value={notes[a.id] ?? ''}
                    onChange={(e) => setNotes((prev) => ({ ...prev, [a.id]: e.target.value }))}
                  />
                  <button
                    className="btn ok"
                    disabled={busy}
                    onClick={() => void resolve(a, 'allow')}
                  >
                    {busy ? <Spinner /> : <Check />}
                    Autoriser
                  </button>
                  <button
                    className="btn danger"
                    disabled={busy}
                    onClick={() => void resolve(a, 'deny')}
                  >
                    {busy ? <Spinner /> : <X />}
                    Refuser
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <h2 className="mt-4">Historique</h2>
      {history.length === 0 ? (
        <EmptyState icon={<Archive size={28} />} title="Aucune décision enregistrée" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Statut</th>
                <th>Agent</th>
                <th>Outil</th>
                <th>Résolu par</th>
                <th>Note</th>
                <th>Demandé le</th>
                <th>Résolu le</th>
              </tr>
            </thead>
            <tbody>
              {history.map((a) => (
                <tr key={a.id}>
                  <td>
                    <span className={`badge ${statusTone(a.status)}`}>
                      {STATUS_LABELS[a.status]}
                    </span>
                  </td>
                  <td>
                    <AgentChip agent={agentOf(a.agentId)} />
                  </td>
                  <td>
                    <code>{a.toolName}</code>
                  </td>
                  <td>
                    {a.resolvedBy ? (
                      RESOLVER_LABELS[a.resolvedBy]
                    ) : (
                      <span className="text-faint">aucun</span>
                    )}
                  </td>
                  <td className="text-muted">
                    {a.note ?? <span className="text-faint">aucune</span>}
                  </td>
                  <td>{fmtDateTime(a.requestedAt)}</td>
                  <td>{fmtDateTime(a.resolvedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
