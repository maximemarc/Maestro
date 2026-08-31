/**
 * Tests du canal Slack.
 *
 * Deux familles, et la première est la seule qui compte vraiment.
 *
 * **La route entrante est publique.** Il n'y a pas de jeton derrière : si la
 * vérification de signature se laisse contourner, n'importe qui sur Internet
 * lance des runs et résout des approbations. Ces tests sont donc écrits comme
 * ceux d'un contrôle d'accès — un cas par manière de tricher : sans signature,
 * signature d'un autre secret, requête rejouée plus tard, salon non autorisé.
 *
 * **Le rendu**, ensuite, pour les limites de Slack qui font refuser un message
 * entier plutôt que le dégrader : dix champs par section, trois mille
 * caractères par bloc.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentService } from '../agents.ts';
import type { Bus } from '../bus.ts';
import type { Store } from '../db.ts';
import type { ApprovalBroker } from '../permissions.ts';
import type { RunEngine } from '../runs.ts';
import {
  escapeMrkdwn,
  normalizeCommand,
  parseSlackPayload,
  renderBlocks,
  SlackChannel,
  slackConfigFromEnv,
  verifySlackSignature,
  type SlackConfig,
} from './slack.ts';
import { supportsInbound, type ChannelMessage } from './types.ts';

const SECRET = 'secret-de-signature-fictif';

function sign(rawBody: string, timestamp: string, secret = SECRET): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
}

function bus(): Bus {
  return { log: vi.fn() } as unknown as Bus;
}

function channel(
  overrides: Partial<SlackConfig> = {},
  extras: { approvals?: ApprovalBroker } = {},
): SlackChannel {
  const config: SlackConfig = {
    botToken: 'xoxb-fictif',
    signingSecret: SECRET,
    channelIds: ['C0AUTORISE'],
    ...overrides,
  };
  return new SlackChannel(
    config,
    { getSettings: () => ({}), countPendingApprovals: () => 0 } as unknown as Store,
    bus(),
    { activeCount: () => 0, queuedCount: () => 0 } as unknown as RunEngine,
    { list: () => [] } as unknown as AgentService,
    extras.approvals ?? ({ resolve: () => true } as unknown as ApprovalBroker),
  );
}

// ---------------------------------------------------------------------------
// Signature : la seule authentification de la route
// ---------------------------------------------------------------------------

describe('vérification de signature', () => {
  const nowMs = 1_760_000_000_000;
  const timestamp = String(Math.floor(nowMs / 1000));
  const rawBody = 'token=x&command=%2Fmaestro&text=status';

  it('accepte une signature calculée avec le bon secret', () => {
    const verdict = verifySlackSignature({
      signingSecret: SECRET,
      rawBody: Buffer.from(rawBody),
      signature: sign(rawBody, timestamp),
      timestamp,
      nowMs,
    });
    expect(verdict.ok).toBe(true);
  });

  it('refuse une requête sans signature', () => {
    const verdict = verifySlackSignature({
      signingSecret: SECRET,
      rawBody: Buffer.from(rawBody),
      signature: undefined,
      timestamp,
      nowMs,
    });
    expect(verdict).toEqual({ ok: false, reason: 'missing' });
  });

  it('refuse une signature signée avec un autre secret', () => {
    const verdict = verifySlackSignature({
      signingSecret: SECRET,
      rawBody: Buffer.from(rawBody),
      signature: sign(rawBody, timestamp, 'mauvais-secret'),
      timestamp,
      nowMs,
    });
    expect(verdict).toEqual({ ok: false, reason: 'mismatch' });
  });

  /* Le cœur de la protection anti-rejeu : la signature reste valable
     éternellement, c'est l'horodatage qui périme la requête. */
  it('refuse une requête valide mais rejouée hors fenêtre', () => {
    const old = String(Math.floor(nowMs / 1000) - 301);
    const verdict = verifySlackSignature({
      signingSecret: SECRET,
      rawBody: Buffer.from(rawBody),
      signature: sign(rawBody, old),
      timestamp: old,
      nowMs,
    });
    expect(verdict).toEqual({ ok: false, reason: 'stale' });
  });

  it('refuse aussi un horodatage dans le futur', () => {
    const future = String(Math.floor(nowMs / 1000) + 301);
    const verdict = verifySlackSignature({
      signingSecret: SECRET,
      rawBody: Buffer.from(rawBody),
      signature: sign(rawBody, future),
      timestamp: future,
      nowMs,
    });
    expect(verdict).toEqual({ ok: false, reason: 'stale' });
  });

  /* Une signature du bon corps mais d'un autre horodatage ne doit pas passer :
     sinon la fenêtre ne protégerait rien, il suffirait de changer l'en-tête. */
  it('refuse une signature dont l’horodatage a été modifié', () => {
    const verdict = verifySlackSignature({
      signingSecret: SECRET,
      rawBody: Buffer.from(rawBody),
      signature: sign(rawBody, timestamp),
      timestamp: String(Number(timestamp) - 10),
      nowMs,
    });
    expect(verdict).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuse une signature du bon secret mais d’un autre corps', () => {
    const verdict = verifySlackSignature({
      signingSecret: SECRET,
      rawBody: Buffer.from(`${rawBody}&injecte=1`),
      signature: sign(rawBody, timestamp),
      timestamp,
      nowMs,
    });
    expect(verdict).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuse un préfixe de version inconnu', () => {
    const verdict = verifySlackSignature({
      signingSecret: SECRET,
      rawBody: Buffer.from(rawBody),
      signature: sign(rawBody, timestamp).replace('v0=', 'v1='),
      timestamp,
      nowMs,
    });
    expect(verdict).toEqual({ ok: false, reason: 'malformed' });
  });

  /* Longueurs différentes : `timingSafeEqual` lèverait. Le verdict doit être un
     refus propre, pas une exception qui remonterait en 500. */
  it('refuse une signature tronquée sans lever', () => {
    const verdict = verifySlackSignature({
      signingSecret: SECRET,
      rawBody: Buffer.from(rawBody),
      signature: 'v0=abcd',
      timestamp,
      nowMs,
    });
    expect(verdict).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('refuse un horodatage non numérique', () => {
    const verdict = verifySlackSignature({
      signingSecret: SECRET,
      rawBody: Buffer.from(rawBody),
      signature: sign(rawBody, 'hier'),
      timestamp: 'hier',
      nowMs,
    });
    expect(verdict).toEqual({ ok: false, reason: 'malformed' });
  });
});

