/**
 * Routes des fournisseurs : comptes, politiques de résilience, sondes,
 * assistant de configuration, tentatives et résumés de reprise.
 *
 * Module à part de `routes.ts`, qui approche déjà 1 200 lignes. Le découpage
 * suit le domaine, pas la taille : ces routes partagent un vocabulaire et des
 * schémas de validation qui ne servent qu'ici.
 *
 * 🔒 Invariant de ce fichier : **aucune valeur de secret ne traverse l'API.**
 * Un compte expose le *nom* de la variable d'environnement qui porte sa clé,
 * jamais son contenu. Les sondes rendent la liste des noms définis, ce qui
 * suffit à composer un formulaire sans rien divulguer.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ONBOARDING_STEPS, PROVIDER_CAPABILITIES, PROVIDER_KINDS } from '@maestro/shared';
import type { ProviderAccountCreate, ResiliencePolicyCreate } from '@maestro/shared';
import type { Store } from './db.ts';
import type { HandoffService } from './providers/handoff.ts';
import { emptyAccount, type ProviderService } from './providers/registry.ts';

const kindSchema = z.enum(PROVIDER_KINDS as unknown as [string, ...string[]]);

/** Une carte clé/valeur pour les variables non secrètes d'un compte. */
const envSchema = z.record(z.string().min(1).max(200), z.string().max(4000));

const accountSchema = z.object({
  name: z.string().min(1).max(120),
  kind: kindSchema,
  enabled: z.boolean().default(true),
  authMode: z.enum(['profile', 'api-key-env', 'inherit']).default('inherit'),
  configDir: z.string().max(500).nullable().default(null),
  /*
   * Le NOM d'une variable d'environnement, jamais sa valeur. Le motif l'impose
   * : accepter une chaîne libre inviterait à coller la clé elle-même, qui
   * partirait alors en base et dans le journal des requêtes.
   */
  apiKeyEnv: z
    .string()
    .regex(
      /^[A-Z][A-Z0-9_]{2,80}$/,
      'Nom de variable d’environnement attendu (MAJUSCULES_ET_TIRETS_BAS)',
    )
    .nullable()
    .default(null),
  baseUrl: z.string().url().max(500).nullable().default(null),
  apiFlavor: z.enum(['anthropic', 'openai']).nullable().default(null),
  model: z.string().max(120).nullable().default(null),
  command: z.string().max(300).nullable().default(null),
  args: z.array(z.string().max(4000)).max(40).nullable().default(null),
  env: envSchema.default({}),
  priority: z.number().int().min(0).max(10_000).default(100),
  dailyCostLimitUsd: z.number().min(0).max(100_000).nullable().default(null),
});

const targetSchema = z.object({
  accountId: z.string().min(1),
  model: z.string().max(120).nullable().default(null),
});

const policySchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  targets: z.array(targetSchema).max(20).default([]),
  maxAttemptsPerTarget: z.number().int().min(1).max(10).default(2),
  maxTotalAttempts: z.number().int().min(1).max(30).default(4),
  backoffInitialMs: z.number().int().min(0).max(600_000).default(2000),
  backoffFactor: z.number().min(1).max(10).default(3),
  backoffMaxMs: z.number().int().min(0).max(3_600_000).default(60_000),
  backoffJitter: z.boolean().default(true),
  quotaWaitMaxSec: z.number().int().min(0).max(86_400).default(900),
  switchOnError: z.boolean().default(true),
  handoffThresholdPct: z.number().int().min(0).max(100).default(80),
});

const onboardingSchema = z.object({
  step: z.enum(ONBOARDING_STEPS as unknown as [string, ...string[]]).optional(),
  completed: z.boolean().optional(),
  skipped: z.array(z.enum(ONBOARDING_STEPS as unknown as [string, ...string[]])).optional(),
});

const profileSchema = z.object({ slug: z.string().min(1).max(60) });

export interface ProviderRouteServices {
  store: Store;
  providers: ProviderService;
  handoffs: HandoffService;
}

function parseOr400<T>(schema: z.ZodType<T>, body: unknown): T {
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

/** Rend chaque champ optionnel et retire les valeurs par défaut. */
function patchOf<T extends z.ZodRawShape>(schema: z.ZodObject<T>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [key, rawField] of Object.entries(schema.shape)) {
    const field = rawField as z.ZodType;
    shape[key] = (
      field instanceof z.ZodDefault ? (field.removeDefault() as z.ZodType) : field
    ).optional();
  }
  return z.object(shape);
}

