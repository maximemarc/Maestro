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
import { authorize, deniedBody } from './auth.ts';
import { makeIdentityResolver } from './identity.ts';
import { Bus } from './bus.ts';
import { loadConfig } from './config.ts';
import { ConnectorRegistry } from './connectors.ts';
import { Store } from './db.ts';
import { createSecretBox } from './secrets.ts';
import { TaskService } from './kanban.ts';
import { Metrics } from './metrics.ts';
import { ApprovalBroker } from './permissions.ts';
import { PipelineService } from './pipelines.ts';
import { HeartbeatService } from './heartbeat.ts';
import { FederationService } from './federation.ts';
import { ExternalSessionService } from './mcp-external.ts';
import { registerMcpGateway } from './mcp-http.ts';
import { McpRegistry } from './mcp-registry.ts';
import { PluginService } from './plugins.ts';
import { HandoffService } from './providers/handoff.ts';
import { ProviderService } from './providers/registry.ts';
import { RagService } from './rag.ts';
import { SessionRadar } from './radar.ts';
import { registerRoutes } from './routes.ts';
import { RunEngine } from './runs.ts';
import { Scheduler } from './scheduler.ts';
import { SkillRegistry } from './skills.ts';
import { ChannelRegistry } from './channels/registry.ts';
import { DiscordChannel } from './channels/discord.ts';
import { SlackChannel } from './channels/slack.ts';
import { TelegramChannel } from './channels/telegram.ts';
import { WebhookChannel, webhookConfigFromEnv } from './channels/webhook.ts';
import { MaintenanceService } from './maintenance.ts';
import { TmuxBridge } from './tmux.ts';
import { TrainingService } from './training.ts';
import { nowIso } from './util.ts';

const config = loadConfig();
/*
 * 🔒 Les secrets des serveurs MCP sont chiffrés en base, avec une clé conservée
 * dans un fichier séparé. Séparer la clé de la base est l'essentiel : les deux
 * ne voyagent pas ensemble, et une sauvegarde copiée ne suffit plus à divulguer
 * les jetons qu'elle contient.
 */
const store = new Store(config.dbPath, createSecretBox(config.dataDir));
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
const providers = new ProviderService(store, bus, config);
const handoffs = new HandoffService(store, bus, providers);
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
  providers,
  handoffs,
);
const externalSessions = new ExternalSessionService(store, bus);
const heartbeat = new HeartbeatService({ store, bus, agents, engine, providers });
/* Branchée après le moteur : celui-ci en a besoin pour ses outils de contrôle,
   et la passer au constructeur créerait une dépendance circulaire. */
const federation = new FederationService(store, bus);
engine.attachFederation(federation);
const scheduler = new Scheduler(store, bus, engine);
const pipelines = new PipelineService(store, bus, engine);
const training = new TrainingService(store, bus, engine, agents);
const maintenance = new MaintenanceService(store, bus, config);
/*
 * Les canaux passent par un registre : un seul abonnement au bus, une seule
 * règle « faut-il notifier ». Les passerelles s'abonnaient chacune de son côté,
 * avec sa propre version de la règle — et les versions avaient divergé.
 */
const channels = new ChannelRegistry(
  [
    new TelegramChannel(config, store, bus, engine, agents, approvals),
    new SlackChannel(config, store, bus, engine, agents),
    new DiscordChannel(config, store, bus, engine, agents, approvals),
    new WebhookChannel(webhookConfigFromEnv(), bus),
  ],
  bus,
  { store, agents },
);
const connectors = new ConnectorRegistry();
const radar = new SessionRadar(config, store, bus, agents);

skills.syncAllWorkspaces();
scheduler.init();
channels.start();
externalSessions.start();
heartbeat.start();
/*
 * Après `failStaleActiveRuns` : les runs orphelins sont déjà clôturés, la
 * reprise voit donc des échantillons dont le run est bel et bien terminé et
 * peut les remettre en file sans risquer de les compter deux fois.
 */
training.resumeInterrupted();
/*
 * Entretien : un passage au démarrage, puis toutes les six heures. Sans
 * rétention configurée il ne supprime rien — c'est un réglage qu'on active en
 * connaissance de cause.
 */
maintenance.start();

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
 * La décision elle-même vit dans `auth.ts`, avec ses tests — elle était ici, au
 * milieu de l'assemblage, où rien ne pouvait la vérifier, alors que c'est le
 * seul rempart entre l'extérieur et le lancement d'agents.
 */
