/**
 * Tests du routeur de résilience.
 *
 * Ce qui est vérifié ici n'est pas « le code s'exécute » mais l'arbitrage :
 * face à un quota, on bascule si quelqu'un peut prendre le relais et on
 * n'attend qu'à défaut ; une authentification cassée ne se réessaie jamais sur
 * place ; un contexte dépassé exige un résumé, pas un nouvel essai identique.
 * Chacune de ces règles, prise à l'envers, produit un système qui a l'air de
 * fonctionner et perd des heures.
 */
import { describe, expect, it } from 'vitest';
import type { FailureVerdict, ProviderAccount, ResiliencePolicy } from '@maestro/shared';
import {
  availability,
  backoffMs,
  planFirstAttempt,
  planRecovery,
  type ResolvedTarget,
} from './policy.ts';

const NOW = Date.parse('2026-08-31T10:00:00.000Z');

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: 'acc_1',
    name: 'Compte A',
    kind: 'claude-sdk',
    enabled: true,
    authMode: 'profile',
    configDir: '/tmp/profil-a',
    apiKeyEnv: null,
    baseUrl: null,
    apiFlavor: null,
    model: null,
    command: null,
    args: null,
    env: {},
    priority: 10,
    dailyCostLimitUsd: null,
    health: 'ready',
    cooldownUntil: null,
    lastError: null,
    lastCheckedAt: null,
    detail: null,
    createdAt: '2026-08-31T09:00:00.000Z',
    updatedAt: '2026-08-31T09:00:00.000Z',
    ...overrides,
  };
}

function targets(...accounts: ProviderAccount[]): ResolvedTarget[] {
  return accounts.map((acc, index) => ({
    target: { accountId: acc.id, model: null },
    account: acc,
    index,
  }));
}

