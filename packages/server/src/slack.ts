/**
 * Passerelle Slack — Socket Mode, sans dépendance.
 *
 * Socket Mode et non l'API Events : celle-ci exige une URL publique que Slack
 * appelle, donc un tunnel ou un reverse proxy exposé. Maestro est fait pour
 * tourner derrière un pare-feu, souvent sur un poste de travail ; Socket Mode
 * inverse le sens de la connexion — c'est Maestro qui appelle Slack et garde la
 * socket ouverte. C'est la seule des deux voies compatible avec l'usage réel.
 *
 * Deux jetons, deux rôles, à ne pas confondre :
 *  - `SLACK_APP_TOKEN` (xapp-…), portée `connections:write`, sert uniquement à
 *    ouvrir la socket ;
 *  - `SLACK_BOT_TOKEN` (xoxb-…) sert à poster les messages.
 *
 * 🔒 Liste blanche de canaux stricte, comme ailleurs : sans `SLACK_CHANNEL_IDS`,
 * la passerelle ne démarre pas.
 */
import type { Approval, Run } from '@maestro/shared';
import type { AgentService } from './agents.ts';
import type { Bus } from './bus.ts';
import type { MaestroConfig } from './config.ts';
import type { Store } from './db.ts';
import type { RunEngine } from './runs.ts';
import {
  executeChatCommand,
  parseChatCommand,
  renderMrkdwn,
  type ChatDeps,
} from './chat-commands.ts';
import { truncate } from './util.ts';

const API = 'https://slack.com/api';
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

/** Enveloppe Socket Mode. `envelope_id` doit être renvoyé en accusé. */
interface SlackEnvelope {
  type?: string;
  envelope_id?: string;
  payload?: {
    event?: SlackEvent;
  };
}

interface SlackEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  /** Horodatage du message, identifiant de fil. */
  ts?: string;
  thread_ts?: string;
}

export class SlackBot {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private stopped = false;

  readonly enabled: boolean;

  constructor(
    private config: MaestroConfig,
    private store: Store,
    private bus: Bus,
    private engine: RunEngine,
    private agents: AgentService,
  ) {
    this.enabled = Boolean(
      config.slackAppToken && config.slackBotToken && config.slackChannelIds.length > 0,
    );
  }

