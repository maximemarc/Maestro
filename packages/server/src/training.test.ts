/**
 * Tests du service de lots, sur une base réelle en mémoire.
 *
 * Le moteur de runs est remplacé par un double : ce qui est vérifié ici, c'est
 * l'ordonnancement (un worker par agent, reprise, tentatives, annulation) et la
 * persistance de l'état, pas la capacité du SDK à exécuter un prompt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig, Run, TrainingBatchSpec } from '@maestro/shared';
import { Bus } from './bus.ts';
import { Store } from './db.ts';
import type { AgentService } from './agents.ts';
import type { RunEngine, StartRunInput } from './runs.ts';
import { DEFAULT_SPEC, TrainingError, TrainingService, parseScore } from './training.ts';

function makeAgent(id: string, patch: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id,
    name: id,
    emoji: '🤖',
    description: '',
    model: 'sonnet',
    engine: 'sdk',
    permissionMode: 'default',
    approvalPolicy: 'auto',
    systemPrompt: null,
    cliAgent: null,
    parentAgentId: null,
    pluginIds: [],
    mcpServerIds: [],
    ragCollectionIds: [],
    workspaceDir: `/tmp/${id}`,
    memoryEnabled: false,
    allowedTools: null,
    disallowedTools: null,
    maxTurns: null,
    timeoutSec: null,
    tokenBudget: null,
    sandbox: null,
    color: '#fff',
    pinned: null,
    archived: false,
    createdAt: '2026-08-28T09:00:00.000Z',
    updatedAt: '2026-08-28T09:00:00.000Z',
    ...patch,
  };
}

/**
 * Double du moteur de runs.
 *
 * Il rejoue la contrainte qui structure tout le service : un agent n'exécute
 * jamais deux runs à la fois. Sans elle, un test passerait alors que la
 * production sérialiserait tout.
 */
class FakeEngine {
  started: StartRunInput[] = [];
  /** Agents occupés à un instant donné, et maximum observé. */
  private busy = new Set<string>();
  maxConcurrent = 0;
  /** Réponses forcées par index d'appel : statut et texte de résultat. */
  script: Array<{ status: Run['status']; resultText?: string }> = [];
  cancelled: string[] = [];

  private runs = new Map<string, Run>();
  private seq = 0;

  start(input: StartRunInput): Run {
    if (this.busy.has(input.agentId)) {
      throw new Error(`double run sur ${input.agentId}`);
    }
    this.busy.add(input.agentId);
    this.maxConcurrent = Math.max(this.maxConcurrent, this.busy.size);
    this.started.push(input);
    this.seq += 1;
    const outcome = this.script[this.seq - 1] ?? { status: 'succeeded' as const };
    const run: Run = {
      id: `run_${this.seq}`,
      agentId: input.agentId,
      origin: input.origin,
      originId: input.originId ?? null,
      parentRunId: null,
      prompt: input.prompt,
      skillId: input.skillId ?? null,
      status: outcome.status,
      sessionId: null,
      model: 'sonnet',
      engine: 'sdk',
      tmuxSession: null,
      numTurns: 1,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.001,
      resultText: outcome.resultText ?? 'fait',
      error: outcome.status === 'succeeded' ? null : 'échec simulé',
      createdAt: '2026-08-28T09:00:00.000Z',
      startedAt: '2026-08-28T09:00:00.000Z',
      endedAt: '2026-08-28T09:00:10.000Z',
    };
    this.runs.set(run.id, run);
    return run;
  }

  async waitForRun(runId: string): Promise<Run | null> {
    /* Une bascule de microtâche : les workers doivent s'entrelacer, sinon le
       test ne mesurerait rien du parallélisme. */
    await Promise.resolve();
    const run = this.runs.get(runId) ?? null;
    if (run) this.busy.delete(run.agentId);
    return run;
  }

  cancel(runId: string): boolean {
    this.cancelled.push(runId);
    return true;
  }
}

function setup(agentIds: string[]) {
  const store = new Store(':memory:');
  const bus = new Bus(store);
  const agents = new Map(agentIds.map((id) => [id, makeAgent(id)]));
  const agentService = {
    get: (id: string) => agents.get(id) ?? null,
  } as unknown as AgentService;
  const engine = new FakeEngine();
  const service = new TrainingService(store, bus, engine as unknown as RunEngine, agentService);
  return { store, bus, engine, service, agents };
}

