/**
 * Métriques temps réel : snapshot périodique diffusé sur le bus (metrics.tick).
 */
import type { MetricsSnapshot } from '@maestro/shared';
import type { Bus } from './bus.ts';
import type { Store } from './db.ts';
import type { RunEngine } from './runs.ts';
import { nowIso, todayKey } from './util.ts';

export class Metrics {
  private startedAtMs = Date.now();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private store: Store,
    private bus: Bus,
    private engine: RunEngine,
    private connectedClients: () => number,
  ) {}

  snapshot(): MetricsSnapshot {
    const today = this.store.todayTotals(todayKey());
    return {
      ts: nowIso(),
      uptimeSec: Math.floor((Date.now() - this.startedAtMs) / 1000),
      activeRuns: this.engine.activeCount(),
      queuedRuns: this.engine.queuedCount(),
      pendingApprovals: this.store.countPendingApprovals(),
      eventsPerSec: this.bus.eventsPerSec(),
      todayInputTokens: today.inputTokens,
      todayOutputTokens: today.outputTokens,
      todayCostUsd: today.costUsd,
      connectedClients: this.connectedClients(),
    };
  }

  start(intervalMs = 2000): void {
    this.timer = setInterval(() => {
      this.bus.publish({ type: 'metrics.tick', payload: this.snapshot() });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
