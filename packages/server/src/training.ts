/**
 * Génération de jeux de données par lots.
 *
 * Un lot décrit ce qu'on veut obtenir — des gabarits de prompt, des variables,
 * un nombre d'échantillons, une distribution d'outils — et le service produit
 * les trajectoires correspondantes en faisant travailler plusieurs agents de
 * front, avec reprise après interruption.
 *
 * Deux contraintes structurelles de Maestro dictent la conception :
 *
 *  1. Un agent n'exécute jamais deux runs à la fois — son workspace est unique.
 *     Le parallélisme d'un lot ne vient donc pas d'un nombre de workers réglable
 *     à volonté, mais du nombre d'agents qu'on lui confie. Un worker par agent,
 *     et rien de plus : promettre huit workers sur un agent unique reviendrait à
 *     annoncer un débit huit fois trop élevé pour un lot qui s'exécuterait en
 *     série.
 *  2. Le processus peut mourir à tout instant. L'état vit donc en base, un
 *     échantillon à la fois : le lot n'a pas de mémoire propre à reconstituer,
 *     il relit ses échantillons en attente.
 */
import type {
  Trajectory,
  TrainingBatch,
  TrainingBatchSpec,
  TrainingExportRequest,
  TrainingItem,
  TrainingItemStatus,
} from '@maestro/shared';
import type { AgentService } from './agents.ts';
import type { Bus } from './bus.ts';
import type { Store } from './db.ts';
import type { RunEngine } from './runs.ts';
import { type ExportInput, type ExportResult, buildExport } from './training-export.ts';
import { DEFAULT_DIALECT, isToolCallDialect } from './training-parsers.ts';
import { buildTrajectory } from './training-trajectory.ts';
import { makeId, nowIso } from './util.ts';

/** Délai maximal d'attente d'un échantillon, faute de délai explicite. */
const DEFAULT_ITEM_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * Runs balayés lors d'un export sans lot ni liste.
 *
 * Une borne est indispensable : construire les trajectoires de toute une
 * instance relit chaque événement de chaque run, et le coût est linéaire en
 * historique. Mieux vaut un export explicitement borné, et le dire, qu'une
 * requête qui fige le serveur sur une base d'un an.
 */
const EXPORT_RUN_SCAN_LIMIT = 500;
/** Délai d'attente d'une notation : un juge doit répondre court et vite. */
const GRADER_TIMEOUT_MS = 5 * 60 * 1000;

export class TrainingError extends Error {}

export const DEFAULT_GRADER_PROMPT = `Évalue la trajectoire suivante.

Demande initiale :
{{prompt}}

Réponse produite :
{{result}}

Juge la pertinence, l'exactitude et l'usage des outils. Réponds en deux phrases
maximum, puis termine par un score entre 0 et 1 sur une ligne seule.`;

/**
 * Générateur pseudo-aléatoire déterministe (xorshift32).
 *
 * `Math.random` conviendrait pour tirer une variable, mais pas pour un jeu de
 * données : deux lots de même spécification doivent donner les mêmes prompts,
 * sinon une expérience n'est pas reproductible et comparer deux entraînements
 * ne veut plus rien dire. La graine dérive de l'identifiant du lot et de
 * l'index de l'échantillon.
 */
function seededRandom(seed: string): () => number {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state |= 0;
    return (state >>> 0) / 4294967296;
  };
}

function pick<T>(items: T[], rand: () => number): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(rand() * items.length) % items.length];
}

/** Tirage pondéré : c'est lui qui donne sa forme à la distribution d'outils. */
function pickWeighted(
  weights: Array<{ tool: string; weight: number }>,
  rand: () => number,
): string | null {
  const usable = weights.filter((w) => w.tool.trim() && w.weight > 0);
  if (usable.length === 0) return null;
  const total = usable.reduce((sum, w) => sum + w.weight, 0);
  let threshold = rand() * total;
  for (const entry of usable) {
    threshold -= entry.weight;
    if (threshold <= 0) return entry.tool;
  }
  return usable.at(-1)?.tool ?? null;
}

