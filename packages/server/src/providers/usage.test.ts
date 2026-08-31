/**
 * Tests de la mesure de consommation.
 *
 * Deux erreurs coûteraient cher ici, et aucune ne se verrait : compter le cache
 * de lecture comme une entrée neuve — la jauge afficherait 90 % sur un compte
 * qui ne fait que relire un gros contexte, et Maestro délaisserait un compte
 * parfaitement disponible — et ne pas voir les sessions lancées hors de
 * Maestro, qui consomment pourtant le même quota.
 *
 * Les transcripts sont écrits sur disque plutôt que simulés : le format est
 * celui d'un outil tiers, et une simulation ne vérifierait que ma
 * compréhension de ce format.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderAccount } from '@maestro/shared';
import {
  billableTokens,
  pressureOf,
  readTranscriptUsage,
  transcriptsDirFor,
  UsageTracker,
} from './usage.ts';

const NOW = Date.parse('2026-08-31T12:00:00.000Z');

let root: string;
let projects: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'maestro-usage-'));
  projects = join(root, 'projects', 'un-projet');
  mkdirSync(projects, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Une ligne de transcript, réduite aux champs que Maestro lit. */
function line(opts: {
  at: string;
  session: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.at,
    sessionId: opts.session,
    message: {
      model: 'claude-haiku-4-5-20251001',
      role: 'assistant',
      content: [{ type: 'text', text: 'contenu qui ne doit jamais être lu' }],
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheWrite ?? 0,
      },
    },
  });
}

function writeTranscript(name: string, lines: string[]): void {
  writeFileSync(join(projects, name), `${lines.join('\n')}\n`, 'utf8');
}

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: 'acc_1',
    name: 'Compte',
    kind: 'claude-sdk',
    enabled: true,
    authMode: 'profile',
    configDir: root,
    apiKeyEnv: null,
    baseUrl: null,
    apiFlavor: null,
    model: null,
    command: null,
    args: null,
    env: {},
    priority: 10,
    dailyCostLimitUsd: null,
    usageWindowSec: 5 * 3600,
    windowTokenLimit: null,
    learnedTokenLimit: null,
    learnedAt: null,
    health: 'ready',
    cooldownUntil: null,
    lastError: null,
    lastCheckedAt: null,
    detail: null,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

describe('lecture des transcripts', () => {
  it('additionne l’usage des messages de la fenêtre', () => {
    writeTranscript('a.jsonl', [
      line({ at: '2026-08-31T11:00:00.000Z', session: 's1', input: 100, output: 200 }),
      line({ at: '2026-08-31T11:30:00.000Z', session: 's1', input: 50, output: 25 }),
    ]);
    const totals = readTranscriptUsage(join(root, 'projects'), NOW - 5 * 3600 * 1000);
    expect(totals.inputTokens).toBe(150);
    expect(totals.outputTokens).toBe(225);
    expect(totals.sessions).toBe(1);
  });

  it('ignore ce qui précède la fenêtre', () => {
    writeTranscript('a.jsonl', [
      line({ at: '2026-08-30T08:00:00.000Z', session: 'vieux', input: 999_999 }),
      line({ at: '2026-08-31T11:00:00.000Z', session: 's1', input: 10 }),
    ]);
    const totals = readTranscriptUsage(join(root, 'projects'), NOW - 5 * 3600 * 1000);
    expect(totals.inputTokens).toBe(10);
  });

  it('compte les sessions distinctes, y compris celles lancées hors Maestro', () => {
    // C'est tout l'intérêt de cette source : elle voit ce que l'orchestrateur
    // n'a pas lancé, mais qui consomme le même quota.
    writeTranscript('a.jsonl', [line({ at: '2026-08-31T11:00:00.000Z', session: 's1', input: 5 })]);
    writeTranscript('b.jsonl', [line({ at: '2026-08-31T11:10:00.000Z', session: 's2', input: 5 })]);
    const totals = readTranscriptUsage(join(root, 'projects'), NOW - 5 * 3600 * 1000);
    expect(totals.sessions).toBe(2);
    expect(totals.inputTokens).toBe(10);
  });

  it('survit à une ligne tronquée en fin de fichier', () => {
    // Cas normal : on lit pendant qu'une session écrit.
    const partial = line({ at: '2026-08-31T11:00:00.000Z', session: 's1', input: 7 });
    writeFileSync(
      join(projects, 'c.jsonl'),
      `${partial}\n{"type":"assistant","message":{"usage":{"inp`,
      'utf8',
    );
    const totals = readTranscriptUsage(join(root, 'projects'), NOW - 5 * 3600 * 1000);
    expect(totals.inputTokens).toBe(7);
  });

  it('ignore un répertoire absent sans lever', () => {
    const totals = readTranscriptUsage(join(root, 'nulle-part'), NOW - 1000);
    expect(totals.inputTokens).toBe(0);
  });
});

