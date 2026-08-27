/**
 * Bot Telegram bidirectionnel — zéro dépendance, long-polling via fetch.
 *
 * Sortant : notifications de fin de run, demandes d'approbation (boutons).
 * Entrant : /agents, /status, /approvals, /run <agent> <prompt>.
 * Sécurité : seuls les chat_id de la whitelist (TELEGRAM_CHAT_IDS) sont servis.
 */
import type { Run } from '@maestro/shared';
import type { AgentService } from './agents.ts';
import type { Bus } from './bus.ts';
import type { MaestroConfig } from './config.ts';
import type { Store } from './db.ts';
import type { ApprovalBroker } from './permissions.ts';
import type { RunEngine } from './runs.ts';
import { truncate } from './util.ts';

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

export class TelegramBot {
  readonly enabled: boolean;
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
    this.bus.subscribe((event) => {
      if (event.type === 'approval.requested') {
        void this.notifyApproval(event.payload.id);
      } else if (event.type === 'run.updated' && event.payload.endedAt) {
        void this.notifyRunEnd(event.payload);
      }
    });
    void this.pollLoop();
    this.bus.log(
      'success',
      'telegram',
      `Bot Telegram actif (${this.config.telegramChatIds.length} chat(s) autorisés)`,
    );
  }

  stop(): void {
    this.stopped = true;
  }

  // -- Sortant -----------------------------------------------------------------

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

  private async broadcast(text: string, replyMarkup?: unknown): Promise<void> {
    for (const chatId of this.config.telegramChatIds) {
      await this.api('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      });
    }
  }

  private async notifyApproval(approvalId: string): Promise<void> {
    const approval = this.store.getApproval(approvalId);
    if (!approval || approval.status !== 'pending') return;
    const agent = this.agents.get(approval.agentId);
    const input = truncate(JSON.stringify(approval.input ?? {}), 300);
    await this.broadcast(
      `🔐 <b>Approbation demandée</b>\nAgent : ${agent?.name ?? approval.agentId}\nOutil : <code>${approval.toolName}</code>\nEntrée : <code>${escapeHtml(input)}</code>`,
      {
        inline_keyboard: [
          [
            { text: '✅ Autoriser', callback_data: `apr:${approval.id}:allow` },
            { text: '❌ Refuser', callback_data: `apr:${approval.id}:deny` },
          ],
        ],
      },
    );
  }

  private async notifyRunEnd(run: Run): Promise<void> {
    const settings = this.store.getSettings();
    const shouldNotify =
      run.origin === 'telegram' ||
      settings.telegramNotifyAllRuns ||
      (run.origin === 'routine' && this.routineWantsNotify(run.originId));
    if (!shouldNotify) return;
    const agent = this.agents.get(run.agentId);
    const icon = run.status === 'succeeded' ? '✅' : run.status === 'cancelled' ? '⏹' : '❌';
    const summary = run.resultText ? `\n\n${escapeHtml(truncate(run.resultText, 800))}` : '';
    const error = run.error ? `\nErreur : ${escapeHtml(truncate(run.error, 300))}` : '';
    await this.broadcast(
      `${icon} <b>Run terminé</b> — ${agent?.name ?? run.agentId}\nStatut : ${run.status} · ${run.numTurns} tours · $${run.costUsd.toFixed(4)}${error}${summary}`,
    );
  }

  private routineWantsNotify(routineId: string | null): boolean {
    if (!routineId) return false;
    return this.store.getRoutine(routineId)?.notify ?? false;
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
      const [kind, approvalId, decision] = (cq.data ?? '').split(':');
      if (kind === 'apr' && approvalId && (decision === 'allow' || decision === 'deny')) {
        const resolved = this.approvals.resolve(approvalId, decision, 'telegram', 'Via Telegram');
        await this.api('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: resolved ? (decision === 'allow' ? 'Autorisé ✅' : 'Refusé ❌') : 'Déjà résolue',
        });
      }
      return;
    }

    const msg = update.message;
    if (!msg?.text) return;
    if (!this.isAllowed(msg.chat.id)) return;
    const text = msg.text.trim();

    if (text === '/start' || text === '/help') {
      await this.reply(
        msg.chat.id,
        '🎛 <b>Maestro</b>\n/agents — liste des agents\n/status — état de l’orchestrateur\n/approvals — approbations en attente\n/run &lt;agent&gt; &lt;prompt&gt; — lancer un run',
      );
    } else if (text === '/agents') {
      const list = this.agents
        .list()
        .map(
          (a) => `${a.emoji} <b>${escapeHtml(a.name)}</b> — ${escapeHtml(a.model)} (${a.engine})`,
        )
        .join('\n');
      await this.reply(msg.chat.id, list || 'Aucun agent.');
    } else if (text === '/status') {
      await this.reply(
        msg.chat.id,
        `Runs actifs : ${this.engine.activeCount()}\nEn file : ${this.engine.queuedCount()}\nApprobations en attente : ${this.store.countPendingApprovals()}`,
      );
    } else if (text === '/approvals') {
      const pending = this.store.listApprovals('pending');
      if (pending.length === 0) {
        await this.reply(msg.chat.id, 'Aucune approbation en attente.');
        return;
      }
      for (const approval of pending.slice(0, 5)) {
        await this.notifyApproval(approval.id);
      }
    } else if (text.startsWith('/run ')) {
      const rest = text.slice(5).trim();
      const spaceIdx = rest.indexOf(' ');
      if (spaceIdx === -1) {
        await this.reply(msg.chat.id, 'Usage : /run &lt;agent&gt; &lt;prompt&gt;');
        return;
      }
      const agentName = rest.slice(0, spaceIdx);
      const prompt = rest.slice(spaceIdx + 1).trim();
      const agent = this.agents.getByName(agentName);
      if (!agent) {
        const names = this.agents
          .list()
          .map((a) => a.name)
          .join(', ');
        await this.reply(
          msg.chat.id,
          `Agent « ${escapeHtml(agentName)} » introuvable. Disponibles : ${escapeHtml(names)}`,
        );
        return;
      }
      try {
        const run = this.engine.start({ agentId: agent.id, prompt, origin: 'telegram' });
        await this.reply(
          msg.chat.id,
          `🚀 Run <code>${run.id}</code> lancé pour ${agent.emoji} <b>${escapeHtml(agent.name)}</b>. Je te notifie à la fin.`,
        );
      } catch (err) {
        await this.reply(msg.chat.id, `Échec du lancement : ${escapeHtml(String(err))}`);
      }
    }
  }

  private async reply(chatId: number, text: string): Promise<void> {
    await this.api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
  }
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