function spec(patch: Partial<TrainingBatchSpec> = {}): TrainingBatchSpec {
  return {
    ...DEFAULT_SPEC,
    agentIds: ['a1'],
    promptTemplates: ['Analyse {{sujet}}.'],
    variables: { sujet: ['les écritures', 'le bilan'] },
    samples: 4,
    workers: 1,
    ...patch,
  };
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe('validation d’une spécification', () => {
  it('refuse un lot sans agent', () => {
    const { service } = setup([]);
    expect(() => service.create({ name: 'x', spec: spec({ agentIds: [] }) })).toThrow(
      TrainingError,
    );
  });

  it('refuse un agent inconnu', () => {
    const { service } = setup(['a1']);
    expect(() => service.create({ name: 'x', spec: spec({ agentIds: ['fantome'] }) })).toThrow(
      /introuvable/,
    );
  });

  /*
   * Une session tmux interactive ne se termine pas d'elle-même : un lot
   * l'attendrait indéfiniment. Le refus explicite vaut mieux qu'un moteur forcé
   * en douce, le choix du moteur étant un réglage volontaire de l'agent.
   */
  it('refuse un agent en moteur tmux', () => {
    const { service, agents } = setup(['a1']);
    agents.set('a1', makeAgent('a1', { engine: 'tmux' }));
    expect(() => service.create({ name: 'x', spec: spec() })).toThrow(/tmux/);
  });

  it('refuse un lot sans gabarit exploitable', () => {
    const { service } = setup(['a1']);
    expect(() => service.create({ name: 'x', spec: spec({ promptTemplates: ['   '] }) })).toThrow(
      /gabarit/,
    );
  });

  it('refuse un nombre d’échantillons nul', () => {
    const { service } = setup(['a1']);
    expect(() => service.create({ name: 'x', spec: spec({ samples: 0 }) })).toThrow(/échantillon/);
  });

  it('refuse un juge inconnu', () => {
    const { service } = setup(['a1']);
    expect(() =>
      service.create({
        name: 'x',
        spec: spec({ grader: { agentId: 'fantome', promptTemplate: 'note' } }),
      }),
    ).toThrow(/juge/);
  });

  it('crée un lot en brouillon', () => {
    const { service } = setup(['a1']);
    const batch = service.create({ name: 'Lot A', description: 'essai', spec: spec() });
    expect(batch.status).toBe('draft');
    expect(batch.checkpointIndex).toBe(0);
    expect(service.list()).toHaveLength(1);
  });
});

describe('planification des échantillons', () => {
  it('engendre autant d’échantillons que demandé', async () => {
    const { service } = setup(['a1']);
    const batch = service.create({ name: 'x', spec: spec({ samples: 7 }) });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).not.toBe('running'));
    expect(service.items(batch.id)).toHaveLength(7);
  });

  it('substitue les variables du gabarit', async () => {
    const { service } = setup(['a1']);
    const batch = service.create({ name: 'x', spec: spec({ samples: 4 }) });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).not.toBe('running'));
    for (const item of service.items(batch.id)) {
      expect(item.prompt).toMatch(/^Analyse (les écritures|le bilan)\.$/);
    }
  });

  it('laisse en place un marqueur sans valeur', async () => {
    const { service } = setup(['a1']);
    const batch = service.create({
      name: 'x',
      spec: spec({ promptTemplates: ['Voir {{inconnu}}.'], variables: {}, samples: 1 }),
    });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).not.toBe('running'));
    expect(service.items(batch.id)[0]?.prompt).toContain('{{inconnu}}');
  });

  it('couvre les gabarits à tour de rôle', async () => {
    const { service } = setup(['a1']);
    const batch = service.create({
      name: 'x',
      spec: spec({ promptTemplates: ['A', 'B', 'C'], variables: {}, samples: 6 }),
    });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).not.toBe('running'));
    const prompts = service.items(batch.id).map((i) => i.prompt);
    expect(prompts.filter((p) => p === 'A')).toHaveLength(2);
    expect(prompts.filter((p) => p === 'B')).toHaveLength(2);
    expect(prompts.filter((p) => p === 'C')).toHaveLength(2);
  });

  /*
   * Reproductibilité : deux lots de même spécification doivent donner les mêmes
   * prompts, sinon comparer deux entraînements ne veut rien dire. La graine
   * dérive de l'identifiant du lot, donc deux lots distincts diffèrent — mais
   * chacun est stable, ce que vérifie la reprise.
   */
  it('produit un plan stable pour un même lot', async () => {
    const { service } = setup(['a1']);
    const batch = service.create({ name: 'x', spec: spec({ samples: 5 }) });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).not.toBe('running'));
    const first = service.items(batch.id).map((i) => i.prompt);

    // Relance : le plan existant est conservé, pas régénéré.
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).not.toBe('running'));
    expect(service.items(batch.id).map((i) => i.prompt)).toEqual(first);
    expect(service.items(batch.id)).toHaveLength(5);
  });

  it('injecte une consigne d’outil selon la pondération', async () => {
    const { service } = setup(['a1']);
    const batch = service.create({
      name: 'x',
      spec: spec({
        samples: 6,
        variables: {},
        promptTemplates: ['Fais.'],
        toolWeights: [{ tool: 'Read', weight: 1 }],
      }),
    });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).not.toBe('running'));
    for (const item of service.items(batch.id)) {
      expect(item.prompt).toContain('« Read »');
    }
  });

  it('ignore une pondération vide ou nulle', async () => {
    const { service } = setup(['a1']);
    const batch = service.create({
      name: 'x',
      spec: spec({
        samples: 2,
        variables: {},
        promptTemplates: ['Fais.'],
        toolWeights: [
          { tool: '  ', weight: 5 },
          { tool: 'Read', weight: 0 },
        ],
      }),
    });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).not.toBe('running'));
    for (const item of service.items(batch.id)) {
      expect(item.prompt).toBe('Fais.');
    }
  });
});

