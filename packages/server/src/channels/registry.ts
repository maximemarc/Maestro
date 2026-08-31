/**
 * Registre des canaux : un seul abonnement au bus, plusieurs destinataires.
 *
 * Avant, chaque passerelle s'abonnait elle-même et décidait seule de ce qui
 * méritait une notification — trois abonnements, trois copies de la règle de
 * décision, trois mises en page. Les copies avaient déjà divergé. Ici la règle
 * est appliquée **une fois**, et le message est diffusé à qui veut l'entendre.
 */
import type { Bus } from '../bus.ts';
import type { ChatReply } from '../chat-commands.ts';
import {
  approvalMessage,
  runEndMessage,
  shouldNotifyRunEnd,
  type MessageDeps,
} from './messages.ts';
import type { Channel } from './types.ts';

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
        const approval = this.deps.store.getApproval(event.payload.id);
        if (!approval) return;
        const message = approvalMessage(this.deps, approval);
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
  async broadcast(reply: ChatReply): Promise<void> {
    await Promise.all(
      this.channels.map(async (channel) => {
        try {
          await channel.send(reply);
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
