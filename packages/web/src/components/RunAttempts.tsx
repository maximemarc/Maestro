/**
 * Tentatives d'un run : qui a essayé, pourquoi ça a échoué, où c'est reparti.
 *
 * N'apparaît qu'à partir de la deuxième tentative. Un run qui a réussi du
 * premier coup n'a rien à raconter, et afficher « tentative 1 / 1 » sur chaque
 * run noierait les rares cas où la bascule s'est produite — les seuls qui
 * méritent qu'on s'y arrête.
 */
import { useEffect } from 'react';
import { ArrowBendDownRight, Timer, Warning } from '@phosphor-icons/react';
import { PROVIDER_LABELS, type FailureClass, type RunAttempt } from '@maestro/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { fmtCost, fmtTokens } from '../lib/format';

const FAILURE_LABELS: Record<FailureClass, string> = {
  quota: 'limite d’usage atteinte',
  rate_limit: 'débit limité',
  overloaded: 'fournisseur saturé',
  auth: 'authentification invalide',
  context: 'contexte dépassé',
  transient: 'incident réseau',
  budget: 'garde-fou Maestro',
  cancelled: 'annulé',
  fatal: 'erreur non récupérable',
};

const EMPTY: RunAttempt[] = [];

function fmtWait(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} s`;
  const min = Math.round(sec / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

export function RunAttempts({ runId }: { runId: string }) {
  const attempts = useStore((s) => s.runAttempts[runId] ?? EMPTY);

  /* L'historique est relu une fois ; la suite arrive par événement, ce qui rend
     une bascule visible pendant qu'elle se produit. */
  useEffect(() => {
    let cancelled = false;
    api
      .listRunAttempts(runId)
      .then((list) => {
        if (cancelled || list.length === 0) return;
        useStore.setState((state) => ({
          runAttempts: { ...state.runAttempts, [runId]: list },
        }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (attempts.length < 2) return null;

  return (
    <section className="card" aria-label="Tentatives du run">
      <h3>
        <ArrowBendDownRight /> {attempts.length} tentatives
      </h3>
      <p className="text-muted text-sm">
        Ce run a changé de compte ou réessayé. Chaque ligne dit ce qui a échoué et ce qui a été
        tenté ensuite.
      </p>
      <div className="col gap-2 mt-3">
        {attempts.map((attempt) => (
          <div className="row gap-2 items-center wrap" key={attempt.id}>
            <span className="badge">{attempt.index}</span>
            <strong>{attempt.accountName}</strong>
            <span className="muted sm">{PROVIDER_LABELS[attempt.providerKind]}</span>
            <span className="muted sm mono">{attempt.model}</span>
            {attempt.waitedMs > 0 && (
              <span className="muted sm">
                <Timer /> {fmtWait(attempt.waitedMs)} d’attente
              </span>
            )}
            <span className="spacer" />
            {attempt.costUsd > 0 && <span className="muted sm">{fmtCost(attempt.costUsd)}</span>}
            {attempt.inputTokens + attempt.outputTokens > 0 && (
              <span className="muted sm">
                {fmtTokens(attempt.inputTokens + attempt.outputTokens)} tokens
              </span>
            )}
            {attempt.status === 'succeeded' ? (
              <span className="badge ok">réussie</span>
            ) : attempt.status === 'running' ? (
              <span className="badge">en cours</span>
            ) : (
              <span className="badge warn" title={attempt.error ?? undefined}>
                <Warning /> {attempt.failureClass ? FAILURE_LABELS[attempt.failureClass] : 'échec'}
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
