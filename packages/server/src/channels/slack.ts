/**
 * Canal Slack — bidirectionnel, zéro dépendance.
 *
 * Ce canal est le second canal *entrant* de Maestro, après Telegram. C'est ce
 * qui le rend intéressant au-delà de sa propre utilité : il éprouve
 * l'abstraction dans la seule direction qui n'avait jamais été testée deux
 * fois. Le webhook sortant, lui, ne validait que la moitié sortante du contrat.
 *
 * Et l'abstraction tient : `parseCommand`, `runCommand` et
 * `parseApprovalAction` sont repris **tels quels** de `messages.ts`. Tout ce
 * fichier ne contient que du transport Slack — signature, enveloppes, blocs.
 *
 * ## Le point délicat : cette route est publique
 *
 * Telegram va chercher ses messages (long-polling) : rien n'est exposé. Slack
 * pousse les siens vers une URL, qui doit donc être joignable sans le jeton
 * Maestro — Slack ne le connaît pas et ne peut pas l'apprendre.
 *
 * 🔒 La signature **est** l'authentification, il n'y a rien derrière. D'où
 * trois règles qui ne se négocient pas :
 *
 * 1. sans secret de signature, la route n'existe pas (pas de mode « ouvert
 *    pour tester ») ;
 * 2. horodatage hors fenêtre de cinq minutes : rejeté, sinon une requête
 *    valide capturée serait rejouable indéfiniment ;
 * 3. comparaison à temps constant, parce qu'un `===` sur un HMAC laisse fuir
 *    la signature attendue octet par octet.
 *
 * 🔒 Et comme pour Telegram, la liste blanche de salons s'applique dans les
 * deux sens. Une signature valide prouve que Slack parle, pas que la personne
 * a le droit de lancer un run : sans liste blanche, tout l'espace de travail
 * piloterait l'orchestrateur.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AgentService } from '../agents.ts';
import type { Bus } from '../bus.ts';
import type { Store } from '../db.ts';
import type { ApprovalBroker } from '../permissions.ts';
import type { RunEngine } from '../runs.ts';
import { parseApprovalAction, parseCommand, runCommand, type MessageDeps } from './messages.ts';
import {
  TONE_ICONS,
  type ChannelMessage,
  type InboundChannel,
  type InboundRequest,
  type InboundResponse,
} from './types.ts';

export interface SlackConfig {
  /** Jeton de bot (`xoxb-…`), nécessaire au **sortant** seulement. */
  botToken: string | null;
  /** Secret de signature, nécessaire à l'**entrant** seulement. */
  signingSecret: string | null;
  /** Liste blanche de salons, requise dans les deux sens. */
  channelIds: string[];
}

/**
 * Lecture de la configuration Slack depuis l'environnement.
 *
 * 🔒 Les deux secrets ne sont **jamais** conservés en base ni renvoyés par
 * l'API : ils restent dans l'environnement du processus, comme le jeton
 * Telegram. Un secret de signature en base serait exportable par n'importe
 * quelle route d'administration.
 */
