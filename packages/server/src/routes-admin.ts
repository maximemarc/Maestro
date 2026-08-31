/**
 * Routes d'administration de l'instance : jetons d'accès et entretien de la base.
 *
 * Extrait de `routes.ts` sans réécriture. Les deux domaines voisinent parce
 * qu'ils portent sur l'instance elle-même, et non sur les agents ni leur travail.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateToken, hashToken, tokenPreview } from './access-tokens.ts';
import { parseOr400, type Services } from './routes-shared.ts';
import { makeId, nowIso } from './util.ts';

export function registerAdminRoutes(app: FastifyInstance, s: Services): void {
  // -- Jetons d'accès ----------------------------------------------------------------------------

  app.get('/api/access-tokens', async () => s.store.listAccessTokens());

  /**
   * Crée un jeton nommé.
   *
   * 🔒 La valeur n'est renvoyée qu'ici, une seule fois : seule son empreinte est
   * conservée. La réafficher ensuite supposerait de la stocker en clair, ce qui
   * annulerait tout l'intérêt.
   */
  app.post('/api/access-tokens', async (req, reply) => {
    const body = parseOr400(z.object({ label: z.string().trim().min(1).max(60) }), req.body);
    const value = generateToken();
    const token = {
      id: makeId('tok'),
      label: body.label,
      preview: tokenPreview(value),
      createdAt: nowIso(),
      lastUsedAt: null,
      revokedAt: null,
    };
    s.store.insertAccessToken(token, hashToken(value));
    s.bus.log('warn', 'auth', `Jeton d'accès « ${token.label} » créé`);
    reply.code(201);
    return { token, value };
  });

  app.post('/api/access-tokens/:id/revoke', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.store.revokeAccessToken(id, nowIso())) {
      return reply.code(404).send({ error: 'Jeton introuvable ou déjà révoqué' });
    }
    // Trace en avertissement : révoquer un accès mérite d'apparaître au journal.
    s.bus.log('warn', 'auth', `Jeton d'accès ${id} révoqué`);
    return { ok: true };
  });

  // -- Entretien de la base ----------------------------------------------------------------------

  /** État : taille de la base, rétention en vigueur, sauvegardes disponibles. */
  app.get('/api/maintenance', async () => ({
    databaseBytes: s.store.databaseBytes(),
    retentionDays: s.store.getSettings().retentionDays,
    backups: s.maintenance.listBackups(),
  }));

  app.post('/api/maintenance/prune', async () => s.maintenance.prune());

  app.post('/api/maintenance/backup', async (_req, reply) => {
    try {
      reply.code(201);
      return s.maintenance.backup();
    } catch (err) {
      // Disque plein ou répertoire non inscriptible : le dire, plutôt qu'une
      // trace de pile qui ne mentionne pas la sauvegarde.
      return reply.code(500).send({
        error: `Sauvegarde impossible : ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}
