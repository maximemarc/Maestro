/**
 * Passerelle Discord — WebSocket Gateway v10, sans dépendance.
 *
 * Le protocole tient en quatre messages : le serveur envoie HELLO avec un
 * intervalle de battement, on répond IDENTIFY, puis on bat la mesure et on reçoit
 * des événements. Une bibliothèque complète (discord.js pèse plusieurs Mo et
 * traîne un cache d'objets) n'apporterait rien ici : on lit des messages et on
 * en poste, c'est tout.
 *
 * ⚠️ `MESSAGE_CONTENT` est un intent privilégié : il doit être activé dans le
 * portail développeur de l'application, sinon le contenu des messages arrive
 * vide et la passerelle semble sourde sans qu'aucune erreur ne le dise. C'est
 * le piège le plus coûteux de cette intégration, d'où le contrôle explicite
 * ci-dessous.
 *
 * 🔒 Comme pour Telegram, la liste blanche de canaux est stricte : sans
 * `DISCORD_CHANNEL_IDS`, la passerelle ne démarre pas. Un bot qui répond partout
 * exécute des agents pour n'importe qui.
 */
import type { Approval, Run } from '@maestro/shared';
import type { AgentService } from './agents.ts';
import type { Bus } from './bus.ts';
import type { MaestroConfig } from './config.ts';
import type { Store } from './db.ts';
import type { ApprovalBroker } from './permissions.ts';
import type { RunEngine } from './runs.ts';
import {
  executeChatCommand,
  parseChatCommand,
  renderMarkdown,
  type ChatDeps,
} from './chat-commands.ts';
import { truncate } from './util.ts';

const API = 'https://discord.com/api/v10';
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';

/** Opcodes employés — le protocole en compte davantage, inutiles ici. */
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

/**
 * Intents demandés.
 *
 * GUILD_MESSAGES (1 << 9) pour recevoir les messages de salon, MESSAGE_CONTENT
 * (1 << 15) pour en lire le texte, DIRECT_MESSAGES (1 << 12) pour les messages
 * privés. Rien de plus : demander la liste des membres ou les présences ferait
 * transiter des données personnelles dont Maestro n'a aucun usage.
 */
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

/** Reconnexion : progression géométrique bornée, pour ne pas marteler l'API. */
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

interface DiscordPayload {
  op: number;
  d?: unknown;
  t?: string | null;
  s?: number | null;
}

export class DiscordBot {
  private socket: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private sequence: number | null = null;
  private stopped = false;
  /** Vrai dès qu'un message non vide est reçu — sert au diagnostic d'intent. */
  private sawContent = false;
  private emptyMessages = 0;

  readonly enabled: boolean;

  constructor(
    private config: MaestroConfig,
    private store: Store,
    private bus: Bus,
    private engine: RunEngine,
    private agents: AgentService,
    private approvals: ApprovalBroker,
  ) {
    this.enabled = Boolean(config.discordBotToken && config.discordChannelIds.length > 0);
  }

