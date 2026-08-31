/**
 * Service worker minimal — installabilité, sans mise en cache.
 *
 * Il ne met **rien** en cache, et c'est le point important. Maestro est un
 * tableau de bord temps réel : un shell servi depuis un cache montrerait un état
 * périmé — des runs terminés qui paraissent actifs, des approbations déjà
 * résolues qui semblent attendre. Un écran de chargement d'une demi-seconde est
 * préférable à une information fausse qui a l'air vraie.
 *
 * Il existe donc pour une seule raison : les navigateurs exigent un service
 * worker doté d'un gestionnaire `fetch` pour proposer l'installation. Celui-ci
 * relaie, un point c'est tout.
 *
 * Conséquence assumée : aucun mode hors ligne. Sans le serveur, il n'y a de
 * toute façon ni agents, ni runs, ni approbations à afficher — l'interface n'a
 * aucun état propre à montrer.
 */

self.addEventListener('install', () => {
  // Prend la main immédiatement : pas d'ancienne version à laisser finir,
  // puisqu'il n'y a rien en cache à préserver.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  /* Aucun `event.respondWith` : la requête suit son cours normal vers le réseau.
     C'est la façon la plus sûre de satisfaire l'exigence d'installabilité sans
     s'interposer entre l'interface et son serveur. */
});
