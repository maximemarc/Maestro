/**
 * Routes du domaine Entraînement : dialectes, lots, comparaison, export.
 *
 * Extrait de `routes.ts` sans réécriture — le découpage est structurel, pas
 * comportemental, et la table de routage est identique avant et après.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ToolCallDialect } from '@maestro/shared';
import { parseOr400, type Services } from './routes-shared.ts';
import { DEFAULT_SPEC, TrainingError } from './training.ts';
import { summarise } from './training-compare.ts';
import { toJsonl } from './training-export.ts';
import { TOOL_CALL_DIALECTS, listDialects } from './training-parsers.ts';
import { nowIso } from './util.ts';

/**
 * Spécification d'un lot d'entraînement.
 *
 * Les bornes ne sont pas décoratives : `samples` plafonné évite qu'une faute de
 * frappe ne lance cinquante mille runs, et `workers` plafonné rappelle que le
 * parallélisme réel vient du pool d'agents, pas de ce nombre.
 */
const trainingSpecSchema = z.object({
  agentIds: z.array(z.string()).min(1).max(32),
  promptTemplates: z.array(z.string().min(1).max(20_000)).min(1).max(200),
  variables: z
    .record(z.string().min(1).max(60), z.array(z.string().max(2000)).max(500))
    .default({}),
  samples: z.number().int().min(1).max(10_000),
  workers: z.number().int().min(1).max(32).default(1),
  maxAttempts: z.number().int().min(1).max(5).default(1),
  toolWeights: z
    .array(z.object({ tool: z.string().max(120), weight: z.number().min(0).max(1000) }))
    .max(50)
    .default([]),
  timeoutSec: z.number().int().positive().max(86_400).nullable().default(null),
  skillId: z.string().nullable().default(null),
  grader: z
    .object({ agentId: z.string(), promptTemplate: z.string().min(1).max(20_000) })
    .nullable()
    .default(null),
});

const trainingBatchSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  spec: trainingSpecSchema,
});

/**
 * Modification d'un lot.
 *
 * Un schéma explicite plutôt que `patchOf` : la spécification se remplace en
 * bloc, jamais champ par champ. Un lot dont on changerait le nombre
 * d'échantillons sans revoir les gabarits produirait un plan incohérent avec
 * les échantillons déjà engendrés.
 */
const trainingBatchPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  spec: trainingSpecSchema.optional(),
});

const trainingExportSchema = z.object({
  format: z.enum(['sharegpt', 'openai', 'atropos', 'raw']),
  dialect: z.enum(TOOL_CALL_DIALECTS as [ToolCallDialect, ...ToolCallDialect[]]).optional(),
  batchId: z.string().nullable().optional(),
  runIds: z.array(z.string()).max(2000).optional(),
  tokenBudget: z.number().int().min(100).max(1_000_000).nullable().optional(),
  onlySucceeded: z.boolean().optional(),
  includeThinking: z.boolean().optional(),
  requireToolCalls: z.boolean().optional(),
});

/**
 * Erreur de spécification d'un lot → 400.
 *
 * Une spécification refusée (agent inconnu, moteur tmux, gabarit vide) est une
 * faute de la requête, pas une panne : la distinguer d'un 500 évite qu'un
 * message utile se perde dans une trace de pile.
 */
function trainingError(
  reply: { code: (n: number) => { send: (body: unknown) => unknown } },
  err: unknown,
): unknown {
  if (err instanceof TrainingError) return reply.code(400).send({ error: err.message });
  throw err;
}

