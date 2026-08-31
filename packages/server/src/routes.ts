/**
 * API REST — toutes les mutations passent ici ; le WebSocket ne fait que pousser.
 */
import type { FastifyInstance } from 'fastify';
import { registerAdminRoutes } from './routes-admin.ts';
import {
  badRequestOn,
  keyValueSchema,
  parseOr400,
  patchOf,
  type Services,
} from './routes-shared.ts';
import { registerTrainingRoutes } from './routes-training.ts';
import { z } from 'zod';
import { KANBAN_COLUMNS } from '@maestro/shared';
import type { OverviewResponse } from '@maestro/shared';
import { AGENT_TEMPLATES } from './agents.ts';
import { type Identity } from './access-tokens.ts';
import { renderPrometheus } from './metrics-prometheus.ts';
import { ConnectorError } from './connectors.ts';
import { previewImport, readConfig, selectForImport } from './mcp-import.ts';
import { buildRagGraph } from './rag-graph.ts';
import { probeMcpServer } from './mcp-probe.ts';
import {
  findMcpPreset,
  mcpPresets,
  missingRequiredEnv,
  presetToServerInput,
} from './mcp-presets.ts';
import { McpError } from './mcp-registry.ts';
import { PluginError } from './plugins.ts';
import { embeddingStatus } from './rag-embeddings.ts';
import { RagError } from './rag.ts';
import { readHops } from './federation.ts';
import { registerProviderRoutes } from './routes-providers.ts';
import {
  WorkspaceGitError,
  branchNameFor,
  changes as gitChanges,
  commitToBranch,
  patch as gitPatch,
  pushBranch,
} from './workspace-git.ts';

// -- MCP ---------------------------------------------------------------------

/**
 * Une carte clé/valeur libre, pour les variables d'environnement et les
 * en-têtes. Les clés sont bornées pour éviter qu'un client n'envoie un objet
 * arbitrairement large, mais les valeurs restent libres : un jeton est opaque.
 */
const mcpParamSchema = z.object({
  name: z.string().min(1).max(31),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string().max(500).default(''),
  required: z.boolean().default(false),
  enumValues: z.array(z.string().min(1).max(100)).max(30).default([]),
});

const mcpActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    urlTemplate: z.string().min(1).max(2000),
    headers: keyValueSchema.default({}),
    bodyTemplate: z.string().max(8000).default(''),
    responsePath: z.string().max(200).default(''),
    timeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
  }),
  z.object({
    kind: z.literal('text'),
    template: z.string().min(1).max(20_000),
  }),
]);

const mcpToolSchema = z.object({
  name: z.string().min(1).max(49),
  description: z.string().min(1).max(1000),
  params: z.array(mcpParamSchema).max(20).default([]),
  action: mcpActionSchema,
  /* Une approbation forcée outil par outil : un GET de consultation et un
     DELETE n'appellent pas la même vigilance, alors que la politique de l'agent
     les traite pareil. */
  requiresApproval: z.boolean().default(false),
});

const mcpServerSchema = z.object({
  slug: z.string().max(40).default(''),
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  kind: z.enum(['external', 'custom']),
  enabled: z.boolean().default(true),
  transport: z.enum(['stdio', 'http', 'sse']).nullable().default(null),
  command: z.string().max(500).nullable().default(null),
  args: z.array(z.string().max(500)).max(50).default([]),
  env: keyValueSchema.default({}),
  url: z.string().max(2000).nullable().default(null),
  headers: keyValueSchema.default({}),
  tools: z.array(mcpToolSchema).max(30).default([]),
});

/** Source d'une configuration à importer : un chemin, ou un contenu collé. */
const mcpImportSourceSchema = z
  .object({
    path: z.string().max(1000).optional(),
    json: z.string().max(2_000_000).optional(),
  })
  .refine((v) => Boolean(v.path?.trim()) || Boolean(v.json?.trim()), {
    message: 'Indique un chemin de fichier ou colle une configuration.',
  });

const mcpImportSchema = mcpImportSourceSchema.and(
  z.object({ names: z.array(z.string().min(1).max(200)).min(1).max(100) }),
);

const mcpTrialSchema = z.object({
  tool: z.string().min(1).max(50),
  args: z.record(z.string(), z.unknown()).default({}),
});

// -- RAG ---------------------------------------------------------------------

const ragCollectionSchema = z.object({
  slug: z.string().max(40).default(''),
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  chunkSize: z.number().int().min(300).max(4000).default(1200),
  chunkOverlap: z.number().int().min(0).max(2000).default(150),
});

const ragIngestSchema = z.object({
  sourceKind: z.enum(['text', 'file', 'directory', 'url', 'workspace']),
  title: z.string().max(200).optional(),
  /* Un collage peut être long : c'est le cas d'usage principal pour des
     procédures internes qu'on ne veut pas sortir dans un fichier. */
  content: z.string().max(2_000_000).optional(),
  source: z.string().max(2000).optional(),
});

const ragSearchSchema = z.object({
  query: z.string().min(2).max(1000),
  topK: z.number().int().min(1).max(20).default(5),
});

