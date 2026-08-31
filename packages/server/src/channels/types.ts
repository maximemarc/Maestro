/**
 * Canaux de notification et de commande.
 *
 * Un canal relie Maestro à un endroit où des humains regardent : Telegram, un
 * salon Slack, un salon Discord, un webhook. Le contrat est volontairement
 * mince, parce que ce qui distingue deux canaux tient presque entièrement dans
 * le transport.
 *
 * ## La décision qui structure tout : un message n'est pas du texte
 *
 * Le code d'origine fabriquait directement du HTML Telegram. Cette chaîne est
 * inutilisable ailleurs — `<b>` s'affiche littéralement dans Discord, et un nom
 * d'agent contenant `_` met la moitié d'un message Discord en italique. Un
 * message est donc une **structure** de spans (`chat-commands.ts`), qui décrit
 * l'intention — emphase, code — et non le balisage. Chaque canal la rend avec
 * son propre `render*`.
 *
 * Sans cela, ajouter un canal reviendrait à réécrire la mise en forme *et* la
 * logique de notification, et les deux copies divergeraient à la première
 * évolution. C'est précisément ce qui était arrivé : trois passerelles, trois
 * copies de « faut-il notifier », trois mises en page à maintenir.
 */
import type { ChatReply } from '../chat-commands.ts';

export interface Channel {
  /** Identifiant stable, utilisé dans les journaux. */
  readonly id: string;
  readonly label: string;
  /** Faux quand la configuration est absente : le canal est alors ignoré. */
  readonly enabled: boolean;
  /**
   * Le canal sait **résoudre** une approbation, pas seulement l'annoncer.
   *
   * La distinction est structurante et pas cosmétique : un canal sortant seul
   * peut dire qu'une approbation attend, il ne peut pas la trancher. Le message
   * doit alors indiquer où aller — une approbation qui attend sans que
   * personne ne sache où la résoudre est pire qu'une notification absente.
   */
  readonly interactive: boolean;
  start(): void;
  stop(): void;
  /** Diffuse un message aux destinataires du canal. */
  send(reply: ChatReply): Promise<void>;
}

/**
 * Libellés des boutons d'approbation.
 *
 * Ici et non dans chaque canal : ce sont les mêmes décisions partout, et les
 * voir diverger d'un canal à l'autre serait déroutant au moment précis où
 * l'utilisateur doit trancher vite.
 */
export const APPROVAL_ACTIONS = [
  { decision: 'allow' as const, label: 'Autoriser', icon: '✅' },
  { decision: 'deny' as const, label: 'Refuser', icon: '❌' },
];

/** Encode l'identifiant d'action d'un bouton d'approbation. */
export function approvalActionId(approvalId: string, decision: 'allow' | 'deny'): string {
  return `apr:${approvalId}:${decision}`;
}

/**
 * Ajoute au message la mention de l'endroit où trancher.
 *
 * À appeler par tout canal **non interactif** qui reçoit un message portant des
 * approbations. C'est ici et non dans chaque canal pour une raison précise :
 * c'est exactement le genre de détail qu'une implémentation oublie, et l'oubli
 * produit le pire résultat possible — une notification qui annonce une décision
 * à prendre sans dire où la prendre.
 */
export function withResolutionHint(reply: ChatReply): ChatReply {
  if (!reply.approvalIds || reply.approvalIds.length === 0) return reply;
  return {
    ...reply,
    lines: [
      ...reply.lines,
      { spans: [{ text: 'À trancher dans l’interface Maestro ou depuis Telegram.' }] },
    ],
  };
}

/** Décode l'identifiant d'une action d'approbation, ou `null` s'il n'en est pas. */
export function parseApprovalAction(
  actionId: string,
): { approvalId: string; decision: 'allow' | 'deny' } | null {
  const [kind, approvalId, decision] = actionId.split(':');
  if (kind !== 'apr' || !approvalId) return null;
  if (decision !== 'allow' && decision !== 'deny') return null;
  return { approvalId, decision };
}