export const DEFAULT_SPEC: TrainingBatchSpec = {
  agentIds: [],
  promptTemplates: [],
  variables: {},
  samples: 10,
  workers: 1,
  maxAttempts: 1,
  toolWeights: [],
  timeoutSec: null,
  skillId: null,
  grader: null,
};

/**
 * Ordre d'arrêt donné à un lot en cours.
 *
 * La distinction porte à conséquence : une annulation clôt le lot, alors qu'une
 * extinction du serveur doit le laisser « running » pour qu'il reprenne au
 * prochain démarrage. Un booléen unique les confondait, et un redémarrage
 * annulait donc silencieusement les lots en cours.
 */
type StopReason = 'cancel' | 'shutdown';

interface BatchState {
  stop: StopReason | null;
  pause: boolean;
}

export class TrainingService {
  /** Lots en cours d'exécution dans ce processus, et leur ordre d'arrêt. */
  private running = new Map<string, BatchState>();

  constructor(
    private store: Store,
    private bus: Bus,
    private engine: RunEngine,
    private agents: AgentService,
  ) {}

  /**
   * Reprise au démarrage.
   *
   * Les échantillons restés « running » ont été remis en attente par le Store ;
   * un lot qui se croyait en cours redémarre donc là où il s'était arrêté. Sans
   * cela, un redémarrage laisserait un lot figé à 60 % sans que rien ne le
   * signale.
   */
  resumeInterrupted(): void {
    const reset = this.store.resetRunningTrainingItems();
    if (reset > 0) {
      this.bus.log('warn', 'training', `${reset} échantillon(s) remis en attente au démarrage`);
    }
    for (const batch of this.store.listTrainingBatches()) {
      if (batch.status !== 'running') continue;
      this.bus.log('info', 'training', `Reprise du lot « ${batch.name} » (${batch.id})`);
      void this.execute(batch.id);
    }
  }

  shutdown(): void {
    for (const state of this.running.values()) state.stop = 'shutdown';
  }

  // -- Lecture ---------------------------------------------------------------

  list(): TrainingBatch[] {
    return this.store.listTrainingBatches();
  }

  get(id: string): TrainingBatch | null {
    return this.store.getTrainingBatch(id);
  }

  items(batchId: string): TrainingItem[] {
    return this.store.listTrainingItems(batchId);
  }

  /** Runs et scores d'un lot — ce que l'export va lire. */
  runRefs(batchId: string): Array<{ runId: string; score: number | null }> {
    return this.store.listTrainingRunRefs(batchId);
  }

  // -- Export ----------------------------------------------------------------

  /**
   * Construit un export à partir de runs existants.
   *
   * Trois sources possibles, dans cet ordre de priorité : les runs d'un lot,
   * une liste explicite de runs, ou les runs récents de l'instance. La
   * troisième compte : les trajectoires les plus intéressantes sont souvent
   * celles du travail réel, produites avant même qu'on songe à en faire un jeu
   * de données.
   */
  buildDataset(request: TrainingExportRequest): ExportResult {
    const dialect =
      request.dialect && isToolCallDialect(request.dialect) ? request.dialect : DEFAULT_DIALECT;

    const refs: Array<{ runId: string; score: number | null }> = request.batchId
      ? this.store.listTrainingRunRefs(request.batchId)
      : request.runIds?.length
        ? request.runIds.map((runId) => ({ runId, score: this.store.scoreForRun(runId) }))
        : this.store
            .listRuns({ limit: EXPORT_RUN_SCAN_LIMIT })
            .map((run) => ({ runId: run.id, score: this.store.scoreForRun(run.id) }));

    const inputs: ExportInput[] = [];
    /*
     * Runs disparus, rendus compte et non passés sous silence.
     *
     * Le cas arrive : supprimer un agent supprime ses runs, et les échantillons
     * du lot gardent un identifiant orphelin. Les ignorer discrètement rendait
     * un jeu de données plus petit que le lot, sans que rien n'explique l'écart
     * — alors que tous les autres motifs de rejet sont, eux, rapportés.
     */
    const missing: Array<{ runId: string; reason: string }> = [];
    for (const ref of refs) {
      const run = this.store.getRun(ref.runId);
      if (!run) {
        missing.push({ runId: ref.runId, reason: 'run supprimé (agent effacé ?)' });
        continue;
      }
      const agent = this.agents.get(run.agentId);
      const trajectory = buildTrajectory(run, this.store.listRunEvents(run.id), {
        agentName: agent?.name ?? run.agentId,
        systemPrompt: agent?.systemPrompt ?? null,
        includeThinking: request.includeThinking ?? false,
      });
      inputs.push({ trajectory, score: ref.score });
    }

    const result = buildExport(
      {
        format: request.format,
        dialect,
        tokenBudget: request.tokenBudget ?? null,
        onlySucceeded: request.onlySucceeded ?? true,
        requireToolCalls: request.requireToolCalls ?? false,
      },
      inputs,
    );
    // Les runs introuvables viennent en tête : c'est l'écart le moins
    // explicable pour qui relit l'aperçu, donc celui qu'il faut voir d'abord.
    result.preview.skipped = [...missing, ...result.preview.skipped];
    return result;
  }

