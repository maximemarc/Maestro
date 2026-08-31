/**
 * Tests du battement de cœur.
 *
 * Ici, les tests portent moins sur « est-ce que ça marche » que sur « est-ce que
 * ça s'arrête ». Un orchestrateur qui délibère dépense des tokens sans que
 * personne n'ait rien demandé : chaque garde-fou manquant est une facture qui
 * court, et aucun ne se voit à l'œil nu.
 *
 * Le second enjeu est la mémoire des battements passés. Sans elle, un agent
 * recrée la même carte kanban à chaque heure — la fonctionnalité devient
 * activement nuisible, et rien dans le code ne le signalerait.
 */
import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_DEFAULTS,
  type AgentConfig,
  type HeartbeatConfig,
  type SituationReport,
} from '@maestro/shared';
import { guardBeat, intervalTooShort, looksIdle, renderReport, validCron } from './heartbeat.ts';

function config(overrides: Partial<HeartbeatConfig> = {}): HeartbeatConfig {
  return { ...HEARTBEAT_DEFAULTS, enabled: true, agentId: 'ag_1', ...overrides };
}

const agent = { id: 'ag_1', name: 'Veilleur', archived: false } as unknown as AgentConfig;

function guardInput(overrides: Partial<Parameters<typeof guardBeat>[0]> = {}) {
  return {
    config: config(),
    agent,
    activeRuns: 0,
    beatsToday: 0,
    previousStillRunning: false,
    underQuotaPressure: false,
    ...overrides,
  };
}

describe('garde-fous', () => {
  it('bat quand tout est réuni', () => {
    expect(guardBeat(guardInput())).toEqual({ beat: true });
  });

  it('ne bat pas si la fonctionnalité est désactivée', () => {
    // C'est l'état par défaut, et il doit le rester sans geste explicite.
    const verdict = guardBeat(guardInput({ config: config({ enabled: false }) }));
    expect(verdict).toEqual({ beat: false, reason: 'battement désactivé' });
  });

  it('reste désactivé par défaut', () => {
    expect(HEARTBEAT_DEFAULTS.enabled).toBe(false);
  });

  it('ne bat pas sans agent de délibération', () => {
    const verdict = guardBeat(guardInput({ config: config({ agentId: null }), agent: null }));
    expect(verdict.beat).toBe(false);
  });

  it('ne bat pas pour un agent archivé', () => {
    /* Un agent archivé n'a plus de workspace synchronisé : délibérer en son nom
       produirait des décisions prises sur un contexte périmé. */
    const archived = { ...agent, archived: true } as AgentConfig;
    const verdict = guardBeat(guardInput({ agent: archived }));
    expect(verdict.beat).toBe(false);
  });

  it('respecte le plafond quotidien', () => {
    const verdict = guardBeat(guardInput({ config: config({ dailyMax: 5 }), beatsToday: 5 }));
    expect(verdict).toMatchObject({ beat: false });
    if (!verdict.beat) expect(verdict.reason).toContain('plafond quotidien');
  });

  it('n’empile pas un battement sur le précédent', () => {
    /* Deux délibérations concurrentes jugeraient le même état et pourraient
       décider la même action deux fois. */
    const verdict = guardBeat(guardInput({ previousStillRunning: true }));
    expect(verdict.beat).toBe(false);
  });

  it('ne bat pas pendant qu’un run tourne', () => {
    const verdict = guardBeat(guardInput({ activeRuns: 2 }));
    expect(verdict).toMatchObject({ beat: false });
    if (!verdict.beat) expect(verdict.reason).toContain('2 run(s)');
  });

  it('bat quand même si l’opérateur a désactivé ce garde-fou', () => {
    const verdict = guardBeat(
      guardInput({ config: config({ skipWhenBusy: false }), activeRuns: 3 }),
    );
    expect(verdict.beat).toBe(true);
  });

  it('cède le quota au travail demandé par un humain', () => {
    // Consommer la fin d'un quota pour une délibération spontanée serait le
    // pire arbitrage possible.
    const verdict = guardBeat(guardInput({ underQuotaPressure: true }));
    expect(verdict).toMatchObject({ beat: false });
    if (!verdict.beat) expect(verdict.reason).toContain('limite d’usage');
  });

  it('évalue la configuration avant l’état du système', () => {
    /* Ordre significatif : un battement désactivé ne doit pas faire mesurer un
       quota ni interroger la base. Le motif rendu le prouve. */
    const verdict = guardBeat(
      guardInput({
        config: config({ enabled: false }),
        activeRuns: 5,
        beatsToday: 999,
        underQuotaPressure: true,
      }),
    );
    if (!verdict.beat) expect(verdict.reason).toBe('battement désactivé');
  });
});

