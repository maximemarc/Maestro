/**
 * Tests des canaux.
 *
 * Ce que cette couche doit garantir, et qui ne se voit pas autrement :
 *
 * - un message est **structuré**, jamais du balisage. Une notification qui
 *   partirait en HTML Telegram s'afficherait littéralement dans Discord ;
 * - la règle « faut-il notifier » est appliquée **une seule fois**, pour tous
 *   les canaux — c'est elle qu'un second canal aurait recopiée puis laissée
 *   diverger ;
 * - un canal en panne n'empêche pas les autres de recevoir ;
 * - un canal sortant seul ne perd pas les actions : il ne peut pas les rendre
 *   cliquables, il doit dire où aller ;
 * - le webhook n'exporte pas le travail d'un agent vers un service tiers sans
 *   qu'on l'ait demandé.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Approval, Run } from '@maestro/shared';
import type { AgentService } from '../agents.ts';
import type { Bus } from '../bus.ts';
import type { Store } from '../db.ts';
import type { RunEngine } from '../runs.ts';
import {
  approvalMessage,
  parseApprovalAction,
  parseCommand,
  runCommand,
  runEndMessage,
  shouldNotifyRunEnd,
  type MessageDeps,
} from './messages.ts';
import { ChannelRegistry } from './registry.ts';
import { render } from './telegram.ts';
import { renderPlainText, type Channel, type ChannelMessage } from './types.ts';
import { buildPayload, WebhookChannel, webhookConfigFromEnv } from './webhook.ts';

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

function deps(options: { notifyAll?: boolean; notifyRoutine?: boolean } = {}): MessageDeps {
  return {
    store: {
      getSettings: () => ({ telegramNotifyAllRuns: options.notifyAll ?? false }),
      getRoutine: () => ({ notify: options.notifyRoutine ?? false }),
      listApprovals: () => [],
      countPendingApprovals: () => 2,
    } as unknown as Store,
    agents: {
      get: () => ({
        id: 'ag_1',
        name: 'Comptabilité',
        emoji: '📊',
        model: 'sonnet',
        engine: 'sdk',
      }),
      list: () => [
        { id: 'ag_1', name: 'Comptabilité', emoji: '📊', model: 'sonnet', engine: 'sdk' },
      ],
      getByName: (n: string) =>
        n === 'Comptabilité' ? { id: 'ag_1', name: 'Comptabilité', emoji: '📊' } : null,
    } as unknown as AgentService,
    engine: {
      activeCount: () => 1,
      queuedCount: () => 0,
      start: () => ({ id: 'run_new' }),
    } as unknown as RunEngine,
  };
}

describe('décision de notifier', () => {
  it('notifie un run lancé depuis un canal', () => {
    expect(shouldNotifyRunEnd(deps(), run({ origin: 'telegram' }))).toBe(true);
  });

  it('ne notifie pas un run manuel par défaut', () => {
    // Un orchestrateur qui notifie tout finit par n'être plus lu.
    expect(shouldNotifyRunEnd(deps(), run({ origin: 'manual' }))).toBe(false);
  });

  it('notifie tout quand le réglage global le demande', () => {
    expect(shouldNotifyRunEnd(deps({ notifyAll: true }), run())).toBe(true);
  });

  it('suit le réglage de la routine qui a déclenché le run', () => {
    const r = run({ origin: 'routine', originId: 'rtn_1' });
    expect(shouldNotifyRunEnd(deps({ notifyRoutine: true }), r)).toBe(true);
    expect(shouldNotifyRunEnd(deps({ notifyRoutine: false }), r)).toBe(false);
  });

  it('ne notifie pas un run encore en cours', () => {
    expect(shouldNotifyRunEnd(deps({ notifyAll: true }), run({ endedAt: null }))).toBe(false);
  });
});

describe('contenu des messages', () => {
  it('rend un message structuré, sans balisage', () => {
    /* Le balisage appartient au canal : une chaîne HTML fabriquée ici
       s'afficherait telle quelle dans Discord ou dans un webhook. */
    const message = runEndMessage(deps(), run({ resultText: 'Travail fini' }));
    const serialised = JSON.stringify(message);
    expect(serialised).not.toContain('<b>');
    expect(message.fields?.map((f) => f.label)).toContain('Coût');
    expect(message.body).toBe('Travail fini');
  });

  it('ne mentionne les tentatives que lorsqu’il y a eu bascule', () => {
    const simple = runEndMessage(deps(), run());
    expect(simple.fields?.some((f) => f.label === 'Tentatives')).toBe(false);
    const switched = runEndMessage(deps(), run({ attemptCount: 3, accountName: 'Claude perso' }));
    const field = switched.fields?.find((f) => f.label === 'Tentatives');
    expect(field?.value).toContain('Claude perso');
  });

  it('porte les deux actions d’une approbation en attente', () => {
    const approval = {
      id: 'apr_1',
      agentId: 'ag_1',
      toolName: 'Bash',
      status: 'pending',
      input: { command: 'ls' },
    } as unknown as Approval;
    const message = approvalMessage(deps(), approval);
    expect(message?.actions?.map((a) => a.id)).toEqual(['apr:apr_1:allow', 'apr:apr_1:deny']);
  });

  it('ne renotifie pas une approbation déjà résolue', () => {
    const approval = { id: 'apr_1', status: 'allowed' } as unknown as Approval;
    expect(approvalMessage(deps(), approval)).toBeNull();
  });
});

