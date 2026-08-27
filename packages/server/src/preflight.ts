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
