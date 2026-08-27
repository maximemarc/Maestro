/**
 * Kanban partagé : Backlog → Running → Review → Done.
 * Les agents avancent leurs cartes via les outils MCP maestro ; l'humain arbitre.
 */
import type { KanbanColumn, KanbanTask } from '@maestro/shared';
import type { Bus } from './bus.ts';
import type { Store } from './db.ts';
import { makeId, nowIso } from './util.ts';

export class TaskService {
  constructor(
    private store: Store,
    private bus: Bus,
  ) {}

  list(): KanbanTask[] {
    return this.store.listTasks();
  }

  get(id: string): KanbanTask | null {
    return this.store.getTask(id);
  }

  create(input: {
    title: string;
    description?: string;
    column?: KanbanColumn;
    priority?: KanbanTask['priority'];
    labels?: string[];
    agentId?: string | null;
    autoRun?: boolean;
  }): KanbanTask {
    const column = input.column ?? 'backlog';
    const now = nowIso();
    const task: KanbanTask = {
      id: makeId('task'),
      title: input.title,
      description: input.description ?? '',
      column,
      position: this.store.nextTaskPosition(column),
      priority: input.priority ?? 1,
      labels: input.labels ?? [],
      agentId: input.agentId ?? null,
      runId: null,
      autoRun: input.autoRun ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertTask(task);
    this.bus.publish({ type: 'task.created', payload: task });
    return task;
  }

  update(
    id: string,
    patch: Partial<Omit<KanbanTask, 'id' | 'createdAt' | 'updatedAt'>>,
  ): KanbanTask | null {
    const current = this.store.getTask(id);
    if (!current) return null;
    const updated: KanbanTask = { ...current, ...patch, id, updatedAt: nowIso() };
    this.store.updateTask(updated);
    this.bus.publish({ type: 'task.updated', payload: updated });
    return updated;
  }

  move(id: string, column: KanbanColumn, position: number, movedBy: string): KanbanTask | null {
    const task = this.update(id, { column, position });
    if (task) {
      this.bus.log('info', 'kanban', `Carte « ${task.title} » → ${column} (${movedBy})`, {
        agentId: task.agentId,
        runId: task.runId,
      });
    }
    return task;
  }

  delete(id: string): boolean {
    const task = this.store.getTask(id);
    if (!task) return false;
    this.store.deleteTask(id);
    this.bus.publish({ type: 'task.deleted', payload: { id } });
    return true;
  }

  /** Transition automatique pilotée par le cycle de vie d'un run. */
  onRunLifecycle(taskId: string, runId: string, phase: 'started' | 'succeeded' | 'failed'): void {
    const task = this.store.getTask(taskId);
    if (!task) return;
    if (phase === 'started') {
      this.update(taskId, {
        runId,
        column: 'running',
        position: this.store.nextTaskPosition('running'),
      });
    } else if (phase === 'succeeded' && task.column === 'running') {
      // L'agent a pu déplacer sa carte lui-même ; on ne force que depuis 'running'.
      this.move(taskId, 'review', this.store.nextTaskPosition('review'), 'auto');
    } else if (phase === 'failed' && task.column === 'running') {
      this.move(taskId, 'backlog', this.store.nextTaskPosition('backlog'), 'auto (échec)');
    }
  }
}
