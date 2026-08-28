/**
 * Contrôle de version de Node, avant tout autre import.
 *
 * `db.ts` importe `node:sqlite`, disponible à partir de Node 22. Sous une
 * version antérieure, le processus meurt sur « No such built-in module:
 * node:sqlite » — un message que rien ne relie à sa cause, et qui a déjà coûté
 * une recherche inutile sur ce projet.
 *
 * Ce module doit être importé **en première position** dans `index.ts` : les
 * modules ESM sont évalués dans l'ordre de leurs imports, donc ce contrôle
 * s'exécute avant que la chaîne de `db.ts` n'atteigne `node:sqlite`.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_MAJOR = 22;

const major = Number(process.versions.node.split('.')[0]);

if (!Number.isFinite(major) || major < REQUIRED_MAJOR) {
  process.stderr.write(
    [
      '',
      `  Maestro exige Node ${REQUIRED_MAJOR} ou plus récent (détecté : v${process.versions.node}).`,
      '',
      '  La base de données utilise le module natif « node:sqlite », apparu en Node 22 :',
      '  sous une version antérieure, aucune donnée ne peut être lue.',
      '',
      '  Avec nvm :  nvm install 22 && nvm use 22',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

/*
 * Chargement de `.env.local`.
 *
 * `.env.example` documentait des variables que rien ne lisait : il fallait les
 * exporter à la main dans son shell, et l'assistant d'installation n'aurait eu
 * aucun endroit où écrire. `process.loadEnvFile` existe depuis Node 20 et le
 * contrôle de version ci-dessus garantit qu'on est au moins en 22.
 *
 * Ici, et pas dans `config.ts` : celui-ci lit `process.env` au moment de son
 * évaluation, donc le fichier doit être chargé avant que sa chaîne d'imports
 * ne commence. C'est exactement la raison d'être de ce module.
 *
 * L'environnement réel gagne toujours : les valeurs déjà présentes dans
 * `process.env` ne sont pas écrasées par le fichier — sinon un
 * `MAESTRO_PORT=4599 npm start` ponctuel serait silencieusement ignoré.
 */
const here = dirname(fileURLToPath(import.meta.url));
const envFile = resolve(join(here, '..', '..', '..', '.env.local'));
if (existsSync(envFile)) {
  const before = { ...process.env };
  try {
    process.loadEnvFile(envFile);
    for (const [key, value] of Object.entries(before)) {
      if (value !== undefined) process.env[key] = value;
    }
  } catch (err) {
    process.stderr.write(`  ⚠ .env.local illisible, ignoré : ${String(err)}\n`);
  }
}
