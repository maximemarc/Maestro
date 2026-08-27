/**
 * Assemblage de Maestro : services, HTTP et WebSocket.
 *
 * Chargé dynamiquement par `index.ts`, après le contrôle de version de Node —
 * voir l'explication là-bas.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { RUN_INTERRUPTED_BY_RESTART, type ServerEvent } from '@maestro/shared';
import { AgentService } from './agents.ts';
import { Bus } from './bus.ts';
import { loadConfig } from './config.ts';
import { ConnectorRegistry } from './connectors.ts';
import { Store } from './db.ts';
import { TaskService } from './kanban.ts';
import { Metrics } from './metrics.ts';
import { ApprovalBroker } from './permissions.ts';
import { PipelineService } from './pipelines.ts';
import { registerMcpGateway } from './mcp-http.ts';
import { McpRegistry } from './mcp-registry.ts';
import { PluginService } from './plugins.ts';
import { RagService } from './rag.ts';
import { SessionRadar } from './radar.ts';
import { registerRoutes } from './routes.ts';
import { RunEngine } from './runs.ts';
import { Scheduler } from './scheduler.ts';
import { SkillRegistry } from './skills.ts';
import { TelegramBot } from './telegram.ts';
import { TmuxBridge } from './tmux.ts';
import { nowIso } from './util.ts';

const config = loadConfig();
const store = new Store(config.dbPath);
const bus = new Bus(store);
const startedAt = nowIso();

// Les runs restés « actifs » après un arrêt brutal sont clôturés proprement.
const stale = store.failStaleActiveRuns(RUN_INTERRUPTED_BY_RESTART);
if (stale > 0) bus.log('warn', 'server', `${stale} run(s) orphelin(s) clôturé(s) au démarrage`);

// Une approbation en attente n'a plus personne à débloquer : la promesse qui la
// suspendait est morte avec le processus précédent. La laisser « pending » la
// rendrait actionnable dans l'UI sans aucun effet.
const orphanApprovals = store.expireOldApprovals(nowIso());
if (orphanApprovals.length > 0) {
  bus.log(
    'warn',
    'server',
    `${orphanApprovals.length} approbation(s) orpheline(s) expirée(s) au démarrage`,
  );
}

const agents = new AgentService(store, bus, config);
const skills = new SkillRegistry(config, bus, () => agents.list(true));
const approvals = new ApprovalBroker(store, bus, () => store.getSettings().approvalTimeoutSec);
const tasks = new TaskService(store, bus);
const tmux = new TmuxBridge();
const pluginService = new PluginService(config, store, bus);
const mcpRegistry = new McpRegistry(store, bus);
const ragService = new RagService(store, bus, agents);
const engine = new RunEngine(
  store,
  bus,
  config,
  agents,
  skills,
  approvals,
  tasks,
  tmux,
  pluginService,
  mcpRegistry,
  ragService,
);
const scheduler = new Scheduler(store, bus, engine);
const pipelines = new PipelineService(store, bus, engine);
const telegram = new TelegramBot(config, store, bus, engine, agents, approvals);
const connectors = new ConnectorRegistry();
const radar = new SessionRadar(config, store, bus, agents);

skills.syncAllWorkspaces();
scheduler.init();
telegram.start();

// ---------------------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------------------

const app = Fastify({ logger: false });
const wsClients = new Set<{ send: (data: string) => void }>();
const metrics = new Metrics(store, bus, engine, () => wsClients.size);

/*
 * CORS restreint à une liste d'origines.
 *
 * L'interface est servie par ce serveur et le dev passe par le proxy Vite :
 * aucun appel d'origine croisée n'est nécessaire. `MAESTRO_ALLOWED_ORIGINS`
 * ouvre la liste pour l'installation qui sert le front ailleurs. Les appels
 * sans en-tête `Origin` (curl, clients MCP, Telegram) ne sont pas concernés :
 * CORS est une politique de navigateur.
 */
await app.register(fastifyCors, {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    cb(null, config.allowedOrigins.includes(origin));
  },
});
await app.register(fastifyWebsocket);

/*
 * Authentification : jeton requis sur /api/*, /mcp et /ws.
 *
 * Le jeton en paramètre de requête est réservé à /ws, et à lui seul. L'API des
 * navigateurs ne permet pas d'en-tête sur une connexion WebSocket, donc le
 * paramètre y est incontournable ; partout ailleurs il ne servait à rien et
 * faisait fuir le secret dans les journaux du serveur, ceux du reverse proxy et
 * l'historique du navigateur.
 */