describe('commandes', () => {
  it('reconnaît les commandes connues, quelle que soit la casse', () => {
    expect(parseCommand('/Status')?.name).toBe('status');
    expect(parseCommand('/run Comptabilité fais ceci')?.rest).toBe('Comptabilité fais ceci');
  });

  it('ignore la conversation ordinaire', () => {
    // Répondre « commande inconnue » à chaque phrase rendrait le canal inutilisable.
    expect(parseCommand('bonjour')).toBeNull();
    expect(parseCommand('/inconnue')).toBeNull();
  });

  it('lance un run et rend son identifiant', () => {
    const messages = runCommand(deps(), { name: 'run', rest: 'Comptabilité analyse ceci' });
    expect(messages[0]?.tone).toBe('ok');
    expect(messages[0]?.fields?.[0]?.value).toBe('run_new');
  });

  it('refuse un agent inconnu en listant les disponibles', () => {
    const messages = runCommand(deps(), { name: 'run', rest: 'Fantôme fais ceci' });
    expect(messages[0]?.tone).toBe('warn');
    expect(messages[0]?.fields?.[0]?.value).toContain('Comptabilité');
  });

  it('rappelle l’usage quand le prompt manque', () => {
    expect(runCommand(deps(), { name: 'run', rest: 'Comptabilité' })[0]?.title).toContain('Usage');
  });

  it('décode une action d’approbation, et rejette le reste', () => {
    expect(parseApprovalAction('apr:apr_1:allow')).toEqual({
      approvalId: 'apr_1',
      decision: 'allow',
    });
    expect(parseApprovalAction('apr:apr_1:peut-etre')).toBeNull();
    expect(parseApprovalAction('autre:chose')).toBeNull();
  });
});

describe('rendu par canal', () => {
  const message: ChannelMessage = {
    title: 'Approbation demandée',
    tone: 'warn',
    fields: [{ label: 'Outil', value: 'Bash' }],
    body: 'a < b & c',
    actions: [{ id: 'apr:1:allow', label: 'Autoriser' }],
  };

  it('Telegram échappe le HTML et laisse les actions aux boutons', () => {
    const out = render(message);
    expect(out).toContain('&lt; b &amp;');
    // Répéter les actions en texte ferait doublon avec les boutons.
    expect(out).not.toContain('Autoriser');
  });

  it('le texte brut rappelle les actions, faute de pouvoir les rendre', () => {
    // Une approbation qui attend sans qu'on sache où la résoudre est pire
    // qu'une notification absente.
    const out = renderPlainText(message);
    expect(out).toContain('Autoriser');
    expect(out).toContain('Maestro');
  });

  it('le texte brut peut taire le corps du message', () => {
    expect(renderPlainText(message, false)).not.toContain('a < b');
  });

  it('adapte la charge utile au service destinataire', () => {
    expect(buildPayload('slack', 'x')).toEqual({ text: 'x' });
    expect(buildPayload('discord', 'x')).toEqual({ content: 'x' });
  });
});