  /** Trajectoire d'un run seul, pour l'inspecter avant d'exporter un lot. */
  trajectoryOf(runId: string, includeThinking: boolean): Trajectory | null {
    const run = this.store.getRun(runId);
    if (!run) return null;
    const agent = this.agents.get(run.agentId);
    return buildTrajectory(run, this.store.listRunEvents(run.id), {
      agentName: agent?.name ?? run.agentId,
      systemPrompt: agent?.systemPrompt ?? null,
      includeThinking,
    });
  }

  // -- Écriture --------------------------------------------------------------

  private validateSpec(spec: TrainingBatchSpec): void {
    if (spec.agentIds.length === 0) throw new TrainingError('Au moins un agent est requis.');
    for (const id of spec.agentIds) {
      const agent = this.agents.get(id);
      if (!agent) throw new TrainingError(`Agent introuvable : ${id}`);
      /*
       * Un agent en moteur tmux ne convient pas : sa session interactive ne se
       * termine pas d'elle-même, et un lot attendrait indéfiniment. Le refus est
       * explicite plutôt que forcé en douce, parce que le choix du moteur est un
       * réglage volontaire de l'agent.
       */
      if (agent.engine === 'tmux') {
        throw new TrainingError(
          `L'agent « ${agent.name} » est en moteur tmux : sa session ne se termine pas seule, ` +
            `un lot ne peut pas l'attendre. Bascule-le en moteur SDK.`,
        );
      }
    }
    if (spec.promptTemplates.filter((t) => t.trim()).length === 0) {
      throw new TrainingError('Au moins un gabarit de prompt est requis.');
    }
    if (spec.samples < 1) throw new TrainingError('Il faut au moins un échantillon.');
    if (spec.grader && !this.agents.get(spec.grader.agentId)) {
      throw new TrainingError(`Agent juge introuvable : ${spec.grader.agentId}`);
    }
  }

  create(input: { name: string; description?: string; spec: TrainingBatchSpec }): TrainingBatch {
    this.validateSpec(input.spec);
    const now = nowIso();
    const batch: TrainingBatch = {
      id: makeId('tbatch'),
      name: input.name,
      description: input.description ?? '',
      status: 'draft',
      spec: input.spec,
      counts: {
        pending: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        cancelled: 0,
      },
      checkpointIndex: 0,
      error: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      endedAt: null,
    };
    this.store.insertTrainingBatch(batch);
    this.publish(batch);
    return batch;
  }

  update(
    id: string,
    patch: { name?: string; description?: string; spec?: TrainingBatchSpec },
  ): TrainingBatch | null {
    const current = this.store.getTrainingBatch(id);
    if (!current) return null;
    if (current.status === 'running') {
      throw new TrainingError('Un lot en cours ne se modifie pas : mets-le en pause d’abord.');
    }
    if (patch.spec) this.validateSpec(patch.spec);
    const updated: TrainingBatch = {
      ...current,
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      spec: patch.spec ?? current.spec,
      updatedAt: nowIso(),
    };
    this.store.updateTrainingBatch(updated);
    this.publish(updated);
    return updated;
  }

