/**
 * Canal webhook sortant — Slack, Discord, Mattermost, ou n'importe quel
 * point d'entrée qui accepte du JSON.
 *
 * Il existe pour deux raisons. La première est utilitaire : le webhook entrant
 * est l'intégration la plus répandue, et il ne demande ni dépendance ni bot à
 * déclarer. La seconde compte davantage — une interface qui n'a qu'une seule
 * implémentation ne prouve rien. Celle-ci confronte le contrat à un transport
 * qui ne ressemble en rien à Telegram : pas de réception, pas de boutons, un
 * format de charge utile différent par service.
 *
 * 🔒 **Envoyer, c'est publier.** Ce canal pousse du contenu vers un service
 * tiers, où il sera stocké et indexé. Le résultat d'un run peut contenir du
 * code, des extraits de dossier, des noms de clients. Le réglage par défaut
 * n'envoie donc **que l'état** — agent, statut, coût — et jamais le corps du
 * message. Passer à `full` est un choix explicite de l'opérateur, pas un défaut
 * qu'on subit.
 *
 * 🔒 L'URL d'un webhook **est un secret** : quiconque la connaît peut publier
 * dans le salon. Elle vit donc en variable d'environnement, jamais en base,
 * comme les clés d'API des comptes.
 */
import type { Bus } from '../bus.ts';
import { renderPlain, type ChatReply } from '../chat-commands.ts';
import { withResolutionHint, type Channel } from './types.ts';

/** Dialecte de la charge utile attendu par le service destinataire. */
export type WebhookFormat = 'slack' | 'discord' | 'raw';

/** Ce que le canal accepte d'envoyer hors de Maestro. */
export type WebhookDetail = 'status' | 'full';

export interface WebhookConfig {
  urls: string[];
  format: WebhookFormat;
  detail: WebhookDetail;
}

/** Délai au-delà duquel on cesse d'attendre un service tiers. */
const TIMEOUT_MS = 10_000;

export class WebhookChannel implements Channel {
  readonly id = 'webhook';
  readonly label = 'Webhook sortant';
  readonly enabled: boolean;
  /* Un webhook entrant est propre à chaque service — signature, format,
     enveloppe. Prétendre le contraire ici produirait un canal qui semble
     interactif et ne résout jamais une approbation. */
  readonly interactive = false;

  constructor(
    private config: WebhookConfig,
    private bus: Bus,
  ) {
    this.enabled = config.urls.length > 0;
  }

  start(): void {
    if (!this.enabled) return;
    this.bus.log(
      'success',
      'webhook',
      `Canal webhook actif (${this.config.urls.length} destination(s), format ${this.config.format}, détail ${this.config.detail})`,
    );
  }

  stop(): void {
    /* Rien à arrêter : le canal n'ouvre ni boucle ni connexion persistante. */
  }

  async send(reply: ChatReply): Promise<void> {
    if (!this.enabled) return;
    const text = renderPlain(withResolutionHint(stripDetail(reply, this.config.detail)));
    const payload = buildPayload(this.config.format, text);

    for (const url of this.config.urls) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) {
          /* L'URL n'est jamais journalisée : elle vaut un mot de passe, et les
             journaux sont lisibles depuis l'interface. */
          this.bus.log('warn', 'webhook', `Destination refusée (HTTP ${res.status})`);
        }
      } catch (err) {
        this.bus.log(
          'warn',
          'webhook',
          `Envoi impossible : ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

/**
 * Retire le contenu de travail, sauf réglage contraire.
 *
 * 🔒 C'est le garde-fou du canal : sans lui, une sortie de run — du code, des
 * extraits de dossier, des noms de clients — partirait vers un service tiers
 * qui la stockera et l'indexera. `full` est un choix que l'opérateur pose, pas
 * un défaut qu'il subit.
 */
export function stripDetail(reply: ChatReply, detail: WebhookDetail): ChatReply {
  if (detail === 'full') return reply;
  return { ...reply, lines: reply.lines.filter((l) => !l.detail) };
}

/**
 * Charge utile attendue par le service.
 *
 * Trois dialectes plutôt qu'un objet fourre-tout portant toutes les clés à la
 * fois : Slack rejette les champs inconnus sur certains points d'entrée, et un
 * message qui part sans erreur mais n'apparaît nulle part est le pire des
 * échecs — silencieux.
 */
export function buildPayload(format: WebhookFormat, text: string): Record<string, unknown> {
  switch (format) {
    case 'slack':
      return { text };
    case 'discord':
      return { content: text };
    case 'raw':
      return { text, message: text };
  }
}

/**
 * Lit la configuration depuis l'environnement.
 *
 * Absente, le canal est simplement désactivé : un webhook mal configuré ne doit
 * pas empêcher Maestro de démarrer, et un opérateur qui n'en veut pas n'a rien
 * à faire.
 */
export function webhookConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WebhookConfig {
  const urls = (env.MAESTRO_WEBHOOK_URL ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.startsWith('https://') || u.startsWith('http://'));

  const rawFormat = (env.MAESTRO_WEBHOOK_FORMAT ?? 'raw').toLowerCase();
  const format: WebhookFormat =
    rawFormat === 'slack' || rawFormat === 'discord' ? rawFormat : 'raw';

  /* Défaut prudent : on n'exporte pas le travail d'un agent vers un service
     tiers sans que quelqu'un l'ait demandé. */
  const detail: WebhookDetail =
    (env.MAESTRO_WEBHOOK_DETAIL ?? '').toLowerCase() === 'full' ? 'full' : 'status';

  return { urls, format, detail };
}
