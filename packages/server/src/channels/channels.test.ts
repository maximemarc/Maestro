/**
 * Tests des canaux.
 *
 * Ce que cette couche doit garantir, et qui ne se voit pas autrement :
 *
 * - la règle « faut-il notifier » est appliquée **une seule fois**, pour tous
 *   les canaux. C'est elle que les trois passerelles avaient recopiée, puis
 *   laissée diverger — celle de Slack ignorait les routines que Telegram
 *   honorait ;
 * - un message est une **structure** de spans, jamais du balisage : c'est ce
 *   qui permet à quatre rendus de rester justes sans se recopier ;
 * - un canal en panne n'empêche pas les autres de recevoir ;
 * - un canal non interactif ne perd pas les approbations : il ne peut pas les
 *   rendre cliquables, il doit dire où trancher ;
 * - 🔒 le webhook n'exporte pas le travail d'un agent vers un service tiers
 *   sans qu'on l'ait demandé.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Approval, Run } from '@maestro/shared';
import type { AgentService } from '../agents.ts';
import type { Bus } from '../bus.ts';
import type { Store } from '../db.ts';
import { renderHtml, renderMrkdwn, renderPlain, type ChatReply } from '../chat-commands.ts';
import {
  approvalMessage,
  runEndMessage,
  shouldNotifyRunEnd,
  type MessageDeps,
} from './messages.ts';
import { ChannelRegistry } from './registry.ts';
import { parseApprovalAction, withResolutionHint, type Channel } from './types.ts';
import { buildPayload, stripDetail, WebhookChannel, webhookConfigFromEnv } from './webhook.ts';

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_1',
    agentId: 'ag_1',
    origin: 'manual',
    originId: null,
    status: 'succeeded',
    numTurns: 3,
    costUsd: 0.0421,
    attemptCount: 1,
    accountName: null,
    resultText: null,
    error: null,
    endedAt: '2026-08-31T12:00:00.000Z',
    ...overrides,
  } as unknown as Run;
}

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'ap_1',
    runId: 'run_1',
    agentId: 'ag_1',
    toolName: 'Bash',
    input: { command: 'ls' },
    status: 'pending',
    ...overrides,
  } as unknown as Approval;
}

function deps(options: { notifyAll?: boolean; notifyRoutine?: boolean } = {}): MessageDeps {
  return {
    store: {
      getSettings: () => ({ notifyAllRuns: options.notifyAll ?? false }),
      getRoutine: () => ({ notify: options.notifyRoutine ?? false }),
    } as unknown as Store,
    agents: {
      get: () => ({ id: 'ag_1', name: 'Comptabilité', emoji: '📊' }),
    } as unknown as AgentService,
  };
}

// ---------------------------------------------------------------------------
// La décision de notifier, appliquée une seule fois
// ---------------------------------------------------------------------------

describe('décision de notifier', () => {
  /* Les trois origines conversationnelles, et pas seulement Telegram : c'est
     précisément là que les copies avaient divergé. */
  it('notifie un run lancé depuis n’importe quel canal', () => {
    for (const origin of ['telegram', 'discord', 'slack'] as const) {
      expect(shouldNotifyRunEnd(deps(), run({ origin }))).toBe(true);
    }
  });

  it('ne notifie pas un run manuel par défaut', () => {
    expect(shouldNotifyRunEnd(deps(), run({ origin: 'manual' }))).toBe(false);
  });

  it('notifie tout quand le réglage global le demande', () => {
    expect(shouldNotifyRunEnd(deps({ notifyAll: true }), run({ origin: 'manual' }))).toBe(true);
  });

  it('notifie une routine qui l’a demandé, pas les autres', () => {
    const r = run({ origin: 'routine', originId: 'rt_1' });
    expect(shouldNotifyRunEnd(deps({ notifyRoutine: true }), r)).toBe(true);
    expect(shouldNotifyRunEnd(deps(), r)).toBe(false);
  });

  it('ne notifie pas un run qui n’est pas terminé', () => {
    expect(shouldNotifyRunEnd(deps({ notifyAll: true }), run({ endedAt: null }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Structure et rendus
// ---------------------------------------------------------------------------

describe('message structuré', () => {
  it('ne contient aucun balisage : le rendu appartient au canal', () => {
    const reply = runEndMessage(deps(), run({ resultText: 'Fait <b>gras</b> & fini' }));
    const flat = JSON.stringify(reply);
    expect(flat).not.toContain('<b>Run');
    expect(flat).not.toContain('**Run');
  });

  /* Le même message, trois balisages. Une erreur d'échappement ne casserait
     qu'un canal sur trois — le pire cas à déboguer. */
  it('se rend correctement dans les trois dialectes', () => {
    const reply = runEndMessage(deps(), run());
    expect(renderHtml(reply)).toContain('<b>Run terminé</b>');
    expect(renderMrkdwn(reply)).toContain('*Run terminé*');
    expect(renderPlain(reply)).toContain('Run terminé');
    expect(renderPlain(reply)).not.toContain('*');
  });

  it('neutralise le balisage présent dans le contenu, dialecte par dialecte', () => {
    const reply = runEndMessage(deps(), run({ resultText: 'vu <b>ici</b> & là' }));
    expect(renderHtml(reply)).toContain('&lt;b&gt;');
    expect(renderMrkdwn(reply)).toContain('&lt;b&gt;');
  });

  it('n’affiche les tentatives que lorsqu’il y en a eu plusieurs', () => {
    expect(renderPlain(runEndMessage(deps(), run()))).not.toContain('Tentatives');
    const relance = run({ attemptCount: 3, accountName: 'secours' });
    const text = renderPlain(runEndMessage(deps(), relance));
    expect(text).toContain('Tentatives : 3');
    expect(text).toContain('secours');
  });

  it('porte l’identifiant de l’approbation, pour les boutons', () => {
    const reply = approvalMessage(deps(), approval());
    expect(reply?.approvalIds).toEqual(['ap_1']);
  });

  it('rend null pour une approbation déjà tranchée', () => {
    expect(approvalMessage(deps(), approval({ status: 'allowed' }))).toBeNull();
  });
});

describe('identifiant d’action d’approbation', () => {
  it('décode une décision valide', () => {
    expect(parseApprovalAction('apr:ap_1:allow')).toEqual({
      approvalId: 'ap_1',
      decision: 'allow',
    });
  });

  it('refuse ce qui n’en est pas', () => {
    expect(parseApprovalAction('autre:ap_1:allow')).toBeNull();
    expect(parseApprovalAction('apr:ap_1:peut-être')).toBeNull();
    expect(parseApprovalAction('')).toBeNull();
  });
});

/* Un canal sortant ne peut pas rendre une approbation cliquable. Ne rien dire
   serait le pire résultat : une décision annoncée sans lieu où la prendre. */
describe('canal non interactif', () => {
  it('ajoute où trancher quand le message porte une approbation', () => {
    const reply = approvalMessage(deps(), approval())!;
    expect(renderPlain(withResolutionHint(reply))).toContain('interface Maestro');
  });

  it('n’ajoute rien à un message sans approbation', () => {
    const reply = runEndMessage(deps(), run());
    expect(withResolutionHint(reply)).toBe(reply);
  });
});

// ---------------------------------------------------------------------------
// Diffusion
// ---------------------------------------------------------------------------

function fakeChannel(id: string, overrides: Partial<Channel> = {}): Channel {
  return {
    id,
    label: id,
    enabled: true,
    interactive: false,
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('registre', () => {
  function bus(): Bus {
    return { log: vi.fn(), subscribe: vi.fn() } as unknown as Bus;
  }

  it('écarte les canaux désactivés au lieu de les tester à chaque envoi', () => {
    const registry = new ChannelRegistry(
      [fakeChannel('a'), fakeChannel('b', { enabled: false })],
      bus(),
      deps(),
    );
    expect(registry.list().map((c) => c.id)).toEqual(['a']);
  });

  /* Un webhook injoignable ne doit pas empêcher la notification Telegram de
     partir — ce qui arriverait avec un `Promise.all` sans garde. */
  it('isole les échecs : un canal en panne n’empêche pas les autres', async () => {
    const casse = fakeChannel('casse', {
      send: vi.fn(async () => {
        throw new Error('injoignable');
      }),
    });
    const sain = fakeChannel('sain');
    const b = bus();
    const registry = new ChannelRegistry([casse, sain], b, deps());

    await registry.broadcast({ lines: [{ spans: [{ text: 'coucou' }] }] });

    expect(sain.send).toHaveBeenCalled();
    expect(b.log).toHaveBeenCalledWith('warn', 'channels', expect.stringContaining('casse'));
  });

  it('signale si un canal sait trancher une approbation', () => {
    expect(new ChannelRegistry([fakeChannel('a')], bus(), deps()).hasInteractive).toBe(false);
    expect(
      new ChannelRegistry([fakeChannel('a', { interactive: true })], bus(), deps()).hasInteractive,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 🔒 Webhook : envoyer, c'est publier
// ---------------------------------------------------------------------------

describe('webhook sortant', () => {
  const reply: ChatReply = {
    lines: [
      { spans: [{ text: 'Run terminé' }] },
      { spans: [{ text: 'du code confidentiel' }], detail: true },
    ],
  };

  it('n’envoie que l’état par défaut', () => {
    const text = renderPlain(stripDetail(reply, 'status'));
    expect(text).toContain('Run terminé');
    expect(text).not.toContain('confidentiel');
  });

  it('n’ajoute le contenu que sur choix explicite', () => {
    expect(renderPlain(stripDetail(reply, 'full'))).toContain('confidentiel');
  });

  it('parle le dialecte du service destinataire', () => {
    expect(buildPayload('slack', 'x')).toEqual({ text: 'x' });
    expect(buildPayload('discord', 'x')).toEqual({ content: 'x' });
    expect(buildPayload('raw', 'x')).toEqual({ text: 'x', message: 'x' });
  });

  it('reste désactivé sans configuration, et n’impose rien au démarrage', () => {
    const channel = new WebhookChannel(webhookConfigFromEnv({}), {
      log: vi.fn(),
    } as unknown as Bus);
    expect(channel.enabled).toBe(false);
  });

  /* Défaut prudent délibéré : `full` doit être écrit, pas deviné. */
  it('exige « full » écrit en clair pour exporter le travail', () => {
    expect(webhookConfigFromEnv({ MAESTRO_WEBHOOK_DETAIL: 'oui' }).detail).toBe('status');
    expect(webhookConfigFromEnv({ MAESTRO_WEBHOOK_DETAIL: 'full' }).detail).toBe('full');
  });

  it('ignore une URL qui n’en est pas', () => {
    expect(webhookConfigFromEnv({ MAESTRO_WEBHOOK_URL: 'pas-une-url' }).urls).toEqual([]);
  });
});
