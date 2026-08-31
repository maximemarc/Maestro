/**
 * Routeur de résilience : quelle cible pour la prochaine tentative, et après
 * quelle attente.
 *
 * Module **pur** — pas d'accès base, pas d'horloge implicite, pas d'aléa
 * implicite. C'est délibéré : c'est la seule façon de tester une politique de
 * repli sans faire réellement échouer un fournisseur.
 *
 * Principe d'arbitrage, une fois pour toutes : **avancer plutôt qu'attendre**.
 * Face à un quota, basculer sur un compte disponible fait progresser le run
 * tout de suite ; attendre la réouverture ne se justifie que si personne
 * d'autre ne peut prendre le relais. L'inverse — attendre par défaut —
 * immobiliserait des runs pendant des heures alors qu'un second compte est
 * inactif à côté.
 */
import type {
  FailureVerdict,
  ProviderAccount,
  RecoveryAction,
  ResiliencePolicy,
  ResilienceTarget,
} from '@maestro/shared';
import { FAILURE_LABELS } from './failure.ts';

/** Cible résolue : la préférence de la politique, jointe au compte réel. */
export interface ResolvedTarget {
  target: ResilienceTarget;
  account: ProviderAccount;
  /** Index dans la liste ordonnée de la politique. */
  index: number;
}

export type TargetAvailability =
  /** Utilisable maintenant. */
  | { state: 'ready' }
  /** Indisponible jusqu'à un instant connu — attendre a un sens. */
  | { state: 'blocked'; untilMs: number; reason: string }
  /** Indisponible sans horizon : désactivé, non authentifié, en erreur. */
  | { state: 'unusable'; reason: string };

export interface AttemptPlan {
  action: RecoveryAction;
  /** Cible de la prochaine tentative ; null quand on abandonne. */
  target: ResolvedTarget | null;
  /** Attente à observer avant de démarrer, en millisecondes. */
  waitMs: number;
  /**
   * Vrai quand la tentative suivante doit repartir d'un résumé plutôt que du
   * contexte accumulé : contexte dépassé, ou changement de fournisseur (une
   * session Claude ne se reprend pas dans Codex).
   */
  requiresHandoff: boolean;
  /** Phrase affichée dans le transcript et le journal. */
  reason: string;
}

export interface PlanInput {
  policy: ResiliencePolicy;
  /** Cibles résolues, dans l'ordre de la politique. */
  targets: ResolvedTarget[];
  verdict: FailureVerdict;
  /** Index (dans `targets`) de la cible qui vient d'échouer ; -1 si aucune. */
  currentIndex: number;
  /** Tentatives déjà consommées sur cette cible, celle qui échoue comprise. */
  attemptsOnCurrent: number;
  /** Tentatives consommées au total, toutes cibles confondues. */
  totalAttempts: number;
  nowMs: number;
  /** Injecté pour rendre le jitter déterministe en test. */
  random?: () => number;
}

/**
 * Disponibilité d'une cible.
 *
 * `cooldownUntil` déjà passé rend la main : c'est le seul endroit où un compte
 * sort de pénitence, ce qui évite d'avoir à réveiller une minuterie pour
 * chaque compte en attente.
 */
export function availability(account: ProviderAccount, nowMs: number): TargetAvailability {
  if (!account.enabled) return { state: 'unusable', reason: 'compte désactivé' };
  if (account.health === 'unauthenticated')
    return { state: 'unusable', reason: 'compte non authentifié' };
  if (account.health === 'error')
    return { state: 'unusable', reason: account.lastError ?? 'compte en erreur' };

  if (account.health === 'cooldown' || account.health === 'exhausted') {
    if (!account.cooldownUntil) {
      return {
        state: 'unusable',
        reason:
          account.health === 'exhausted' ? 'quota épuisé, sans réouverture connue' : 'en pause',
      };
    }
    const untilMs = Date.parse(account.cooldownUntil);
    if (Number.isFinite(untilMs) && untilMs > nowMs) {
      return {
        state: 'blocked',
        untilMs,
        reason:
          account.health === 'exhausted'
            ? `quota rouvert à ${formatTime(account.cooldownUntil)}`
            : `en pause jusqu'à ${formatTime(account.cooldownUntil)}`,
      };
    }
  }
  return { state: 'ready' };
}

/** Attente exponentielle bornée, avec bruit optionnel. */
export function backoffMs(
  policy: ResiliencePolicy,
  attemptIndex: number,
  random = Math.random,
): number {
  const raw =
    policy.backoffInitialMs * Math.pow(policy.backoffFactor, Math.max(0, attemptIndex - 1));
  const capped = Math.min(raw, policy.backoffMaxMs);
  if (!policy.backoffJitter) return Math.round(capped);
  /* Jitter « full » : un intervalle tiré dans [50 %, 100 %] du délai. Deux runs
     coupés par le même incident ne repartent pas à la même milliseconde, ce qui
     éviterait de reconstituer la rafale qu'on cherche justement à étaler. */
  return Math.round(capped * (0.5 + random() * 0.5));
}

