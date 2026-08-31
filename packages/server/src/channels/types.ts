/**
 * Canaux de notification et de commande.
 *
 * Un canal relie Maestro à un endroit où des humains regardent : Telegram, un
 * salon Slack, un webhook Discord. Le contrat est volontairement mince, parce
 * que ce qui distingue deux canaux tient presque entièrement dans le transport.
 *
 * ## La décision qui structure tout : un message n'est pas du texte
 *
 * Le code d'origine fabriquait directement du HTML Telegram. Cette chaîne est
 * inutilisable ailleurs — `<b>` s'affiche littéralement dans Discord, et les
 * boutons d'approbation n'ont d'équivalent nulle part. Un message est donc ici
 * une **structure** : un titre, des faits, un corps, des actions. Chaque canal
 * la rend selon ses moyens.
 *
 * Sans cela, ajouter un canal reviendrait à réécrire la mise en forme *et* la
 * logique de notification, et les deux copies divergeraient à la première
 * évolution.
 */

/** Ton d'un message, dont chaque canal tire son icône ou sa couleur. */
export type ChannelTone = 'ok' | 'warn' | 'error' | 'info';

/**
 * Action proposée à l'humain.
 *
 * Seuls les canaux interactifs les rendent en boutons. Les autres doivent les
 * mentionner en texte : une approbation qui attend sans que personne ne sache
 * où la résoudre est pire qu'une notification absente.
 */
export interface ChannelAction {
  /** Identifiant repris tel quel dans la réponse du canal (`apr:<id>:allow`). */
  id: string;
  label: string;
  style?: 'primary' | 'danger';
}

export interface ChannelMessage {
  /** Une ligne, sans balisage. */
  title: string;
  tone: ChannelTone;
  /** Faits affichés en liste ; l'ordre est celui de la lecture utile. */
  fields?: { label: string; value: string }[];
  /**
   * Corps long — résultat d'un run, entrée d'un outil.
   *
   * Séparé des faits parce que tous les canaux ne veulent pas l'envoyer : ce
   * contenu peut porter du travail confidentiel, et le pousser vers un service
   * externe est une publication.
   */
  body?: string;
  actions?: ChannelAction[];
}

export interface Channel {
  /** Identifiant stable, utilisé dans les journaux. */
  readonly id: string;
  readonly label: string;
  /** Faux quand la configuration est absente : le canal est alors ignoré. */
  readonly enabled: boolean;
  /**
   * Le canal sait **recevoir** : commandes entrantes, résolution d'approbation.
   *
   * La distinction est structurante et pas cosmétique : un canal sortant seul
   * peut annoncer qu'une approbation attend, il ne peut pas la résoudre. Le
   * message doit alors dire où aller.
   */
  readonly interactive: boolean;
  start(): void;
  stop(): void;
  /** Diffuse un message aux destinataires du canal. */
  send(message: ChannelMessage): Promise<void>;
}

/** Icône par ton, partagée par les canaux qui en affichent une. */
export const TONE_ICONS: Record<ChannelTone, string> = {
  ok: '✅',
  warn: '⚠️',
  error: '❌',
  info: 'ℹ️',
};

/**
 * Rendu en texte brut, sans balisage.
 *
 * Repli commun à tout canal qui n'a pas de format riche. Le placer ici évite
 * que chaque implémentation réinvente sa mise en page — et que l'une d'elles
 * oublie les actions, qui sont la partie la plus importante à ne pas perdre.
 */
export function renderPlainText(message: ChannelMessage, includeBody = true): string {
  const lines = [`${TONE_ICONS[message.tone]} ${message.title}`];
  for (const field of message.fields ?? []) lines.push(`${field.label} : ${field.value}`);
  if (includeBody && message.body) lines.push('', message.body);
  if (message.actions && message.actions.length > 0) {
    lines.push(
      '',
      `Action attendue dans Maestro : ${message.actions.map((a) => a.label).join(' / ')}`,
    );
  }
  return lines.join('\n');
}