describe('plancher de fréquence', () => {
  it('refuse un rythme à la minute', () => {
    expect(intervalTooShort('* * * * *')).toBe(true);
  });

  it('refuse toutes les deux minutes', () => {
    expect(intervalTooShort('*/2 * * * *')).toBe(true);
  });

  it('accepte toutes les cinq minutes', () => {
    expect(intervalTooShort('*/5 * * * *')).toBe(false);
  });

  it('accepte le rythme horaire par défaut', () => {
    expect(intervalTooShort(HEARTBEAT_DEFAULTS.cronExpr)).toBe(false);
  });

  it('laisse la validation d’expression à qui s’en charge', () => {
    // Ce n'est pas le rôle du plancher de dire qu'une expression est invalide :
    // il rendrait un motif trompeur.
    expect(intervalTooShort('n’importe quoi')).toBe(false);
    expect(validCron('n’importe quoi')).toBe(false);
    expect(validCron('0 * * * *')).toBe(true);
  });
});

describe('état des lieux', () => {
  function report(overrides: Partial<SituationReport> = {}): SituationReport {
    return {
      at: '2026-08-31T14:00:00.000Z',
      activeRuns: 0,
      queuedRuns: 0,
      pendingApprovals: 3,
      tasksByColumn: { backlog: 2, doing: 1, review: 0, done: 7 },
      recentFailures: [],
      pressuredAccounts: [],
      previousBeats: [],
      ...overrides,
    };
  }

  it('rappelle les battements précédents et leur compte rendu', () => {
    /* La section décisive : sans elle, l'agent refait chaque heure ce qu'il a
       déjà fait, faute de pouvoir s'en souvenir. */
    const text = renderReport(
      report({
        previousBeats: [
          { at: '2026-08-31T13:00:00.000Z', outcome: 'acted', summary: 'Carte créée pour la CI' },
          { at: '2026-08-31T12:00:00.000Z', outcome: 'idle', summary: null },
        ],
      }),
    );
    expect(text).toContain('Carte créée pour la CI');
    expect(text).toContain('rien à faire');
  });

  it('dit explicitement quand c’est le premier battement', () => {
    expect(renderReport(report())).toContain('c’est le premier');
  });

  it('porte ce sur quoi un agent peut agir', () => {
    const text = renderReport(
      report({
        recentFailures: [{ runId: 'run_9', agentName: 'Développeur', error: 'quota atteint' }],
        pressuredAccounts: [{ name: 'Claude perso', pressurePct: 92 }],
      }),
    );
    expect(text).toContain('approbations en attente : 3');
    expect(text).toContain('Développeur (run_9)');
    expect(text).toContain('Claude perso : 92 %');
  });

  it('tait la section des comptes quand aucun n’est chargé', () => {
    // Une section vide occupe du contexte et invite à chercher un problème
    // qui n'existe pas.
    expect(renderReport(report())).not.toContain('Comptes proches');
  });
});

describe('reconnaissance de l’inaction', () => {
  it('reconnaît un compte rendu d’inaction, accentué ou non', () => {
    expect(looksIdle('Rien à faire ce cycle.')).toBe(true);
    expect(looksIdle('Aucune action nécessaire')).toBe(true);
    expect(looksIdle('Nothing to do.')).toBe(true);
  });

  it('compte comme une action ce qu’elle ne reconnaît pas', () => {
    /* Heuristique faillible, qui ne sert qu'à l'affichage : en cas de doute,
       surestimer l'activité est moins trompeur que de la masquer. */
    expect(looksIdle('J’ai créé une carte pour la CI cassée.')).toBe(false);
    expect(looksIdle(null)).toBe(false);
  });
});
