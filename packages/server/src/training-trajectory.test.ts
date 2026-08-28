import { describe, expect, it } from 'vitest';
import type { Run, RunEvent, RunEventKind, RunEventPayload } from '@maestro/shared';
import {
  buildTrajectory,
  compressTrajectory,
  estimateTokens,
  mergeCompression,
} from './training-trajectory.ts';

function makeRun(patch: Partial<Run> = {}): Run {
  return {
    id: 'run_1',
    agentId: 'agent_1',
    origin: 'manual',
    originId: null,
    parentRunId: null,
    prompt: 'Range le dossier des écritures.',
    skillId: null,
    status: 'succeeded',
    sessionId: 'sess_1',
    model: 'sonnet',
    engine: 'sdk',
    tmuxSession: null,
    numTurns: 3,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    costUsd: 0.02,
    resultText: 'Dossier rangé.',
    error: null,
    createdAt: '2026-08-28T09:00:00.000Z',
    startedAt: '2026-08-28T09:00:01.000Z',
    endedAt: '2026-08-28T09:00:30.000Z',
    ...patch,
  };
}

let seq = 0;
function ev(kind: RunEventKind, payload: RunEventPayload): RunEvent {
  seq += 1;
  return {
    id: seq,
    runId: 'run_1',
    agentId: 'agent_1',
    ts: '2026-08-28T09:00:02.000Z',
    kind,
    payload,
  };
}

/** Un run typique : un peu de texte, un outil, son retour, la réponse. */
function typicalEvents(): RunEvent[] {
  return [
    ev('init', { sessionId: 'sess_1', model: 'sonnet', tools: ['Read'] }),
    ev('thinking', { text: 'Il faut lister le dossier.' }),
    ev('assistant_text', { text: 'Je regarde le dossier.' }),
    ev('tool_use', { toolName: 'Read', toolInput: { path: 'a.md' }, toolUseId: 'tu_1' }),
    ev('tool_result', { toolUseId: 'tu_1', isError: false, text: 'contenu de a.md' }),
    ev('assistant_text', { text: 'Dossier rangé.' }),
    ev('result', {
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
      costUsd: 0.02,
      numTurns: 3,
      durationMs: 29_000,
    }),
  ];
}

