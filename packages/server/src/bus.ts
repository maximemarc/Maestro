/**
 * Bus d'événements central : tout changement d'état passe par ici.
 * Les abonnés (hub WebSocket, bot Telegram, métriques) reçoivent chaque
 * ServerEvent ; les logs sont persistés puis diffusés comme événement 'log'.
 */
import type { LogLevel, ServerEvent } from '@maestro/shared';
import type { Store } from './db.ts';

export type BusSubscriber = (event: ServerEvent) => void;

export class Bus {
  private subscribers = new Set<BusSubscriber>();
  /** Horodatages (ms) des derniers événements — fenêtre glissante pour le débit. */
  private recentTimestamps: number[] = [];

  constructor(private store: Store) {}

  subscribe(fn: BusSubscriber): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  publish(event: ServerEvent): void {
    const now = Date.now();
    this.recentTimestamps.push(now);
    // Fenêtre de 10 s, bornée pour éviter toute croissance sous forte charge.
    while (this.recentTimestamps.length > 0 && (this.recentTimestamps[0] ?? 0) < now - 10_000) {
      this.recentTimestamps.shift();
    }
    if (this.recentTimestamps.length > 10_000) {
      this.recentTimestamps.splice(0, this.recentTimestamps.length - 10_000);
    }
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch (err) {
        // Un abonné défaillant ne doit jamais casser la diffusion.
        console.error('[bus] subscriber error:', err);
      }
    }
  }

  /** Débit d'événements par seconde sur la fenêtre glissante. */
  eventsPerSec(): number {
    const now = Date.now();
    const count = this.recentTimestamps.filter((t) => t >= now - 10_000).length;
    return Math.round((count / 10) * 10) / 10;
  }

  log(
    level: LogLevel,
    source: string,
    message: string,
    ctx: { agentId?: string | null; runId?: string | null } = {},
  ): void {
    const line = this.store.insertLog(
      level,
      source,
      message,
      ctx.agentId ?? null,
      ctx.runId ?? null,
    );
    this.publish({ type: 'log', payload: line });
  }
}