describe('total facturable', () => {
  it('exclut le cache de lecture', () => {
    /* Un contexte de 100 000 tokens relu à chaque tour ferait exploser la jauge
       alors qu'il coûte une fraction du prix. */
    const totals = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 200,
      costUsd: 0,
      sessions: 1,
    };
    expect(billableTokens(totals)).toBe(350);
  });
});

describe('pression', () => {
  it('rapporte la consommation au plafond', () => {
    expect(pressureOf(850, 1000)).toBeCloseTo(0.85);
  });

  it('ne conclut rien sans plafond connu', () => {
    // Comparer à un chiffre inventé produirait des bascules incompréhensibles.
    expect(pressureOf(850, null)).toBeNull();
    expect(pressureOf(850, 0)).toBeNull();
  });
});

describe('choix de la source', () => {
  it('lit les transcripts d’un profil Claude', () => {
    expect(transcriptsDirFor(account())).toBe(join(root, 'projects'));
  });

  it('n’en attend aucun pour une API HTTP', () => {
    expect(transcriptsDirFor(account({ kind: 'http-api' }))).toBeNull();
  });

  it('déclare la mesure indisponible sur un moteur CLI tiers', () => {
    // Afficher zéro ferait passer un angle mort pour un compte au repos.
    const tracker = new UsageTracker(() => {
      throw new Error('ne doit pas être appelé');
    });
    const usage = tracker.usageFor(account({ kind: 'codex-cli', configDir: null }), NOW);
    expect(usage.source).toBe('unavailable');
    expect(usage.pressure).toBeNull();
  });

  it('rend une consommation nulle pour un profil qui n’a encore rien exécuté', () => {
    /* Répertoire de transcripts absent = rien consommé, pas « impossible à
       mesurer ». Les confondre écarterait de l'anticipation le compte le plus
       frais, exactement celui qu'on voudrait choisir. */
    const tracker = new UsageTracker(() => {
      throw new Error('ne doit pas être appelé');
    });
    const usage = tracker.usageFor(
      account({ configDir: join(root, 'profil-neuf'), windowTokenLimit: 1000 }),
      NOW,
    );
    expect(usage.source).toBe('transcripts');
    expect(usage.billableTokens).toBe(0);
    expect(usage.pressure).toBe(0);
  });

  it('retombe sur les tentatives pour une API HTTP', () => {
    const tracker = new UsageTracker(() => ({
      inputTokens: 400,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 1.5,
      sessions: 2,
    }));
    const usage = tracker.usageFor(
      account({
        kind: 'http-api',
        authMode: 'api-key-env',
        configDir: null,
        windowTokenLimit: 1000,
      }),
      NOW,
    );
    expect(usage.source).toBe('attempts');
    expect(usage.billableTokens).toBe(500);
    expect(usage.pressure).toBeCloseTo(0.5);
  });
});

describe('plafond retenu', () => {
  it('préfère le plafond déclaré à celui appris', () => {
    // Quelqu'un qui connaît son contrat en sait plus qu'une observation.
    writeTranscript('a.jsonl', [
      line({ at: '2026-08-31T11:00:00.000Z', session: 's1', input: 500 }),
    ]);
    const tracker = new UsageTracker(() => {
      throw new Error('ne doit pas être appelé');
    });
    const usage = tracker.usageFor(
      account({ windowTokenLimit: 2000, learnedTokenLimit: 800 }),
      NOW,
    );
    expect(usage.limitTokens).toBe(2000);
    expect(usage.limitLearned).toBe(false);
    expect(usage.pressure).toBeCloseTo(0.25);
  });

  it('utilise le plafond appris à défaut, et le signale', () => {
    writeTranscript('a.jsonl', [
      line({ at: '2026-08-31T11:00:00.000Z', session: 's1', input: 400 }),
    ]);
    const tracker = new UsageTracker(() => {
      throw new Error('ne doit pas être appelé');
    });
    const usage = tracker.usageFor(account({ learnedTokenLimit: 800 }), NOW);
    expect(usage.limitTokens).toBe(800);
    expect(usage.limitLearned).toBe(true);
    expect(usage.pressure).toBeCloseTo(0.5);
  });
});
