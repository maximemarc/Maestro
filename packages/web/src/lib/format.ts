/**
 * Helpers d'affichage partagés.
 *
 * Une valeur absente s'affiche par un tiret simple, jamais par un cadratin :
 * le cadratin se confond avec un signe moins dans une colonne de nombres, et
 * les lecteurs d'écran l'annoncent comme un mot.
 */
const ABSENT = '-';

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return ABSENT;
  return new Date(iso).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return ABSENT;
  return new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Durée en millisecondes, au même format qu'une durée de run. */
export function fmtDurationMs(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export function fmtDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso) return ABSENT;
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  return fmtDurationMs(end - new Date(startIso).getTime());
}

export function fmtUptime(sec: number): string {
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}j ${Math.floor((sec % 86400) / 3600)}h`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function fmtCost(usd: number): string {
  return `$${usd.toFixed(usd >= 1 ? 2 : 4)}`;
}

export const RUN_STATUS_LABELS: Record<string, string> = {
  queued: 'En file',
  running: 'En cours',
  waiting_approval: 'Attente approbation',
  succeeded: 'Réussi',
  failed: 'Échoué',
  cancelled: 'Annulé',
  timeout: 'Délai dépassé',
};

export const COLUMN_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  running: 'En cours',
  review: 'Revue',
  done: 'Terminé',
};

export const ORIGIN_LABELS: Record<string, string> = {
  manual: 'Manuel',
  routine: 'Routine',
  kanban: 'Kanban',
  telegram: 'Telegram',
  pipeline: 'Pipeline',
  agent: 'Délégation',
};