// ---------------------------------------------------------------------------
// Enveloppes Slack
// ---------------------------------------------------------------------------

describe('analyse des enveloppes', () => {
  it('reconnaît la vérification d’URL', () => {
    const payload = parseSlackPayload(
      'application/json',
      Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'abc123' })),
    );
    expect(payload).toEqual({ kind: 'url_verification', challenge: 'abc123' });
  });

  it('reconnaît une commande slash', () => {
    const form = new URLSearchParams({
      command: '/maestro',
      text: 'status',
      channel_id: 'C0AUTORISE',
      response_url: 'https://hooks.slack.com/commands/abc',
    });
    const payload = parseSlackPayload(
      'application/x-www-form-urlencoded',
      Buffer.from(form.toString()),
    );
    expect(payload).toEqual({
      kind: 'command',
      text: '/status',
      channelId: 'C0AUTORISE',
      responseUrl: 'https://hooks.slack.com/commands/abc',
    });
  });

  it('reconnaît un clic de bouton', () => {
    const form = new URLSearchParams({
      payload: JSON.stringify({
        type: 'block_actions',
        channel: { id: 'C0AUTORISE' },
        response_url: 'https://hooks.slack.com/actions/abc',
        actions: [{ action_id: 'apr:ap_1:allow' }],
      }),
    });
    const payload = parseSlackPayload(
      'application/x-www-form-urlencoded',
      Buffer.from(form.toString()),
    );
    expect(payload).toEqual({
      kind: 'action',
      actionId: 'apr:ap_1:allow',
      channelId: 'C0AUTORISE',
      responseUrl: 'https://hooks.slack.com/actions/abc',
    });
  });

  /* Slack envoie aussi des événements dont Maestro n'a rien à faire. Ils
     doivent être ignorés, pas provoquer une erreur — un 500 déclencherait des
     tentatives répétées côté Slack. */
  it('ignore un contenu inconnu', () => {
    expect(parseSlackPayload('application/json', Buffer.from('{"type":"event_callback"}'))).toEqual(
      {
        kind: 'ignored',
      },
    );
    expect(parseSlackPayload('application/json', Buffer.from('pas du json'))).toEqual({
      kind: 'ignored',
    });
    expect(parseSlackPayload(undefined, Buffer.from(''))).toEqual({ kind: 'ignored' });
  });

  it('ignore un clic sans identifiant d’action', () => {
    const form = new URLSearchParams({
      payload: JSON.stringify({ type: 'block_actions', channel: { id: 'C1' }, actions: [] }),
    });
    expect(
      parseSlackPayload('application/x-www-form-urlencoded', Buffer.from(form.toString())),
    ).toEqual({ kind: 'ignored' });
  });
});