describe('exécution', () => {
  it('mène chaque échantillon à son terme et clôt le lot', async () => {
    const { service, engine } = setup(['a1']);
    const batch = service.create({ name: 'x', spec: spec({ samples: 3 }) });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).toBe('succeeded'));

    const final = service.get(batch.id);
    expect(final?.counts.succeeded).toBe(3);
    expect(final?.endedAt).not.toBeNull();
    expect(engine.started).toHaveLength(3);
    for (const item of service.items(batch.id)) {
      expect(item.runId).toMatch(/^run_/);
      expect(item.totalTokens).toBe(15);
      expect(item.attempts).toBe(1);
    }
  });

  it('force le moteur SDK et transmet la skill et le délai', async () => {
    const { service, engine } = setup(['a1']);
    const batch = service.create({
      name: 'x',
      spec: spec({ samples: 1, skillId: 'skill_1', timeoutSec: 60 }),
    });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).toBe('succeeded'));
    expect(engine.started[0]?.engineOverride).toBe('sdk');
    expect(engine.started[0]?.skillId).toBe('skill_1');
    expect(engine.started[0]?.timeoutSecOverride).toBe(60);
    expect(engine.started[0]?.origin).toBe('training');
    expect(engine.started[0]?.originId).toBe(batch.id);
  });

  /*
   * Le parallélisme vient du pool d'agents, pas du nombre de workers : un agent
   * n'exécute qu'un run à la fois. Demander huit workers sur deux agents doit
   * donner deux runs simultanés, et le double du moteur lève si l'invariant est
   * violé.
   */
  it('borne le parallélisme au nombre d’agents du pool', async () => {
    const { service, engine } = setup(['a1', 'a2']);
    const batch = service.create({
      name: 'x',
      spec: spec({ agentIds: ['a1', 'a2'], workers: 8, samples: 6 }),
    });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).toBe('succeeded'));
    expect(engine.maxConcurrent).toBeLessThanOrEqual(2);
    expect(engine.maxConcurrent).toBeGreaterThan(1);
  });

  it('n’emploie qu’un agent quand un seul worker est demandé', async () => {
    const { service, engine } = setup(['a1', 'a2']);
    const batch = service.create({
      name: 'x',
      spec: spec({ agentIds: ['a1', 'a2'], workers: 1, samples: 4 }),
    });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).toBe('succeeded'));
    expect(engine.maxConcurrent).toBe(1);
    expect(new Set(engine.started.map((s) => s.agentId)).size).toBe(1);
  });

  it('retente un échantillon en échec dans la limite des tentatives', async () => {
    const { service, engine } = setup(['a1']);
    engine.script = [{ status: 'failed' }, { status: 'succeeded' }];
    const batch = service.create({ name: 'x', spec: spec({ samples: 1, maxAttempts: 2 }) });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).toBe('succeeded'));
    expect(engine.started).toHaveLength(2);
    expect(service.items(batch.id)[0]?.attempts).toBe(2);
    expect(service.items(batch.id)[0]?.status).toBe('succeeded');
  });

  it('abandonne un échantillon après la dernière tentative', async () => {
    const { service, engine } = setup(['a1']);
    engine.script = [{ status: 'failed' }];
    const batch = service.create({ name: 'x', spec: spec({ samples: 1, maxAttempts: 1 }) });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).toBe('failed'));
    const item = service.items(batch.id)[0];
    expect(item?.status).toBe('failed');
    expect(item?.error).toContain('échec');
    expect(item?.endedAt).not.toBeNull();
  });

  it('refuse de démarrer deux fois', async () => {
    const { service } = setup(['a1']);
    const batch = service.create({ name: 'x', spec: spec({ samples: 2 }) });
    service.start(batch.id);
    expect(() => service.start(batch.id)).toThrow(/en cours/);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).not.toBe('running'));
  });

  it('refuse de modifier un lot en cours', async () => {
    const { service } = setup(['a1']);
    const batch = service.create({ name: 'x', spec: spec({ samples: 2 }) });
    service.start(batch.id);
    expect(() => service.update(batch.id, { name: 'y' })).toThrow(/pause/);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).not.toBe('running'));
  });
});