export function registerProviderRoutes(app: FastifyInstance, s: ProviderRouteServices): void {
  // -- Catalogue -------------------------------------------------------------

  /**
   * Ce que chaque fournisseur sait faire. Le front s'en sert pour prévenir
   * avant qu'un opérateur ne route un agent en `guarded` vers un moteur qui
   * n'applique aucune permission.
   */
  app.get('/api/providers/capabilities', async () =>
    PROVIDER_KINDS.map((kind) => ({ kind, ...PROVIDER_CAPABILITIES[kind] })),
  );

  /** Sonde de la machine : binaires, versions, profils, variables définies. */
  app.get('/api/providers/probe', async () => s.providers.probeAll());

  /** Gabarit d'un compte vierge — évite au front de dupliquer les valeurs par défaut. */
  app.get('/api/providers/template/:kind', async (req, reply) => {
    const { kind } = req.params as { kind: string };
    const parsed = kindSchema.safeParse(kind);
    if (!parsed.success) return reply.code(404).send({ error: 'Fournisseur inconnu' });
    return emptyAccount(parsed.data as ProviderAccountCreate['kind']);
  });

  // -- Comptes ---------------------------------------------------------------

  app.get('/api/providers/accounts', async () => s.providers.listAccounts());

  app.post('/api/providers/accounts', async (req, reply) => {
    const input = parseOr400(accountSchema, req.body);
    reply.code(201);
    return s.providers.createAccount(input as ProviderAccountCreate);
  });

  app.patch('/api/providers/accounts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = parseOr400(patchOf(accountSchema), req.body);
    const account = s.providers.updateAccount(id, patch as Partial<ProviderAccountCreate>);
    if (!account) return reply.code(404).send({ error: 'Compte introuvable' });
    return account;
  });

  app.delete('/api/providers/accounts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.providers.deleteAccount(id))
      return reply.code(404).send({ error: 'Compte introuvable' });
    return { ok: true };
  });

  /** Test léger, sans appel facturable : présence, authentification, variable. */
  app.post('/api/providers/accounts/:id/test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const account = await s.providers.testAccount(id);
    if (!account) return reply.code(404).send({ error: 'Compte introuvable' });
    return account;
  });

  /**
   * Prépare un profil d'abonnement et rend la commande de connexion.
   *
   * Maestro ne lance pas `claude auth login` : cette commande ouvre un
   * navigateur et attend un code. La faire exécuter par le serveur laisserait
   * un processus interactif suspendu sans personne pour y répondre.
   */
  app.post('/api/providers/profiles', async (req) => {
    const { slug } = parseOr400(profileSchema, req.body);
    return s.providers.prepareProfile(slug);
  });

  /** Comptes déduits de la machine, à confirmer par l'opérateur. */
  app.get('/api/providers/suggestions', async () => s.providers.suggestAccounts());

  // -- Politiques ------------------------------------------------------------

  app.get('/api/providers/policies', async () => s.providers.listPolicies());

  app.post('/api/providers/policies', async (req, reply) => {
    const input = parseOr400(policySchema, req.body);
    reply.code(201);
    return s.providers.createPolicy(input as ResiliencePolicyCreate);
  });

  app.patch('/api/providers/policies/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const patch = parseOr400(patchOf(policySchema), req.body);
    const policy = s.providers.updatePolicy(id, patch as Partial<ResiliencePolicyCreate>);
    if (!policy) return reply.code(404).send({ error: 'Politique introuvable' });
    return policy;
  });

  app.delete('/api/providers/policies/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!s.providers.deletePolicy(id))
      return reply.code(404).send({ error: 'Politique introuvable' });
    /* Une politique supprimée qui restait la politique par défaut aurait laissé
       chaque run chercher une référence morte à chaque démarrage. */
    if (s.store.getSettings().defaultResiliencePolicyId === id) {
      s.store.patchSettings({ defaultResiliencePolicyId: null });
    }
    return { ok: true };
  });

  // -- Tentatives & handoffs -------------------------------------------------

  app.get('/api/runs/:id/attempts', async (req) => {
    const { id } = req.params as { id: string };
    return s.store.listRunAttempts(id);
  });

  app.get('/api/handoffs', async (req) => {
    const { agentId, limit } = req.query as { agentId?: string; limit?: string };
    const parsed = Number(limit);
    return s.store.listHandoffs(agentId, Number.isFinite(parsed) ? Math.min(parsed, 200) : 50);
  });

  app.get('/api/handoffs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const handoff = s.store.getHandoff(id);
    if (!handoff) return reply.code(404).send({ error: 'Résumé introuvable' });
    return handoff;
  });

  // -- Assistant de configuration -------------------------------------------

  app.get('/api/onboarding', async () => {
    const state = s.store.getOnboarding();
    return {
      state,
      accounts: s.providers.listAccounts().length,
      policies: s.providers.listPolicies().length,
    };
  });

  app.patch('/api/onboarding', async (req) => {
    const patch = parseOr400(onboardingSchema, req.body);
    const next = {
      ...patch,
      ...(patch.completed === true
        ? { completedAt: new Date().toISOString(), step: 'done' as const }
        : {}),
    };
    return s.store.patchOnboarding(next as Parameters<Store['patchOnboarding']>[0]);
  });
}