function policy(overrides: Partial<ResiliencePolicy> = {}): ResiliencePolicy {
  return {
    id: 'pol_1',
    name: 'Défaut',
    description: '',
    targets: [],
    maxAttemptsPerTarget: 2,
    maxTotalAttempts: 4,
    backoffInitialMs: 1000,
    backoffFactor: 3,
    backoffMaxMs: 60_000,
    backoffJitter: false,
    quotaWaitMaxSec: 900,
    switchOnError: true,
    handoffThresholdPct: 80,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function verdict(overrides: Partial<FailureVerdict> = {}): FailureVerdict {
  return {
    klass: 'transient',
    message: 'incident',
    retryAfterMs: null,
    poisonsAccount: false,
    ...overrides,
  };
}

describe('disponibilité d’un compte', () => {
  it('un compte en pause dont l’heure est passée redevient utilisable', () => {
    const acc = account({
      health: 'cooldown',
      cooldownUntil: new Date(NOW - 1000).toISOString(),
    });
    expect(availability(acc, NOW).state).toBe('ready');
  });

  it('un quota épuisé sans réouverture connue est inutilisable, pas « en attente »', () => {
    // Distinction utile : on ne peut pas attendre une heure qu'on ignore.
    const acc = account({ health: 'exhausted', cooldownUntil: null });
    expect(availability(acc, NOW).state).toBe('unusable');
  });

  it('un compte désactivé n’est jamais candidat', () => {
    expect(availability(account({ enabled: false }), NOW).state).toBe('unusable');
  });
});

describe('première tentative', () => {
  it('prend le premier compte prêt', () => {
    const plan = planFirstAttempt({
      policy: policy(),
      targets: targets(account({ id: 'a' }), account({ id: 'b' })),
      nowMs: NOW,
    });
    expect(plan.action).toBe('retry_same');
    expect(plan.target?.account.id).toBe('a');
  });

  it('saute un compte en pause pour prendre le suivant', () => {
    const plan = planFirstAttempt({
      policy: policy(),
      targets: targets(
        account({
          id: 'a',
          health: 'exhausted',
          cooldownUntil: new Date(NOW + 3600_000).toISOString(),
        }),
        account({ id: 'b' }),
      ),
      nowMs: NOW,
    });
    expect(plan.target?.account.id).toBe('b');
  });

  it('attend si tous les comptes sont en pause mais rouvrent bientôt', () => {
    const plan = planFirstAttempt({
      policy: policy({ quotaWaitMaxSec: 900 }),
      targets: targets(
        account({
          id: 'a',
          health: 'cooldown',
          cooldownUntil: new Date(NOW + 60_000).toISOString(),
        }),
      ),
      nowMs: NOW,
    });
    expect(plan.action).toBe('wait_then_retry');
    expect(plan.waitMs).toBe(60_000);
  });

  it('renonce si la réouverture dépasse le plafond d’attente', () => {
    const plan = planFirstAttempt({
      policy: policy({ quotaWaitMaxSec: 60 }),
      targets: targets(
        account({
          id: 'a',
          health: 'exhausted',
          cooldownUntil: new Date(NOW + 3600_000).toISOString(),
        }),
      ),
      nowMs: NOW,
    });
    expect(plan.action).toBe('give_up');
  });

  it('renonce quand la politique n’a aucune cible', () => {
    const plan = planFirstAttempt({ policy: policy(), targets: [], nowMs: NOW });
    expect(plan.action).toBe('give_up');
  });
});

describe('quota', () => {
  it('bascule plutôt que d’attendre quand un autre compte est prêt', () => {
    // Avancer maintenant vaut mieux qu'attendre une réouverture dans une heure.
    const plan = planRecovery({
      policy: policy(),
      targets: targets(account({ id: 'a' }), account({ id: 'b' })),
      verdict: verdict({ klass: 'quota', poisonsAccount: true, retryAfterMs: 3600_000 }),
      currentIndex: 0,
      attemptsOnCurrent: 1,
      totalAttempts: 1,
      nowMs: NOW,
    });
    expect(plan.action).toBe('switch_account');
    expect(plan.target?.account.id).toBe('b');
    expect(plan.waitMs).toBe(0);
  });

  it('exige un résumé de reprise à chaque bascule', () => {
    // Une session appartient au compte qui l'a créée : elle ne se reprend pas ailleurs.
    const plan = planRecovery({
      policy: policy(),
      targets: targets(account({ id: 'a' }), account({ id: 'b' })),
      verdict: verdict({ klass: 'quota', poisonsAccount: true }),
      currentIndex: 0,
      attemptsOnCurrent: 1,
      totalAttempts: 1,
      nowMs: NOW,
    });
    expect(plan.requiresHandoff).toBe(true);
  });

  it('attend la réouverture annoncée s’il n’y a personne d’autre', () => {
    const plan = planRecovery({
      policy: policy({ quotaWaitMaxSec: 900 }),
      targets: targets(account({ id: 'a' })),
      verdict: verdict({ klass: 'quota', poisonsAccount: true, retryAfterMs: 120_000 }),
      currentIndex: 0,
      attemptsOnCurrent: 1,
      totalAttempts: 1,
      nowMs: NOW,
    });
    expect(plan.action).toBe('wait_then_retry');
    expect(plan.waitMs).toBe(120_000);
  });

  it('renonce quand aucune réouverture n’est annoncée et qu’il n’y a pas de repli', () => {
    // Deviner une durée d'attente serait pire qu'un échec franc.
    const plan = planRecovery({
      policy: policy(),
      targets: targets(account({ id: 'a' })),
      verdict: verdict({ klass: 'quota', poisonsAccount: true, retryAfterMs: null }),
      currentIndex: 0,
      attemptsOnCurrent: 1,
      totalAttempts: 1,
      nowMs: NOW,
    });
    expect(plan.action).toBe('give_up');
  });

  it('renonce si la réouverture dépasse le plafond d’attente', () => {
    const plan = planRecovery({
      policy: policy({ quotaWaitMaxSec: 60 }),
      targets: targets(account({ id: 'a' })),
      verdict: verdict({ klass: 'quota', poisonsAccount: true, retryAfterMs: 3600_000 }),
      currentIndex: 0,
      attemptsOnCurrent: 1,
      totalAttempts: 1,
      nowMs: NOW,
    });
    expect(plan.action).toBe('give_up');
  });
});

describe('authentification', () => {
  it('ne réessaie jamais sur place, bascule directement', () => {
    const plan = planRecovery({
      policy: policy({ maxAttemptsPerTarget: 5 }),
      targets: targets(account({ id: 'a' }), account({ id: 'b' })),
      verdict: verdict({ klass: 'auth', poisonsAccount: true }),
      currentIndex: 0,
      attemptsOnCurrent: 1,
      totalAttempts: 1,
      nowMs: NOW,
    });
    expect(plan.action).toBe('switch_account');
    expect(plan.waitMs).toBe(0);
  });

  it('renonce s’il n’y a nulle part où aller', () => {
    const plan = planRecovery({
      policy: policy(),
      targets: targets(account({ id: 'a' })),
      verdict: verdict({ klass: 'auth', poisonsAccount: true }),
      currentIndex: 0,
      attemptsOnCurrent: 1,
      totalAttempts: 1,
      nowMs: NOW,
    });
    expect(plan.action).toBe('give_up');
  });
});

describe('contexte dépassé', () => {
  it('reste sur place mais exige un résumé', () => {
    // Rejouer le même prompt trop long donnerait exactement le même verdict.
    const plan = planRecovery({
      policy: policy(),
      targets: targets(account({ id: 'a' })),
      verdict: verdict({ klass: 'context' }),
      currentIndex: 0,
      attemptsOnCurrent: 1,
      totalAttempts: 1,
      nowMs: NOW,
    });
    expect(plan.action).toBe('retry_same');
    expect(plan.requiresHandoff).toBe(true);
  });
});

describe('incidents passagers', () => {
  it('patiente sur place tant que la politique le permet', () => {
    const plan = planRecovery({
      policy: policy({ maxAttemptsPerTarget: 3, backoffInitialMs: 1000, backoffFactor: 3 }),
      targets: targets(account({ id: 'a' }), account({ id: 'b' })),
      verdict: verdict({ klass: 'overloaded' }),
      currentIndex: 0,
      attemptsOnCurrent: 1,
      totalAttempts: 1,
      nowMs: NOW,
    });
    expect(plan.action).toBe('wait_then_retry');
    expect(plan.target?.account.id).toBe('a');
    expect(plan.waitMs).toBe(1000);
  });

  it('bascule une fois les tentatives locales épuisées', () => {
    const plan = planRecovery({
      policy: policy({ maxAttemptsPerTarget: 2 }),
      targets: targets(account({ id: 'a' }), account({ id: 'b' })),
      verdict: verdict({ klass: 'transient' }),
      currentIndex: 0,
      attemptsOnCurrent: 2,
      totalAttempts: 2,
      nowMs: NOW,
    });
    expect(plan.action).toBe('switch_account');
    expect(plan.target?.account.id).toBe('b');
  });

  it('respecte un retry-after plus long que le backoff', () => {
    const plan = planRecovery({
      policy: policy({ backoffInitialMs: 1000 }),
      targets: targets(account({ id: 'a' })),
      verdict: verdict({ klass: 'rate_limit', poisonsAccount: true, retryAfterMs: 30_000 }),
      currentIndex: 0,
      attemptsOnCurrent: 1,
      totalAttempts: 1,
      nowMs: NOW,
    });
    expect(plan.waitMs).toBe(30_000);
  });

  it('ne bascule pas si la politique l’interdit', () => {
    const plan = planRecovery({
      policy: policy({ maxAttemptsPerTarget: 1, switchOnError: false }),
      targets: targets(account({ id: 'a' }), account({ id: 'b' })),
      verdict: verdict({ klass: 'transient' }),
      currentIndex: 0,
      attemptsOnCurrent: 1,
      totalAttempts: 1,
      nowMs: NOW,
    });
    expect(plan.action).toBe('give_up');
  });
});

describe('échecs sans recours', () => {
  it.each(['cancelled', 'budget', 'fatal'] as const)('%s arrête le run', (klass) => {
    const plan = planRecovery({
      policy: policy(),
      targets: targets(account({ id: 'a' }), account({ id: 'b' })),
      verdict: verdict({ klass }),
      currentIndex: 0,
      attemptsOnCurrent: 1,
      totalAttempts: 1,
      nowMs: NOW,
    });
    expect(plan.action).toBe('give_up');
  });

  it('le plafond total de tentatives arrête tout', () => {
    const plan = planRecovery({
      policy: policy({ maxTotalAttempts: 3 }),
      targets: targets(account({ id: 'a' }), account({ id: 'b' })),
      verdict: verdict({ klass: 'transient' }),
      currentIndex: 0,
      attemptsOnCurrent: 1,
      totalAttempts: 3,
      nowMs: NOW,
    });
    expect(plan.action).toBe('give_up');
  });
});

describe('backoff', () => {
  it('croît de façon exponentielle et se borne', () => {
    const p = policy({ backoffInitialMs: 1000, backoffFactor: 3, backoffMaxMs: 10_000 });
    expect(backoffMs(p, 1)).toBe(1000);
    expect(backoffMs(p, 2)).toBe(3000);
    expect(backoffMs(p, 3)).toBe(9000);
    expect(backoffMs(p, 4)).toBe(10_000);
  });

  it('le jitter reste dans la moitié haute de l’intervalle', () => {
    // Étaler les reprises sans jamais réessayer plus tôt que la moitié du délai.
    const p = policy({ backoffInitialMs: 1000, backoffJitter: true });
    expect(backoffMs(p, 1, () => 0)).toBe(500);
    expect(backoffMs(p, 1, () => 1)).toBe(1000);
  });
});