/**
 * Première tentative : la meilleure cible disponible.
 *
 * Si aucune n'est prête mais qu'une se rouvre dans les délais tolérés, on
 * attend — un run qui démarre dans dix minutes vaut mieux qu'un run refusé.
 */
export function planFirstAttempt(input: {
  policy: ResiliencePolicy;
  targets: ResolvedTarget[];
  nowMs: number;
}): AttemptPlan {
  const { policy, targets, nowMs } = input;
  if (targets.length === 0) {
    return {
      action: 'give_up',
      target: null,
      waitMs: 0,
      requiresHandoff: false,
      reason: 'aucun compte configuré dans la politique',
    };
  }

  const ready = targets.find((t) => availability(t.account, nowMs).state === 'ready');
  if (ready) {
    return {
      action: 'retry_same',
      target: ready,
      waitMs: 0,
      requiresHandoff: false,
      reason: `compte « ${ready.account.name} »`,
    };
  }

  const soonest = earliestBlocked(targets, nowMs);
  if (soonest && soonest.waitMs <= policy.quotaWaitMaxSec * 1000) {
    return {
      action: 'wait_then_retry',
      target: soonest.target,
      waitMs: soonest.waitMs,
      requiresHandoff: false,
      reason: `tous les comptes sont en pause — attente de « ${soonest.target.account.name} » (${soonest.target.availabilityReason})`,
    };
  }

  return {
    action: 'give_up',
    target: null,
    waitMs: 0,
    requiresHandoff: false,
    reason: soonest
      ? `réouverture trop lointaine (${formatDuration(soonest.waitMs)} > plafond d'attente ${formatDuration(policy.quotaWaitMaxSec * 1000)})`
      : 'aucun compte utilisable',
  };
}

/**
 * Décide de la suite après un échec.
 *
 * L'ordre des tests est l'essentiel de la logique :
 *  1. les échecs qui ne se rejouent jamais (annulation, budget, erreur fatale) ;
 *  2. le plafond de tentatives ;
 *  3. l'authentification, qui condamne la cible sans condamner le run ;
 *  4. le contexte dépassé, qui exige un résumé et non un nouvel essai ;
 *  5. le quota, où l'on bascule si possible et n'attend qu'à défaut ;
 *  6. le reste (débit, saturation, réseau), traité par attente puis bascule.
 */
