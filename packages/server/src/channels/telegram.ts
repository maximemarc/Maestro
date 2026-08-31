/**
 * Canal Telegram — zéro dépendance, long-polling via fetch.
 *
 * Ce fichier ne contient plus que ce qui est propre à Telegram : l'API, la
 * boucle de réception, le rendu HTML et les boutons. Décider quoi notifier
 * appartient à `messages.ts` et au registre ; exécuter les commandes appartient
 * à `chat-commands.ts`, partagé avec Slack et Discord — une commande corrigée
 * l'est sur les trois canaux.
 *
 * 🔒 Sécurité inchangée : seuls les `chat_id` de la liste blanche sont servis,
 * en réception comme en émission. Un canal ouvert à tout le monde donnerait à
 * n'importe qui le droit de lancer des runs.
 */
import type { AgentService } from '../agents.ts';
import type { Bus } from '../bus.ts';
import type { MaestroConfig } from '../config.ts';
import type { Store } from '../db.ts';
import type { ApprovalBroker } from '../permissions.ts';
import type { RunEngine } from '../runs.ts';
import {
  executeChatCommand,
  parseChatCommand,
  renderHtml,
  type ChatReply,
} from '../chat-commands.ts';
import { APPROVAL_ACTIONS, approvalActionId, parseApprovalAction, type Channel } from './types.ts';

interface TgUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { chat: { id: number }; message_id: number };
  };
}

export class TelegramChannel implements Channel {
  readonly id = 'telegram';
  readonly label = 'Telegram';
  readonly enabled: boolean;
  readonly interactive = true;

  private offset = 0;
  private stopped = false;
  private apiBase: string;

  constructor(
    private config: MaestroConfig,
    private store: Store,
    private bus: Bus,
    private engine: RunEngine,
    private agents: AgentService,
    private approvals: ApprovalBroker,
  ) {
    this.enabled = Boolean(config.telegramBotToken) && config.telegramChatIds.length > 0;
    this.apiBase = `https://api.telegram.org/bot${config.telegramBotToken ?? ''}`;
  }

  start(): void {
    if (!this.enabled) return;
    void this.pollLoop();
    this.bus.log(
      'success',
      'telegram',
      `Canal Telegram actif (${this.config.telegramChatIds.length} chat(s) autorisés)`,
    );
  }

  stop(): void {
    this.stopped = true;
  }

  // -- Sortant -----------------------------------------------------------------

  async send(reply: ChatReply): Promise<void> {
    if (!this.enabled) return;
    for (const chatId of this.config.telegramChatIds) await this.post(chatId, reply);
  }

  /**
   * Envoie un message rendu, avec ses boutons s'il porte des approbations.
   *
   * Un rang de boutons par approbation : `callback_data` porte l'identifiant,
   * ce qui évite de conserver un état côté serveur entre l'envoi et le clic.
   */
  private async post(chatId: number | string, reply: ChatReply): Promise<void> {
    const ids = reply.approvalIds ?? [];
    const markup =
      ids.length > 0
        ? {
            inline_keyboard: ids.map((approvalId) =>
              APPROVAL_ACTIONS.map((action) => ({
                text: `${action.icon} ${action.label}`,
                callback_data: approvalActionId(approvalId, action.decision),
              })),
            ),
          }
        : null;

    await this.api('sendMessage', {
      chat_id: chatId,
      text: renderHtml(reply),
      parse_mode: 'HTML',
      ...(markup ? { reply_markup: markup } : {}),
    });
  }

  private async api(method: string, body: Record<string, unknown>): Promise<unknown> {
    try {
      const res = await fetch(`${this.apiBase}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return (await res.json()) as unknown;
    } catch (err) {
      this.bus.log('warn', 'telegram', `API ${method} en échec : ${String(err)}`);
      return null;
    }
  }

  // -- Entrant ------------------------------------------------------------------

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const res = await fetch(`${this.apiBase}/getUpdates?offset=${this.offset}&timeout=25`, {
          signal: AbortSignal.timeout(35_000),
        });
        const data = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
        for (const update of data.result ?? []) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch {
        // Réseau indisponible : on retente après une pause.
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private isAllowed(chatId: number): boolean {
    return this.config.telegramChatIds.includes(String(chatId));
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat.id;
      if (chatId === undefined || !this.isAllowed(chatId)) return;
      const action = parseApprovalAction(cq.data ?? '');
      if (action) {
        const resolved = this.approvals.resolve(
          action.approvalId,
          action.decision,
          'telegram',
          'Via Telegram',
        );
        await this.api('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: resolved
            ? action.decision === 'allow'
              ? 'Autorisé ✅'
              : 'Refusé ❌'
            : 'Déjà résolue',
        });
      }
      return;
    }

    const msg = update.message;
    if (!msg?.text || !this.isAllowed(msg.chat.id)) return;

    const command = parseChatCommand(msg.text);
    const reply = executeChatCommand(command, {
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
      startRun: (agentId, prompt) => this.engine.start({ agentId, prompt, origin: 'telegram' }).id,
    });
    if (!reply) return;

    await this.post(msg.chat.id, reply);
  }
}
