/**
 * Routines planifiées (cron) : agent + skill + prompt, déclenchés par croner.
 */
import { Cron } from 'croner';
import type { CreateRoutineRequest, Routine } from '@maestro/shared';
import type { Bus } from './bus.ts';
import type { Store } from './db.ts';
import type { RunEngine } from './runs.ts';
import { makeId, nowIso } from './util.ts';

export class Scheduler {
  private jobs = new Map<string, Cron>();

  constructor(
    private store: Store,
    private bus: Bus,
    private engine: RunEngine,
  ) {}

  init(): void {
    for (const routine of this.store.listRoutines()) {
      this.schedule(routine);
    }
  }

  shutdown(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  static validateCron(expr: string): boolean {
    try {
      new Cron(expr, { paused: true }).stop();
      return true;
    } catch {
      return false;
    }
  }

  private schedule(routine: Routine): void {
    this.jobs.get(routine.id)?.stop();
    this.jobs.delete(routine.id);
    if (!routine.enabled) return;
    try {
      const job = new Cron(routine.cronExpr, () => this.fire(routine.id, false));
      this.jobs.set(routine.id, job);
    } catch (err) {
      this.bus.log('error', 'routines', `Cron invalide pour « ${routine.name} » : ${String(err)}`);
    }
  }

  withNextFire(routine: Routine): Routine {
    const next = this.jobs.get(routine.id)?.nextRun();
    return { ...routine, nextFireAt: next ? next.toISOString() : null };
  }

  list(): Routine[] {
    return this.store.listRoutines().map((r) => this.withNextFire(r));
  }

  create(input: CreateRoutineRequest): Routine {
    if (!Scheduler.validateCron(input.cronExpr)) {
      throw new Error(`Expression cron invalide : ${input.cronExpr}`);
    }
    const now = nowIso();
    const routine: Routine = {
      id: makeId('rtn'),
      name: input.name,
      agentId: input.agentId,
      skillId: input.skillId ?? null,
      prompt: input.prompt,
      cronExpr: input.cronExpr,
      enabled: input.enabled ?? true,
      timeoutSec: input.timeoutSec ?? null,
      notify: input.notify ?? true,
      lastFiredAt: null,
      nextFireAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertRoutine(routine);
    this.schedule(routine);
    const published = this.withNextFire(routine);
    this.bus.publish({ type: 'routine.updated', payload: published });
    this.bus.log(
      'success',
      'routines',
      `Routine « ${routine.name} » planifiée (${routine.cronExpr})`,
    );
    return published;
  }

  update(id: string, patch: Partial<CreateRoutineRequest>): Routine | null {
    const current = this.store.getRoutine(id);
    if (!current) return null;
    if (patch.cronExpr && !Scheduler.validateCron(patch.cronExpr)) {
      throw new Error(`Expression cron invalide : ${patch.cronExpr}`);
    }
    const updated: Routine = {
      ...current,
      ...patch,
      skillId: patch.skillId !== undefined ? (patch.skillId ?? null) : current.skillId,
      timeoutSec: patch.timeoutSec !== undefined ? (patch.timeoutSec ?? null) : current.timeoutSec,
      id,
      updatedAt: nowIso(),
    };
    this.store.updateRoutine(updated);
    this.schedule(updated);
    const published = this.withNextFire(updated);
    this.bus.publish({ type: 'routine.updated', payload: published });
    return published;
  }

  remove(id: string): boolean {
    const routine = this.store.getRoutine(id);
    if (!routine) return false;
    this.jobs.get(id)?.stop();
    this.jobs.delete(id);
    this.store.deleteRoutine(id);
    this.bus.publish({ type: 'routine.deleted', payload: { id } });
    return true;
  }

  fire(id: string, manual: boolean): void {
    const routine = this.store.getRoutine(id);
    if (!routine) return;
    try {
      this.engine.start({
        agentId: routine.agentId,
        prompt: routine.prompt,
        skillId: routine.skillId,
        origin: 'routine',
        originId: routine.id,
        timeoutSecOverride: routine.timeoutSec,
      });
      routine.lastFiredAt = nowIso();
      this.store.updateRoutine(routine);
      this.bus.publish({ type: 'routine.updated', payload: this.withNextFire(routine) });
      this.bus.log(
        'info',
        'routines',
        `Routine « ${routine.name} » déclenchée${manual ? ' (run-now)' : ''}`,
      );
    } catch (err) {
      this.bus.log('error', 'routines', `Routine « ${routine.name} » : ${String(err)}`);
    }
  }
}