  start(): void {
    if (!this.enabled) {
      if (
        (this.config.slackAppToken || this.config.slackBotToken) &&
        this.config.slackChannelIds.length === 0
      ) {
        this.bus.log(
          'warn',
          'slack',
          'Jetons Slack présents mais SLACK_CHANNEL_IDS vide : passerelle inactive. ' +
            'La liste blanche est obligatoire.',
        );
      }
      return;
    }
    this.stopped = false;
    void this.connect();

    this.bus.subscribe((event) => {
      if (event.type === 'approval.requested') void this.notifyApproval(event.payload);
      if (event.type === 'run.updated' && event.payload.endedAt)
        void this.notifyRunEnd(event.payload);
    });
    this.bus.log(
      'success',
      'slack',
      `Passerelle Slack active (${this.config.slackChannelIds.length} canal/canaux)`,
    );
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  // -- Connexion -------------------------------------------------------------

  /**
   * Ouvre la socket.
   *
   * `apps.connections.open` rend une URL WebSocket à usage unique et de courte
   * durée : elle se redemande à chaque reconnexion, on ne la met jamais en cache.
   */
  private async connect(): Promise<void> {
    if (this.stopped) return;
    let url: string;
    try {
      const res = await fetch(`${API}/apps.connections.open`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.slackAppToken ?? ''}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
      });
      const body = (await res.json()) as { ok?: boolean; url?: string; error?: string };
      if (!body.ok || !body.url) {
        // `invalid_auth` et `not_allowed_token_type` ne se corrigent pas en
        // réessayant : c'est le mauvais jeton, ou la mauvaise portée.
        const fatal = body.error === 'invalid_auth' || body.error === 'not_allowed_token_type';
        this.bus.log(
          fatal ? 'error' : 'warn',
          'slack',
          `Ouverture de socket refusée : ${body.error ?? 'réponse inattendue'}` +
            (fatal
              ? ' — vérifie que SLACK_APP_TOKEN est un jeton xapp- avec connections:write.'
              : ''),
        );
        if (fatal) {
          this.stopped = true;
          return;
        }
        this.scheduleReconnect();
        return;
      }
      url = body.url;
    } catch (err) {
      this.bus.log('warn', 'slack', `Connexion impossible : ${String(err)}`);
      this.scheduleReconnect();
      return;
    }

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.bus.log('success', 'slack', 'Passerelle Slack connectée.');
    });

    socket.addEventListener('message', (event) => {
      let envelope: SlackEnvelope;
      try {
        envelope = JSON.parse(String(event.data)) as SlackEnvelope;
      } catch {
        return;
      }
      void this.handleEnvelope(envelope);
    });

    socket.addEventListener('close', () => {
      if (this.stopped) return;
      this.bus.log('warn', 'slack', 'Socket fermée, reconnexion…');
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // 'close' suit toujours : la reconnexion y est planifiée.
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.reconnectTimer = setTimeout(() => void this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  /**
   * Traite une enveloppe.
   *
   * L'accusé part **avant** le traitement : Slack attend une réponse en trois
   * secondes et redélivre l'enveloppe au-delà. Traiter d'abord ferait rejouer
   * une commande `/run` — donc lancer deux fois le même agent.
   */
  private async handleEnvelope(envelope: SlackEnvelope): Promise<void> {
    if (envelope.envelope_id) {
      this.socket?.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    }
    if (envelope.type === 'hello' || envelope.type === 'disconnect') {
      if (envelope.type === 'disconnect') this.socket?.close();
      return;
    }
    const event = envelope.payload?.event;
    if (!event || event.type !== 'message') return;
    await this.handleMessage(event);
  }

  // -- Messages --------------------------------------------------------------

  private async handleMessage(event: SlackEvent): Promise<void> {
    if (!event.channel || !this.config.slackChannelIds.includes(event.channel)) return;
    // Un message posté par un bot, ou une modification/suppression, n'est pas
    // une commande. Sans ce filtre, la passerelle se répond à elle-même.
    if (event.bot_id || event.subtype) return;

    const command = parseChatCommand(event.text ?? '');
    const reply = executeChatCommand(command, this.chatDeps());
    if (!reply) return;

    // Réponse dans le fil quand le message en ouvre un : sinon un canal actif
    // devient illisible.
    await this.post(event.channel, renderMrkdwn(reply), event.thread_ts ?? event.ts);

    for (const approvalId of reply.approvalIds ?? []) {
      const approval = this.store.getApproval(approvalId);
      if (approval) await this.notifyApproval(approval, event.channel);
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
      startRun: (agentId, prompt) => this.engine.start({ agentId, prompt, origin: 'slack' }).id,
    };
  }

  // -- Notifications ---------------------------------------------------------

  private async notifyApproval(approval: Approval, channelId?: string): Promise<void> {
    const agent = this.agents.get(approval.agentId);
    const text = [
      '⚠️ *Approbation requise*',
      `Agent : ${agent?.name ?? approval.agentId}`,
      `Outil : \`${approval.toolName}\``,
      `Run : \`${approval.runId}\``,
      'À résoudre dans l’interface Maestro ou sur Telegram.',
    ].join('\n');
    for (const target of channelId ? [channelId] : this.config.slackChannelIds) {
      await this.post(target, text);
    }
  }

  private async notifyRunEnd(run: Run): Promise<void> {
    if (!this.store.getSettings().notifyAllRuns && run.origin !== 'slack') return;
    const agent = this.agents.get(run.agentId);
    const icon = run.status === 'succeeded' ? '✅' : '❌';
    const text = [
      `${icon} Run \`${run.id}\` — *${run.status}*`,
      `Agent : ${agent?.name ?? run.agentId}`,
      run.resultText ? `\n${truncate(run.resultText, 2500)}` : '',
      run.error ? `\nErreur : ${truncate(run.error, 500)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    for (const channelId of this.config.slackChannelIds) await this.post(channelId, text);
  }

  private async post(channelId: string, text: string, threadTs?: string): Promise<void> {
    try {
      const res = await fetch(`${API}/chat.postMessage`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.slackBotToken ?? ''}`,
          'content-type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: channelId,
          text: truncate(text, SLACK_MAX),
          ...(threadTs ? { thread_ts: threadTs } : {}),
        }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string };
      if (!body.ok) {
        /*
         * `not_in_channel` est l'erreur la plus fréquente et la plus opaque : le
         * bot est installé mais n'a pas été invité dans le canal. Le dire en
         * clair épargne une recherche.
         */
        this.bus.log(
          'warn',
          'slack',
          body.error === 'not_in_channel'
            ? `Le bot n’est pas membre du canal ${channelId} — l’y inviter avec /invite.`
            : `Envoi refusé sur ${channelId} : ${body.error ?? 'erreur inconnue'}`,
        );
      }
    } catch (err) {
      this.bus.log('warn', 'slack', `Envoi impossible : ${String(err)}`);
    }
  }
}

/** Limite pratique du champ `text` de chat.postMessage. */
const SLACK_MAX = 39_000;
