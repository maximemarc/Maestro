import { describe, expect, it } from 'vitest';
import { fmtDateTime, fmtDuration, fmtTime } from './format';

describe('valeur absente', () => {
  /**
   * Le tiret cadratin est banni de l'interface : il se confond avec un signe
   * moins dans une colonne de nombres, et les lecteurs d'écran l'annoncent
   * comme un mot. Ce test verrouille la correction.
   */
  it('affiche un tiret simple, jamais un cadratin', () => {
    for (const value of [fmtTime(null), fmtDateTime(undefined), fmtDuration(null, null)]) {
      expect(value).toBe('-');
      expect(value).not.toContain('—');
    }
  });
});

describe('fmtDuration', () => {
  it('compte les secondes en dessous d’une minute', () => {
    expect(fmtDuration('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:42.000Z')).toBe('42s');
  });

  it('sépare minutes et secondes', () => {
    expect(fmtDuration('2026-01-01T00:00:00.000Z', '2026-01-01T00:02:05.000Z')).toBe('2m 5s');
  });

  it('passe aux heures au delà de soixante minutes', () => {
    expect(fmtDuration('2026-01-01T00:00:00.000Z', '2026-01-01T03:30:00.000Z')).toBe('3h 30m');
  });
});
