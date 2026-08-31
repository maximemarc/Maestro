import { describe, expect, it } from 'vitest';
import type { Trajectory } from '@maestro/shared';
import { type ExportInput, buildExport, toJsonl } from './training-export.ts';

function makeTrajectory(patch: Partial<Trajectory> = {}): Trajectory {
  return {
    runId: 'run_1',
    agentId: 'agent_1',
    agentName: 'Comptable',
    model: 'sonnet',
    status: 'succeeded',
    turns: [
      { role: 'system', content: 'Tu es rigoureux.' },
      { role: 'user', content: 'Lis a.md.' },
      {
        role: 'assistant',
        content: 'Je lis le fichier.',
        toolCalls: [{ id: 'tu_1', name: 'Read', arguments: { path: 'a.md' } }],
      },
      { role: 'tool', content: 'contenu', toolCallId: 'tu_1', toolName: 'Read', isError: false },
      { role: 'assistant', content: 'Voici le contenu.' },
    ],
    toolsUsed: ['Read'],
    estimatedTokens: 40,
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    costUsd: 0.01,
    durationMs: 1200,
    createdAt: '2026-08-28T09:00:00.000Z',
    ...patch,
  };
}

const OPTIONS = {
  format: 'sharegpt' as const,
  dialect: 'hermes' as const,
  tokenBudget: null,
  onlySucceeded: true,
  requireToolCalls: false,
};

function one(patch: Partial<Trajectory> = {}, score: number | null = null): ExportInput[] {
  return [{ trajectory: makeTrajectory(patch), score }];
}

describe('format ShareGPT', () => {
  it('traduit les rôles selon la convention outillée', () => {
    const { lines } = buildExport(OPTIONS, one());
    const parsed = JSON.parse(lines[0] ?? '{}') as { conversations: Array<{ from: string }> };
    expect(parsed.conversations.map((c) => c.from)).toEqual([
      'system',
      'human',
      'gpt',
      'observation',
      'gpt',
    ]);
  });

  it('rend les appels d’outils dans le texte du tour, selon le dialecte', () => {
    const { lines } = buildExport(OPTIONS, one());
    const parsed = JSON.parse(lines[0] ?? '{}') as {
      conversations: Array<{ from: string; value: string }>;
    };
    const gpt = parsed.conversations[2];
    expect(gpt?.value).toContain('Je lis le fichier.');
    expect(gpt?.value).toContain('<tool_call>');
    expect(parsed.conversations[3]?.value).toContain('<tool_response>');
  });

  it('change de marqueurs quand on change de dialecte', () => {
    const { lines } = buildExport({ ...OPTIONS, dialect: 'mistral' }, one());
    expect(lines[0]).toContain('[TOOL_CALLS]');
    expect(lines[0]).not.toContain('tool_call>');
  });
});

