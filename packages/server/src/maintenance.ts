/**
 * Entretien de la base : rétention et sauvegarde.
 *
 * Rien ne purgeait `run_events` ni `logs`. C'était sans conséquence tant qu'une
 * instance faisait quelques dizaines de runs — mais un seul lot d'entraînement
 * de mille échantillons, avec la capture intégrale des retours d'outils, écrit
 * de l'ordre de plusieurs centaines de mégaoctets de texte. La base grossit sans
 * jamais rendre d'espace, et personne ne s'en aperçoit avant que le disque ne
 * soit plein.
 *
 * Les sauvegardes existaient déjà, mais faites à la main : on trouve des copies
 * `maestro.db.avant-<date>` dans les répertoires de données. Ce qui est fait à
 * la main n'est pas fait le jour où l'on en a besoin.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Bus } from './bus.ts';
import type { MaestroConfig } from './config.ts';
import type { Store } from './db.ts';

/** Compte rendu d'une purge — ce qui a disparu, et ce que ça a rendu. */
export interface PruneReport {
  /** Faux quand la rétention est désactivée : rien n'a été touché. */
  applied: boolean;
  cutoff: string | null;
  deletedEvents: number;
  deletedLogs: number;
  bytesBefore: number;
  bytesAfter: number;
}

export interface BackupReport {
  path: string;
  bytes: number;
  /** Sauvegardes supprimées par la rotation. */
  rotated: string[];
}

/** Intervalle entre deux passages automatiques. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Sauvegardes conservées par la rotation. Au-delà, la plus ancienne part. */
export const BACKUP_KEEP = 7;

const BACKUP_PREFIX = 'maestro-';
const BACKUP_SUFFIX = '.db';

/**
 * Date de coupure d'une rétention.
 *
 * Isolée et pure pour être testable sans horloge : passer `now` explicitement
 * évite un test qui dépend du moment où il tourne.
 */
export function retentionCutoff(retentionDays: number | null, now: Date): string | null {
  if (!retentionDays || retentionDays <= 0) return null;
  return new Date(now.getTime() - retentionDays * MS_PER_DAY).toISOString();
}

/**
 * Nom d'une sauvegarde.
 *
 * Horodaté à la seconde et trié lexicographiquement : deux sauvegardes du même
 * jour ne s'écrasent pas, et l'ordre alphabétique est l'ordre chronologique —
 * ce dont la rotation dépend.
 */
export function backupName(now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replaceAll(':', '-');
  return `${BACKUP_PREFIX}${stamp}${BACKUP_SUFFIX}`;
}

/** Sauvegardes à supprimer pour n'en garder que `keep`, les plus récentes. */
export function backupsToRotate(existing: string[], keep: number): string[] {
  const ours = existing
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
    .sort();
  return ours.slice(0, Math.max(0, ours.length - keep));
}

export class MaintenanceService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private store: Store,
    private bus: Bus,
    private config: MaestroConfig,
  ) {}

  /**
   * Démarre l'entretien périodique.
   *
   * Un premier passage au démarrage, puis toutes les six heures. `unref` est
   * indispensable : sans lui, ce minuteur suffirait à maintenir le processus en
   * vie et le serveur ne s'arrêterait jamais tout seul.
   */
  start(): void {
    this.prune();
    this.timer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Applique la rétention configurée. */
  prune(now: Date = new Date()): PruneReport {
    const days = this.store.getSettings().retentionDays;
    const cutoff = retentionCutoff(days, now);
    const bytesBefore = this.store.databaseBytes();

    if (!cutoff) {
      return {
        applied: false,
        cutoff: null,
        deletedEvents: 0,
        deletedLogs: 0,
        bytesBefore,
        bytesAfter: bytesBefore,
      };
    }

    const deletedEvents = this.store.pruneRunEvents(cutoff);
    const deletedLogs = this.store.pruneLogs(cutoff);

    // VACUUM réécrit la base entière : on ne le paie que si la purge a
    // réellement supprimé quelque chose.
    if (deletedEvents + deletedLogs > 0) this.store.vacuum();
    const bytesAfter = this.store.databaseBytes();

    if (deletedEvents + deletedLogs > 0) {
      this.bus.log(
        'info',
        'maintenance',
        `Rétention ${days} j : ${deletedEvents} événement(s) et ${deletedLogs} ligne(s) de journal purgés, ` +
          `${formatBytes(bytesBefore - bytesAfter)} rendus.`,
      );
    }
    return { applied: true, cutoff, deletedEvents, deletedLogs, bytesBefore, bytesAfter };
  }

  /** Répertoire des sauvegardes, créé à la demande. */
  private backupDir(): string {
    const dir = join(this.config.dataDir, 'backups');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * Sauvegarde la base, puis fait tourner les anciennes.
   *
   * 🔒 Le répertoire est en 0700 : une sauvegarde contient tout — transcripts,
   * approbations, configuration des serveurs MCP et leurs clés. Elle mérite les
   * mêmes précautions que la base elle-même.
   */
  backup(now: Date = new Date()): BackupReport {
    const dir = this.backupDir();
    const path = join(dir, backupName(now));
    this.store.backupTo(path);

    const rotated = backupsToRotate(readdirSync(dir), BACKUP_KEEP);
    for (const name of rotated) rmSync(join(dir, name), { force: true });

    const bytes = statSync(path).size;
    this.bus.log(
      'success',
      'maintenance',
      `Sauvegarde écrite (${formatBytes(bytes)})` +
        (rotated.length > 0 ? `, ${rotated.length} ancienne(s) supprimée(s)` : ''),
    );
    return { path, bytes, rotated };
  }

  /** Sauvegardes disponibles, de la plus récente à la plus ancienne. */
  listBackups(): Array<{ name: string; bytes: number; createdAt: string }> {
    const dir = this.backupDir();
    return readdirSync(dir)
      .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
      .sort()
      .reverse()
      .map((name) => {
        const info = statSync(join(dir, name));
        return { name, bytes: info.size, createdAt: info.mtime.toISOString() };
      });
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} Go`;
}
