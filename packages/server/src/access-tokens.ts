/**
 * Jetons d'accès nommés.
 *
 * Maestro n'avait qu'un jeton, partagé. Dès qu'on est deux, plus rien n'est
 * attribuable : une approbation était enregistrée « web », sans dire qui — or
 * c'est précisément ce qu'un human-in-the-loop doit garantir. Révoquer l'accès
 * d'une personne obligeait par ailleurs à changer le jeton de tout le monde.
 *
 * Ce n'est pas un système d'utilisateurs : pas de mot de passe, pas de rôles,
 * pas de session. Un jeton porte un nom, il se révoque seul, et son nom suit les
 * actes. C'est le minimum qui rend la traçabilité vraie, et c'est proportionné à
 * un outil qu'une petite équipe fait tourner sur une machine.
 *
 * 🔒 Les jetons ne sont jamais stockés en clair : seule leur empreinte SHA-256
 * est en base. Un vol de base ne donne donc aucun accès — c'est le même
 * raisonnement que pour un mot de passe, et la raison pour laquelle la valeur
 * n'est montrée qu'une fois, à la création.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Qui agit. L'identité suit la requête jusqu'aux actes qu'elle déclenche. */
export interface Identity {
  /**
   * `instance` : le jeton principal, celui du fichier de configuration. Il ne
   * se révoque pas et reste le moyen de reprendre la main si l'on révoque tout
   * le reste.
   */
  kind: 'instance' | 'token';
  label: string;
  tokenId: string | null;
}

export const INSTANCE_IDENTITY: Identity = {
  kind: 'instance',
  label: 'instance',
  tokenId: null,
};

/** Longueur du jeton engendré, en octets avant encodage. */
const TOKEN_BYTES = 24;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Empreinte d'un jeton.
 *
 * SHA-256 sans sel : contrairement à un mot de passe, un jeton engendré fait
 * 24 octets aléatoires — il n'y a rien à deviner par force brute ni par
 * dictionnaire, et un sel n'apporterait donc rien qu'une complexité de plus.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Comparaison d'empreintes à durée constante. */
export function hashesEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Aperçu d'un jeton, pour le reconnaître sans le divulguer.
 *
 * Six caractères suffisent à distinguer deux jetons dans une liste, et ne
 * permettent pas de reconstituer le reste.
 */
export function tokenPreview(token: string): string {
  return `${token.slice(0, 6)}…`;
}