describe('configuration du webhook', () => {
  it('n’exporte pas le corps des messages par défaut', () => {
    /* Envoyer, c'est publier : le résultat d'un run peut porter du code ou des
       noms de clients, et ne doit pas partir vers un service tiers sans que
       quelqu'un l'ait demandé. */
    expect(webhookConfigFromEnv({ MAESTRO_WEBHOOK_URL: 'https://x/y' }).detail).toBe('status');
  });

  it('accepte le détail complet quand il est demandé explicitement', () => {
    const config = webhookConfigFromEnv({
      MAESTRO_WEBHOOK_URL: 'https://x/y',
      MAESTRO_WEBHOOK_DETAIL: 'full',
    });
    expect(config.detail).toBe('full');
  });

  it('ignore une URL qui n’en est pas une, et reste désactivé', () => {
    expect(webhookConfigFromEnv({ MAESTRO_WEBHOOK_URL: 'pas-une-url' }).urls).toEqual([]);
  });

  it('retombe sur le format brut devant une valeur inconnue', () => {
    expect(webhookConfigFromEnv({ MAESTRO_WEBHOOK_FORMAT: 'mattermost' }).format).toBe('raw');
  });
});

describe('registre', () => {
  function fakeChannel(id: string, options: { fails?: boolean; enabled?: boolean } = {}): Channel {
    return {
      id,
      label: id,
      enabled: options.enabled ?? true,
      interactive: false,
      start: vi.fn(),
      stop: vi.fn(),
      send: options.fails
        ? vi.fn(async () => {
            throw new Error('service injoignable');
          })
        : vi.fn(async () => undefined),
    };
  }

  const bus = { log: vi.fn(), subscribe: vi.fn() } as unknown as Bus;

  it('diffuse à tous les canaux actifs', async () => {
    const a = fakeChannel('a');
    const b = fakeChannel('b');
    const registry = new ChannelRegistry([a, b], bus, deps());
    await registry.broadcast({ title: 'x', tone: 'info' });
    expect(a.send).toHaveBeenCalledOnce();
    expect(b.send).toHaveBeenCalledOnce();
  });

  it('un canal en panne n’empêche pas les autres de recevoir', async () => {
    // C'est exactement ce qu'un Promise.all sans garde aurait cassé.
    const cassé = fakeChannel('cassé', { fails: true });
    const bon = fakeChannel('bon');
    const registry = new ChannelRegistry([cassé, bon], bus, deps());
    await expect(registry.broadcast({ title: 'x', tone: 'info' })).resolves.toBeUndefined();
    expect(bon.send).toHaveBeenCalledOnce();
  });

  it('écarte les canaux désactivés', () => {
    const registry = new ChannelRegistry(
      [fakeChannel('a', { enabled: false }), fakeChannel('b')],
      bus,
      deps(),
    );
    expect(registry.list().map((c) => c.id)).toEqual(['b']);
    expect(registry.enabled).toBe(true);
  });

  it('signale qu’aucun canal ne sait résoudre une approbation', () => {
    const registry = new ChannelRegistry([fakeChannel('a')], bus, deps());
    expect(registry.hasInteractive).toBe(false);
  });

  it('n’envoie rien quand aucun webhook n’est configuré', async () => {
    const channel = new WebhookChannel({ urls: [], format: 'raw', detail: 'status' }, bus);
    expect(channel.enabled).toBe(false);
    await expect(channel.send({ title: 'x', tone: 'info' })).resolves.toBeUndefined();
  });
});
