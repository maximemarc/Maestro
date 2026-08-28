/**
 * Résolution d'un jeton présenté en identité.
 *
 * Le pont entre `auth.ts` — qui ne connaît ni la base ni la configuration, et
 * doit le rester pour demeurer testable — et le reste du serveur.
 */
import { INSTANCE_IDENTITY, type Identity, hashToken, hashesEqual } from './access-tokens.ts';
import type { Store } from './db.ts';
import type { IdentityResolver } from './auth.ts';
import { nowIso } from './util.ts';

/**
 * Construit le résolveur de l'instance.
 *
 * Le jeton principal reste valable et prime : c'est lui qui permet de reprendre
 * la main si l'on a révoqué tous les autres, et il ne se révoque pas lui-même.
 * Les jetons nommés viennent ensuite, cherchés par empreinte.
 */
export function makeIdentityResolver(store: Store, instanceToken: string): IdentityResolver {
  const instanceHash = hashToken(instanceToken);

  return (presented: string): Identity | null => {
    if (presented === '') return null;

    /*
     * Comparaison d'empreintes plutôt que de jetons : deux empreintes ont
     * toujours la même longueur, ce qui évite qu'un refus immédiat pour cause
     * de longueur différente ne renseigne sur celle du secret attendu.
     */
    const hash = hashToken(presented);
    if (hashesEqual(hash, instanceHash)) return INSTANCE_IDENTITY;

    const token = store.findActiveAccessToken(hash);
    if (!token) return null;

    /*
     * Dernier usage, écrit à chaque requête authentifiée.
     *
     * C'est ce qui permet de repérer un jeton oublié — celui d'une personne
     * partie, ou d'un script qu'on ne fait plus tourner — et donc de le
     * révoquer en connaissance de cause.
     */
    store.touchAccessToken(token.id, nowIso());
    return { kind: 'token', label: token.label, tokenId: token.id };
  };
}