  remove(id: string): boolean {
    const state = this.running.get(id);
    if (state) state.stop = 'cancel';
    const removed = this.store.deleteTrainingBatch(id);
    if (removed) this.bus.publish({ type: 'trainingBatch.deleted', payload: { id } });
    return removed;
  }

  /** Notation humaine d'un échantillon, quand aucun juge n'a été configuré. */
  scoreItem(itemId: string, score: number): TrainingItem | null {
    const item = this.store.getTrainingItem(itemId);
    if (!item) return null;
    const updated: TrainingItem = {
      ...item,
      score: Math.min(1, Math.max(0, score)),
      scoreSource: 'human',
    };
    this.store.updateTrainingItem(updated);
    this.bus.publish({ type: 'trainingItem.updated', payload: updated });
    return updated;
  }

  // -- Exécution -------------------------------------------------------------

  start(id: string): TrainingBatch {
    const batch = this.store.getTrainingBatch(id);
    if (!batch) throw new TrainingError(`Lot introuvable : ${id}`);
    if (batch.status === 'running') throw new TrainingError('Lot déjà en cours.');
    this.validateSpec(batch.spec);

    // Les échantillons sont engendrés une fois pour toutes : c'est le plan du
    // lot, et un plan qui change à chaque reprise n'est pas reproductible.
    if (batch.checkpointIndex === 0) this.generateItems(batch);

    const restarted: TrainingBatch = {
      ...this.store.getTrainingBatch(id)!,
      status: 'running',
      error: null,
      startedAt: batch.startedAt ?? nowIso(),
      endedAt: null,
      updatedAt: nowIso(),
    };
    this.store.updateTrainingBatch(restarted);
    this.publish(restarted);
    void this.execute(id);
    return restarted;
  }

  pause(id: string): boolean {
    const state = this.running.get(id);
    if (!state) return false;
    state.pause = true;
    return true;
  }

  cancel(id: string): boolean {
    const batch = this.store.getTrainingBatch(id);
    if (!batch) return false;
    const state = this.running.get(id);
    if (state) state.stop = 'cancel';

    /*
     * Les échantillons en attente sont annulés tout de suite, sans attendre que
     * les workers s'arrêtent : un lot annulé qui continue d'afficher 800
     * échantillons « en attente » laisse croire qu'il va reprendre.
     */
    for (const item of this.store.listTrainingItems(id)) {
      if (item.status !== 'pending') continue;
      this.saveItem({ ...item, status: 'cancelled', endedAt: nowIso() });
    }
    for (const item of this.store.listTrainingItems(id)) {
      if (item.status === 'running' && item.runId) this.engine.cancel(item.runId);
    }
    if (!state) this.finish(id, 'cancelled');
    return true;
  }