export function registerTrainingRoutes(app: FastifyInstance, s: Services): void {
  // -- Entraînement (MLOps) --------------------------------------------------------------------

  app.get('/api/training/dialects', async () => listDialects());

  app.get('/api/training/batches', async () => s.training.list());

  app.post('/api/training/batches', async (req, reply) => {
    const input = parseOr400(trainingBatchSchema, req.body);
    try {
      reply.code(201);
      return s.training.create({
        name: input.name,
        description: input.description,
        spec: { ...DEFAULT_SPEC, ...input.spec },
      });
    } catch (err) {
      return trainingError(reply, err);
    }
  });

  /**
   * Banc de non-régression : deux lots, un écart.
   *
   * Les identifiants passent en requête et non dans le chemin : c'est une
   * lecture croisée entre deux ressources, aucune des deux n'étant le parent de
   * l'autre.
   */
  app.get('/api/training/compare', async (req, reply) => {
    const { baseline, candidate } = req.query as { baseline?: string; candidate?: string };
    if (!baseline || !candidate) {
      return reply.code(400).send({ error: 'Paramètres « baseline » et « candidate » requis' });
    }
    const comparison = s.training.compare(baseline, candidate);
    if (!comparison) return reply.code(404).send({ error: 'Lot introuvable' });
    return { ...comparison, verdict: summarise(comparison) };
  });

  app.get('/api/training/batches/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const batch = s.training.get(id);
    if (!batch) return reply.code(404).send({ error: 'Lot introuvable' });
    const { items, truncated, total } = s.training.itemPage(id);
    return { batch, items, itemsTruncated: truncated, itemTotal: total };
  });

  app.patch('/api/training/batches/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = parseOr400(trainingBatchPatchSchema, req.body);
    try {
      const batch = s.training.update(id, {
        name: patch.name,
        description: patch.description,
        ...(patch.spec ? { spec: { ...DEFAULT_SPEC, ...patch.spec } } : {}),
      });
      if (!batch) return reply.code(404).send({ error: 'Lot introuvable' });
      return batch;
    } catch (err) {
      return trainingError(reply, err);
    }
  });

  app.delete('/api/training/batches/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.training.remove(id)) return reply.code(404).send({ error: 'Lot introuvable' });
    return { ok: true };
  });

  app.post('/api/training/batches/:id/start', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return s.training.start(id);
    } catch (err) {
      return trainingError(reply, err);
    }
  });

  app.post('/api/training/batches/:id/pause', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.training.pause(id)) return reply.code(409).send({ error: 'Lot non interruptible' });
    return { ok: true };
  });

  app.post('/api/training/batches/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.training.cancel(id)) return reply.code(404).send({ error: 'Lot introuvable' });
    return { ok: true };
  });

  app.post('/api/training/items/:id/score', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseOr400(z.object({ score: z.number().min(0).max(1) }), req.body);
    const item = s.training.scoreItem(id, body.score);
    if (!item) return reply.code(404).send({ error: 'Échantillon introuvable' });
    return item;
  });

  app.get('/api/training/runs/:id/trajectory', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { thinking } = req.query as { thinking?: string };
    const trajectory = s.training.trajectoryOf(id, thinking === '1');
    if (!trajectory) return reply.code(404).send({ error: 'Run introuvable' });
    return trajectory;
  });

  /** Aperçu : compte, écarts et compression, sans produire le fichier. */
  app.post('/api/training/export/preview', async (req) => {
    const input = parseOr400(trainingExportSchema, req.body);
    return (await s.training.buildDataset(input)).preview;
  });

  /**
   * Téléchargement du jeu de données.
   *
   * En `application/x-ndjson` et non en JSON : la réponse n'est pas un document
   * unique mais une suite de lignes indépendantes, et c'est ce que les
   * chargeurs de jeux de données attendent.
   */
  app.post('/api/training/export', async (req, reply) => {
    const input = parseOr400(trainingExportSchema, req.body);
    const { lines } = await s.training.buildDataset(input);
    const stamp = nowIso().slice(0, 19).replaceAll(':', '-');
    reply
      .header('content-type', 'application/x-ndjson; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="maestro-${input.format}-${stamp}.jsonl"`,
      );
    return toJsonl(lines);
  });
}