export function planRecovery(input: PlanInput): AttemptPlan {
  const { policy, targets, verdict, currentIndex, attemptsOnCurrent, totalAttempts, nowMs } = input;
  const random = input.random ?? Math.random;
  const label = FAILURE_LABELS[verdict.klass];
  const current = targets[currentIndex] ?? null;

  if (verdict.klass === 'cancelled' || verdict.klass === 'budget' || verdict.klass === 'fatal') {
    return giveUp(`${label} — aucun repli n'y changerait rien`);
  }

  if (totalAttempts >= policy.maxTotalAttempts) {
    return giveUp(`${label} — plafond de ${policy.maxTotalAttempts} tentative(s) atteint`);
  }

  /* Une authentification cassée n'est pas une malchance : la réessayer sur la
     même cible échouerait à l'identique. On passe à la suivante, sans attendre. */
  if (verdict.klass === 'auth') {
    const next = nextReady(targets, currentIndex, nowMs);
    if (next) return switchTo(next, 0, current, `${label} sur « ${current?.account.name ?? '?'} »`);
    return giveUp(`${label} et aucun autre compte disponible`);
  }

  /* Contexte dépassé : réessayer le même prompt donnerait le même verdict. La
     seule sortie est de repartir d'un résumé — sur la même cible, qui n'a rien
     fait de mal. */
  if (verdict.klass === 'context') {
    if (current && availability(current.account, nowMs).state === 'ready') {
      return {
        action: 'retry_same',
        target: current,
        waitMs: 0,
        requiresHandoff: true,
        reason: `${label} — reprise depuis un résumé de session`,
      };
    }
    const next = nextReady(targets, currentIndex, nowMs);
    if (next) return switchTo(next, 0, current, `${label} — reprise ailleurs depuis un résumé`);
    return giveUp(`${label} et aucun compte disponible pour reprendre`);
  }

  if (verdict.klass === 'quota') {
    const next = nextReady(targets, currentIndex, nowMs);
    if (next) {
      return switchTo(next, 0, current, `${label} sur « ${current?.account.name ?? '?'} »`);
    }
    /* Personne pour prendre le relais : attendre devient la meilleure option,
       à condition que la réouverture soit *annoncée*. Une attente calculée sur
       une durée devinée serait pire qu'un échec franc. */
    const waitMs = verdict.retryAfterMs;
    if (waitMs !== null && waitMs <= policy.quotaWaitMaxSec * 1000 && current) {
      return {
        action: 'wait_then_retry',
        target: current,
        waitMs,
        requiresHandoff: false,
        reason: `${label} — réouverture annoncée dans ${formatDuration(waitMs)}, attente`,
      };
    }
    const soonest = earliestBlocked(targets, nowMs);
    if (soonest && soonest.waitMs <= policy.quotaWaitMaxSec * 1000) {
      return {
        action: 'wait_then_retry',
        target: soonest.target,
        waitMs: soonest.waitMs,
        requiresHandoff: soonest.target.index !== currentIndex,
        reason: `${label} — attente de « ${soonest.target.account.name} » (${soonest.target.availabilityReason})`,
      };
    }
    return giveUp(
      waitMs === null
        ? `${label} — aucune réouverture annoncée et aucun autre compte disponible`
        : `${label} — réouverture dans ${formatDuration(waitMs)}, au-delà du plafond d'attente`,
    );
  }

  // Débit limité, saturation, incident réseau : d'abord patienter sur place.
  const canRetrySame =
    current !== null &&
    attemptsOnCurrent < policy.maxAttemptsPerTarget &&
    availability(current.account, nowMs).state !== 'unusable';

  if (canRetrySame && current) {
    const wait = Math.max(verdict.retryAfterMs ?? 0, backoffMs(policy, attemptsOnCurrent, random));
    return {
      action: 'wait_then_retry',
      target: current,
      waitMs: wait,
      requiresHandoff: false,
      reason: `${label} — nouvelle tentative sur « ${current.account.name} » dans ${formatDuration(wait)}`,
    };
  }

  if (!policy.switchOnError) {
    return giveUp(`${label} — bascule désactivée par la politique`);
  }

  const next = nextReady(targets, currentIndex, nowMs);
  if (next) {
    return switchTo(
      next,
      0,
      current,
      `${label} — ${policy.maxAttemptsPerTarget} tentative(s) épuisée(s) sur « ${current?.account.name ?? '?'} »`,
    );
  }

  const soonest = earliestBlocked(targets, nowMs);
  if (soonest && soonest.waitMs <= policy.quotaWaitMaxSec * 1000) {
    return {
      action: 'wait_then_retry',
      target: soonest.target,
      waitMs: soonest.waitMs,
      requiresHandoff: soonest.target.index !== currentIndex,
      reason: `${label} — attente de « ${soonest.target.account.name} » (${soonest.target.availabilityReason})`,
    };
  }

  return giveUp(`${label} — plus aucun compte disponible`);
}

// -- Aides ------------------------------------------------------------------

function giveUp(reason: string): AttemptPlan {
  return { action: 'give_up', target: null, waitMs: 0, requiresHandoff: false, reason };
}

/**
 * Bascule vers une autre cible.
 *
 * Le handoff est exigé dès que le **fournisseur** change : un identifiant de
 * session Claude n'a aucun sens pour Codex. Entre deux comptes du même
 * fournisseur il l'est aussi — une session appartient au compte qui l'a créée,
 * la reprendre ailleurs échouerait.
 */
function switchTo(
  next: ResolvedTarget,
  waitMs: number,
  current: ResolvedTarget | null,
  reason: string,
): AttemptPlan {
  return {
    action: 'switch_account',
    target: next,
    waitMs,
    requiresHandoff: current !== null,
    reason: `${reason} → bascule sur « ${next.account.name} »`,
  };
}

/** Première cible prête après `fromIndex`, en repartant du début si besoin. */
function nextReady(
  targets: ResolvedTarget[],
  fromIndex: number,
  nowMs: number,
): ResolvedTarget | null {
  for (let offset = 1; offset <= targets.length; offset++) {
    const candidate = targets[(Math.max(fromIndex, 0) + offset) % targets.length];
    if (!candidate || candidate.index === fromIndex) continue;
    if (availability(candidate.account, nowMs).state === 'ready') return candidate;
  }
  return null;
}

interface BlockedCandidate {
  target: ResolvedTarget & { availabilityReason: string };
  waitMs: number;
}

/** Cible bloquée dont la réouverture est la plus proche. */
function earliestBlocked(targets: ResolvedTarget[], nowMs: number): BlockedCandidate | null {
  let best: BlockedCandidate | null = null;
  for (const candidate of targets) {
    const av = availability(candidate.account, nowMs);
    if (av.state !== 'blocked') continue;
    const waitMs = Math.max(0, av.untilMs - nowMs);
    if (!best || waitMs < best.waitMs) {
      best = { target: { ...candidate, availabilityReason: av.reason }, waitMs };
    }
  }
  return best;
}

function formatTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}