  start(): void {
    if (!this.enabled) {
      if (this.config.discordBotToken && this.config.discordChannelIds.length === 0) {
        // 🔒 Le jeton sans liste blanche est le cas dangereux : le signaler plutôt
        // que de rester muet, sinon on croit la passerelle active.
        this.bus.log(
          'warn',
          'discord',
          'Jeton Discord présent mais DISCORD_CHANNEL_IDS vide : passerelle inactive. ' +
            'La liste blanche est obligatoire.',
        );
      }
      return;
    }
    this.stopped = false;
    this.connect();

    this.bus.subscribe((event) => {
      if (event.type === 'approval.requested') void this.notifyApproval(event.payload);
      if (event.type === 'run.updated' && event.payload.endedAt)
        void this.notifyRunEnd(event.payload);
    });
    this.bus.log(
      'success',
      'discord',
      `Passerelle Discord active (${this.config.discordChannelIds.length} salon(s))`,
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeat = null;
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  // -- Connexion -------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(GATEWAY);
    this.socket = socket;

    socket.addEventListener('message', (event) => {
      let payload: DiscordPayload;
      try {
        payload = JSON.parse(String(event.data)) as DiscordPayload;
      } catch {
        return;
      }
      void this.handlePayload(payload);
    });

    socket.addEventListener('close', (event) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      if (this.stopped) return;
      /*
       * 4014 = intents refusés, 4004 = jeton invalide. Ces deux causes ne se
       * résolvent pas en réessayant : reconnecter en boucle noierait les
       * journaux sans jamais aboutir.
       */
      if (event.code === 4014 || event.code === 4004) {
        this.bus.log(
          'error',
          'discord',
          event.code === 4014
            ? 'Discord a refusé les intents. Active « Message Content Intent » dans le portail développeur de l’application.'
            : 'Jeton Discord invalide.',
        );
        this.stopped = true;
        return;
      }
      this.bus.log('warn', 'discord', `Connexion fermée (${event.code}), reconnexion…`);
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // L'événement 'close' suit toujours : la reconnexion est planifiée là.
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  private send(payload: DiscordPayload): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private async handlePayload(payload: DiscordPayload): Promise<void> {
    if (payload.s !== null && payload.s !== undefined) this.sequence = payload.s;

    switch (payload.op) {
      case OP_HELLO: {
        const interval = (payload.d as { heartbeat_interval?: number } | undefined)
          ?.heartbeat_interval;
        if (interval && interval > 0) {
          this.heartbeat = setInterval(
            () => this.send({ op: OP_HEARTBEAT, d: this.sequence }),
            interval,
          );
        }
        this.send({
          op: OP_IDENTIFY,
          d: {
            token: this.config.discordBotToken,
            intents: INTENTS,
            properties: { os: process.platform, browser: 'maestro', device: 'maestro' },
          },
        });
        break;
      }

      case OP_HEARTBEAT_ACK:
        // Connexion saine : on remet le délai de reconnexion à son plancher,
        // sinon une coupure tardive attendrait une minute pour rien.
        this.reconnectDelay = RECONNECT_MIN_MS;
        break;

      case OP_DISPATCH:
        if (payload.t === 'READY') {
          this.bus.log('success', 'discord', 'Passerelle Discord connectée.');
        } else if (payload.t === 'MESSAGE_CREATE') {
          await this.handleMessage(payload.d as DiscordMessage);
        }
        break;

      default:
        break;
    }
  }

  // -- Messages --------------------------------------------------------------

  private async handleMessage(msg: DiscordMessage | undefined): Promise<void> {
    if (!msg?.channel_id) return;
    if (!this.config.discordChannelIds.includes(msg.channel_id)) return;
    // Un bot qui se répond à lui-même part en boucle.
    if (msg.author?.bot) return;

    const content = msg.content ?? '';
    if (content.trim() === '') {
      /*
       * Contenu vide alors qu'un message est bien arrivé : signature d'un intent
       * MESSAGE_CONTENT non activé. On le dit une fois — répéter à chaque message
       * noierait le journal, se taire laisserait chercher pendant une heure.
       */
      this.emptyMessages++;
      if (!this.sawContent && this.emptyMessages === 3) {
        this.bus.log(
          'warn',
          'discord',
          'Trois messages reçus sans contenu : l’intent « Message Content » est probablement ' +
            'désactivé dans le portail développeur de l’application.',
        );
      }
      return;
    }
    this.sawContent = true;

    const command = parseChatCommand(content);
    const reply = executeChatCommand(command, this.chatDeps());
    if (!reply) return;
    await this.post(msg.channel_id, renderMarkdown(reply));

    for (const approvalId of reply.approvalIds ?? []) {
      const approval = this.store.getApproval(approvalId);
      if (approval) await this.notifyApproval(approval, msg.channel_id);
    }
  }

  private chatDeps(): ChatDeps {
    return {
      listAgents: () => this.agents.list(),
      findAgent: (name) => this.agents.getByName(name),
      activeRuns: () => this.engine.activeCount(),
      queuedRuns: () => this.engine.queuedCount(),
      pendingApprovals: () => this.store.countPendingApprovals(),
      listPendingApprovalIds: (limit) =>
        this.store
          .listApprovals('pending')
          .slice(0, limit)
          .map((a) => a.id),
      startRun: (agentId, prompt) => this.engine.start({ agentId, prompt, origin: 'discord' }).id,
    };
  }

  // -- Notifications ---------------------------------------------------------

  /**
   * Approbation, en texte.
   *
   * Pas de boutons : les composants d'interaction de Discord exigent un point
   * d'entrée HTTP public pour recevoir les réponses, ce que Maestro n'a pas par
   * construction — il est fait pour tourner derrière un pare-feu. La résolution
   * passe donc par l'interface web ou Telegram, et le message dit où aller.
   */
  private async notifyApproval(approval: Approval, channelId?: string): Promise<void> {
    const agent = this.agents.get(approval.agentId);
    const text = [
      `⚠️ **Approbation requise**`,
      `Agent : ${agent?.name ?? approval.agentId}`,
      `Outil : \`${approval.toolName}\``,
      `Run : \`${approval.runId}\``,
      `À résoudre dans l’interface Maestro ou sur Telegram.`,
    ].join('\n');
    const targets = channelId ? [channelId] : this.config.discordChannelIds;
    for (const target of targets) await this.post(target, text);
  }

  private async notifyRunEnd(run: Run): Promise<void> {
    const settings = this.store.getSettings();
    /*
     * On ne parle que des runs venus de Discord, sauf si l'utilisateur veut
     * être notifié de tous.
     */
    if (!settings.notifyAllRuns && run.origin !== 'discord') return;
    const agent = this.agents.get(run.agentId);
    const icon = run.status === 'succeeded' ? '✅' : '❌';
    const text = [
      `${icon} Run \`${run.id}\` — **${run.status}**`,
      `Agent : ${agent?.name ?? run.agentId}`,
      run.resultText ? `\n${truncate(run.resultText, 1500)}` : '',
      run.error ? `\nErreur : ${truncate(run.error, 500)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    for (const channelId of this.config.discordChannelIds) await this.post(channelId, text);
  }

  /**
   * Poste un message.
   *
   * Découpé à 2 000 caractères, la limite de Discord : au-delà l'API refuse tout
   * le message, et un rapport d'agent la dépasse souvent.
   */
  private async post(channelId: string, text: string): Promise<void> {
    for (const chunk of splitForDiscord(text)) {
      try {
        const res = await fetch(`${API}/channels/${channelId}/messages`, {
          method: 'POST',
          headers: {
            authorization: `Bot ${this.config.discordBotToken ?? ''}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ content: chunk }),
        });
        if (!res.ok) {
          this.bus.log('warn', 'discord', `Envoi refusé (${res.status}) sur ${channelId}`);
          return;
        }
      } catch (err) {
        this.bus.log('warn', 'discord', `Envoi impossible : ${String(err)}`);
        return;
      }
    }
  }
}

interface DiscordMessage {
  channel_id?: string;
  content?: string;
  author?: { bot?: boolean };
}

/** Limite dure de l'API Discord pour le champ `content`. */
const DISCORD_MAX = 2000;

/**
 * Découpe un texte en messages acceptables.
 *
 * On coupe sur un saut de ligne quand c'est possible : trancher au milieu d'un
 * mot rend un rapport d'agent pénible à lire, et couper au milieu d'un bloc de
 * code casse son rendu.
 */
export function splitForDiscord(text: string, max = DISCORD_MAX): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = window.lastIndexOf('\n');
    const size = cut > max / 2 ? cut : max;
    chunks.push(rest.slice(0, size));
    rest = rest.slice(size).replace(/^\n/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}
