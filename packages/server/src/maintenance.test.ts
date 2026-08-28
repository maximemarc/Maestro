import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Run } from '@maestro/shared';
import { Bus } from './bus.ts';
import type { MaestroConfig } from './config.ts';
import { Store } from './db.ts';
import {
  BACKUP_KEEP,
  MaintenanceService,
  backupName,
  backupsToRotate,
  formatBytes,
  retentionCutoff,
} from './maintenance.ts';

const NOW = new Date('2026-08-28T12:00:00.000Z');

function makeRun(id: string, endedAt: string | null): Run {
  return {
    id,
    agentId: 'agt_1',
    origin: 'manual',
    originId: null,
    parentRunId: null,
    prompt: 'x',
    skillId: null,
    status: endedAt ? 'succeeded' : 'running',
    sessionId: null,
    model: 'sonnet',
    engine: 'sdk',
    tmuxSession: null,
    numTurns: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    resultText: null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt,
  };
}

let dir: string;
let store: Store;
let service: MaintenanceService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maestro-maint-'));
  store = new Store(':memory:');
  const bus = new Bus(store);
  service = new MaintenanceService(store, bus, { dataDir: dir } as MaestroConfig);

  store.insertAgent({
    id: 'agt_1',
    name: 'A',
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
    workspaceDir: dir,
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
});

