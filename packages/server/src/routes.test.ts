/**
 * Tests de l'API HTTP.
 *
 * `routes.ts` est le fichier le plus exposé du serveur — validation des entrées,
 * codes de retour, refus — et il n'avait aucun test. On passe par `app.inject()`
 * de Fastify : la requête traverse le routage, les schémas et les gestionnaires
 * d'erreur réels, sans ouvrir de port ni de socket.
 *
 * Les services sont réels quand ils sont peu coûteux (Store en mémoire, Bus,
 * agents, skills) et remplacés par des doubles quand ils parleraient au réseau
 * ou au SDK. Ce qui est vérifié ici, c'est le contrat de l'API, pas l'exécution
 * d'un agent.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentService } from './agents.ts';
import { Bus } from './bus.ts';
import type { MaestroConfig } from './config.ts';
import { Store } from './db.ts';
import { TaskService } from './kanban.ts';
import { MaintenanceService } from './maintenance.ts';
import { registerRoutes, type Services } from './routes.ts';
import { SkillRegistry } from './skills.ts';
import { TrainingService } from './training.ts';
import type { RunEngine } from './runs.ts';

let dataDir: string;
let app: FastifyInstance;
let store: Store;

function makeConfig(dir: string): MaestroConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    dbPath: ':memory:',
    workspacesDir: join(dir, 'workspaces'),
    globalSkillsDir: join(dir, 'skills'),
    builtinSkillsDir: join(dir, 'builtin'),
    nativeSkillsDir: join(dir, 'native'),
    pluginsDir: join(dir, 'plugins'),
    claudeProjectsDir: join(dir, 'projects'),
    authToken: 'jeton-de-test',
    allowedOrigins: [],
    telegramBotToken: null,
    telegramChatIds: [],
    discordBotToken: null,
    discordChannelIds: [],
    slackAppToken: null,
    slackBotToken: null,
    slackChannelIds: [],
    version: '0.0.0-test',
  };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'maestro-routes-'));
  store = new Store(':memory:');
  const bus = new Bus(store);
  const config = makeConfig(dataDir);
  const agents = new AgentService(store, bus, config);
  const skills = new SkillRegistry(config, bus, () => agents.list(true));
  const tasks = new TaskService(store, bus);

  /*
   * Moteur de runs remplacé : démarrer un run lancerait une vraie session
   * Claude Code. Les routes testées ici ne font que le solliciter, elles ne
   * dépendent pas de ce qu'il produit.
   */
  const engine = {
    activeCount: () => 0,
    queuedCount: () => 0,
    start: () => {
      throw new Error('moteur indisponible en test');
    },
    cancel: () => false,
  } as unknown as RunEngine;

  const training = new TrainingService(store, bus, engine, agents);
  const maintenance = new MaintenanceService(store, bus, config);

  app = Fastify({ logger: false });
  registerRoutes(app, {
    config,
    store,
    bus,
    agents,
    skills,
    tasks,
    engine,
    training,
    maintenance,
    // Services non sollicités par les routes testées : un double vide suffit,
    // et une méthode manquante ferait échouer le test de façon lisible.
    approvals: {} as Services['approvals'],
    scheduler: {} as Services['scheduler'],
    pipelines: {} as Services['pipelines'],
    metrics: {} as Services['metrics'],
    connectors: {} as Services['connectors'],
    plugins: {} as Services['plugins'],
    mcp: {} as Services['mcp'],
    rag: {} as Services['rag'],
    radar: {} as Services['radar'],
    tmux: {} as Services['tmux'],
    providers: {} as Services['providers'],
    handoffs: {} as Services['handoffs'],
    heartbeat: {} as Services['heartbeat'],
    federation: {} as Services['federation'],
    telegramEnabled: false,
    startedAt: '2026-08-28T09:00:00.000Z',
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Raccourci de lecture : statut + corps déjà décodé. */
async function call(method: string, url: string, payload?: unknown) {
  const res = await app.inject({
    method: method as 'GET',
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  let body: unknown = null;
  try {
    body = res.json();
  } catch {
    body = res.body;
  }
  return { status: res.statusCode, body };
}

describe('santé', () => {
  it('répond sans jeton', async () => {
    const res = await call('GET', '/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('agents', () => {
  it('part d’une liste vide', async () => {
    const res = await call('GET', '/api/agents');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('crée un agent avec les valeurs par défaut', async () => {
    const res = await call('POST', '/api/agents', { name: 'Testeur' });
    expect(res.status).toBe(201);
    const agent = res.body as { id: string; engine: string; sandbox: unknown };
    expect(agent.id).toMatch(/^agt_/);
    expect(agent.engine).toBe('sdk');
    // 🔒 L'invariant du confinement : rien ne l'active tout seul.
    expect(agent.sandbox).toBeNull();
  });

  it('refuse un agent sans nom', async () => {
    expect((await call('POST', '/api/agents', {})).status).toBe(400);
  });

  it('refuse un nom vide', async () => {
    expect((await call('POST', '/api/agents', { name: '   ' })).status).toBe(400);
  });

  it('rend 404 sur un agent inconnu', async () => {
    expect((await call('GET', '/api/agents/agt_fantome')).status).toBe(404);
  });

  it('accepte un confinement complet et le relit', async () => {
    const created = await call('POST', '/api/agents', {
      name: 'Confiné',
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowedDomains: ['registry.npmjs.org'],
        strictAllowlist: true,
        allowWrite: ['/tmp/partage'],
        denyRead: ['~/.ssh'],
      },
    });
    expect(created.status).toBe(201);
    const { id } = created.body as { id: string };
    const read = (await call('GET', `/api/agents/${id}`)).body as {
      sandbox: { enabled: boolean; allowedDomains: string[] };
    };
    expect(read.sandbox.enabled).toBe(true);
    expect(read.sandbox.allowedDomains).toEqual(['registry.npmjs.org']);
  });

  it('refuse un confinement mal formé', async () => {
    const res = await call('POST', '/api/agents', {
      name: 'Bancal',
      sandbox: { enabled: 'oui' },
    });
    expect(res.status).toBe(400);
  });
});

describe('catalogue MCP', () => {
  it('expose le catalogue', async () => {
    const res = await call('GET', '/api/mcp-presets');
    expect(res.status).toBe(200);
    expect((res.body as unknown[]).length).toBeGreaterThan(5);
  });

  it('rend 404 sur un preset inconnu', async () => {
    const res = await call('POST', '/api/mcp-presets/fantome/install', {});
    expect(res.status).toBe(404);
  });

  /* 🔒 Une clé requise absente doit être refusée avec son nom, plutôt que de
     laisser déclarer un serveur qui échouera au premier appel. */
  it('refuse une installation sans les clés requises, en les nommant', async () => {
    const res = await call('POST', '/api/mcp-presets/browserbase/install', {});
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain('BROWSERBASE_API_KEY');
  });
});

describe('entraînement', () => {
  it('expose les onze dialectes', async () => {
    const res = await call('GET', '/api/training/dialects');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(11);
  });

  it('part sans aucun lot', async () => {
    expect((await call('GET', '/api/training/batches')).body).toEqual([]);
  });

  it('refuse un lot sans agent', async () => {
    const res = await call('POST', '/api/training/batches', {
      name: 'x',
      spec: { agentIds: [], promptTemplates: ['a'], samples: 1 },
    });
    expect(res.status).toBe(400);
  });

  it('refuse un agent inconnu, avec un message métier', async () => {
    const res = await call('POST', '/api/training/batches', {
      name: 'x',
      spec: { agentIds: ['agt_fantome'], promptTemplates: ['a'], samples: 1 },
    });
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain('introuvable');
  });

  /* La borne haute n'est pas décorative : une faute de frappe lancerait
     cinquante mille runs. */
  it('refuse un nombre d’échantillons hors bornes', async () => {
    const spec = { agentIds: ['a'], promptTemplates: ['a'], samples: 99_999 };
    expect((await call('POST', '/api/training/batches', { name: 'x', spec })).status).toBe(400);
  });

  it('rend 404 sur un lot inconnu', async () => {
    expect((await call('GET', '/api/training/batches/tbatch_fantome')).status).toBe(404);
  });

  it('rend un aperçu d’export vide sans run', async () => {
    const res = await call('POST', '/api/training/export/preview', { format: 'sharegpt' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 0, format: 'sharegpt', dialect: 'hermes' });
  });

  it('refuse un format d’export inconnu', async () => {
    expect((await call('POST', '/api/training/export/preview', { format: 'parquet' })).status).toBe(
      400,
    );
  });

  it('rend 404 sur la trajectoire d’un run inconnu', async () => {
    expect((await call('GET', '/api/training/runs/run_fantome/trajectory')).status).toBe(404);
  });

  it('télécharge un JSONL vide en x-ndjson', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/training/export',
      payload: { format: 'sharegpt' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/x-ndjson');
    expect(res.headers['content-disposition']).toContain('.jsonl');
  });
});

describe('skills', () => {
  it('exporte une skill au format ouvert', async () => {
    await call('PUT', '/api/skills', {
      scope: 'global',
      slug: 'essai',
      name: 'Essai',
      description: 'Une skill de test',
      content: 'Corps de la skill.',
    });
    const res = await app.inject({ method: 'GET', url: '/api/skills/export?id=global:essai' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.body).toContain('name: Essai');
    expect(res.body).toContain('Corps de la skill.');
  });

  it('rend 400 sans identifiant et 404 sur une skill inconnue', async () => {
    expect((await call('GET', '/api/skills/export')).status).toBe(400);
    expect((await call('GET', '/api/skills/export?id=global:fantome')).status).toBe(404);
  });
});

describe('réglages', () => {
  it('rend les valeurs par défaut, confinement de capture compris', async () => {
    const res = await call('GET', '/api/settings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ maxConcurrentRuns: 4, fullTrajectoryCapture: false });
  });

  it('applique une modification partielle sans écraser le reste', async () => {
    await call('PATCH', '/api/settings', { fullTrajectoryCapture: true });
    const res = await call('GET', '/api/settings');
    expect(res.body).toMatchObject({ fullTrajectoryCapture: true, maxConcurrentRuns: 4 });
  });

  it('refuse une valeur hors bornes', async () => {
    expect((await call('PATCH', '/api/settings', { maxConcurrentRuns: 999 })).status).toBe(400);
  });
});