  /**
   * Substitue les variables d'un gabarit.
   *
   * Une valeur absente laisse le marqueur en place plutôt que d'insérer du
   * vide : un prompt amputé en silence produit un échantillon absurde qu'on
   * n'identifie plus dans le jeu de données final.
   */
  private renderTemplate(template: string, values: Record<string, string>): string {
    return template.replaceAll(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
  }

  private generateItems(batch: TrainingBatch): void {
    const spec = batch.spec;
    const templates = spec.promptTemplates.filter((t) => t.trim());
    const agentIds = spec.agentIds;
    const items: TrainingItem[] = [];
    const now = nowIso();

    for (let i = 0; i < spec.samples; i++) {
      const rand = seededRandom(`${batch.id}:${i}`);
      const values: Record<string, string> = {};
      for (const [key, options] of Object.entries(spec.variables)) {
        const value = pick(options, rand);
        if (value !== undefined) values[key] = value;
      }
      // Tour de rôle sur les gabarits : chacun est couvert autant de fois que
      // les autres, là où un tirage laisserait des trous sur un petit lot.
      const template = templates[i % templates.length] ?? '';
      let prompt = this.renderTemplate(template, values);

      const tool = pickWeighted(spec.toolWeights, rand);
      if (tool) {
        prompt += `\n\nPour cette tâche, appuie-toi en priorité sur l'outil « ${tool} ».`;
      }

      items.push({
        id: makeId('titem'),
        batchId: batch.id,
        index: i,
        // Affectation au tour de rôle, révisée au moment de l'exécution selon
        // le worker qui prend l'échantillon.
        agentId: agentIds[i % agentIds.length] ?? '',
        prompt,
        runId: null,
        status: 'pending',
        attempts: 0,
        score: null,
        scoreSource: null,
        toolCallCount: 0,
        totalTokens: 0,
        costUsd: 0,
        error: null,
        createdAt: now,
        endedAt: null,
      });
    }

    this.store.insertTrainingItems(items);
    const updated = { ...batch, checkpointIndex: items.length, updatedAt: nowIso() };
    this.store.updateTrainingBatch(updated);
    this.bus.log(
      'info',
      'training',
      `Lot « ${batch.name} » : ${items.length} échantillon(s) planifié(s)`,
    );
  }

  /**
   * Lance un worker par agent du pool, dans la limite demandée.
   *
   * Les workers se partagent la file des échantillons en attente ; chacun
   * garde son agent, ce qui supprime toute contention sur la sérialisation par
   * agent du moteur de runs.
   */
  private async execute(batchId: string): Promise<void> {
    if (this.running.has(batchId)) return;
    const batch = this.store.getTrainingBatch(batchId);
    if (!batch) return;

    const state: BatchState = { stop: null, pause: false };
    this.running.set(batchId, state);

    const pool = batch.spec.agentIds.filter((id) => this.agents.get(id));
    const workerCount = Math.max(1, Math.min(batch.spec.workers, pool.length));
    if (workerCount < batch.spec.workers) {
      this.bus.log(
        'warn',
        'training',
        `Lot « ${batch.name} » : ${workerCount} worker(s) au lieu de ${batch.spec.workers} — ` +
          `un agent n'exécute qu'un run à la fois, le pool en compte ${pool.length}.`,
      );
    }

    /** File partagée : un seul dépilement à la fois, par construction mono-thread. */
    const claim = (): TrainingItem | null => {
      const [next] = this.store.listPendingTrainingItems(batchId, 1);
      if (!next) return null;
      const claimed: TrainingItem = { ...next, status: 'running', attempts: next.attempts + 1 };
      this.saveItem(claimed);
      return claimed;
    };

    const worker = async (agentId: string): Promise<void> => {
      for (;;) {
        if (state.stop || state.pause) return;
        const item = claim();
        if (!item) return;
        await this.runItem(batch.spec, { ...item, agentId }, state);
      }
    };

    try {
      await Promise.all(pool.slice(0, workerCount).map((agentId) => worker(agentId)));
    } catch (err) {
      this.bus.log('error', 'training', `Lot ${batchId} interrompu : ${String(err)}`);
      this.running.delete(batchId);
      this.finish(batchId, 'failed', err instanceof Error ? err.message : String(err));
      return;
    }

    const paused = state.pause && !state.stop;
    this.running.delete(batchId);

    // Un arrêt à l'extinction du serveur n'est pas une annulation : le lot reste
    // « running », et `resumeInterrupted` le reprendra au prochain démarrage.
    if (state.stop === 'shutdown') return;
    if (paused) {
      this.finish(batchId, 'paused');
      return;
    }
    if (state.stop === 'cancel') {
      this.finish(batchId, 'cancelled');
      return;
    }

    const counts = this.store.getTrainingBatch(batchId)?.counts;
    const failed = counts?.failed ?? 0;
    const succeeded = counts?.succeeded ?? 0;
    this.finish(batchId, succeeded === 0 && failed > 0 ? 'failed' : 'succeeded');
  }

  private async runItem(
    spec: TrainingBatchSpec,
    item: TrainingItem,
    state: BatchState,
  ): Promise<void> {
    let run;
    try {
      run = this.engine.start({
        agentId: item.agentId,
        prompt: item.prompt,
        skillId: spec.skillId,
        origin: 'training',
        originId: item.batchId,
        // Le moteur SDK, toujours : une session tmux ne se termine pas seule.
        engineOverride: 'sdk',
        timeoutSecOverride: spec.timeoutSec,
      });
    } catch (err) {
      this.failItem(item, spec, err instanceof Error ? err.message : String(err));
      return;
    }

    this.saveItem({ ...item, runId: run.id });

    const timeoutMs = spec.timeoutSec ? spec.timeoutSec * 1000 + 30_000 : DEFAULT_ITEM_TIMEOUT_MS;
    const finished = await this.engine.waitForRun(run.id, timeoutMs);

    if (!finished || finished.status !== 'succeeded') {
      const reason = finished
        ? (finished.error ?? `run ${finished.status}`)
        : 'délai dépassé sans résultat';
      if (finished?.status === 'cancelled' && state.stop) {
        this.saveItem({ ...item, runId: run.id, status: 'cancelled', endedAt: nowIso() });
        return;
      }
      this.failItem({ ...item, runId: run.id }, spec, reason);
      return;
    }

    /*
     * Comptage des appels d'outils sur les événements du run, et non sur son
     * texte : c'est le seul décompte qui ne dépende pas du dialecte de rendu, et
     * il sert à repérer les échantillons stériles — un run qui n'a appelé aucun
     * outil n'apprend rien à un modèle qu'on entraîne à s'outiller.
     */
    const events = this.store.listRunEvents(run.id);
    const toolCallCount = events.reduce((n, e) => (e.kind === 'tool_use' ? n + 1 : n), 0);

    const done: TrainingItem = {
      ...item,
      runId: run.id,
      status: 'succeeded',
      toolCallCount,
      totalTokens: finished.inputTokens + finished.outputTokens,
      costUsd: finished.costUsd,
      error: null,
      endedAt: nowIso(),
    };

    if (spec.grader && !state.stop) {
      const score = await this.grade(spec.grader, item.prompt, finished.resultText ?? '');
      if (score !== null) {
        done.score = score;
        done.scoreSource = 'grader';
      }
    }
    this.saveItem(done);
  }

  /**
   * Note une trajectoire avec un agent juge.
   *
   * Sans score, un export destiné au renforcement n'a pas de signal : c'est la
   * récompense qui fait la différence entre un jeu de données supervisé et un
   * jeu de rollouts exploitable par Atropos.
   */
  private async grade(
    grader: NonNullable<TrainingBatchSpec['grader']>,
    prompt: string,
    result: string,
  ): Promise<number | null> {
    try {
      const run = this.engine.start({
        agentId: grader.agentId,
        prompt: grader.promptTemplate
          .replaceAll('{{prompt}}', prompt)
          .replaceAll('{{result}}', result),
        origin: 'training',
        engineOverride: 'sdk',
      });
      const finished = await this.engine.waitForRun(run.id, GRADER_TIMEOUT_MS);
      if (!finished || finished.status !== 'succeeded') return null;
      return parseScore(finished.resultText ?? '');
    } catch (err) {
      this.bus.log('warn', 'training', `Notation impossible : ${String(err)}`);
      return null;
    }
  }

  /** Échec d'un échantillon : remis en file s'il reste des tentatives. */
  private failItem(item: TrainingItem, spec: TrainingBatchSpec, reason: string): void {
    const retryable = item.attempts < Math.max(1, spec.maxAttempts);
    this.saveItem({
      ...item,
      status: retryable ? 'pending' : 'failed',
      error: reason,
      endedAt: retryable ? null : nowIso(),
      ...(retryable ? { runId: null } : {}),
    });
  }

  /**
   * Enregistre un échantillon et rediffuse son lot.
   *
   * Le lot est republié à chaque transition, et pas seulement au début et à la
   * fin : ses compteurs sont la seule source d'avancement affichée dans la
   * liste, et un lot qui reste à « 0 sur 500 » pendant une heure passe pour un
   * lot en panne. Le surcoût est d'un événement par échantillon, là où
   * l'exécution du run en produit des dizaines.
   */
  private saveItem(item: TrainingItem): void {
    this.store.updateTrainingItem(item);
    this.bus.publish({ type: 'trainingItem.updated', payload: item });
    const batch = this.store.getTrainingBatch(item.batchId);
    if (batch) this.publish(batch);
  }

  private finish(batchId: string, status: TrainingBatch['status'], error?: string): void {
    const batch = this.store.getTrainingBatch(batchId);
    if (!batch) return;
    const terminal: TrainingItemStatus[] = ['succeeded', 'failed', 'skipped', 'cancelled'];
    const done = terminal.reduce((n, key) => n + batch.counts[key], 0);
    const updated: TrainingBatch = {
      ...batch,
      status,
      error: error ?? batch.error,
      endedAt: status === 'paused' ? null : nowIso(),
      updatedAt: nowIso(),
    };
    this.store.updateTrainingBatch(updated);
    this.publish(updated);
    this.bus.log(
      status === 'succeeded' ? 'success' : status === 'failed' ? 'error' : 'warn',
      'training',
      `Lot « ${batch.name} » ${status} — ${done}/${batch.checkpointIndex} échantillon(s) traité(s)`,
    );
  }

  private publish(batch: TrainingBatch): void {
    this.bus.publish({ type: 'trainingBatch.updated', payload: batch });
  }
}

/**
 * Lit le score dans la réponse d'un juge.
 *
 * Le dernier nombre de la réponse, et non le premier : un juge commente puis
 * conclut, et son commentaire contient volontiers des chiffres (« 3 appels
 * d'outils »). Un score au-delà de 1 est ramené dans l'intervalle — un juge
 * répond parfois sur 10 ou en pourcentage malgré la consigne.
 */
export function parseScore(text: string): number | null {
  /*
   * La conclusion d'abord.
   *
   * La consigne demande un nombre sur une ligne seule ; quand le juge la suit,
   * lire cette ligne évite tout le bruit du commentaire. On ne retombe sur le
   * texte entier que si la dernière ligne ne porte aucun nombre.
   */
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const lastLine = lines.at(-1);
  return (lastLine ? scoreIn(lastLine) : null) ?? scoreIn(text);
}

/**
 * Lit un score dans un fragment de texte.
 *
 * La fraction est cherchée avant tout nombre isolé, et c'est le cœur du
 * problème : « 0.8/1 », « 0.4 sur 1 » et « 7/10 » sont les formulations
 * spontanées d'un juge, malgré la consigne. Prendre le dernier nombre y
 * retenait le dénominateur — donc 1.0 pour une note basse, une récompense
 * maximale attribuée en silence, et un jeu de données de renforcement dont le
 * signal est inversé sur une part des échantillons.
 */
function scoreIn(fragment: string): number | null {
  const fraction = [
    ...fragment.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:\/|sur)\s*(\d+(?:[.,]\d+)?)/gi),
  ].at(-1);
  if (fraction?.[1] && fraction[2]) {
    const numerator = Number.parseFloat(fraction[1].replace(',', '.'));
    const denominator = Number.parseFloat(fraction[2].replace(',', '.'));
    if (Number.isFinite(numerator)) {
      /*
       * Dénominateur inutilisable : on garde le numérateur.
       *
       * Retomber sur « le dernier nombre du fragment » retiendrait justement ce
       * dénominateur — le défaut même qu'on corrige ici. « 0.5 sur 0 » n'a pas
       * de sens, mais le juge a bien voulu dire 0.5.
       */
      if (denominator > 0) return clampScore(numerator / denominator);
      return scaleLoneNumber(numerator);
    }
  }

  const last = [...fragment.matchAll(/-?\d+(?:[.,]\d+)?/g)].map((m) => m[0]).at(-1);
  if (last === undefined) return null;
  const value = Number.parseFloat(last.replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  return scaleLoneNumber(value);
}

/**
 * Devine l'échelle d'un nombre isolé.
 *
 * Un juge répond parfois sur 10 ou en pourcentage sans le dire. Refuser ces
 * réponses coûterait plus d'échantillons que la déduction n'en dégrade.
 */
function scaleLoneNumber(value: number): number {
  if (value < 0) return 0;
  if (value <= 1) return value;
  if (value <= 10) return value / 10;
  if (value <= 100) return value / 100;
  return 1;
}

function clampScore(value: number): number {
  return Math.min(1, Math.max(0, value));
}