const isAuthorized = (
  req: { headers: Record<string, unknown>; query: unknown },
  allowQueryToken: boolean,
): boolean => {
  const header = req.headers['authorization'];
  if (typeof header === 'string' && header === `Bearer ${config.authToken}`) return true;
  if (!allowQueryToken) return false;
  const token = (req.query as { token?: string } | undefined)?.token;
  return token === config.authToken;
};

app.addHook('onRequest', async (req, reply) => {
  const url = req.raw.url ?? '';
  const isWebSocket = url.startsWith('/ws');
  const isGateway = url.startsWith('/mcp');
  if (!isWebSocket && !isGateway && !url.startsWith('/api/')) return;
  if (url.startsWith('/api/health')) return;
  if (isAuthorized(req, isWebSocket)) return;
  // Un client MCP ne sait lire qu'une enveloppe JSON-RPC : lui répondre dans sa
  // langue lui permet d'afficher la cause au lieu d'un « erreur inconnue ».
  if (isGateway) {
    return reply.code(401).send({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Jeton invalide ou manquant' },
      id: null,
    });
  }
  return reply.code(401).send({ error: 'Jeton invalide ou manquant' });
});

app.register(async (scope) => {
  scope.get('/ws', { websocket: true }, (socket) => {
    wsClients.add(socket);
    const hello: ServerEvent = {
      type: 'hello',
      payload: {
        server: {
          version: config.version,
          startedAt,
          dataDir: config.dataDir,
          telegramEnabled: telegram.enabled,
          tmuxAvailable: false,
        },
        metrics: metrics.snapshot(),
      },
    };
    socket.send(JSON.stringify(hello));
    socket.on('close', () => wsClients.delete(socket));
    socket.on('error', () => wsClients.delete(socket));
  });
});

bus.subscribe((event) => {
  if (wsClients.size === 0) return;
  const data = JSON.stringify(event);
  for (const client of wsClients) {
    try {
      client.send(data);
    } catch {
      // Socket fermé entre-temps : le handler close s'en charge.
    }
  }
});

registerRoutes(app, {
  config,
  store,
  bus,
  agents,
  skills,
  approvals,
  tasks,
  engine,
  scheduler,
  pipelines,
  metrics,
  connectors,
  plugins: pluginService,
  mcp: mcpRegistry,
  rag: ragService,
  radar,
  tmux,
  telegramEnabled: telegram.enabled,
  startedAt,
});

/*
 * Passerelle MCP : les outils Maestro pour les clients tiers (Codex, OpenCode,
 * Goose…). Déclarée après les routes REST et avant le front statique, dont le
 * repli SPA capterait autrement /mcp.
 */
registerMcpGateway(app, {
  rag: ragService,
  agents,
  bus,
  listServers: () => mcpRegistry.listRaw(),
  version: config.version,
});

// Front statique (build de production) avec repli SPA.
const webDist = new URL('../../web/dist', import.meta.url).pathname;
if (existsSync(join(webDist, 'index.html'))) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/' });
  app.setNotFoundHandler((req, reply) => {
    if (
      req.raw.url?.startsWith('/api/') ||
      req.raw.url?.startsWith('/ws') ||
      req.raw.url?.startsWith('/mcp')
    ) {
      return reply.code(404).send({ error: 'Introuvable' });
    }
    return reply.sendFile('index.html');
  });
}

metrics.start();
radar.start();

const shutdown = async (): Promise<void> => {
  bus.log('warn', 'server', 'Arrêt de Maestro…');
  metrics.stop();
  radar.stop();
  scheduler.shutdown();
  telegram.stop();
  engine.shutdown();
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  bus.log('success', 'server', `Maestro v${config.version} démarré sur le port ${config.port}`);
  console.log(`\n  🎛  Maestro v${config.version}`);
  console.log(`  ➜  Interface : http://localhost:${config.port}`);
  console.log(`  ➜  Jeton     : ${config.authToken}`);
  console.log(`  ➜  Données   : ${config.dataDir}`);
  console.log(`  ➜  MCP       : http://localhost:${config.port}/mcp (Bearer)`);
  console.log(
    `  ➜  Telegram  : ${telegram.enabled ? 'actif' : 'inactif (TELEGRAM_BOT_TOKEN absent)'}\n`,
  );
} catch (err) {
  console.error('Démarrage impossible :', err);
  process.exit(1);
}