describe('notation', () => {
  it('note chaque échantillon avec le juge configuré', async () => {
    const { service, engine } = setup(['a1', 'juge']);
    /* Un run d'échantillon, puis un run de notation, en alternance. */
    engine.script = [
      { status: 'succeeded', resultText: 'travail fait' },
      { status: 'succeeded', resultText: 'Correct et complet. 0.8' },
    ];
    const batch = service.create({
      name: 'x',
      spec: spec({
        samples: 1,
        grader: { agentId: 'juge', promptTemplate: 'Note {{prompt}} → {{result}}' },
      }),
    });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).toBe('succeeded'));

    const item = service.items(batch.id)[0];
    expect(item?.score).toBeCloseTo(0.8);
    expect(item?.scoreSource).toBe('grader');
    expect(engine.started[1]?.agentId).toBe('juge');
    expect(engine.started[1]?.prompt).toContain('travail fait');
  });

  it('laisse l’échantillon sans score si le juge échoue', async () => {
    const { service, engine } = setup(['a1', 'juge']);
    engine.script = [{ status: 'succeeded' }, { status: 'failed' }];
    const batch = service.create({
      name: 'x',
      spec: spec({ samples: 1, grader: { agentId: 'juge', promptTemplate: 'note' } }),
    });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).toBe('succeeded'));
    expect(service.items(batch.id)[0]?.score).toBeNull();
  });

  it('accepte une notation humaine', async () => {
    const { service } = setup(['a1']);
    const batch = service.create({ name: 'x', spec: spec({ samples: 1 }) });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).toBe('succeeded'));
    const item = service.items(batch.id)[0]!;
    const scored = service.scoreItem(item.id, 0.5);
    expect(scored?.score).toBe(0.5);
    expect(scored?.scoreSource).toBe('human');
  });

  it('borne une notation humaine hors intervalle', async () => {
    const { service } = setup(['a1']);
    const batch = service.create({ name: 'x', spec: spec({ samples: 1 }) });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).toBe('succeeded'));
    const item = service.items(batch.id)[0]!;
    expect(service.scoreItem(item.id, 42)?.score).toBe(1);
    expect(service.scoreItem(item.id, -3)?.score).toBe(0);
  });
});

