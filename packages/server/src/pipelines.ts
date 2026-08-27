/**
 * Pipelines : chaînes d'agents séquentielles. La sortie de chaque étape est
 * disponible pour les suivantes via {{prev}} et {{steps.<nom>}}.
 */
import type { Pipeline, PipelineRun, PipelineStep } from '@maestro/shared';
import type { Bus } from './bus.ts';
import type { Store } from './db.ts';
import type { RunEngine } from './runs.ts';
import { makeId, nowIso } from './util.ts';

const STEP_TIMEOUT_MS = 60 * 60 * 1000;

export class PipelineService {
  private cancelled = new Set<string>();

  constructor(
    private store: Store,
    private bus: Bus,
    private engine: RunEngine,
  ) {}

  list(): Pipeline[] {
    return this.store.listPipelines();
  }

  get(id: string): Pipeline | null {
    return this.store.getPipeline(id);
  }

  create(input: {
    name: string;
    description?: string;
    steps: Omit<PipelineStep, 'id'>[];
  }): Pipeline {
    const now = nowIso();
    const pipeline: Pipeline = {
      id: makeId('ppl'),
      name: input.name,
      description: input.description ?? '',
      steps: input.steps.map((s) => ({ ...s, id: makeId('stp') })),
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertPipeline(pipeline);
    this.bus.publish({ type: 'pipeline.updated', payload: pipeline });
    return pipeline;
  }

  update(
    id: string,
    patch: {
      name?: string;
      description?: string;
      steps?: (PipelineStep | Omit<PipelineStep, 'id'>)[];
    },
  ): Pipeline | null {
    const current = this.store.getPipeline(id);
    if (!current) return null;
    const updated: Pipeline = {
      ...current,
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      steps: patch.steps
        ? patch.steps.map((s) =>
            'id' in s && s.id ? (s as PipelineStep) : { ...s, id: makeId('stp') },
          )
        : current.steps,
      updatedAt: nowIso(),
    };
    this.store.updatePipeline(updated);
    this.bus.publish({ type: 'pipeline.updated', payload: updated });
    return updated;
  }

  remove(id: string): boolean {
    if (!this.store.getPipeline(id)) return false;
    this.store.deletePipeline(id);
    return true;
  }

  listRuns(pipelineId?: string): PipelineRun[] {
    return this.store.listPipelineRuns(pipelineId);
  }

  getRun(id: string): PipelineRun | null {
    return this.store.getPipelineRun(id);
  }

  cancelRun(id: string): boolean {
    const pr = this.store.getPipelineRun(id);
    if (!pr || pr.status !== 'running') return false;
    this.cancelled.add(id);
    const current = pr.stepRuns[pr.currentStepIndex];
    if (current?.runId) this.engine.cancel(current.runId);
    return true;
  }

  /** Lance l'exécution (asynchrone) et retourne immédiatement l'état initial. */
  start(pipelineId: string, input: string): PipelineRun {
    const pipeline = this.store.getPipeline(pipelineId);
    if (!pipeline) throw new Error(`Pipeline introuvable : ${pipelineId}`);
    if (pipeline.steps.length === 0) throw new Error('Pipeline sans étape');

    const pr: PipelineRun = {
      id: makeId('prun'),
      pipelineId,
      status: 'running',
      input,
      currentStepIndex: 0,
      stepRuns: pipeline.steps.map((s) => ({
        stepId: s.id,
        runId: null,
        status: 'pending',
        output: null,
      })),
      startedAt: nowIso(),
      endedAt: null,
    };
    this.store.insertPipelineRun(pr);
    this.bus.publish({ type: 'pipelineRun.updated', payload: pr });
    this.bus.log('info', 'pipelines', `Pipeline « ${pipeline.name} » démarré (${pr.id})`);
    void this.executeSteps(pipeline, pr);
    return pr;
  }

  private renderTemplate(
    template: string,
    input: string,
    prev: string,
    outputs: Map<string, string>,
  ): string {
    return template
      .replaceAll('{{input}}', input)
      .replaceAll('{{prev}}', prev)
      .replace(/\{\{steps\.([^}]+)\}\}/g, (_m, name: string) => outputs.get(name.trim()) ?? '');
  }

  private async executeSteps(pipeline: Pipeline, pr: PipelineRun): Promise<void> {
    const outputs = new Map<string, string>();
    let prev = pr.input;

    for (let i = 0; i < pipeline.steps.length; i++) {
      if (this.cancelled.has(pr.id)) {
        this.finish(pr, 'cancelled');
        return;
      }
      const step = pipeline.steps[i];
      if (!step) break;
      pr.currentStepIndex = i;

      let run;
      try {
        run = this.engine.start({
          agentId: step.agentId,
          prompt: this.renderTemplate(step.promptTemplate, pr.input, prev, outputs),
          skillId: step.skillId,
          origin: 'pipeline',
          originId: pr.id,
          // Une session tmux interactive ne se termine pas d'elle-même : un
          // enchaînement exige des runs qui finissent, donc le moteur SDK.
          engineOverride: 'sdk',
        });
      } catch (err) {
        const sr = pr.stepRuns[i];
        if (sr) sr.status = 'failed';
        this.bus.log('error', 'pipelines', `Étape « ${step.name} » : ${String(err)}`);
        this.finish(pr, 'failed');
        return;
      }

      const sr = pr.stepRuns[i];
      if (sr) {
        sr.runId = run.id;
        sr.status = 'running';
      }
      this.store.updatePipelineRun(pr);
      this.bus.publish({ type: 'pipelineRun.updated', payload: pr });

      const finished = await this.engine.waitForRun(run.id, STEP_TIMEOUT_MS);
      const stepRun = pr.stepRuns[i];
      if (!finished || finished.status !== 'succeeded') {
        if (stepRun) {
          stepRun.status = finished?.status ?? 'failed';
          stepRun.output = finished?.error ?? null;
        }
        this.finish(pr, this.cancelled.has(pr.id) ? 'cancelled' : 'failed');
        return;
      }
      const output = finished.resultText ?? '';
      if (stepRun) {
        stepRun.status = 'succeeded';
        stepRun.output = output;
      }
      outputs.set(step.name, output);
      prev = output;
      this.store.updatePipelineRun(pr);
      this.bus.publish({ type: 'pipelineRun.updated', payload: pr });
    }

    this.finish(pr, 'succeeded');
  }

  private finish(pr: PipelineRun, status: PipelineRun['status']): void {
    this.cancelled.delete(pr.id);
    pr.status = status;
    pr.endedAt = nowIso();
    this.store.updatePipelineRun(pr);
    this.bus.publish({ type: 'pipelineRun.updated', payload: pr });
    this.bus.log(
      status === 'succeeded' ? 'success' : 'warn',
      'pipelines',
      `Pipeline ${pr.id} terminé : ${status}`,
    );
  }
}
