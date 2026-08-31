/**
 * Registre des canaux : un seul abonnement au bus, plusieurs destinataires.
 *
 * Avant, le bot Telegram s'abonnait lui-même et décidait seul de ce qui méritait
 * une notification. Chaque canal supplémentaire aurait dupliqué cet abonnement
 * *et* la règle de décision — deux copies qui auraient divergé au premier
 * réglage ajouté. Ici la règle est appliquée une fois, et le message est diffusé
 * à qui veut l'entendre.
 */
import type { Bus } from '../bus.ts';
import {
  approvalMessage,
  runEndMessage,
  shouldNotifyRunEnd,
  type MessageDeps,
} from './messages.ts';
import type { Channel, ChannelMessage } from './types.ts';

export class ChannelRegistry {
  private channels: Channel[];

  constructor(
    channels: Channel[],
    private bus: Bus,
    private deps: MessageDeps,
  ) {
    // Un canal désactivé n'est pas conservé : rien ne le réactivera à chaud,
    // et le garder obligerait chaque diffusion à le tester.
    this.channels = channels.filter((c) => c.enabled);
  }

  /** Canaux actifs, pour l'état du serveur et les journaux. */
  list(): { id: string; label: string; interactive: boolean }[] {
    return this.channels.map((c) => ({ id: c.id, label: c.label, interactive: c.interactive }));
  }

  get enabled(): boolean {
    return this.channels.length > 0;
  }

  /** Vrai si au moins un canal sait résoudre une approbation. */
  get hasInteractive(): boolean {
    return this.channels.some((c) => c.interactive);
  }

  start(): void {
    if (this.channels.length === 0) return;

    this.bus.subscribe((event) => {
      if (event.type === 'approval.requested') {
        const message = approvalMessage(this.deps, event.payload);
        if (message) void this.broadcast(message);
      } else if (event.type === 'run.updated' && event.payload.endedAt) {
        if (!shouldNotifyRunEnd(this.deps, event.payload)) return;
        void this.broadcast(runEndMessage(this.deps, event.payload));
      }
    });

    for (const channel of this.channels) channel.start();
  }

  stop(): void {
    for (const channel of this.channels) channel.stop();
  }

  /**
   * Diffuse à tous les canaux.
   *
   * Chaque envoi est isolé : un webhook injoignable ne doit pas empêcher la
   * notification Telegram de partir. C'est précisément ce qui arriverait avec un
   * `Promise.all` sans garde.
   */
  async broadcast(message: ChannelMessage): Promise<void> {
    await Promise.all(
      this.channels.map(async (channel) => {
        try {
          await channel.send(message);
        } catch (err) {
          this.bus.log(
            'warn',
            'channels',
            `Canal ${channel.id} : envoi impossible — ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
  }
}