describe('lecture du score d’un juge', () => {
  it('retient le dernier nombre, non le premier', () => {
    expect(parseScore('3 appels d’outils, tout est correct. 0.9')).toBeCloseTo(0.9);
  });

  /*
   * Le piège central : « 0.8/1 » et « 0.4 sur 1 » sont les formulations
   * spontanées d'un juge malgré la consigne. Retenir le dénominateur y donnait
   * 1.0 — une récompense maximale sur une note basse, attribuée en silence, qui
   * inverse le signal d'apprentissage sur une part du jeu de données.
   */
  it('lit une fraction et non son dénominateur', () => {
    expect(parseScore('0.8/1')).toBeCloseTo(0.8);
    expect(parseScore('Score : 0.8 sur 1')).toBeCloseTo(0.8);
    expect(parseScore('3 outils utilisés, note 0.4 sur 1')).toBeCloseTo(0.4);
  });

  it('ramène une fraction sur dix dans l’intervalle', () => {
    expect(parseScore('Note finale : 7/10')).toBeCloseTo(0.7);
    expect(parseScore('Correct. 85/100')).toBeCloseTo(0.85);
  });

  it('ignore un dénominateur nul plutôt que de diviser par zéro', () => {
    expect(parseScore('0.5 sur 0')).toBeCloseTo(0.5);
  });

  it('privilégie la conclusion sur le commentaire', () => {
    expect(parseScore('J’ai compté 3 outils et 12 fichiers.\n0.6')).toBeCloseTo(0.6);
  });

  it('retombe sur le texte entier si la dernière ligne ne chiffre rien', () => {
    expect(parseScore('Score : 0.45\nRien à ajouter.')).toBeCloseTo(0.45);
  });

  it('borne une fraction supérieure à un', () => {
    expect(parseScore('12/10')).toBe(1);
  });

  it('ramène une note sur 10 dans l’intervalle', () => {
    expect(parseScore('Bon travail. 8')).toBeCloseTo(0.8);
  });

  it('ramène un pourcentage dans l’intervalle', () => {
    expect(parseScore('Score : 75')).toBeCloseTo(0.75);
  });

  it('accepte la virgule décimale', () => {
    expect(parseScore('0,65')).toBeCloseTo(0.65);
  });

  it('plafonne au-delà de cent', () => {
    expect(parseScore('1000')).toBe(1);
  });

  it('plancher à zéro sur un nombre négatif', () => {
    expect(parseScore('-4')).toBe(0);
  });

  it('rend null sans aucun nombre', () => {
    expect(parseScore('Impossible à juger.')).toBeNull();
  });
});

describe('annulation et reprise', () => {
  it('annule les échantillons en attente', async () => {
    const { service } = setup(['a1']);
    const batch = service.create({ name: 'x', spec: spec({ samples: 20 }) });
    service.start(batch.id);
    service.cancel(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).not.toBe('running'));
    const final = service.get(batch.id);
    expect(final?.status).toBe('cancelled');
    expect(final?.counts.pending).toBe(0);
    expect(final?.counts.cancelled).toBeGreaterThan(0);
  });

  it('annule un lot jamais démarré', () => {
    const { service } = setup(['a1']);
    const batch = service.create({ name: 'x', spec: spec() });
    expect(service.cancel(batch.id)).toBe(true);
    expect(service.get(batch.id)?.status).toBe('cancelled');
  });

  it('met un lot en pause, puis le reprend là où il s’était arrêté', async () => {
    const { service } = setup(['a1']);
    const batch = service.create({ name: 'x', spec: spec({ samples: 6 }) });
    service.start(batch.id);
    service.pause(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).toBe('paused'));

    const doneAtPause = service.get(batch.id)?.counts.succeeded ?? 0;
    expect(doneAtPause).toBeLessThan(6);

    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).toBe('succeeded'));
    expect(service.get(batch.id)?.counts.succeeded).toBe(6);
    // Aucun échantillon n'a été rejoué : le total reste celui du plan.
    expect(service.items(batch.id)).toHaveLength(6);
  });

  /*
   * Reprise après redémarrage : les échantillons « running » n'ont plus de
   * processus derrière eux. Sans remise en attente, un lot resterait figé.
   */
  it('remet en attente les échantillons interrompus au démarrage', async () => {
    const { service, store, engine } = setup(['a1']);
    const batch = service.create({ name: 'x', spec: spec({ samples: 2 }) });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).toBe('succeeded'));

    // Simule un arrêt brutal en pleine exécution.
    const items = service.items(batch.id);
    store.updateTrainingItem({ ...items[0]!, status: 'running', endedAt: null });
    const running = { ...service.get(batch.id)!, status: 'running' as const };
    store.updateTrainingBatch(running);

    engine.script = [];
    service.resumeInterrupted();
    await vi.waitFor(() => expect(service.get(batch.id)?.status).toBe('succeeded'));
    expect(service.get(batch.id)?.counts.running).toBe(0);
    expect(service.get(batch.id)?.counts.succeeded).toBe(2);
  });

  it('supprime un lot et ses échantillons', async () => {
    const { service, store } = setup(['a1']);
    const batch = service.create({ name: 'x', spec: spec({ samples: 2 }) });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).toBe('succeeded'));
    expect(service.remove(batch.id)).toBe(true);
    expect(service.get(batch.id)).toBeNull();
    expect(store.listTrainingItems(batch.id)).toHaveLength(0);
  });

  it('rend faux à la suppression d’un lot inconnu', () => {
    const { service } = setup(['a1']);
    expect(service.remove('tbatch_inconnu')).toBe(false);
  });
});