const agentBaseSchema = z.object({
  /*
   * Rogné avant contrôle : `min(1)` seul laissait passer un nom fait d'espaces.
   * Un agent nommé « ␣␣␣ » est inutilisable — invisible dans l'interface, et
   * introuvable par `/run <agent>`, qui résout par le nom.
   */
  name: z.string().trim().min(1).max(60),
  emoji: z.string().min(1).max(8).default('🤖'),
  description: z.string().max(500).default(''),
  model: z.string().min(1).max(80).default('sonnet'),
  engine: z.enum(['sdk', 'tmux']).default('sdk'),
  permissionMode: z
    .enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
    .default('default'),
  approvalPolicy: z.enum(['auto', 'ask', 'guarded']).default('guarded'),
  systemPrompt: z.string().max(20000).nullable().default(null),
  cliAgent: z.string().max(80).nullable().default(null),
  parentAgentId: z.string().max(40).nullable().default(null),
  pluginIds: z.array(z.string().max(40)).default([]),
  mcpServerIds: z.array(z.string().max(40)).default([]),
  ragCollectionIds: z.array(z.string().max(40)).default([]),
  resiliencePolicyId: z.string().max(60).nullable().default(null),
  workspaceDir: z.string().max(500).nullable().optional(),
  memoryEnabled: z.boolean().default(true),
  allowedTools: z.array(z.string()).nullable().default(null),
  disallowedTools: z.array(z.string()).nullable().default(null),
  maxTurns: z.number().int().positive().max(500).nullable().default(null),
  timeoutSec: z.number().int().positive().max(86400).nullable().default(null),
  tokenBudget: z.number().int().positive().nullable().default(null),
  /*
   * Confinement, nul par défaut : ne rien dire vaut « comme avant ». Les listes
   * de chemins et de domaines sont bornées — une liste sans limite finit dans
   * une ligne de commande passée au bac à sable.
   */
  sandbox: z
    .object({
      enabled: z.boolean().default(false),
      failIfUnavailable: z.boolean().default(false),
      allowedDomains: z.array(z.string().min(1).max(253)).max(100).default([]),
      strictAllowlist: z.boolean().default(true),
      allowWrite: z.array(z.string().min(1).max(4096)).max(50).default([]),
      denyRead: z.array(z.string().min(1).max(4096)).max(50).default([]),
    })
    .nullable()
    .default(null),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#22d3ee'),
  pinned: z.object({ x: z.number(), y: z.number() }).nullable().default(null),
  archived: z.boolean().default(false),
});

const startRunSchema = z.object({
  agentId: z.string(),
  prompt: z.string().min(1).max(100000),
  skillId: z.string().nullable().optional(),
  resumeRunId: z.string().nullable().optional(),
  engine: z.enum(['sdk', 'tmux']).nullable().optional(),
});

const taskCreateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(10000).default(''),
  column: z.enum(KANBAN_COLUMNS).default('backlog'),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
  labels: z.array(z.string().max(40)).default([]),
  agentId: z.string().nullable().default(null),
  autoRun: z.boolean().default(false),
});

const skillUpsertSchema = z.object({
  scope: z.enum(['global', 'agent']),
  agentId: z.string().nullable().optional(),
  slug: z.string().max(80).default(''),
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  content: z.string().min(1).max(100000),
});

const routineSchema = z.object({
  name: z.string().min(1).max(120),
  agentId: z.string(),
  skillId: z.string().nullable().optional(),
  prompt: z.string().min(1).max(50000),
  cronExpr: z.string().min(1).max(100),
  enabled: z.boolean().optional(),
  timeoutSec: z.number().int().positive().max(86400).nullable().optional(),
  notify: z.boolean().optional(),
});

const pipelineSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  steps: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string().min(1).max(80),
        agentId: z.string(),
        skillId: z.string().nullable().default(null),
        promptTemplate: z.string().min(1).max(50000),
        /* Route cette étape vers d'autres fournisseurs que ceux de l'agent :
           c'est ce qui rend un workflow hétérogène sans dupliquer les agents. */
        resiliencePolicyId: z.string().max(60).nullable().default(null),
      }),
    )
    .min(1),
});

const connectorSearchSchema = z.object({
  q: z.string().max(200).optional(),
  category: z.string().max(60).optional(),
  type: z.string().max(40).optional(),
  featured: z.coerce.boolean().optional(),
  sort: z.enum(['stars', 'newest']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10000).optional(),
});

const connectorInstallSchema = z.object({
  ref: z.string().min(1).max(500),
  slug: z.string().max(80).optional(),
  scope: z.enum(['global', 'agent']).default('global'),
  agentId: z.string().max(40).nullable().optional(),
});

const installAgentSchema = z.object({
  ref: z.string().min(1).max(500),
  name: z.string().min(1).max(60).optional(),
  emoji: z.string().min(1).max(8).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  model: z.string().min(1).max(80).optional(),
  engine: z.enum(['sdk', 'tmux']).optional(),
  approvalPolicy: z.enum(['auto', 'ask', 'guarded']).optional(),
  parentAgentId: z.string().max(40).nullable().optional(),
});

const installPluginSchema = z.object({
  ref: z.string().min(1).max(500),
  slug: z.string().max(64).optional(),
});

const settingsSchema = z.object({
  instanceName: z.string().min(1).max(60).optional(),
  notifyAllRuns: z.boolean().optional(),
  approvalTimeoutSec: z.number().int().min(30).max(86400).optional(),
  maxConcurrentRuns: z.number().int().min(1).max(32).optional(),
  maxAgentDepth: z.number().int().min(0).max(5).optional(),
  defaultResiliencePolicyId: z.string().max(60).nullable().optional(),
  retentionDays: z.number().int().min(1).max(3650).nullable().optional(),
  fullTrajectoryCapture: z.boolean().optional(),
});

const peerSchema = z.object({
  /* Ni arobase ni espace : ce nom sert dans une cible « agent@pair ». */
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[^@\s]+$/, 'Ni arobase ni espace : ce nom sert dans une cible « agent@pair »'),
  baseUrl: z.string().url().max(300),
  /* Le NOM de la variable qui porte le jeton, jamais le jeton : celui d'un pair
     ouvre son API complète. */
  tokenEnv: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{2,80}$/, 'Nom de variable d’environnement attendu (MAJUSCULES)'),
  enabled: z.boolean().default(true),
  maxConcurrent: z.number().int().min(1).max(20).default(2),
});

