/**
 * Contrat et outillage communs aux modules de routes.
 *
 * `routes.ts` dépassait mille six cents lignes et mélangeait dix-neuf domaines.
 * Le découpage se fait par domaine, chaque module recevant l'application et les
 * services — mais tous ont besoin des mêmes trois choses : le type des services,
 * la validation qui répond 400, et la fabrique de schéma partiel. Elles vivent
 * donc ici plutôt que d'être réimportées d'un module de routes vers un autre,
 * ce qui recréerait un couplage circulaire.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentService } from './agents.ts';
import type { Bus } from './bus.ts';
import type { MaestroConfig } from './config.ts';
import type { ConnectorRegistry } from './connectors.ts';
import type { Store } from './db.ts';
import type { TaskService } from './kanban.ts';
import type { MaintenanceService } from './maintenance.ts';
import type { McpRegistry } from './mcp-registry.ts';
import type { Metrics } from './metrics.ts';
import type { ApprovalBroker } from './permissions.ts';
import type { PipelineService } from './pipelines.ts';
import type { PluginService } from './plugins.ts';
import type { RagService } from './rag.ts';
import type { SessionRadar } from './radar.ts';
import type { RunEngine } from './runs.ts';
import type { Scheduler } from './scheduler.ts';
import type { SkillRegistry } from './skills.ts';
import type { TmuxBridge } from './tmux.ts';
import type { TrainingService } from './training.ts';

export interface Services {
  config: MaestroConfig;
  store: Store;
  bus: Bus;
  agents: AgentService;
  skills: SkillRegistry;
  approvals: ApprovalBroker;
  tasks: TaskService;
  engine: RunEngine;
  scheduler: Scheduler;
  pipelines: PipelineService;
  training: TrainingService;
  maintenance: MaintenanceService;
  metrics: Metrics;
  connectors: ConnectorRegistry;
  plugins: PluginService;
  mcp: McpRegistry;
  rag: RagService;
  radar: SessionRadar;
  tmux: TmuxBridge;
  telegramEnabled: boolean;
  startedAt: string;
}

/** Signature d'un module de routes : il reçoit l'application et les services. */
export type RouteModule = (app: FastifyInstance, s: Services) => void;

/**
 * Une carte clé/valeur libre, pour les variables d'environnement et les
 * en-têtes. Les clés sont bornées pour éviter qu'un client n'envoie un objet
 * arbitrairement large, mais les valeurs restent libres : un jeton est opaque.
 */
export const keyValueSchema = z.record(z.string().min(1).max(200), z.string().max(4000));

/**
 * Schéma de mise à jour partielle : chaque champ devient optionnel ET perd sa
 * valeur par défaut.
 *
 * `.partial()` seul ne suffit pas — zod applique quand même les defaults des
 * champs absents, si bien qu'un PATCH `{ archived: true }` renverrait aussi
 * `model: 'sonnet'`, `cliAgent: null`, `color: '#22d3ee'`… et écraserait la
 * configuration de l'agent. Ici, un champ absent de la requête reste absent du
 * patch, donc inchangé côté service.
 */
export function patchOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, rawField] of Object.entries(schema.shape)) {
    const field = rawField as z.ZodType;
    shape[key] = (
      field instanceof z.ZodDefault ? (field.removeDefault() as z.ZodType) : field
    ).optional();
  }
  return z.object(shape);
}

/** Exécute un appel de service dont les erreurs sont des erreurs de validation métier (→ 400). */
export function badRequestOn<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const wrapped = new Error(err instanceof Error ? err.message : String(err));
    (wrapped as Error & { statusCode?: number }).statusCode = 400;
    throw wrapped;
  }
}

export function parseOr400<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const err = new Error(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' ; '),
    );
    (err as Error & { statusCode?: number }).statusCode = 400;
    throw err;
  }
  return parsed.data;
}
