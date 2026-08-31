/**
 * Montage HTTP des canaux entrants.
 *
 * Séparé du registre parce que ce sont deux responsabilités distinctes : le
 * registre décide *quoi* notifier, ce fichier décide *quels chemins existent*.
 *
 * ## Pourquoi un plugin encapsulé, et pas trois routes en vrac
 *
 * Une signature de webhook porte sur les octets exacts du corps. Or Fastify
 * analyse le JSON avant d'atteindre le gestionnaire, et il n'existe aucun moyen
 * de retrouver les octets d'origine après coup — un `JSON.stringify` du résultat
 * change les espaces et fait échouer toutes les vérifications.
 *
 * Les analyseurs de contenu de Fastify étant encapsulés par portée, un plugin
 * dédié permet de les remplacer par un « donne-moi les octets » **sans toucher**
 * au reste de l'API, qui a besoin de son JSON analysé.
 *
 * 🔒 Ces routes sont hors `/api`, donc hors du jeton Maestro (voir le hook
 * d'authentification dans `bootstrap.ts`, qui ne garde que `/api`, `/ws` et
 * `/mcp`). C'est volontaire et sans alternative : Slack ne connaît pas le
 * jeton. La contrepartie est que chaque canal doit s'authentifier lui-même, et
 * `supportsInbound` refuse de monter un canal qui n'est pas configuré pour.
 */
import type { FastifyInstance } from 'fastify';
import type { Bus } from '../bus.ts';
import type { ChannelRegistry } from './registry.ts';

/** Borne de taille du corps entrant. */
const MAX_INBOUND_BYTES = 1024 * 1024;

export async function registerInboundRoutes(
  app: FastifyInstance,
  registry: ChannelRegistry,
  bus: Bus,
): Promise<void> {
  const channels = registry.inbound();
  if (channels.length === 0) return;

  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: MAX_INBOUND_BYTES },
      (_req, body, done) => {
        done(null, body);
      },
    );

    for (const channel of channels) {
      scope.post(channel.inboundPath, async (req, reply) => {
        const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        try {
          const result = await channel.handleInbound({
            rawBody,
            headers: req.headers as Record<string, string | undefined>,
          });
          if (result.body === undefined) return await reply.code(result.status).send();
          return await reply.code(result.status).send(result.body);
        } catch (err) {
          // Un canal qui lève ne doit pas rendre 500 au service distant : Slack
          // afficherait une erreur à l'utilisateur et retenterait. On journalise
          // et on acquitte.
          bus.log(
            'error',
            'channels',
            `Canal ${channel.id} : requête entrante en erreur — ${err instanceof Error ? err.message : String(err)}`,
          );
          return await reply.code(200).send();
        }
      });
      bus.log('info', 'channels', `Canal ${channel.id} à l'écoute sur POST ${channel.inboundPath}`);
    }
  });
}
