import { describe, expect, it } from 'vitest';
import { Store } from './db.ts';
import { generateToken, hashToken, hashesEqual, tokenPreview } from './access-tokens.ts';
import { makeIdentityResolver } from './identity.ts';

const INSTANCE = 'jeton-principal-de-configuration';

function seed(store: Store, label: string) {
  const value = generateToken();
  store.insertAccessToken(
    {
      id: `tok_${label}`,
      label,
      preview: tokenPreview(value),
      createdAt: '2026-08-28T09:00:00.000Z',
      lastUsedAt: null,
      revokedAt: null,
    },
    hashToken(value),
  );
  return value;
}

describe('empreintes', () => {
  /*
   * 🔒 L'invariant : la valeur ne doit jamais être déductible de ce qui est
   * stocké. Un vol de base ne donne donc aucun accès.
   */
  it('l’empreinte ne contient pas le jeton', () => {
    const value = generateToken();
    expect(hashToken(value)).not.toContain(value);
    expect(hashToken(value)).toHaveLength(64);
  });

  it('la même valeur donne la même empreinte', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });

  it('deux jetons engendrés diffèrent', () => {
    expect(generateToken()).not.toBe(generateToken());
  });

  it('l’aperçu ne divulgue que le début', () => {
    const value = 'abcdefghijklmnop';
    expect(tokenPreview(value)).toBe('abcdef…');
    expect(tokenPreview(value).length).toBeLessThan(value.length);
  });

  it('compare des empreintes sans se tromper', () => {
    expect(hashesEqual(hashToken('a'), hashToken('a'))).toBe(true);
    expect(hashesEqual(hashToken('a'), hashToken('b'))).toBe(false);
    expect(hashesEqual('court', 'plus-long')).toBe(false);
  });
});

describe('résolution', () => {
  it('reconnaît le jeton principal', () => {
    const store = new Store(':memory:');
    const resolve = makeIdentityResolver(store, INSTANCE);
    expect(resolve(INSTANCE)).toEqual({ kind: 'instance', label: 'instance', tokenId: null });
    store.close();
  });

  it('reconnaît un jeton nommé et rend son nom', () => {
    const store = new Store(':memory:');
    const value = seed(store, 'Marc');
    const identity = makeIdentityResolver(store, INSTANCE)(value);
    expect(identity).toEqual({ kind: 'token', label: 'Marc', tokenId: 'tok_Marc' });
    store.close();
  });

  it('refuse un jeton inconnu et une valeur vide', () => {
    const store = new Store(':memory:');
    const resolve = makeIdentityResolver(store, INSTANCE);
    expect(resolve('inconnu')).toBeNull();
    expect(resolve('')).toBeNull();
    store.close();
  });

  /*
   * La révocation doit prendre effet tout de suite : un jeton révoqué qui
   * fonctionne encore jusqu'au redémarrage n'est pas révoqué.
   */
  it('refuse un jeton révoqué, immédiatement', () => {
    const store = new Store(':memory:');
    const value = seed(store, 'Parti');
    const resolve = makeIdentityResolver(store, INSTANCE);
    expect(resolve(value)).not.toBeNull();

    store.revokeAccessToken('tok_Parti', '2026-08-28T10:00:00.000Z');
    expect(resolve(value)).toBeNull();
    store.close();
  });

  /*
   * Le jeton principal ne se révoque pas : c'est lui qui permet de reprendre la
   * main après avoir révoqué tous les autres.
   */
  it('laisse le jeton principal hors de portée de la révocation', () => {
    const store = new Store(':memory:');
    const resolve = makeIdentityResolver(store, INSTANCE);
    for (const token of store.listAccessTokens()) {
      store.revokeAccessToken(token.id, '2026-08-28T10:00:00.000Z');
    }
    expect(resolve(INSTANCE)?.kind).toBe('instance');
    store.close();
  });

  /* Le dernier usage permet de repérer un jeton oublié — celui d'une personne
     partie, ou d'un script qu'on ne fait plus tourner. */
  it('note la dernière utilisation', () => {
    const store = new Store(':memory:');
    const value = seed(store, 'Script');
    expect(store.listAccessTokens()[0]?.lastUsedAt).toBeNull();

    makeIdentityResolver(store, INSTANCE)(value);
    expect(store.listAccessTokens()[0]?.lastUsedAt).not.toBeNull();
    store.close();
  });
});

describe('stockage', () => {
  it('ne conserve jamais la valeur du jeton', () => {
    const store = new Store(':memory:');
    const value = seed(store, 'Secret');
    const stored = store.listAccessTokens()[0];
    expect(JSON.stringify(stored)).not.toContain(value);
    expect(stored?.preview.length).toBeLessThan(value.length);
    store.close();
  });

  /* Révoquer conserve la ligne : c'est elle qui dit, six mois plus tard, quel
     jeton avait approuvé quoi. */
  it('garde la trace d’un jeton révoqué', () => {
    const store = new Store(':memory:');
    seed(store, 'Ancien');
    store.revokeAccessToken('tok_Ancien', '2026-08-28T10:00:00.000Z');
    const tokens = store.listAccessTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.revokedAt).not.toBeNull();
    store.close();
  });

  it('ne révoque pas deux fois', () => {
    const store = new Store(':memory:');
    seed(store, 'X');
    expect(store.revokeAccessToken('tok_X', '2026-08-28T10:00:00.000Z')).toBe(true);
    expect(store.revokeAccessToken('tok_X', '2026-08-28T11:00:00.000Z')).toBe(false);
    store.close();
  });
});

describe('traçabilité des approbations', () => {
  /*
   * Le point qui justifie tout le reste : une approbation doit dire par qui
   * elle a été tranchée, pas seulement par quel canal.
   */
  it('enregistre le nom du jeton qui a tranché', () => {
    const store = new Store(':memory:');
    const now = '2026-08-28T09:00:00.000Z';
    store.insertApproval({
      id: 'apr_1',
      runId: 'run_1',
      agentId: 'agt_1',
      toolName: 'Bash',
      input: {},
      status: 'pending',
      resolvedBy: null,
      resolvedByLabel: null,
      note: null,
      requestedAt: now,
      resolvedAt: null,
    });

    const resolved = store.resolveApproval('apr_1', 'allowed', 'web', null, 'Marc');
    expect(resolved?.resolvedBy).toBe('web');
    expect(resolved?.resolvedByLabel).toBe('Marc');
    store.close();
  });

  /* Une résolution automatique n'a pas d'auteur : prétendre le contraire serait
     pire que l'absence d'information. */
  it('laisse le nom vide pour une résolution automatique', () => {
    const store = new Store(':memory:');
    const now = '2026-08-28T09:00:00.000Z';
    store.insertApproval({
      id: 'apr_2',
      runId: 'run_1',
      agentId: 'agt_1',
      toolName: 'Bash',
      input: {},
      status: 'pending',
      resolvedBy: null,
      resolvedByLabel: null,
      note: null,
      requestedAt: now,
      resolvedAt: null,
    });
    const resolved = store.resolveApproval('apr_2', 'denied', 'timeout', 'Expirée');
    expect(resolved?.resolvedByLabel).toBeNull();
    store.close();
  });
});