describe('export d’un lot', () => {
  beforeEach(() => {
    cleanup = [];
  });

  it('exporte les trajectoires des runs du lot avec leurs scores', async () => {
    const { service, store } = setup(['a1']);
    const batch = service.create({ name: 'x', spec: spec({ samples: 2 }) });
    service.start(batch.id);
    await vi.waitFor(() => expect(service.get(batch.id)?.status).toBe('succeeded'));

    /* Le double du moteur n'écrit pas en base : on y inscrit les runs et leurs
       événements pour que l'export ait de la matière à lire. */
    store.insertAgent(makeAgent('a1'));
    for (const item of service.items(batch.id)) {
      const run: Run = {
        id: item.runId!,
        agentId: 'a1',
        origin: 'training',
        originId: batch.id,
        parentRunId: null,
        prompt: item.prompt,
        skillId: null,
        status: 'succeeded',
        sessionId: null,
        model: 'sonnet',
        engine: 'sdk',
        tmuxSession: null,
        numTurns: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.001,
        resultText: 'réponse',
        error: null,
        createdAt: '2026-08-28T09:00:00.000Z',
        startedAt: null,
        endedAt: '2026-08-28T09:00:10.000Z',
      };
      store.insertRun(run);
      store.insertRunEvent(run.id, 'a1', 'tool_use', {
        toolName: 'Read',
        toolInput: { path: 'a.md' },
        toolUseId: 'tu_1',
      });
      store.insertRunEvent(run.id, 'a1', 'tool_result', { toolUseId: 'tu_1', text: 'contenu' });
      service.scoreItem(item.id, 0.6);
    }

    const result = service.buildDataset({ format: 'atropos', batchId: batch.id });
    expect(result.lines).toHaveLength(2);
    const parsed = JSON.parse(result.lines[0]!) as { score: number; metadata: { agent: string } };
    expect(parsed.score).toBeCloseTo(0.6);
    expect(parsed.metadata.agent).toBe('a1');
  });

  it('retombe sur le dialecte par défaut si celui demandé est inconnu', () => {
    const { service } = setup(['a1']);
    const result = service.buildDataset({
      format: 'sharegpt',
      runIds: [],
      dialect: 'inconnu' as never,
    });
    expect(result.preview.dialect).toBe('hermes');
  });

  it('rend une trajectoire nulle pour un run inconnu', () => {
    const { service } = setup(['a1']);
    expect(service.trajectoryOf('run_fantome', false)).toBeNull();
  });

  /*
   * Supprimer un agent supprime ses runs ; les échantillons du lot gardent un
   * identifiant orphelin. L'écart doit apparaître dans l'aperçu, sans quoi le
   * jeu de données est plus petit que le lot sans explication.
   */
  it('rapporte les runs disparus au lieu de les ignorer', () => {
    const { service } = setup(['a1']);
    const result = service.buildDataset({ format: 'sharegpt', runIds: ['run_disparu'] });
    expect(result.lines).toHaveLength(0);
    expect(result.preview.skipped).toEqual([
      { runId: 'run_disparu', reason: 'run supprimé (agent effacé ?)' },
    ]);
  });
});
