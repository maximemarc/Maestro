import { randomUUID } from 'node:crypto';

/** Identifiant court préfixé, lisible dans les logs (ex. run_a1b2c3d4e5). */
export function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Date locale YYYY-MM-DD (regroupements journaliers). */
/**
 * Instant du début de la journée courante, en ISO UTC.
 *
 * Sert de borne aux totaux « du jour ». La version précédente fabriquait une
 * date au format local (`2026-08-27`) et la comparait à `created_at`, qui est
 * stocké en UTC : en Europe/Paris, les runs lancés entre minuit et deux heures
 * du matin portaient un horodatage UTC de la veille et disparaissaient donc du
 * total de la journée. Comparer des instants, et non des préfixes de chaîne,
 * supprime la classe entière de ce défaut.
 */
export function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