describe('construction d’une trajectoire', () => {
  it('ouvre sur la consigne de l’utilisateur', () => {
    const t = buildTrajectory(makeRun(), typicalEvents(), { agentName: 'Comptable' });
    expect(t.turns[0]?.role).toBe('user');
    expect(t.turns[0]?.content).toBe('Range le dossier des écritures.');
  });

  it('place la consigne système avant la consigne utilisateur', () => {
    const t = buildTrajectory(makeRun(), typicalEvents(), {
      agentName: 'Comptable',
      systemPrompt: 'Tu es rigoureux.',
    });
    expect(t.turns.map((x) => x.role).slice(0, 2)).toEqual(['system', 'user']);
  });

  it('ignore une consigne système vide', () => {
    const t = buildTrajectory(makeRun(), typicalEvents(), {
      agentName: 'Comptable',
      systemPrompt: '   ',
    });
    expect(t.turns[0]?.role).toBe('user');
  });

  it('apparie l’appel d’outil et son retour', () => {
    const t = buildTrajectory(makeRun(), typicalEvents(), { agentName: 'Comptable' });
    const assistant = t.turns.find((x) => x.role === 'assistant' && x.toolCalls?.length);
    const tool = t.turns.find((x) => x.role === 'tool');
    expect(assistant?.toolCalls?.[0]?.name).toBe('Read');
    expect(assistant?.toolCalls?.[0]?.arguments).toEqual({ path: 'a.md' });
    expect(tool?.toolCallId).toBe('tu_1');
    expect(tool?.toolName).toBe('Read');
  });

  it('exclut la réflexion par défaut', () => {
    const t = buildTrajectory(makeRun(), typicalEvents(), { agentName: 'Comptable' });
    expect(t.turns.some((x) => x.thinking)).toBe(false);
  });

  it('conserve la réflexion à la demande', () => {
    const t = buildTrajectory(makeRun(), typicalEvents(), {
      agentName: 'Comptable',
      includeThinking: true,
    });
    expect(t.turns.find((x) => x.thinking)?.thinking).toContain('lister le dossier');
  });

  /*
   * Le SDK émet un événement par bloc de contenu. Deux textes et deux appels
   * qui appartenaient au même message du modèle doivent redevenir un seul tour :
   * un modèle entraîné sur des tours éclatés apprendrait à s'arrêter après
   * chaque phrase.
   */
  it('regroupe en un seul tour les blocs d’un même message', () => {
    const events = [
      ev('assistant_text', { text: 'Première partie.' }),
      ev('assistant_text', { text: 'Seconde partie.' }),
      ev('tool_use', { toolName: 'A', toolInput: {}, toolUseId: 'tu_a' }),
      ev('tool_use', { toolName: 'B', toolInput: {}, toolUseId: 'tu_b' }),
      ev('tool_result', { toolUseId: 'tu_a', text: 'ra' }),
    ];
    const t = buildTrajectory(makeRun({ resultText: null }), events, { agentName: 'A' });
    const assistants = t.turns.filter((x) => x.role === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.content).toBe('Première partie.\nSeconde partie.');
    expect(assistants[0]?.toolCalls).toHaveLength(2);
  });

  it('liste les outils employés, sans doublon et dans l’ordre', () => {
    const events = [
      ev('tool_use', { toolName: 'Read', toolInput: {}, toolUseId: '1' }),
      ev('tool_use', { toolName: 'Write', toolInput: {}, toolUseId: '2' }),
      ev('tool_use', { toolName: 'Read', toolInput: {}, toolUseId: '3' }),
    ];
    expect(buildTrajectory(makeRun(), events, { agentName: 'A' }).toolsUsed).toEqual([
      'Read',
      'Write',
    ]);
  });

  it('signale un retour d’outil tronqué à la capture', () => {
    const events = [
      ev('tool_use', { toolName: 'Read', toolInput: {}, toolUseId: 'tu_1' }),
      ev('tool_result', { toolUseId: 'tu_1', text: 'début du fichier…' }),
    ];
    const t = buildTrajectory(makeRun(), events, { agentName: 'A' });
    expect(t.turns.find((x) => x.role === 'tool')?.truncated).toBe(true);
  });

  /*
   * Un run peut se terminer sur un rapport transmis via l'outil de contrôle :
   * le dernier événement est alors un retour d'outil. La cible d'apprentissage
   * doit rester une réponse d'assistant.
   */
  it('ajoute la réponse finale quand le dernier tour est une observation', () => {
    const events = [
      ev('tool_use', { toolName: 'Read', toolInput: {}, toolUseId: 'tu_1' }),
      ev('tool_result', { toolUseId: 'tu_1', text: 'contenu' }),
    ];
    const t = buildTrajectory(makeRun({ resultText: 'Voici la synthèse.' }), events, {
      agentName: 'A',
    });
    expect(t.turns.at(-1)?.role).toBe('assistant');
    expect(t.turns.at(-1)?.content).toBe('Voici la synthèse.');
  });

  it('ne duplique pas une réponse finale déjà présente', () => {
    const t = buildTrajectory(makeRun({ resultText: 'Dossier rangé.' }), typicalEvents(), {
      agentName: 'A',
    });
    expect(t.turns.filter((x) => x.content === 'Dossier rangé.')).toHaveLength(1);
  });

  it('reporte l’usage, le coût et la durée du run', () => {
    const t = buildTrajectory(makeRun(), typicalEvents(), { agentName: 'Comptable' });
    expect(t.usage.inputTokens).toBe(100);
    expect(t.costUsd).toBe(0.02);
    expect(t.durationMs).toBe(29_000);
    expect(t.agentName).toBe('Comptable');
    expect(t.estimatedTokens).toBeGreaterThan(0);
  });

  it('produit une trajectoire lisible d’un run sans événement', () => {
    const t = buildTrajectory(makeRun({ resultText: null }), [], { agentName: 'A' });
    expect(t.turns).toHaveLength(1);
    expect(t.toolsUsed).toEqual([]);
  });
});