describe('format OpenAI', () => {
  it('écrit des tool_calls structurés et un rôle tool apparié', () => {
    const { lines } = buildExport({ ...OPTIONS, format: 'openai' }, one());
    const parsed = JSON.parse(lines[0] ?? '{}') as {
      messages: Array<{
        role: string;
        content: string | null;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        tool_call_id?: string;
      }>;
    };
    expect(parsed.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    const call = parsed.messages[2]?.tool_calls?.[0];
    expect(call?.id).toBe('tu_1');
    expect(JSON.parse(call?.function.arguments ?? '{}')).toEqual({ path: 'a.md' });
    expect(parsed.messages[3]?.tool_call_id).toBe('tu_1');
  });
});

describe('format Atropos', () => {
  it('joint le score et la métadonnée du run', () => {
    const { lines } = buildExport({ ...OPTIONS, format: 'atropos' }, one({}, 0.75));
    const parsed = JSON.parse(lines[0] ?? '{}') as {
      score: number;
      metadata: { run_id: string; tools_used: string[] };
      messages: unknown[];
    };
    expect(parsed.score).toBe(0.75);
    expect(parsed.metadata.run_id).toBe('run_1');
    expect(parsed.metadata.tools_used).toEqual(['Read']);
    expect(parsed.messages).toHaveLength(5);
  });

  /*
   * Un rollout sans récompense n'apprend rien à un algorithme de renforcement.
   * L'écarter en le disant vaut mieux que lui inventer un score par défaut, qui
   * biaiserait l'entraînement en silence.
   */
  it('écarte une trajectoire non notée', () => {
    const { lines, preview } = buildExport({ ...OPTIONS, format: 'atropos' }, one({}, null));
    expect(lines).toHaveLength(0);
    expect(preview.skipped[0]?.reason).toContain('score');
  });

  it('accepte un score nul, qui est une information', () => {
    const { lines } = buildExport({ ...OPTIONS, format: 'atropos' }, one({}, 0));
    expect(lines).toHaveLength(1);
  });
});

describe('format brut', () => {
  it('rend la trajectoire canonique sans perte', () => {
    const { lines } = buildExport({ ...OPTIONS, format: 'raw' }, one());
    const parsed = JSON.parse(lines[0] ?? '{}') as Trajectory;
    expect(parsed.runId).toBe('run_1');
    expect(parsed.turns).toHaveLength(5);
    expect(parsed.turns[2]?.toolCalls?.[0]?.name).toBe('Read');
  });
});

describe('filtres', () => {
  it('exclut les runs en échec par défaut', () => {
    const { lines, preview } = buildExport(OPTIONS, one({ status: 'failed' }));
    expect(lines).toHaveLength(0);
    expect(preview.skipped[0]?.reason).toBe('run failed');
  });

  it('les inclut quand on le demande', () => {
    const { lines } = buildExport({ ...OPTIONS, onlySucceeded: false }, one({ status: 'failed' }));
    expect(lines).toHaveLength(1);
  });

  it('peut exiger au moins un appel d’outil', () => {
    const inputs = one({
      toolsUsed: [],
      turns: [
        { role: 'user', content: 'Bonjour.' },
        { role: 'assistant', content: 'Bonjour !' },
      ],
    });
    expect(buildExport(OPTIONS, inputs).lines).toHaveLength(1);
    expect(buildExport({ ...OPTIONS, requireToolCalls: true }, inputs).lines).toHaveLength(0);
  });

  it('écarte une trajectoire vidée par la compression', () => {
    /* Budget minuscule : il ne reste plus de tour assistant à apprendre. */
    const inputs = one({
      estimatedTokens: 5000,
      turns: [
        { role: 'user', content: 'x'.repeat(40_000) },
        { role: 'assistant', content: '' },
      ],
    });
    const { lines, preview } = buildExport({ ...OPTIONS, tokenBudget: 10 }, inputs);
    expect(lines).toHaveLength(0);
    expect(preview.skipped[0]?.reason).toContain('compression');
  });
});

describe('aperçu', () => {
  it('compte les retenues, les écarts et les tokens', () => {
    const inputs: ExportInput[] = [
      { trajectory: makeTrajectory({ runId: 'a' }), score: null },
      { trajectory: makeTrajectory({ runId: 'b', status: 'failed' }), score: null },
      { trajectory: makeTrajectory({ runId: 'c' }), score: null },
    ];
    const { preview } = buildExport(OPTIONS, inputs);
    expect(preview.count).toBe(2);
    expect(preview.skipped).toEqual([{ runId: 'b', reason: 'run failed' }]);
    expect(preview.totalEstimatedTokens).toBeGreaterThan(0);
    expect(preview.format).toBe('sharegpt');
    expect(preview.dialect).toBe('hermes');
  });

  it('ne montre que les deux premières lignes', () => {
    const inputs = Array.from({ length: 5 }, (_unused, i) => ({
      trajectory: makeTrajectory({ runId: `r${i}` }),
      score: null,
    }));
    const { preview, lines } = buildExport(OPTIONS, inputs);
    expect(lines).toHaveLength(5);
    expect(preview.sample).toHaveLength(2);
  });

  it('reporte la compression appliquée', () => {
    const heavy = one({
      estimatedTokens: 4000,
      turns: [
        { role: 'user', content: 'Lis.' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tu_1', name: 'Read', arguments: {} }],
        },
        { role: 'tool', content: 'x'.repeat(12_000), toolCallId: 'tu_1', toolName: 'Read' },
        { role: 'assistant', content: 'Fini.' },
      ],
    });
    const { preview } = buildExport({ ...OPTIONS, tokenBudget: 300 }, heavy);
    expect(preview.compression.applied).toBe(true);
    expect(preview.compression.tokenBudget).toBe(300);
    expect(preview.compression.tokensAfter).toBeLessThan(preview.compression.tokensBefore);
    expect(preview.compression.truncatedToolResults).toBeGreaterThan(0);
  });
});

describe('sérialisation JSONL', () => {
  it('sépare par des sauts de ligne et termine par un saut', () => {
    expect(toJsonl(['{"a":1}', '{"b":2}'])).toBe('{"a":1}\n{"b":2}\n');
  });

  it('rend une chaîne vide sans ligne', () => {
    expect(toJsonl([])).toBe('');
  });

  it('produit une ligne par trajectoire, chacune valide isolément', () => {
    const inputs = Array.from({ length: 3 }, (_unused, i) => ({
      trajectory: makeTrajectory({ runId: `r${i}` }),
      score: null,
    }));
    const body = toJsonl(buildExport(OPTIONS, inputs).lines);
    const rows = body.trimEnd().split('\n');
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(() => JSON.parse(row) as unknown).not.toThrow();
  });
});