export function slackConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SlackConfig {
  return {
    botToken: env.SLACK_BOT_TOKEN?.trim() || null,
    signingSecret: env.SLACK_SIGNING_SECRET?.trim() || null,
    channelIds: (env.SLACK_CHANNEL_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/**
 * Fenêtre de validité d'un horodatage Slack.
 *
 * Cinq minutes est la valeur recommandée par Slack. Elle borne la fenêtre de
 * rejeu ; l'élargir pour « éviter les soucis d'horloge » revient à allonger
 * d'autant la durée de vie d'une requête capturée.
 */
export const SLACK_TIMESTAMP_WINDOW_SEC = 300;

export const SLACK_INBOUND_PATH = '/hooks/slack';

/** Verdict de vérification, avec la raison — utile au journal, jamais au client. */
export interface SignatureVerdict {
  ok: boolean;
  reason?: 'missing' | 'malformed' | 'stale' | 'mismatch';
}

/**
 * Vérifie la signature d'une requête Slack.
 *
 * La chaîne signée est `v0:<horodatage>:<corps brut>`. « Brut » est le mot
 * important : re-sérialiser le JSON reçu change les espaces et invalide la
 * signature. C'est la raison d'être du corps en `Buffer` jusqu'ici.
 */
export function verifySlackSignature(input: {
  signingSecret: string;
  rawBody: Buffer;
  signature: string | undefined;
  timestamp: string | undefined;
  nowMs: number;
}): SignatureVerdict {
  const { signingSecret, rawBody, signature, timestamp, nowMs } = input;
  if (!signature || !timestamp) return { ok: false, reason: 'missing' };
  if (!signature.startsWith('v0=')) return { ok: false, reason: 'malformed' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'malformed' };
  // Valeur absolue : une requête « du futur » est aussi suspecte qu'une vieille.
  if (Math.abs(nowMs / 1000 - ts) > SLACK_TIMESTAMP_WINDOW_SEC)
    return { ok: false, reason: 'stale' };

  const expected = `v0=${createHmac('sha256', signingSecret)
    .update(`v0:${timestamp}:${rawBody.toString('utf8')}`)
    .digest('hex')}`;

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  // `timingSafeEqual` lève si les longueurs diffèrent : le test de longueur
  // n'est pas une optimisation, il évite l'exception.
  if (a.length !== b.length) return { ok: false, reason: 'mismatch' };
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/**
 * Charge utile Slack, une fois le transport décodé.
 *
 * Slack utilise trois enveloppes différentes selon la fonctionnalité, et deux
 * types de contenu. Les normaliser ici garde le reste du canal lisible.
 */
export type SlackPayload =
  | { kind: 'url_verification'; challenge: string }
  | { kind: 'command'; text: string; channelId: string; responseUrl: string | null }
  | { kind: 'action'; actionId: string; channelId: string; responseUrl: string | null }
  | { kind: 'ignored' };

export function parseSlackPayload(contentType: string | undefined, rawBody: Buffer): SlackPayload {
  const body = rawBody.toString('utf8');

  if (contentType?.includes('application/json')) {
    const json = safeJson(body);
    if (json && json['type'] === 'url_verification' && typeof json['challenge'] === 'string') {
      return { kind: 'url_verification', challenge: json['challenge'] };
    }
    return { kind: 'ignored' };
  }

  const form = new URLSearchParams(body);

  // Composants interactifs : tout est dans un champ `payload` en JSON.
  const raw = form.get('payload');
  if (raw) {
    const json = safeJson(raw);
    if (!json || json['type'] !== 'block_actions') return { kind: 'ignored' };
    const actions = Array.isArray(json['actions']) ? json['actions'] : [];
    const first = actions[0] as Record<string, unknown> | undefined;
    const actionId = typeof first?.['action_id'] === 'string' ? first['action_id'] : null;
    const channel = json['channel'] as Record<string, unknown> | undefined;
    const channelId = typeof channel?.['id'] === 'string' ? channel['id'] : null;
    if (!actionId || !channelId) return { kind: 'ignored' };
    return {
      kind: 'action',
      actionId,
      channelId,
      responseUrl: typeof json['response_url'] === 'string' ? json['response_url'] : null,
    };
  }

  // Commande slash. Slack sépare le nom (`/maestro`) du reste (`status`) : on
  // les recolle pour que `parseCommand` voie la même chose que sur Telegram.
  const command = form.get('command');
  const channelId = form.get('channel_id');
  if (command && channelId) {
    const rest = (form.get('text') ?? '').trim();
    return {
      kind: 'command',
      text: normalizeCommand(command, rest),
      channelId,
      responseUrl: form.get('response_url'),
    };
  }

  return { kind: 'ignored' };
}

/**
 * Recompose une ligne de commande à partir de l'enveloppe Slack.
 *
 * Deux conventions de déclaration doivent marcher, parce que Slack impose une
 * commande par déclaration et qu'un espace de travail n'en veut pas cinq :
 *
 * - `/maestro status` — une seule commande déclarée, le verbe est dans le
 *   texte. C'est la forme recommandée.
 * - `/status` — une commande par verbe, comme sur Telegram.
 */
export function normalizeCommand(command: string, rest: string): string {
  const name = command.startsWith('/') ? command.slice(1) : command;
  if (name.toLowerCase() !== 'maestro') return `/${name} ${rest}`.trim();
  // `/maestro` seul vaut `/help` : une commande sans verbe doit expliquer, pas
  // rester muette.
  if (!rest) return '/help';
  return `/${rest}`;
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export class SlackChannel implements InboundChannel {
  readonly id = 'slack';
  readonly label = 'Slack';
  readonly enabled: boolean;
  readonly interactive: boolean;
  readonly inboundPath = SLACK_INBOUND_PATH;

  private outbound: boolean;
  private deps: MessageDeps;

  constructor(
    private config: SlackConfig,
    store: Store,
    private bus: Bus,
    engine: RunEngine,
    agents: AgentService,
    private approvals: ApprovalBroker,
  ) {
    const whitelisted = config.channelIds.length > 0;
    this.outbound = Boolean(config.botToken) && whitelisted;
    // L'entrant n'a besoin que du secret : les réponses aux commandes partent
    // par `response_url`, fourni dans la requête. Un espace de travail peut
    // donc piloter Maestro sans jamais installer de bot émetteur.
    this.interactive = Boolean(config.signingSecret) && whitelisted;
    this.enabled = this.outbound || this.interactive;
    this.deps = { store, agents, engine };
  }

  start(): void {
    if (!this.enabled) return;
    const modes = [this.outbound && 'sortant', this.interactive && 'entrant'].filter(Boolean);
    this.bus.log(
      'success',
      'slack',
      `Canal Slack actif (${modes.join(' + ')}, ${this.config.channelIds.length} salon(s) autorisés)`,
    );
  }

  stop(): void {
    /* Rien à arrêter : pas de boucle, le transport entrant est le serveur HTTP. */
  }

  // -- Sortant -----------------------------------------------------------------

  async send(message: ChannelMessage): Promise<void> {
    if (!this.outbound) return;
    for (const channel of this.config.channelIds) {
      await this.api('chat.postMessage', {
        channel,
        // `text` reste rempli même avec des blocs : c'est lui qui sert de
        // repli dans les notifications mobiles et les résumés.
        text: message.title,
        blocks: renderBlocks(message),
      });
    }
  }

  private async api(method: string, body: Record<string, unknown>): Promise<void> {
    try {
      const res = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${this.config.botToken ?? ''}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      // Slack répond 200 même en cas d'erreur métier : c'est `ok` qui tranche.
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok) this.bus.log('warn', 'slack', `API ${method} refusée : ${data.error ?? '?'}`);
    } catch (err) {
      this.bus.log('warn', 'slack', `API ${method} en échec : ${String(err)}`);
    }
  }

  // -- Entrant ------------------------------------------------------------------

  async handleInbound(req: InboundRequest): Promise<InboundResponse> {
    if (!this.interactive || !this.config.signingSecret) return { status: 404 };

    const verdict = verifySlackSignature({
      signingSecret: this.config.signingSecret,
      rawBody: req.rawBody,
      signature: req.headers['x-slack-signature'],
      timestamp: req.headers['x-slack-request-timestamp'],
      nowMs: Date.now(),
    });
    if (!verdict.ok) {
      // La raison est journalisée, jamais renvoyée : dire « signature invalide »
      // plutôt que « horodatage périmé » aide surtout celui qui sonde.
      this.bus.log('warn', 'slack', `Requête entrante rejetée (${verdict.reason})`);
      return { status: 401, body: 'signature invalide' };
    }

    const payload = parseSlackPayload(req.headers['content-type'], req.rawBody);

    // Vérification d'URL : Slack l'envoie signée, avant toute notion de salon.
    if (payload.kind === 'url_verification') {
      return { status: 200, body: { challenge: payload.challenge } };
    }
    if (payload.kind === 'ignored') return { status: 200 };

    if (!this.config.channelIds.includes(payload.channelId)) {
      this.bus.log('warn', 'slack', `Salon non autorisé : ${payload.channelId}`);
      return { status: 200, body: ephemeral('Ce salon n’est pas autorisé à piloter Maestro.') };
    }

    if (payload.kind === 'action') return await this.handleAction(payload);
    return this.handleCommand(payload);
  }

  private async handleAction(payload: {
    actionId: string;
    responseUrl: string | null;
  }): Promise<InboundResponse> {
    const action = parseApprovalAction(payload.actionId);
    if (!action) return { status: 200 };
    const resolved = this.approvals.resolve(
      action.approvalId,
      action.decision,
      'slack',
      'Via Slack',
    );
    const text = resolved
      ? action.decision === 'allow'
        ? 'Autorisé ✅'
        : 'Refusé ❌'
      : 'Déjà résolue';
    // Confirmation à côté du message d'origine plutôt qu'à sa place : remplacer
    // la notification effacerait ce sur quoi la décision portait.
    if (payload.responseUrl) await this.post(payload.responseUrl, ephemeral(text));
    return { status: 200 };
  }

  /**
   * Répond à une commande slash.
   *
   * Slack coupe au bout de trois secondes, donc la première réponse voyage dans
   * la réponse HTTP elle-même. Les suivantes passent par `response_url` — et
   * `/approvals` en produit une par approbation en attente.
   */
  private handleCommand(payload: { text: string; responseUrl: string | null }): InboundResponse {
    const command = parseCommand(payload.text);
    if (!command) {
      return {
        status: 200,
        body: ephemeral('Commande inconnue. `/maestro help` liste les verbes.'),
      };
    }

    const replies = runCommand(this.deps, command);
    if (replies.length === 0) return { status: 200 };

    const [first, ...rest] = replies;
    if (rest.length > 0 && payload.responseUrl) {
      // Détaché : la réponse HTTP ne doit pas attendre ces envois, sinon on
      // rejoue exactement le délai de trois secondes qu'on cherche à éviter.
      void this.postExtras(payload.responseUrl, rest);
    }
    return { status: 200, body: ephemeral(undefined, first) };
  }

  /**
   * Envoie les réponses suivantes.
   *
   * 🔒 `response_url` n'accepte que cinq usages ; une d'elles est déjà prise
   * par la réponse HTTP. Au-delà, le reste est annoncé plutôt que perdu en
   * silence — une approbation invisible est pire qu'une liste tronquée qui le dit.
   */
  private async postExtras(responseUrl: string, messages: ChannelMessage[]): Promise<void> {
    const budget = 4;
    for (const message of messages.slice(0, budget)) {
      await this.post(responseUrl, ephemeral(undefined, message));
    }
    const dropped = messages.length - budget;
    if (dropped > 0) {
      await this.post(
        responseUrl,
        ephemeral(`… et ${dropped} autre(s), à voir dans l’interface Maestro.`),
      );
    }
  }

  private async post(url: string, body: unknown): Promise<void> {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.bus.log('warn', 'slack', `Réponse différée en échec : ${String(err)}`);
    }
  }
}

/**
 * Enveloppe de réponse à une commande.
 *
 * 🔒 `ephemeral` n'est pas un détail de confort : une réponse de commande peut
 * porter la sortie d'un run, donc du travail. La diffuser dans le salon serait
 * une publication que personne n'a demandée. Seule la personne qui a tapé la
 * commande la voit ; les notifications, elles, restent publiques — c'est leur
 * raison d'être.
 */
function ephemeral(text?: string, message?: ChannelMessage): Record<string, unknown> {
  if (message) {
    return {
      response_type: 'ephemeral',
      text: message.title,
      blocks: renderBlocks(message),
    };
  }
  return { response_type: 'ephemeral', text: text ?? '' };
}

/**
 * Rendu en blocs Slack.
 *
 * Les actions deviennent des boutons, donc ne sont pas répétées en texte —
 * même choix que sur Telegram, pour la même raison : dans un canal où elles
 * sont cliquables, les réécrire en dessous fait doublon.
 */
export function renderBlocks(message: ChannelMessage): unknown[] {
  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${TONE_ICONS[message.tone]} *${escapeMrkdwn(message.title)}*`,
      },
    },
  ];

  const fields = message.fields ?? [];
  if (fields.length > 0) {
    blocks.push({
      type: 'section',
      // Slack plafonne à dix champs par section et les dispose en deux
      // colonnes. Au-delà, il refuse le bloc entier.
      fields: fields.slice(0, 10).map((f) => ({
        type: 'mrkdwn',
        text: `*${escapeMrkdwn(f.label)}*\n\`${escapeMrkdwn(f.value)}\``,
      })),
    });
  }

  if (message.body) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(escapeMrkdwn(message.body)) },
    });
  }

  if (message.actions && message.actions.length > 0) {
    blocks.push({
      type: 'actions',
      elements: message.actions.map((action) => ({
        type: 'button',
        text: {
          type: 'plain_text',
          text: `${action.style === 'danger' ? '❌' : '✅'} ${action.label}`,
        },
        // `action_id` porte la décision : c'est lui que Slack renvoie, et il
        // suffit à `parseApprovalAction` sans état conservé côté serveur.
        action_id: action.id,
        value: action.id,
        ...(action.style ? { style: action.style } : {}),
      })),
    });
  }

  return blocks;
}

/**
 * Un bloc `section` Slack est limité à 3000 caractères de texte.
 *
 * Dépasser fait refuser le message entier : mieux vaut une sortie de run
 * coupée qu'une notification qui n'arrive jamais.
 */
const SECTION_LIMIT = 3000;

function truncate(text: string): string {
  if (text.length <= SECTION_LIMIT) return text;
  const suffix = '\n… (tronqué)';
  return text.slice(0, SECTION_LIMIT - suffix.length) + suffix;
}

/**
 * Échappement mrkdwn.
 *
 * Slack ne demande que ces trois caractères : `&`, `<` et `>`, qui délimitent
 * ses liens et ses mentions. Un `<@U123>` glissé dans une sortie de run ne doit
 * pas se transformer en notification à quelqu'un.
 */
export function escapeMrkdwn(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