describe('compression sous budget', () => {
  /** Trajectoire volumineuse : dix allers-retours d’outil de 2 000 caractères. */
  function heavyEvents(): RunEvent[] {
    const events: RunEvent[] = [ev('assistant_text', { text: 'Je commence.' })];
    for (let i = 0; i < 10; i++) {
      events.push(ev('thinking', { text: `réflexion ${i} `.repeat(20) }));
      events.push(ev('tool_use', { toolName: 'Read', toolInput: { i }, toolUseId: `tu_${i}` }));
      events.push(ev('tool_result', { toolUseId: `tu_${i}`, text: 'x'.repeat(2000) }));
    }
    events.push(ev('assistant_text', { text: 'Terminé.' }));
    return events;
  }

  const heavy = () =>
    buildTrajectory(makeRun(), heavyEvents(), { agentName: 'A', includeThinking: true });

  it('ne touche à rien sans budget', () => {
    const t = heavy();
    const out = compressTrajectory(t, null);
    expect(out.compression.applied).toBe(false);
    expect(out.trajectory).toBe(t);
  });

  it('ne touche à rien si la trajectoire tient déjà dans le budget', () => {
    const t = heavy();
    const out = compressTrajectory(t, t.estimatedTokens + 1);
    expect(out.compression.applied).toBe(false);
  });

  it('respecte le budget demandé', () => {
    const out = compressTrajectory(heavy(), 800);
    expect(out.compression.applied).toBe(true);
    expect(out.compression.withinBudget).toBe(true);
    expect(out.trajectory.estimatedTokens).toBeLessThanOrEqual(800);
    expect(estimateTokens(out.trajectory.turns)).toBe(out.trajectory.estimatedTokens);
  });

  /*
   * Le budget est un objectif, pas une garantie : une trajectoire réduite à sa
   * consigne et sa réponse ne peut plus rétrécir. Le taire laisserait croire à
   * un corpus calibré qui ne l'est pas.
   */
  it('avoue quand la compression ne suffit pas', () => {
    const t = buildTrajectory(
      makeRun({ resultText: null }),
      [ev('assistant_text', { text: 'x'.repeat(20_000) })],
      { agentName: 'A' },
    );
    const out = compressTrajectory(t, 50);
    expect(out.compression.applied).toBe(true);
    expect(out.compression.withinBudget).toBe(false);
    expect(out.trajectory.estimatedTokens).toBeGreaterThan(50);
  });

  it('sacrifie la réflexion avant les retours d’outils', () => {
    const t = heavy();
    // Budget juste inférieur : la seule réflexion suffit à repasser dessous.
    const thinkingTokens = t.turns.reduce(
      (n, turn) => n + Math.ceil((turn.thinking?.length ?? 0) / 4),
      0,
    );
    const out = compressTrajectory(t, t.estimatedTokens - Math.floor(thinkingTokens / 2));
    expect(out.compression.droppedThinkingTurns).toBeGreaterThan(0);
    expect(out.compression.truncatedToolResults).toBe(0);
    expect(out.compression.droppedTurns).toBe(0);
  });

  it('conserve la consigne initiale et la réponse finale', () => {
    const out = compressTrajectory(heavy(), 400);
    expect(out.trajectory.turns[0]?.role).toBe('user');
    expect(out.trajectory.turns.at(-1)?.role).toBe('assistant');
    expect(out.trajectory.turns.at(-1)?.content).toBe('Terminé.');
  });

  it('marque les retours d’outils raccourcis', () => {
    const out = compressTrajectory(heavy(), 1500);
    const shortened = out.trajectory.turns.filter((x) => x.role === 'tool' && x.truncated);
    expect(shortened.length).toBeGreaterThan(0);
    expect(out.compression.truncatedToolResults).toBe(shortened.length);
  });

  /*
   * Invariant non négociable : un chargeur de jeu de données rejette une
   * conversation où une observation ne répond à aucun appel, ou l'inverse.
   */
  it('laisse appels et observations appariés', () => {
    for (const budget of [2000, 1200, 800, 400, 200, 100]) {
      const out = compressTrajectory(heavy(), budget);
      const callIds = out.trajectory.turns.flatMap((t) => (t.toolCalls ?? []).map((c) => c.id));
      const resultIds = out.trajectory.turns
        .filter((t) => t.role === 'tool')
        .map((t) => t.toolCallId ?? '');
      expect([...resultIds].sort()).toEqual([...callIds].sort());
    }
  });

  it('n’altère pas la trajectoire d’origine', () => {
    const t = heavy();
    const turnsBefore = JSON.stringify(t.turns);
    compressTrajectory(t, 300);
    expect(JSON.stringify(t.turns)).toBe(turnsBefore);
  });

  it('met à jour la liste des outils après une coupe', () => {
    const out = compressTrajectory(heavy(), 200);
    for (const name of out.trajectory.toolsUsed) {
      expect(out.trajectory.turns.some((t) => t.toolCalls?.some((c) => c.name === name))).toBe(
        true,
      );
    }
  });
});

describe('agrégation des comptes rendus', () => {
  it('additionne les compteurs et retient le dernier budget', () => {
    const a = compressTrajectory(
      buildTrajectory(makeRun(), typicalEvents(), { agentName: 'A' }),
      null,
    ).compression;
    const merged = mergeCompression(a, {
      applied: true,
      withinBudget: false,
      tokenBudget: 500,
      tokensBefore: 10,
      tokensAfter: 5,
      droppedThinkingTurns: 1,
      truncatedToolResults: 2,
      droppedTurns: 3,
    });
    expect(merged.applied).toBe(true);
    expect(merged.tokenBudget).toBe(500);
    expect(merged.droppedTurns).toBe(3);
    expect(merged.tokensBefore).toBe(a.tokensBefore + 10);
  });
});
