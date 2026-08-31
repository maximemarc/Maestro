/**
 * Fédération : déléguer du travail à une autre instance de Maestro.
 *
 * `send_to_agent` ne franchissait pas les frontières du processus. Une machine
 * qui atteint sa limite d'usage, ou qui n'a pas l'agent compétent, ne pouvait
 * rien passer à sa voisine.
 *
 * ## Ce qui rend l'ajout léger
 *
 * Rien à inventer côté transport : l'API REST de Maestro sait déjà créer un run
 * et rendre son résultat, derrière un jeton. Une instance délègue donc en étant
 * simplement **cliente** de sa voisine. Passer par la passerelle MCP aurait
 * ajouté une couche de protocole pour le même effet.
 *
 * ## Déclaration explicite, et pas de découverte
 *
 * OpenClaw découvre ses pairs en DNS-SD. Ce n'est pas repris, et c'est un choix :
 * une découverte sur le réseau local accorderait sa confiance à qui répond. Tout
 * le modèle de sécurité de Maestro repose sur un jeton donné exprès. Une
 * découverte sans établissement de confiance serait un passif, pas une
 * fonctionnalité.
 *
 * 🔒 **Un jeton de pair ouvre l'API complète de la machine visée** — lancer des
 * runs, lire les transcripts, modifier la configuration. Il est donc traité
 * comme les clés de fournisseurs : on enregistre le **nom de la variable
 * d'environnement** qui le porte, jamais sa valeur.
 */

/** Séparateur d'une cible fédérée : `agent@pair`. */
export const PEER_SEPARATOR = '@';

/**
 * Santé d'un pair, telle que le disjoncteur la voit.
 *
 * `open` signifie que le disjoncteur a coupé : les échecs se sont répétés, et on
 * cesse d'appeler pendant un temps. Sans cela, chaque délégation vers une
 * machine éteinte attendrait son délai complet avant d'échouer — l'agent
 * appelant, lui, reste bloqué pendant ce temps.
 */
export type PeerHealth = 'unknown' | 'ready' | 'open' | 'unauthorized' | 'unreachable';

export interface FederatedPeer {
  id: string;
  /** Nom court utilisé dans une cible `agent@pair`. Sans arobase ni espace. */
  name: string;
  /** Racine de l'API de la voisine, par exemple `https://maestro.autre:4520`. */
  baseUrl: string;
  /**
   * Nom de la variable d'environnement qui porte le jeton du pair.
   *
   * 🔒 Jamais la valeur : elle reste dans l'environnement du serveur, comme les
   * clés d'API des comptes de fournisseurs.
   */
  tokenEnv: string;
  enabled: boolean;
  /**
   * Délégations simultanées autorisées vers ce pair.
   *
   * Borne le fan-out, et borne aussi le rythme d'une boucle si deux instances
   * se déléguaient mutuellement du travail.
   */
  maxConcurrent: number;
  health: PeerHealth;
  /** Instant de réarmement quand le disjoncteur est ouvert. */
  openUntil: string | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  /** Version et nom d'instance rapportés par le pair, s'il a répondu. */
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FederatedPeerCreate = Omit<
  FederatedPeer,
  | 'id'
  | 'health'
  | 'openUntil'
  | 'lastError'
  | 'lastCheckedAt'
  | 'detail'
  | 'createdAt'
  | 'updatedAt'
>;

/**
 * Découpe une cible de délégation.
 *
 * `relecteur` reste local ; `relecteur@atelier` désigne l'agent « relecteur » de
 * la voisine « atelier ». La forme est choisie pour être devinable par un agent
 * sans documentation : c'est la même que pour une adresse.
 */
export function parseTarget(target: string): { agentName: string; peerName: string | null } {
  const at = target.lastIndexOf(PEER_SEPARATOR);
  if (at <= 0 || at === target.length - 1) return { agentName: target.trim(), peerName: null };
  return {
    agentName: target.slice(0, at).trim(),
    peerName: target.slice(at + 1).trim(),
  };
}

/** Profondeur de fédération maximale : un seul saut entre machines. */
export const MAX_FEDERATION_HOPS = 1;