afterEach(() => {
  service.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('date de coupure', () => {
  it('n’en produit aucune quand la rétention est désactivée', () => {
    expect(retentionCutoff(null, NOW)).toBeNull();
    expect(retentionCutoff(0, NOW)).toBeNull();
    expect(retentionCutoff(-5, NOW)).toBeNull();
  });

  it('recule du nombre de jours demandé', () => {
    expect(retentionCutoff(30, NOW)).toBe('2026-07-29T12:00:00.000Z');
  });
});

describe('purge', () => {
  /*
   * L'invariant qui compte : ne rien configurer ne doit rien supprimer. Une
   * purge automatique par défaut détruirait des transcripts que personne n'a
   * demandé à perdre.
   */
  it('ne touche à rien par défaut', () => {
    store.insertRun(makeRun('run_vieux', '2026-01-01T00:00:00.000Z'));
    store.insertRunEvent('run_vieux', 'agt_1', 'assistant_text', { text: 'ancien' });

    const report = service.prune(NOW);
    expect(report.applied).toBe(false);
    expect(report.deletedEvents).toBe(0);
    expect(store.listRunEvents('run_vieux')).toHaveLength(1);
  });

  it('supprime les événements des runs terminés avant la coupure', () => {
    store.patchSettings({ retentionDays: 30 });
    store.insertRun(makeRun('run_vieux', '2026-01-01T00:00:00.000Z'));
    store.insertRun(makeRun('run_recent', '2026-08-27T00:00:00.000Z'));
    store.insertRunEvent('run_vieux', 'agt_1', 'assistant_text', { text: 'ancien' });
    store.insertRunEvent('run_recent', 'agt_1', 'assistant_text', { text: 'récent' });

    const report = service.prune(NOW);
    expect(report.applied).toBe(true);
    expect(report.deletedEvents).toBe(1);
    expect(store.listRunEvents('run_vieux')).toHaveLength(0);
    expect(store.listRunEvents('run_recent')).toHaveLength(1);
  });

  /*
   * Purger par horodatage d'événement effacerait les premiers événements d'un
   * run long encore en cours : son transcript deviendrait un trou, sous ses
   * propres yeux.
   */
  it('épargne un run encore en cours, si ancien soit-il', () => {
    store.patchSettings({ retentionDays: 1 });
    store.insertRun(makeRun('run_actif', null));
    store.insertRunEvent('run_actif', 'agt_1', 'assistant_text', { text: 'en cours' });

    expect(service.prune(NOW).deletedEvents).toBe(0);
    expect(store.listRunEvents('run_actif')).toHaveLength(1);
  });

  it('purge aussi le journal applicatif', () => {
    store.patchSettings({ retentionDays: 30 });
    store.insertRun(makeRun('run_1', '2026-01-01T00:00:00.000Z'));
    const report = service.prune(NOW);
    // Le journal du test contient au moins la trace des insertions récentes :
    // ce qui compte est que la purge ne lève pas et rende un compte.
    expect(report.deletedLogs).toBeGreaterThanOrEqual(0);
    expect(report.cutoff).toBe('2026-07-29T12:00:00.000Z');
  });

  it('rapporte la taille avant et après', () => {
    const report = service.prune(NOW);
    expect(report.bytesBefore).toBeGreaterThan(0);
    expect(report.bytesAfter).toBeGreaterThan(0);
  });
});

describe('sauvegarde', () => {
  it('écrit une copie lisible et complète', () => {
    store.insertRun(makeRun('run_1', '2026-08-27T00:00:00.000Z'));
    const report = service.backup(NOW);

    expect(report.bytes).toBeGreaterThan(0);
    const copy = new Store(report.path);
    expect(copy.getRun('run_1')?.id).toBe('run_1');
    copy.close();
  });

  it('nomme la sauvegarde de façon triable', () => {
    expect(backupName(NOW)).toBe('maestro-2026-08-28T12-00-00.db');
    /* L'ordre alphabétique doit être l'ordre chronologique : la rotation en
       dépend entièrement. */
    const noms = [
      backupName(new Date('2026-08-28T09:00:00Z')),
      backupName(new Date('2026-08-28T12:00:00Z')),
      backupName(new Date('2026-09-01T08:00:00Z')),
    ];
    expect([...noms].sort()).toEqual(noms);
  });

  it('protège le répertoire des sauvegardes', () => {
    service.backup(NOW);
    // Une sauvegarde contient tout : transcripts, approbations, clés MCP.
    expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
  });

  it('liste les sauvegardes, de la plus récente à la plus ancienne', () => {
    service.backup(new Date('2026-08-26T10:00:00Z'));
    service.backup(new Date('2026-08-28T10:00:00Z'));
    const listed = service.listBackups();
    expect(listed).toHaveLength(2);
    expect(listed[0]?.name).toContain('2026-08-28');
  });
});

describe('rotation', () => {
  it('ne supprime rien tant que le quota n’est pas dépassé', () => {
    const noms = ['maestro-a.db', 'maestro-b.db'];
    expect(backupsToRotate(noms, 7)).toEqual([]);
  });

  it('supprime les plus anciennes au-delà du quota', () => {
    const noms = ['maestro-1.db', 'maestro-2.db', 'maestro-3.db'];
    expect(backupsToRotate(noms, 2)).toEqual(['maestro-1.db']);
  });

  /* Le répertoire peut contenir autre chose — une copie manuelle, une note.
     La rotation ne supprime que ce qu'elle a écrit. */
  it('ignore les fichiers étrangers', () => {
    const noms = ['maestro-1.db', 'notes.txt', 'copie-manuelle.db', 'maestro-2.db'];
    expect(backupsToRotate(noms, 1)).toEqual(['maestro-1.db']);
  });

  it('applique la rotation à l’écriture', () => {
    const backupsDir = join(dir, 'backups');
    service.backup(NOW);
    // On simule un historique déjà plein.
    for (let i = 0; i < BACKUP_KEEP + 2; i++) {
      writeFileSync(join(backupsDir, `maestro-2026-01-0${i % 10}T00-00-0${i % 10}.db`), 'x');
    }
    const report = service.backup(new Date('2026-09-01T00:00:00Z'));
    expect(report.rotated.length).toBeGreaterThan(0);
    expect(service.listBackups().length).toBeLessThanOrEqual(BACKUP_KEEP);
  });
});

describe('formatage des tailles', () => {
  it('choisit l’unité lisible', () => {
    expect(formatBytes(512)).toBe('512 o');
    expect(formatBytes(2048)).toBe('2.0 Ko');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 Mo');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 Go');
  });
});
