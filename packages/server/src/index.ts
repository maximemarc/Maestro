/**
 * Point d'entrée Maestro : contrôle l'environnement, puis démarre le serveur.
 *
 * Le serveur est chargé par un import **dynamique**, et c'est le seul moyen que
 * le contrôle de version serve à quelque chose. Les imports statiques d'un
 * module ESM sont tous résolus avant que sa première ligne ne s'exécute : un
 * `import './preflight.ts'` placé en tête de `bootstrap.ts` arriverait donc
 * après l'échec de résolution de `node:sqlite`. Vérifié sous Node 18 — la
 * version statique meurt sur ERR_UNKNOWN_BUILTIN_MODULE sans rien afficher.
 */
import './preflight.ts';

await import('./bootstrap.ts');