describe('recomposition de la commande', () => {
  /* Slack impose une commande par déclaration : un espace de travail ne veut
     pas en déclarer cinq. Les deux conventions doivent donc marcher. */
  it('accepte la forme « une commande, un verbe en argument »', () => {
    expect(normalizeCommand('/maestro', 'status')).toBe('/status');
    expect(normalizeCommand('/maestro', 'run Comptabilité fais le point')).toBe(
      '/run Comptabilité fais le point',
    );
  });

  it('accepte la forme « une commande par verbe »', () => {
    expect(normalizeCommand('/status', '')).toBe('/status');
    expect(normalizeCommand('/run', 'Comptabilité fais le point')).toBe(
      '/run Comptabilité fais le point',
    );
  });

  it('traite « /maestro » seul comme une demande d’aide', () => {
    expect(normalizeCommand('/maestro', '')).toBe('/help');
  });
});

// ---------------------------------------------------------------------------
// Activation : les deux sens sont indépendants
// ---------------------------------------------------------------------------

describe('activation du canal', () => {
  it('actif dans les deux sens avec jeton et secret', () => {
    const slack = channel();
    expect(slack.enabled).toBe(true);
    expect(slack.interactive).toBe(true);
    expect(supportsInbound(slack)).toBe(true);
  });

  /* Émission seule : le canal marche, mais sa route ne doit pas être montée —
     rien ne vérifierait les requêtes qui y arriveraient. */
  it('sans secret : émission seule, aucune route entrante', () => {
    const slack = channel({ signingSecret: null });
    expect(slack.enabled).toBe(true);
    expect(slack.interactive).toBe(false);
    expect(supportsInbound(slack)).toBe(false);
  });

  it('sans jeton : réception seule, les réponses passent par response_url', () => {
    const slack = channel({ botToken: null });
    expect(slack.enabled).toBe(true);
    expect(slack.interactive).toBe(true);
  });

  /* 🔒 Sans liste blanche, une signature valide suffirait à piloter Maestro
     depuis n'importe quel salon de l'espace de travail. */
  it('sans liste blanche de salons : canal désactivé', () => {
    expect(channel({ channelIds: [] }).enabled).toBe(false);
  });

  it('ne conserve aucun secret absent de l’environnement', () => {
    const config = slackConfigFromEnv({});
    expect(config).toEqual({ botToken: null, signingSecret: null, channelIds: [] });
  });

  it('lit la liste blanche en la nettoyant', () => {
    const config = slackConfigFromEnv({ SLACK_CHANNEL_IDS: ' C1 , ,C2 ' });
    expect(config.channelIds).toEqual(['C1', 'C2']);
  });
});

// ---------------------------------------------------------------------------
// Traitement de bout en bout
// ---------------------------------------------------------------------------

