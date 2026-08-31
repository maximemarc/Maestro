/**
 * Tests de la classification des échecs.
 *
 * Deux erreurs se paient cher et passent inaperçues : prendre une limite
 * d'abonnement pour une saturation de débit — le run martèle un compte épuisé
 * toutes les cinq secondes pendant des heures — et prendre une décision interne
 * de Maestro (annulation, budget) pour un incident fournisseur, ce qui relance
 * ailleurs un travail qu'on venait volontairement d'arrêter.
 */
import { describe, expect, it } from 'vitest';
import { classifyFailure, extractRetryAfterMs } from './failure.ts';

const NOW = Date.parse('2026-08-31T10:00:00.000Z');

describe('classification par message', () => {
  it('reconnaît une limite d’usage d’abonnement', () => {
    const verdict = classifyFailure({
      message: 'Claude AI usage limit reached',
      now: NOW,
    });
    expect(verdict.klass).toBe('quota');
    expect(verdict.poisonsAccount).toBe(true);
  });

  it('classe en quota, et non en débit, une limite d’usage servie en 429', () => {
    // Le cas piège : le statut dit « ralentis », le message dit « reviens demain ».
    const verdict = classifyFailure({
      message: 'Claude AI usage limit reached',
      status: 429,
      now: NOW,
    });
    expect(verdict.klass).toBe('quota');
  });

  it('reconnaît une saturation de débit', () => {
    const verdict = classifyFailure({
      message: '{"type":"error","error":{"type":"rate_limit_error","message":"Too many requests"}}',
      status: 429,
      now: NOW,
    });
    expect(verdict.klass).toBe('rate_limit');
    expect(verdict.poisonsAccount).toBe(true);
  });

  it('reconnaît une authentification cassée et condamne le compte', () => {
    const verdict = classifyFailure({ message: 'invalid api-key provided', now: NOW });
    expect(verdict.klass).toBe('auth');
    expect(verdict.poisonsAccount).toBe(true);
  });

  it('reconnaît un dépassement de contexte sans condamner le compte', () => {
    const verdict = classifyFailure({
      message: 'prompt is too long: 250000 tokens > 200000 maximum',
      now: NOW,
    });
    expect(verdict.klass).toBe('context');
    expect(verdict.poisonsAccount).toBe(false);
  });

  it('reconnaît une surcharge du fournisseur', () => {
    const verdict = classifyFailure({ message: 'overloaded_error', status: 529, now: NOW });
    expect(verdict.klass).toBe('overloaded');
    expect(verdict.poisonsAccount).toBe(false);
  });

  it('reconnaît un incident réseau par son code système', () => {
    const verdict = classifyFailure({ message: 'read ECONNRESET', code: 'ECONNRESET', now: NOW });
    expect(verdict.klass).toBe('transient');
  });

  it('reconnaît un message accentué en français', () => {
    const verdict = classifyFailure({ message: 'Quota mensuel dépassé', now: NOW });
    expect(verdict.klass).toBe('quota');
  });

  it('retombe sur « fatal » plutôt que de deviner', () => {
    const verdict = classifyFailure({ message: 'Segmentation fault dans le plugin X', now: NOW });
    expect(verdict.klass).toBe('fatal');
  });
});

describe('classification par statut HTTP', () => {
  it('utilise le statut quand le message n’apprend rien', () => {
    expect(classifyFailure({ message: 'oops', status: 500, now: NOW }).klass).toBe('overloaded');
    expect(classifyFailure({ message: 'oops', status: 401, now: NOW }).klass).toBe('auth');
    expect(classifyFailure({ message: 'oops', status: 402, now: NOW }).klass).toBe('quota');
    expect(classifyFailure({ message: 'oops', status: 413, now: NOW }).klass).toBe('context');
  });
});

describe('décisions internes de Maestro', () => {
  it('l’annulation prime sur tout message', () => {
    const verdict = classifyFailure({
      message: 'Claude AI usage limit reached',
      hint: 'cancelled',
      now: NOW,
    });
    expect(verdict.klass).toBe('cancelled');
    expect(verdict.poisonsAccount).toBe(false);
  });

  it('le garde-fou de budget n’est pas un incident fournisseur', () => {
    const verdict = classifyFailure({ message: 'rate limit', hint: 'budget', now: NOW });
    expect(verdict.klass).toBe('budget');
    expect(verdict.poisonsAccount).toBe(false);
  });
});

describe('délai de réouverture', () => {
  it('lit un retry-after en secondes', () => {
    const ms = extractRetryAfterMs({ message: '', headers: { 'Retry-After': '42' }, now: NOW });
    expect(ms).toBe(42_000);
  });

  it('lit un retry-after en date HTTP', () => {
    const ms = extractRetryAfterMs({
      message: '',
      headers: { 'retry-after': 'Mon, 31 Aug 2026 10:05:00 GMT' },
      now: NOW,
    });
    expect(ms).toBe(5 * 60 * 1000);
  });

  it('lit l’epoch joint par Claude Code à sa limite d’usage', () => {
    const resetAt = Math.floor(NOW / 1000) + 3600;
    const ms = extractRetryAfterMs({
      message: `Claude AI usage limit reached|${resetAt}`,
      now: NOW,
    });
    expect(ms).toBe(3_600_000);
  });

  it('ignore une réouverture déjà passée', () => {
    const resetAt = Math.floor(NOW / 1000) - 60;
    expect(extractRetryAfterMs({ message: `usage limit reached|${resetAt}`, now: NOW })).toBeNull();
  });

  it('ignore une réouverture absurde au-delà de 24 h', () => {
    expect(
      extractRetryAfterMs({ message: '', headers: { 'retry-after': '999999' }, now: NOW }),
    ).toBeNull();
  });

  it('n’invente aucun délai pour une heure écrite en prose', () => {
    // « resets at 5pm » sans fuseau : mieux vaut le backoff qu'une heure devinée.
    const verdict = classifyFailure({
      message: 'Usage limit reached. Your limit will reset at 5pm.',
      now: NOW,
    });
    expect(verdict.klass).toBe('quota');
    expect(verdict.retryAfterMs).toBeNull();
  });
});
