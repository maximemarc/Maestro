#!/usr/bin/env node
/**
 * Sauvegarde de la base, hors serveur.
 *
 * Le serveur sait déjà sauvegarder à la demande, mais il faut qu'il tourne. Ce
 * script marche dans les deux cas — instance arrêtée, ou lancé depuis une tâche
 * planifiée du système. `VACUUM INTO` produit une copie cohérente et compactée
 * même pendant les écritures : copier le fichier attraperait un état
 * intermédiaire, le journal WAL n'étant pas replié.
 *
 * Usage : node scripts/backup.mjs   (ou `npm run backup`)
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PREFIX = 'maestro-';
const SUFFIX = '.db';
/** Même quota que l'entretien automatique du serveur. */
const KEEP = 7;

const dataDir = process.env.MAESTRO_DATA_DIR ?? join(homedir(), '.maestro');
const dbPath = join(dataDir, 'maestro.db');

if (!existsSync(dbPath)) {
  process.stderr.write(`\n  Aucune base à ${dbPath}.\n  Définir MAESTRO_DATA_DIR si besoin.\n\n`);
  process.exit(1);
}

const backupsDir = join(dataDir, 'backups');
// 🔒 0700 : une sauvegarde contient les transcripts, les approbations et la
// configuration des serveurs MCP — clés comprises.
if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
const target = join(backupsDir, `${PREFIX}${stamp}${SUFFIX}`);

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
} finally {
  db.close();
}

// Rotation : l'horodatage rend l'ordre alphabétique chronologique.
const mine = readdirSync(backupsDir)
  .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
  .sort();
const dropped = mine.slice(0, Math.max(0, mine.length - KEEP));
for (const name of dropped) rmSync(join(backupsDir, name), { force: true });

const size = statSync(target).size;
process.stdout.write(
  `\n  ✓ ${target}\n    ${(size / 1024 / 1024).toFixed(2)} Mo` +
    (dropped.length > 0 ? ` · ${dropped.length} ancienne(s) supprimée(s)` : '') +
    `\n\n  Restaurer : arrêter Maestro, puis remplacer ${dbPath} par cette copie.\n\n`,
);