const heartbeatSchema = z.object({
  enabled: z.boolean().optional(),
  agentId: z.string().max(60).nullable().optional(),
  cronExpr: z.string().min(5).max(120).optional(),
  /* Plafond borné haut : au-delà d'un battement par minute sur la journée, ce
     n'est plus un plafond. */
  dailyMax: z.number().int().min(1).max(1440).optional(),
  skipWhenBusy: z.boolean().optional(),
  skipUnderQuotaPressure: z.boolean().optional(),
});

/* Le contrat des services vit dans `routes-shared`, d'où tous les modules le
   tirent ; il reste réexporté ici pour ne pas casser les appelants. */
export type { Services } from './routes-shared.ts';

export function registerRoutes(app: FastifyInstance, s: Services): void {
  /*
   * Domaines extraits.
   *
   * Le découpage est structurel : les blocs ont été déplacés tels quels, et la
   * table de routage est identique avant et après — vérifié, plutôt que relu.
   */
  registerAdminRoutes(app, s);
  registerTrainingRoutes(app, s);

  // -- Santé & vue d'ensemble -------------------------------------------------

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/overview', async (): Promise<OverviewResponse> => ({
    metrics: s.metrics.snapshot(),
    server: {
      version: s.config.version,
      startedAt: s.startedAt,
      dataDir: s.config.dataDir,
      telegramEnabled: s.telegramEnabled,
      tmuxAvailable: await s.tmux.available(),
    },
    recentLogs: s.store.recentLogs(150),
  }));

  app.get('/api/logs', async (req) => {
    const { limit } = req.query as { limit?: string };
    return s.store.recentLogs(Math.min(Number(limit ?? 200) || 200, 1000));
  });

  // -- Agents -------------------------------------------------------------------

  app.get('/api/agent-templates', async () => AGENT_TEMPLATES);

  app.get('/api/agents', async (req) => {
    const { archived } = req.query as { archived?: string };
    return s.agents.list(archived === '1');
  });

  app.post('/api/agents', async (req, reply) => {
    const input = parseOr400(agentBaseSchema, req.body);
    const agent = s.agents.create(input);
    s.skills.syncAgentWorkspace(agent);
    reply.code(201);
    return agent;
  });

  app.get('/api/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = s.agents.get(id);
    if (!agent) return reply.code(404).send({ error: 'Agent introuvable' });
    return agent;
  });

  app.patch('/api/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = parseOr400(patchOf(agentBaseSchema), req.body);
    const agent = s.agents.update(id, patch);
    if (!agent) return reply.code(404).send({ error: 'Agent introuvable' });
    s.skills.syncAgentWorkspace(agent);
    return agent;
  });

  app.post('/api/agents/:id/clone', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name } = (req.body ?? {}) as { name?: string };
    const clone = s.agents.clone(id, name);
    if (!clone) return reply.code(404).send({ error: 'Agent introuvable' });
    s.skills.syncAgentWorkspace(clone);
    reply.code(201);
    return clone;
  });

  app.delete('/api/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.agents.delete(id)) return reply.code(404).send({ error: 'Agent introuvable' });
    return { ok: true };
  });

  app.get('/api/agents/:id/memory', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = s.agents.get(id);
    if (!agent) return reply.code(404).send({ error: 'Agent introuvable' });
    return { content: s.agents.readMemory(agent) };
  });

  app.put('/api/agents/:id/memory', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = s.agents.get(id);
    if (!agent) return reply.code(404).send({ error: 'Agent introuvable' });
    const { content } = parseOr400(z.object({ content: z.string().max(200000) }), req.body);
    s.agents.writeMemory(agent, content);
    return { ok: true };
  });

  // -- Runs -----------------------------------------------------------------------

  app.post('/api/runs', async (req, reply) => {
    const input = parseOr400(startRunSchema, req.body);
    let resumeSessionId: string | null = null;
    if (input.resumeRunId) {
      resumeSessionId = s.store.getRun(input.resumeRunId)?.sessionId ?? null;
      if (!resumeSessionId) return reply.code(400).send({ error: 'Run à reprendre sans session' });
    }
    const run = badRequestOn(() =>
      s.engine.start({
        agentId: input.agentId,
        prompt: input.prompt,
        skillId: input.skillId ?? null,
        origin: 'manual',
        resumeSessionId,
        engineOverride: input.engine ?? null,
        /* Sauts hérités d'une délégation fédérée. Sans cette lecture, un run
           créé par une voisine repartirait de zéro et un aller-retour entre
           deux machines ne serait borné par rien. */
        federationHops: readHops(req.headers as Record<string, unknown>),
      }),
    );
    reply.code(201);
    return run;
  });

  app.get('/api/runs', async (req) => {
    const q = req.query as { agentId?: string; status?: string; limit?: string };
    return s.store.listRuns({
      agentId: q.agentId,
      status: q.status as never,
      limit: Math.min(Number(q.limit ?? 100) || 100, 500),
    });
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = s.store.getRun(id);
    if (!run) return reply.code(404).send({ error: 'Run introuvable' });
    return { run, events: s.store.listRunEvents(id) };
  });

  app.post('/api/runs/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.engine.cancel(id)) return reply.code(409).send({ error: 'Run non annulable' });
    return { ok: true };
  });

  /*
   * Modifications produites dans le répertoire de l'agent.
   *
   * Trois routes en lecture puis une en écriture, et l'écriture est
   * volontairement séparée : voir ce qu'un agent a changé doit rester sans
   * conséquence, livrer doit être un geste distinct et explicite.
   */
  app.get('/api/runs/:id/changes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = s.store.getRun(id);
    if (!run) return reply.code(404).send({ error: 'Run inconnu' });
    const agent = s.agents.get(run.agentId);
    if (!agent) return reply.code(404).send({ error: 'Agent inconnu' });
    try {
      return await gitChanges(agent.workspaceDir, s.store.getRunGitBase(id));
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : 'Lecture git impossible' });
    }
  });

  app.get('/api/runs/:id/patch', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = s.store.getRun(id);
    if (!run) return reply.code(404).send({ error: 'Run inconnu' });
    const agent = s.agents.get(run.agentId);
    if (!agent) return reply.code(404).send({ error: 'Agent inconnu' });
    try {
      const text = await gitPatch(agent.workspaceDir);
      // Téléchargement plutôt qu'affichage : un patch se relit dans un éditeur
      // et s'applique avec git apply, il n'a pas vocation à s'ouvrir en page.
      return reply
        .header('content-type', 'text/x-patch; charset=utf-8')
        .header('content-disposition', `attachment; filename="maestro-${id.slice(0, 8)}.patch"`)
        .send(text);
    } catch (err) {
      const status = err instanceof WorkspaceGitError ? 409 : 500;
      return reply
        .code(status)
        .send({ error: err instanceof Error ? err.message : 'Patch indisponible' });
    }
  });

  /** Nom de branche proposé par défaut, pour préremplir le formulaire. */
  app.get('/api/runs/:id/branch-name', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = s.store.getRun(id);
    if (!run) return reply.code(404).send({ error: 'Run inconnu' });
    return { branch: branchNameFor(run.prompt, run.id) };
  });

  app.post('/api/runs/:id/branch', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = s.store.getRun(id);
    if (!run) return reply.code(404).send({ error: 'Run inconnu' });
    const agent = s.agents.get(run.agentId);
    if (!agent) return reply.code(404).send({ error: 'Agent inconnu' });

    const body = (req.body ?? {}) as { branch?: string; message?: string; paths?: string[] };
    const branch = body.branch?.trim() || branchNameFor(run.prompt, run.id);
    /* Le prompt sert de message par défaut : c'est la meilleure description
       disponible de l'intention, et elle vient de l'humain. */
    const message =
      body.message?.trim() ||
      `${run.prompt.split('\n')[0]?.slice(0, 72) ?? 'Travail de l’agent'}\n\nProduit par l’agent ${agent.name} (run ${run.id}).`;

    try {
      const result = await commitToBranch(agent.workspaceDir, {
        branch,
        message,
        ...(body.paths && body.paths.length > 0 ? { paths: body.paths } : {}),
      });
      s.bus.log(
        'success',
        'runs',
        `Branche ${result.branch} créée depuis le run ${id.slice(0, 8)} (${result.files} fichier(s))`,
      );
      return result;
    } catch (err) {
      // 409 : la demande est refusée pour l'état du dépôt, pas pour une panne.
      const status = err instanceof WorkspaceGitError ? 409 : 500;
      return reply
        .code(status)
        .send({ error: err instanceof Error ? err.message : 'Livraison impossible' });
    }
  });

  /**
   * Publie la branche d'un run et rend le lien de merge request.
   *
   * 🔒 Le push emprunte les identifiants git de la machine, jamais un jeton
   * stocké par Maestro — et il ne pousse que la branche nommée, jamais en force.
   * La merge request n'est pas créée par API : la forge propose déjà son lien
   * dans la sortie du push, et le fabriquer aurait exigé un jeton, l'URL de
   * l'instance et le chemin du projet.
   */
  app.post('/api/runs/:id/push', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = s.store.getRun(id);
    if (!run) return reply.code(404).send({ error: 'Run introuvable' });
    const agent = s.agents.get(run.agentId);
    if (!agent) return reply.code(404).send({ error: 'Agent introuvable' });

    const body = parseOr400(
      z.object({
        branch: z.string().min(1).max(200),
        remote: z.string().min(1).max(80).default('origin'),
      }),
      req.body ?? {},
    );
    try {
      return await pushBranch(agent.workspaceDir, body);
    } catch (err) {
      if (err instanceof WorkspaceGitError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // -- Approbations ------------------------------------------------------------------

  app.get('/api/approvals', async (req) => {
    const { status } = req.query as { status?: string };
    return s.store.listApprovals(status as never);
  });

  app.post('/api/approvals/:id/resolve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseOr400(
      z.object({ decision: z.enum(['allow', 'deny']), note: z.string().max(500).optional() }),
      req.body,
    );
    /*
     * Qui a tranché, et pas seulement par où.
     *
     * C'est tout l'objet des jetons nommés : « web » ne disait rien d'utile
     * dès qu'on est deux, alors que l'attribution est précisément ce qu'un
     * human-in-the-loop doit garantir.
     */
    const identity = (req as { identity?: Identity }).identity;
    const approval = s.approvals.resolve(
      id,
      body.decision,
      'web',
      body.note ?? null,
      identity?.label ?? null,
    );
    if (!approval) return reply.code(404).send({ error: 'Approbation introuvable' });
    return approval;
  });

  // -- Kanban ---------------------------------------------------------------------------

  app.get('/api/tasks', async () => s.tasks.list());

  app.post('/api/tasks', async (req, reply) => {
    const input = parseOr400(taskCreateSchema, req.body);
    const task = s.tasks.create(input);
    if (task.agentId && input.autoRun) {
      s.engine.start({
        agentId: task.agentId,
        prompt: `${task.title}\n\n${task.description}`.trim(),
        origin: 'kanban',
        originId: task.id,
      });
    }
    reply.code(201);
    return s.tasks.get(task.id);
  });

  app.patch('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = parseOr400(patchOf(taskCreateSchema), req.body);
    const task = s.tasks.update(id, patch);
    if (!task) return reply.code(404).send({ error: 'Carte introuvable' });
    return task;
  });

  app.post('/api/tasks/:id/move', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseOr400(
      z.object({ column: z.enum(KANBAN_COLUMNS), position: z.number() }),
      req.body,
    );
    const task = s.tasks.move(id, body.column, body.position, 'opérateur');
    if (!task) return reply.code(404).send({ error: 'Carte introuvable' });
    return task;
  });

  app.post('/api/tasks/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = s.tasks.get(id);
    if (!task) return reply.code(404).send({ error: 'Carte introuvable' });
    const body = (req.body ?? {}) as { agentId?: string };
    const agentId = body.agentId ?? task.agentId;
    if (!agentId) return reply.code(400).send({ error: 'Aucun agent assigné à cette carte' });
    if (agentId !== task.agentId) s.tasks.update(id, { agentId });
    const run = badRequestOn(() =>
      s.engine.start({
        agentId,
        prompt: `${task.title}\n\n${task.description}`.trim(),
        origin: 'kanban',
        originId: task.id,
      }),
    );
    reply.code(201);
    return run;
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.tasks.delete(id)) return reply.code(404).send({ error: 'Carte introuvable' });
    return { ok: true };
  });

  // -- Skills -----------------------------------------------------------------------------

  app.get('/api/skills', async () => s.skills.list());

  /**
   * Export d'une skill au format ouvert SKILL.md.
   *
   * En `text/markdown` et en pièce jointe : le fichier est fait pour être
   * republié tel quel — dans un dépôt, sur un hub communautaire — et non lu dans
   * le navigateur.
   */
  app.get('/api/skills/export', async (req, reply) => {
    const { id } = req.query as { id?: string };
    if (!id) return reply.code(400).send({ error: 'Paramètre « id » requis' });
    const exported = s.skills.exportSkill(id);
    if (!exported) return reply.code(404).send({ error: 'Skill introuvable' });
    reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header('content-disposition', `attachment; filename="${exported.filename}"`);
    return exported.content;
  });

  app.put('/api/skills', async (req) => {
    const input = parseOr400(skillUpsertSchema, req.body);
    return badRequestOn(() => s.skills.upsert(input));
  });

  app.delete('/api/skills', async (req, reply) => {
    const { id } = req.query as { id?: string };
    if (!id) return reply.code(400).send({ error: 'Paramètre id requis' });
    if (!badRequestOn(() => s.skills.remove(id)))
      return reply.code(404).send({ error: 'Skill introuvable' });
    return { ok: true };
  });

  // -- Connecteurs de skills ---------------------------------------------------------------

  app.get('/api/connectors', async () => s.connectors.list());

  app.get('/api/connectors/:id/search', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = parseOr400(connectorSearchSchema, req.query);
    try {
      return await s.connectors.search(id, query);
    } catch (err) {
      const status = err instanceof ConnectorError ? 400 : 502;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/connectors/:id/preview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { ref } = parseOr400(z.object({ ref: z.string().min(1).max(500) }), req.body);
    try {
      return await s.connectors.preview(id, ref);
    } catch (err) {
      const status = err instanceof ConnectorError ? 400 : 502;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Installe une skill distante. La prévisualisation est refaite côté serveur :
   * le contenu installé est celui réellement lu à la source, pas un corps
   * transmis par le client — ce qui interdirait toute substitution en chemin.
   */
  app.post('/api/connectors/:id/install/skill', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseOr400(connectorInstallSchema, req.body);
    if (body.scope === 'agent' && !body.agentId) {
      return reply.code(400).send({ error: 'agentId requis pour une installation par agent' });
    }
    let preview;
    try {
      preview = await s.connectors.preview(id, body.ref);
    } catch (err) {
      const status = err instanceof ConnectorError ? 400 : 502;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
    const skill = badRequestOn(() =>
      s.skills.upsert({
        scope: body.scope,
        agentId: body.agentId ?? null,
        slug: body.slug?.trim() || preview.suggestedSlug,
        name: preview.name,
        description: preview.description,
        content: preview.content,
        sourceUrl: preview.resolvedUrl,
      }),
    );
    s.bus.log('success', 'skills', `Skill « ${skill.name} » importée depuis ${id}`);
    reply.code(201);
    return skill;
  });

  app.post('/api/connectors/:id/preview/plugin', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { ref } = parseOr400(z.object({ ref: z.string().min(1).max(500) }), req.body);
    try {
      return await s.connectors.previewPlugin(id, ref);
    } catch (err) {
      const status = err instanceof ConnectorError ? 400 : 502;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Importe un subagent distant en agent Maestro : le corps markdown devient le
   * prompt système. `cliAgent` reste nul — la définition n'existe pas dans
   * ~/.claude/agents, c'est Maestro qui la porte désormais.
   */
  app.post('/api/connectors/:id/install/agent', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseOr400(installAgentSchema, req.body);
    let preview;
    try {
      preview = await s.connectors.preview(id, body.ref);
    } catch (err) {
      const status = err instanceof ConnectorError ? 400 : 502;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
    const declaredTools = preview.agentDraft?.tools ?? [];
    const canWrite = declaredTools.some((t) => t === 'Write' || t === 'Edit');
    const draftModel = preview.agentDraft?.model;
    const agent = badRequestOn(() =>
      s.agents.create({
        name: body.name?.trim() || preview.name,
        emoji: body.emoji ?? '🤖',
        description: preview.description.slice(0, 500),
        // 'inherit' dans une définition tierce = modèle de la session appelante.
        model: body.model ?? (draftModel && draftModel !== 'inherit' ? draftModel : 'sonnet'),
        engine: body.engine ?? 'sdk',
        permissionMode: 'default',
        approvalPolicy: body.approvalPolicy ?? (canWrite ? 'guarded' : 'auto'),
        systemPrompt: preview.content,
        cliAgent: null,
        pluginIds: [],
        mcpServerIds: [],
        ragCollectionIds: [],
        /* Un agent importé hérite de la politique par défaut de l'instance : lui
           en imposer une ici ferait un choix que l'opérateur n'a pas fait. */
        resiliencePolicyId: null,
        parentAgentId: body.parentAgentId ?? null,
        memoryEnabled: true,
        allowedTools: declaredTools.length > 0 ? declaredTools : null,
        disallowedTools: null,
        maxTurns: null,
        timeoutSec: null,
        tokenBudget: null,
        sandbox: null,
        color: body.color ?? preview.agentDraft?.color ?? '#22d3ee',
        pinned: null,
        archived: false,
        workspaceDir: null,
      }),
    );
    s.skills.syncAgentWorkspace(agent);
    s.bus.log('success', 'agents', `Agent « ${agent.name} » importé depuis ${id}`, {
      agentId: agent.id,
    });
    reply.code(201);
    return agent;
  });

  app.post('/api/connectors/:id/install/plugin', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseOr400(installPluginSchema, req.body);
    try {
      const preview = await s.connectors.previewPlugin(id, body.ref);
      const plugin = await s.plugins.install({
        slug: body.slug?.trim() || preview.repo.split('/')[1] || preview.name,
        name: preview.name,
        description: preview.description,
        version: preview.version,
        repo: preview.repo,
        cloneUrl: preview.cloneUrl,
        sourceUrl: preview.resolvedUrl,
      });
      reply.code(201);
      return plugin;
    } catch (err) {
      const status = err instanceof ConnectorError || err instanceof PluginError ? 400 : 502;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // -- Plugins installés -------------------------------------------------------------------

  app.get('/api/plugins', async () => s.plugins.list());

  app.post('/api/plugins/:id/update', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await s.plugins.update(id);
    } catch (err) {
      const status = err instanceof PluginError ? 400 : 502;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/plugins/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.plugins.remove(id)) return reply.code(404).send({ error: 'Plugin introuvable' });
    return { ok: true };
  });

  // -- Routines ----------------------------------------------------------------------------

  app.get('/api/routines', async () => s.scheduler.list());

  app.post('/api/routines', async (req, reply) => {
    const input = parseOr400(routineSchema, req.body);
    reply.code(201);
    return badRequestOn(() => s.scheduler.create(input));
  });

  app.patch('/api/routines/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = parseOr400(patchOf(routineSchema), req.body);
    const routine = badRequestOn(() => s.scheduler.update(id, patch));
    if (!routine) return reply.code(404).send({ error: 'Routine introuvable' });
    return routine;
  });

  app.delete('/api/routines/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.scheduler.remove(id)) return reply.code(404).send({ error: 'Routine introuvable' });
    return { ok: true };
  });

  app.post('/api/routines/:id/run-now', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.store.getRoutine(id)) return reply.code(404).send({ error: 'Routine introuvable' });
    s.scheduler.fire(id, true);
    return { ok: true };
  });

  // -- Pipelines ------------------------------------------------------------------------------

  app.get('/api/pipelines', async () => s.pipelines.list());

  app.post('/api/pipelines', async (req, reply) => {
    const input = parseOr400(pipelineSchema, req.body);
    reply.code(201);
    return s.pipelines.create(input);
  });

  app.patch('/api/pipelines/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = parseOr400(patchOf(pipelineSchema), req.body);
    const pipeline = s.pipelines.update(id, patch);
    if (!pipeline) return reply.code(404).send({ error: 'Pipeline introuvable' });
    return pipeline;
  });

  app.delete('/api/pipelines/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.pipelines.remove(id)) return reply.code(404).send({ error: 'Pipeline introuvable' });
    return { ok: true };
  });

  app.post('/api/pipelines/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parseOr400(
      z.object({ input: z.string().max(100000).default('') }),
      req.body ?? {},
    );
    try {
      reply.code(201);
      return s.pipelines.start(id, body.input);
    } catch (err) {
      return reply.code(400).send({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  app.get('/api/pipeline-runs', async (req) => {
    const { pipelineId } = req.query as { pipelineId?: string };
    return s.pipelines.listRuns(pipelineId);
  });

  app.get('/api/pipeline-runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const pr = s.pipelines.getRun(id);
    if (!pr) return reply.code(404).send({ error: 'Exécution introuvable' });
    return pr;
  });

  app.post('/api/pipeline-runs/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.pipelines.cancelRun(id))
      return reply.code(409).send({ error: 'Exécution non annulable' });
    return { ok: true };
  });

  /**
   * Exposition Prometheus.
   *
   * En `text/plain; version=0.0.4` : c'est le type que les collecteurs
   * attendent, et un `application/json` les fait échouer sans message utile.
   * La route reste derrière le jeton, comme le reste de l'API — les valeurs
   * exposées disent l'activité de l'instance.
   */
  app.get('/api/metrics/prometheus', async (_req, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return renderPrometheus(s.metrics.snapshot(), {
      databaseBytes: s.store.databaseBytes(),
      agents: s.store.countRows('agents'),
      runsTotal: s.store.countRows('runs'),
    });
  });

  // -- tmux --------------------------------------------------------------------------------------

  app.get('/api/tmux/sessions', async () => {
    const sessions = await s.tmux.list();
    /*
     * Rattache agent et run quand la session correspond à un run connu.
     *
     * L'index est construit une fois. La version précédente relisait les deux
     * cents derniers runs *à l'intérieur* du map, donc une fois par session :
     * dix sessions ouvertes donnaient dix lectures complètes et deux mille
     * lignes désérialisées pour retrouver dix correspondances.
     */
    const byTmuxSession = new Map<string, { id: string; agentId: string }>();
    for (const run of s.store.listRuns({ limit: 200 })) {
      if (run.tmuxSession) byTmuxSession.set(run.tmuxSession, run);
    }
    return sessions.map((session) => {
      const run = byTmuxSession.get(session.name);
      return run ? { ...session, runId: run.id, agentId: run.agentId } : session;
    });
  });

  app.delete('/api/tmux/sessions/:name', async (req) => {
    const { name } = req.params as { name: string };
    await s.tmux.kill(name);
    return { ok: true };
  });

  // -- Radar de sessions -----------------------------------------------------------------------

  app.get('/api/radar', async () => s.radar.snapshot());

  /** Balayage à la demande, sans attendre le tick périodique. */
  app.post('/api/radar/sweep', async () => s.radar.sweep());

  // -- Métriques -----------------------------------------------------------------------------------

  app.get('/api/metrics/agents', async () => s.store.agentStats());

  app.get('/api/metrics/tokens', async (req) => {
    const q = req.query as { groupBy?: string; days?: string };
    const groupBy = ['day', 'agent', 'model'].includes(q.groupBy ?? '')
      ? (q.groupBy as 'day' | 'agent' | 'model')
      : 'day';
    const days = Math.min(Number(q.days ?? 30) || 30, 365);
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    return s.store.tokensBy(groupBy, since);
  });

  // -- Paramètres -------------------------------------------------------------------------------------

  // -- Serveurs MCP -----------------------------------------------------------

  app.get('/api/mcp-servers', async () => s.mcp.list());

  /**
   * Catalogue de serveurs prêts à déclarer.
   *
   * Sert de raccourci, pas de dépendance : ces serveurs se déclarent aussi à la
   * main, et le catalogue ne fait que dispenser de connaître leur nom de paquet.
   */
  app.get('/api/mcp-presets', async () => mcpPresets());

  app.post('/api/mcp-presets/:slug/install', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const preset = findMcpPreset(slug);
    if (!preset) return reply.code(404).send({ error: `Preset inconnu : ${slug}` });

    const body = parseOr400(
      z.object({
        env: keyValueSchema.default({}),
        args: z.array(z.string().max(2000)).max(30).default([]),
      }),
      req.body ?? {},
    );
    const missing = missingRequiredEnv(preset, body.env);
    if (missing.length > 0) {
      return reply
        .code(400)
        .send({ error: `Variables requises manquantes : ${missing.join(', ')}` });
    }
    try {
      reply.code(201);
      return s.mcp.create(presetToServerInput(preset, { env: body.env, args: body.args }));
    } catch (err) {
      if (err instanceof McpError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/mcp-servers', async (req, reply) => {
    const body = mcpServerSchema.parse(req.body);
    try {
      return s.mcp.create(body);
    } catch (err) {
      if (err instanceof McpError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.patch('/api/mcp-servers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = mcpServerSchema.parse(req.body);
    try {
      return s.mcp.update(id, body);
    } catch (err) {
      if (err instanceof McpError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/api/mcp-servers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      s.mcp.remove(id);
      return { ok: true };
    } catch (err) {
      if (err instanceof McpError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  /* Sonde un serveur externe : répond-il, et quels outils annonce-t-il. */
  app.post('/api/mcp-servers/:id/probe', async (req, reply) => {
    const { id } = req.params as { id: string };
    const def = s.mcp.getRaw(id);
    if (!def) return reply.code(404).send({ error: 'Serveur MCP introuvable.' });
    return await probeMcpServer(def);
  });

  /* Prévisualise l'import d'une configuration existante. Rien n'est écrit. */
  app.post('/api/mcp-servers/import/preview', async (req, reply) => {
    const body = mcpImportSourceSchema.parse(req.body);
    try {
      return previewImport(readConfig(body), s.mcp.listRaw());
    } catch (err) {
      if (err instanceof McpError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  /* Crée les serveurs retenus. La configuration est relue ici : les secrets ne
     transitent donc jamais par le client entre les deux appels. */
  app.post('/api/mcp-servers/import', async (req, reply) => {
    const body = mcpImportSchema.parse(req.body);
    try {
      const created: string[] = [];
      const failed: Array<{ name: string; reason: string }> = [];
      for (const input of selectForImport(readConfig(body), body.names)) {
        try {
          s.mcp.create(input);
          created.push(input.name);
        } catch (err) {
          failed.push({
            name: input.name,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { created, failed };
    } catch (err) {
      if (err instanceof McpError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  /* Export d'une définition, secrets masqués : de quoi la versionner ou la
     rejouer sur une autre machine, à condition d'y ressaisir les jetons. */
  app.get('/api/mcp-servers/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string };
    const def = s.mcp.get(id);
    if (!def) return reply.code(404).send({ error: 'Serveur MCP introuvable.' });
    const { id: _id, createdAt: _c, updatedAt: _u, ...portable } = def;
    return portable;
  });

  /* Essai d'un outil maison avant de l'ouvrir aux agents. */
  app.post('/api/mcp-servers/:id/trial', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = mcpTrialSchema.parse(req.body);
    try {
      return await s.mcp.trial(id, body.tool, body.args);
    } catch (err) {
      if (err instanceof McpError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  // -- Collections RAG --------------------------------------------------------

  app.get('/api/rag/embeddings', async () => embeddingStatus());

  app.get('/api/rag/collections', async () => s.rag.list());

  app.post('/api/rag/collections', async (req, reply) => {
    const body = ragCollectionSchema.parse(req.body);
    try {
      return s.rag.create(body);
    } catch (err) {
      if (err instanceof RagError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.patch('/api/rag/collections/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ragCollectionSchema.parse(req.body);
    try {
      return s.rag.update(id, body);
    } catch (err) {
      if (err instanceof RagError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/api/rag/collections/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      s.rag.remove(id);
      return { ok: true };
    } catch (err) {
      if (err instanceof RagError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/rag/collections/:id/documents', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.rag.get(id)) return reply.code(404).send({ error: 'Collection introuvable.' });
    return s.rag.documents(id);
  });

  app.post('/api/rag/collections/:id/documents', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ragIngestSchema.parse(req.body);
    try {
      return await s.rag.ingest(id, body);
    } catch (err) {
      if (err instanceof RagError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/api/rag/collections/:id/documents/:documentId', async (req, reply) => {
    const { id, documentId } = req.params as { id: string; documentId: string };
    try {
      s.rag.removeDocument(id, documentId);
      return { ok: true };
    } catch (err) {
      if (err instanceof RagError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  /* Graphe de la collection : structure et rapprochements lexicaux. */
  app.get('/api/rag/collections/:id/graph', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.rag.get(id)) return reply.code(404).send({ error: 'Collection introuvable.' });
    return buildRagGraph(s.store, id);
  });

  /* Essai de recherche depuis l'interface : c'est ainsi qu'on vérifie qu'une
     collection est utile avant de la confier à un agent. */
  app.post('/api/rag/collections/:id/search', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ragSearchSchema.parse(req.body);
    try {
      return await s.rag.search(id, body.query, body.topK);
    } catch (err) {
      if (err instanceof RagError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  /* Redécoupe les documents depuis le contenu conservé : c'est ainsi qu'une
     nouvelle taille de découpe s'applique à ce qui est déjà indexé. */
  app.post('/api/rag/collections/:id/reindex', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await s.rag.reindex(id);
    } catch (err) {
      if (err instanceof RagError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  /* Relit les sources relisibles : fichiers, dossiers, pages, workspaces. */
  app.post('/api/rag/collections/:id/refresh', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await s.rag.refresh(id);
    } catch (err) {
      if (err instanceof RagError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/rag/collections/:id/documents/:documentId/chunks', async (req, reply) => {
    const { id, documentId } = req.params as { id: string; documentId: string };
    try {
      return s.rag.chunksOfDocument(id, documentId);
    } catch (err) {
      if (err instanceof RagError) return reply.code(404).send({ error: err.message });
      throw err;
    }
  });

  /* Rattrapage des vecteurs manquants, déclenché à la main : utile après avoir
     ajouté une clé d'API à une collection déjà indexée. */
  app.post('/api/rag/collections/:id/embed', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.rag.get(id)) return reply.code(404).send({ error: 'Collection introuvable.' });
    return await s.rag.backfillEmbeddings(id);
  });

  app.get('/api/settings', async () => s.store.getSettings());

  app.patch('/api/settings', async (req) => {
    const patch = parseOr400(settingsSchema, req.body);
    return s.store.patchSettings(patch);
  });

  // -- Fédération ------------------------------------------------------------

  app.get('/api/peers', async () => s.federation.list());

  app.post('/api/peers', async (req, reply) => {
    const input = parseOr400(peerSchema, req.body);
    reply.code(201);
    return badRequestOn(() => s.federation.create(input));
  });

  app.patch('/api/peers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = parseOr400(patchOf(peerSchema), req.body);
    const peer = badRequestOn(() => s.federation.update(id, patch));
    if (!peer) return reply.code(404).send({ error: 'Pair introuvable' });
    return peer;
  });

  app.delete('/api/peers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.federation.remove(id)) return reply.code(404).send({ error: 'Pair introuvable' });
    return { ok: true };
  });

  /** Vérifie joignabilité **et** jeton : les deux pannes de mise en place. */
  app.post('/api/peers/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const peer = await s.federation.test(id);
    if (!peer) return reply.code(404).send({ error: 'Pair introuvable' });
    return peer;
  });

  // -- Battement de cœur -----------------------------------------------------

  app.get('/api/heartbeat', async () => ({
    config: s.heartbeat.config(),
    nextBeatAt: s.heartbeat.nextBeatAt(),
    beats: s.heartbeat.beats(20),
  }));

  app.patch('/api/heartbeat', async (req) => {
    const patch = parseOr400(heartbeatSchema, req.body);
    /* Expression invalide et rythme trop rapproché remontent tous deux en 400
       avec leur motif : ce sont des règles
       métier, pas une panne, et l'opérateur doit savoir pourquoi son rythme est
       refusé. */
    return badRequestOn(() => s.heartbeat.update(patch));
  });

  /** État des lieux tel que l'agent le verra — pour juger avant d'activer. */
  app.get('/api/heartbeat/situation', async () => s.heartbeat.situation());

  app.post('/api/heartbeat/beat', async () => s.heartbeat.beat(true));

  registerProviderRoutes(app, {
    store: s.store,
    providers: s.providers,
    handoffs: s.handoffs,
  });
}