describe('requête entrante', () => {
  const nowMs = Date.now();
  const timestamp = String(Math.floor(nowMs / 1000));

  function headers(rawBody: string, contentType: string, secret = SECRET) {
    return {
      'content-type': contentType,
      'x-slack-signature': sign(rawBody, timestamp, secret),
      'x-slack-request-timestamp': timestamp,
    };
  }

  it('renvoie 401 sur signature invalide', async () => {
    const slack = channel();
    const rawBody = 'command=%2Fmaestro&text=status&channel_id=C0AUTORISE';
    const res = await slack.handleInbound({
      rawBody: Buffer.from(rawBody),
      headers: headers(rawBody, 'application/x-www-form-urlencoded', 'autre-secret'),
    });
    expect(res.status).toBe(401);
  });

  it('répond au défi de vérification d’URL', async () => {
    const slack = channel();
    const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const res = await slack.handleInbound({
      rawBody: Buffer.from(rawBody),
      headers: headers(rawBody, 'application/json'),
    });
    expect(res).toEqual({ status: 200, body: { challenge: 'abc123' } });
  });

  /* 🔒 Signature valide et salon interdit : la requête vient bien de Slack,
     mais pas d'un endroit autorisé à piloter l'orchestrateur. */
  it('refuse un salon hors liste blanche malgré une signature valide', async () => {
    const resolve = vi.fn(() => true);
    const slack = channel({}, { approvals: { resolve } as unknown as ApprovalBroker });
    const rawBody = new URLSearchParams({
      payload: JSON.stringify({
        type: 'block_actions',
        channel: { id: 'C0INTERDIT' },
        actions: [{ action_id: 'apr:ap_1:allow' }],
      }),
    }).toString();
    const res = await slack.handleInbound({
      rawBody: Buffer.from(rawBody),
      headers: headers(rawBody, 'application/x-www-form-urlencoded'),
    });
    expect(res.status).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('résout une approbation depuis un salon autorisé', async () => {
    const resolve = vi.fn(() => true);
    const slack = channel({}, { approvals: { resolve } as unknown as ApprovalBroker });
    const rawBody = new URLSearchParams({
      payload: JSON.stringify({
        type: 'block_actions',
        channel: { id: 'C0AUTORISE' },
        actions: [{ action_id: 'apr:ap_1:deny' }],
      }),
    }).toString();
    await slack.handleInbound({
      rawBody: Buffer.from(rawBody),
      headers: headers(rawBody, 'application/x-www-form-urlencoded'),
    });
    expect(resolve).toHaveBeenCalledWith('ap_1', 'deny', 'slack', 'Via Slack');
  });

  /* 🔒 La réponse à une commande peut porter la sortie d'un run : elle reste
     visible de la seule personne qui a tapé la commande. */
  it('répond à une commande en éphémère', async () => {
    const slack = channel();
    const rawBody = new URLSearchParams({
      command: '/maestro',
      text: 'help',
      channel_id: 'C0AUTORISE',
    }).toString();
    const res = await slack.handleInbound({
      rawBody: Buffer.from(rawBody),
      headers: headers(rawBody, 'application/x-www-form-urlencoded'),
    });
    expect(res.status).toBe(200);
    expect((res.body as { response_type: string }).response_type).toBe('ephemeral');
  });

  it('ne monte rien quand le secret manque', async () => {
    const slack = channel({ signingSecret: null });
    const res = await slack.handleInbound({ rawBody: Buffer.alloc(0), headers: {} });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Rendu : les limites de Slack font refuser le message entier
// ---------------------------------------------------------------------------

describe('rendu en blocs', () => {
  function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
    return { title: 'Run terminé', tone: 'ok', ...overrides };
  }

  it('rend le titre avec l’icône du ton', () => {
    const blocks = renderBlocks(message()) as { text: { text: string } }[];
    expect(blocks[0]?.text.text).toBe('✅ *Run terminé*');
  });

  /* Slack refuse le bloc entier au-delà de dix champs : mieux vaut une liste
     tronquée qu'aucune notification. */
  it('plafonne les champs à dix', () => {
    const fields = Array.from({ length: 14 }, (_, i) => ({ label: `f${i}`, value: `v${i}` }));
    const blocks = renderBlocks(message({ fields })) as { fields?: unknown[] }[];
    expect(blocks[1]?.fields).toHaveLength(10);
  });

  it('tronque un corps au-delà de trois mille caractères', () => {
    const blocks = renderBlocks(message({ body: 'x'.repeat(4000) })) as {
      text?: { text: string };
    }[];
    const body = blocks[1]?.text?.text ?? '';
    expect(body.length).toBeLessThanOrEqual(3000);
    expect(body.endsWith('… (tronqué)')).toBe(true);
  });

  it('transforme les actions en boutons portant leur identifiant', () => {
    const blocks = renderBlocks(
      message({
        actions: [
          { id: 'apr:ap_1:allow', label: 'Autoriser', style: 'primary' },
          { id: 'apr:ap_1:deny', label: 'Refuser', style: 'danger' },
        ],
      }),
    ) as { type: string; elements?: { action_id: string; style?: string }[] }[];
    const actions = blocks.at(-1);
    expect(actions?.type).toBe('actions');
    expect(actions?.elements?.map((e) => e.action_id)).toEqual(['apr:ap_1:allow', 'apr:ap_1:deny']);
    expect(actions?.elements?.[1]?.style).toBe('danger');
  });

  /* Une sortie de run qui contient `<@U123>` ne doit pas se transformer en
     notification à un collègue au passage. */
  it('neutralise les mentions présentes dans le contenu', () => {
    expect(escapeMrkdwn('vu avec <@U123> & co')).toBe('vu avec &lt;@U123&gt; &amp; co');
  });
});
