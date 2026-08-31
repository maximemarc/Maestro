/**
 * Canal Telegram — zéro dépendance, long-polling via fetch.
 *
 * Ce fichier ne contient plus que ce qui est propre à Telegram : l'API, la
 * boucle de réception, le rendu HTML et les boutons. Décider quoi notifier et
 * exécuter les commandes appartient à `messages.ts`, partagé avec les autres
 * canaux.
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
import { parseApprovalAction, parseCommand, runCommand, type MessageDeps } from './messages.ts';
import { TONE_ICONS, type Channel, type ChannelMessage } from './types.ts';

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
  private deps: MessageDeps;

  constructor(
    private config: MaestroConfig,
    store: Store,
    private bus: Bus,
    engine: RunEngine,
    agents: AgentService,
    private approvals: ApprovalBroker,
  ) {
    this.enabled = Boolean(config.telegramBotToken) && config.telegramChatIds.length > 0;
    this.apiBase = `https://api.telegram.org/bot${config.telegramBotToken ?? ''}`;
    this.deps = { store, agents, engine };
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

  async send(message: ChannelMessage): Promise<void> {
    if (!this.enabled) return;
    const markup = this.keyboard(message);
    for (const chatId of this.config.telegramChatIds) {
      await this.api('sendMessage', {
        chat_id: chatId,
        text: render(message),
        parse_mode: 'HTML',
        ...(markup ? { reply_markup: markup } : {}),
      });
    }
  }

  /** Boutons Telegram, quand le message propose des actions. */
  private keyboard(message: ChannelMessage): unknown {
    if (!message.actions || message.actions.length === 0) return null;
    return {
      inline_keyboard: [
        message.actions.map((action) => ({
          text: `${action.style === 'danger' ? '❌' : '✅'} ${action.label}`,
          callback_data: action.id,
        })),
      ],
    };
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
    const command = parseCommand(msg.text);
    if (!command) return;

    for (const reply of runCommand(this.deps, command)) {
      const markup = this.keyboard(reply);
      await this.api('sendMessage', {
        chat_id: msg.chat.id,
        text: render(reply),
        parse_mode: 'HTML',
        ...(markup ? { reply_markup: markup } : {}),
      });
    }
  }
}

/**
 * Rendu HTML Telegram.
 *
 * Les actions ne sont pas reprises dans le texte : elles deviennent des
 * boutons. Les répéter en dessous ferait doublon dans le seul canal où elles
 * sont réellement cliquables.
 */
export function render(message: ChannelMessage): string {
  const lines = [`${TONE_ICONS[message.tone]} <b>${escapeHtml(message.title)}</b>`];
  for (const field of message.fields ?? []) {
    lines.push(`${escapeHtml(field.label)} : <code>${escapeHtml(field.value)}</code>`);
  }
  if (message.body) lines.push('', escapeHtml(message.body));
  return lines.join('\n');
}

export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
