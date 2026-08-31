import { describe, expect, it } from 'vitest';
import { fmtBytes } from './format';

describe('fmtBytes', () => {
  it('choisit l’unité lisible', () => {
    expect(fmtBytes(512)).toBe('512 o');
    expect(fmtBytes(2048)).toBe('2.0 Ko');
    expect(fmtBytes(5 * 1024 * 1024)).toBe('5.0 Mo');
    expect(fmtBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 Go');
  });

  /* La taille d'une base est un entier d'octets : afficher « 512.4 o » pour un
     arrondi flottant ferait douter du chiffre. */
  it('arrondit sous le kilo-octet', () => {
    expect(fmtBytes(512.4)).toBe('512 o');
    expect(fmtBytes(0)).toBe('0 o');
  });

  it('ne rend jamais de taille négative', () => {
    expect(fmtBytes(-5)).toBe('0 o');
  });
});

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