const resolveIdentity = makeIdentityResolver(store, config.authToken);

app.addHook('onRequest', async (req, reply) => {
  const outcome = authorize(
    { url: req.raw.url ?? '', headers: req.headers, query: req.query },
    resolveIdentity,
  );
  if (outcome.kind === 'denied') {
    return reply.code(401).send(deniedBody(outcome.shape));
  }
  /*
   * L'identité suit la requête jusqu'à ses effets. C'est elle qui permet de
   * dire qui a approuvé quoi — « web » disait par où, jamais par qui.
   */
  if (outcome.kind === 'allowed') {
    (req as { identity?: unknown }).identity = outcome.identity;
  }
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
          telegramEnabled: channels.enabled,
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
  training,
  maintenance,
  metrics,
  connectors,
  plugins: pluginService,
  mcp: mcpRegistry,
  rag: ragService,
  radar,
  tmux,
  providers,
  handoffs,
  heartbeat,
  federation,
  telegramEnabled: channels.enabled,
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
  /* Lot A2 : les clients tiers accèdent au kanban, à la délégation et à la
     mémoire, sous une session visible et avec de vraies approbations. */
  control: {
    tasks,
    agents,
    bus,
    engine,
    skills,
    maxAgentDepth: () => store.getSettings().maxAgentDepth,
  },
  sessions: externalSessions,
  approvals,
});

// Front statique (build de production) avec repli SPA.
const webDist = new URL('../../web/dist', import.meta.url).pathname;
if (existsSync(join(webDist, 'index.html'))) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/' });
  app.setNotFoundHandler((req, reply) => {
    if (
      req.raw.url?.startsWith('/api/') ||
      req.raw.url?.startsWith('/ws') ||
      req.raw.url?.startsWith('/mcp') ||
      req.raw.url?.startsWith('/hooks/')
    ) {
      return reply.code(404).send({ error: 'Introuvable' });
    }
    return reply.sendFile('index.html');
  });
}

metrics.start();
radar.start();

/**
 * Arrêt propre, et une seule fois.
 *
 * Le garde d'idempotence compte dès que Maestro tourne comme service : un
 * gestionnaire de service qui redémarre envoie SIGTERM puis, s'il trouve le
 * processus encore vivant, recommence. Sans ce garde, la seconde passe fermait
 * une base déjà fermée et transformait un arrêt propre en plantage — donc en
 * redémarrage compté comme un échec.
 */
let stopping = false;
const shutdown = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  bus.log('warn', 'server', 'Arrêt de Maestro…');
  metrics.stop();
  radar.stop();
  scheduler.shutdown();
  channels.stop();
  // Avant l'arrêt du moteur : les lots cessent de dépiler, et restent marqués
  // « running » pour reprendre au prochain démarrage.
  training.shutdown();
  maintenance.stop();
  engine.shutdown();
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

try {
  await app.listen({ port: config.port, host: config.host });
  bus.log('success', 'server', `Maestro v${config.version} démarré sur le port ${config.port}`);
  console.log(`\n  🎛  Maestro v${config.version}`);
  console.log(`  ➜  Interface : http://localhost:${config.port}`);
  /*
   * Le jeton ne s'affiche qu'en lancement interactif.
   *
   * Constaté en installant Maestro comme service : la bannière part dans le
   * journal systemd, qui est persistant et lisible au-delà de l'utilisateur
   * courant. Un secret d'accès complet à l'API n'a rien à y faire. Sur un
   * terminal, l'afficher reste ce qu'on veut — c'est même le seul moment où on
   * en a besoin.
   */
  if (process.stdout.isTTY) {
    console.log(`  ➜  Jeton     : ${config.authToken}`);
  } else {
    console.log(`  ➜  Jeton     : dans ${join(config.dataDir, 'token')} (masqué hors terminal)`);
  }
  console.log(`  ➜  Données   : ${config.dataDir}`);
  console.log(`  ➜  MCP       : http://localhost:${config.port}/mcp (Bearer)`);
  const active = channels.list();
  console.log(
    `  ➜  Canaux    : ${active.length > 0 ? active.map((c) => c.label).join(', ') : 'aucun (TELEGRAM_BOT_TOKEN et MAESTRO_WEBHOOK_URL absents)'}\n`,
  );
} catch (err) {
  console.error('Démarrage impossible :', err);
  process.exit(1);
}
