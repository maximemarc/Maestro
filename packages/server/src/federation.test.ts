/**
 * Tests de la fédération.
 *
 * Deux choses doivent tenir, et aucune ne se voit à l'exécution normale :
 *
 * - la **borne de sauts**, sans laquelle deux instances qui se délèguent
 *   mutuellement du travail bouclent indéfiniment — chaque tour coûtant un run
 *   complet de chaque côté ;
 * - la lecture d'une cible `agent@pair`, qui doit continuer de fonctionner pour
 *   les noms d'agents contenant eux-mêmes une arobase.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseTarget, MAX_FEDERATION_HOPS } from '@maestro/shared';
import type { Bus } from './bus.ts';
import type { Store } from './db.ts';
import { FederationError, FederationService, readHops, HOPS_HEADER } from './federation.ts';

describe('lecture d’une cible', () => {
  it('laisse une cible sans arobase en local', () => {
    expect(parseTarget('Relecteur')).toEqual({ agentName: 'Relecteur', peerName: null });
  });

  it('découpe une cible fédérée', () => {
    expect(parseTarget('Relecteur@atelier')).toEqual({
      agentName: 'Relecteur',
      peerName: 'atelier',
    });
  });

  it('coupe sur la dernière arobase', () => {
    /* Un agent peut légitimement s'appeler « ops@infra » ; c'est le pair qui est
       en dernière position, jamais l'inverse. */
    expect(parseTarget('ops@infra@atelier')).toEqual({
      agentName: 'ops@infra',
      peerName: 'atelier',
    });
  });

  it('ne prend pas une arobase de bord pour un séparateur', () => {
    // « @atelier » ne nomme aucun agent, et « Relecteur@ » aucun pair.
    expect(parseTarget('@atelier').peerName).toBeNull();
    expect(parseTarget('Relecteur@').peerName).toBeNull();
  });
});

describe('en-tête de sauts', () => {
  it('lit un nombre de sauts transmis', () => {
    expect(readHops({ [HOPS_HEADER]: '1' })).toBe(1);
  });

  it('retombe à zéro sans en-tête, ou sur une valeur absurde', () => {
    expect(readHops({})).toBe(0);
    expect(readHops({ [HOPS_HEADER]: 'beaucoup' })).toBe(0);
    expect(readHops({ [HOPS_HEADER]: '-3' })).toBe(0);
  });

  it('borne une valeur délirante plutôt que de la propager', () => {
    /* Un pair mal configuré pourrait annoncer un million de sauts : le borner
       évite d'entretenir un nombre qui ne veut plus rien dire. */
    expect(readHops({ [HOPS_HEADER]: '1000000' })).toBe(10);
  });
});

describe('borne de sauts', () => {
  /* Le service est construit avec des doublures qui lèvent : la borne doit être
     vérifiée AVANT toute lecture de base ou tout appel réseau, et ce test le
     prouve — s'il touchait le store, il échouerait. */
  function service(): FederationService {
    const store = {
      getPeerByName: () => {
        throw new Error('le store ne doit pas être consulté');
      },
      listPeers: () => {
        throw new Error('le store ne doit pas être consulté');
      },
    } as unknown as Store;
    const bus = { log: vi.fn(), publish: vi.fn() } as unknown as Bus;
    return new FederationService(store, bus);
  }

  it('refuse une délégation qui a déjà franchi une frontière', async () => {
    await expect(
      service().delegate({
        peerName: 'atelier',
        agentName: 'Relecteur',
        prompt: 'x',
        wait: false,
        hops: MAX_FEDERATION_HOPS,
        fromAgent: 'Chef',
      }),
    ).rejects.toThrow(FederationError);
  });

  it('explique pourquoi, plutôt que de rendre une erreur muette', async () => {
    // Le message part vers un modèle : il doit lui permettre de renoncer, pas
    // de réessayer en boucle.
    try {
      await service().delegate({
        peerName: 'atelier',
        agentName: 'Relecteur',
        prompt: 'x',
        wait: false,
        hops: 1,
        fromAgent: 'Chef',
      });
      expect.unreachable('la délégation aurait dû être refusée');
    } catch (err) {
      expect((err as Error).message).toContain('saut(s) entre machines');
      expect((err as Error).message).toContain('boucle');
    }
  });
});

describe('nom de pair', () => {
  function service(): FederationService {
    const store = { insertPeer: vi.fn() } as unknown as Store;
    const bus = { log: vi.fn(), publish: vi.fn() } as unknown as Bus;
    return new FederationService(store, bus);
  }

  it('refuse une arobase ou un espace', () => {
    /* Le nom sert dans une cible « agent@pair » : une arobase le rendrait
       impossible à découper, un espace impossible à écrire pour un modèle. */
    const base = { baseUrl: 'https://x', tokenEnv: 'T', enabled: true, maxConcurrent: 2 };
    expect(() => service().create({ ...base, name: 'chez@moi' })).toThrow(FederationError);
    expect(() => service().create({ ...base, name: 'mon atelier' })).toThrow(FederationError);
  });

  it('accepte un nom simple', () => {
    expect(
      service().create({
        name: 'atelier',
        baseUrl: 'https://x',
        tokenEnv: 'MAESTRO_PEER_ATELIER',
        enabled: true,
        maxConcurrent: 2,
      }).name,
    ).toBe('atelier');
  });
});
