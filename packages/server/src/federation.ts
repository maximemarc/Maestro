/**
 * Fédération : délégation vers une autre instance de Maestro.
 *
 * Une instance délègue en étant **cliente** de sa voisine, par l'API REST qui
 * existe déjà. Rien de nouveau côté transport ; ce module apporte ce qui manque
 * pour que ce soit sûr : un disjoncteur, un plafond de délégations simultanées,
 * et une borne au nombre de sauts entre machines.
 *
 * ## Le disjoncteur, et pourquoi il compte plus qu'il n'y paraît
 *
 * Une machine éteinte ne répond pas : chaque délégation attendrait son délai
 * complet. Or l'agent qui délègue **attend** — et il occupe un slot de
 * concurrence pendant ce temps. Trois délégations vers une voisine hors service
 * suffiraient à figer l'orchestrateur local. Le disjoncteur transforme cette
 * attente en refus immédiat, avec son motif.
 *
 * ## La borne de sauts repose sur la coopération du pair, et c'est cohérent
 *
 * Le nombre de sauts voyage dans un en-tête que la machine visée choisit de
 * respecter. Un pair malveillant pourrait le remettre à zéro et boucler. Mais un
 * jeton de pair ouvre déjà l'API complète de la machine : la confiance est
 * totale par construction. Se protéger d'un pair hostile n'aurait aucun sens
 * tant qu'on lui confie ce jeton — ce qui se protège ici, c'est l'accident.
 */
import {
  MAX_FEDERATION_HOPS,
  type FederatedPeer,
  type FederatedPeerCreate,
  type PeerHealth,
} from '@maestro/shared';
import type { Bus } from './bus.ts';
import type { Store } from './db.ts';
import { makeId, nowIso } from './util.ts';

/** En-tête qui porte le nombre de sauts déjà effectués. */
export const HOPS_HEADER = 'x-maestro-federation-hops';

/** Échecs consécutifs avant ouverture du disjoncteur. */
const FAILURES_BEFORE_OPEN = 3;
/** Durée d'ouverture du disjoncteur. */
const OPEN_DURATION_MS = 2 * 60 * 1000;
/** Délai d'un appel de création de run chez un pair. */
const CALL_TIMEOUT_MS = 20_000;
/** Intervalle de scrutation d'un run distant, pour une délégation bloquante. */
const POLL_INTERVAL_MS = 5_000;

export class FederationError extends Error {}

export class FederationService {
  /** Échecs consécutifs par pair, pour armer le disjoncteur. */
  private failures = new Map<string, number>();
  /** Délégations en vol par pair, pour tenir le plafond. */
  private inFlight = new Map<string, number>();

  constructor(
    private store: Store,
    private bus: Bus,
  ) {}

  list(): FederatedPeer[] {
    return this.store.listPeers();
  }

  byName(name: string): FederatedPeer | null {
    return this.store.getPeerByName(name);
  }

  create(input: FederatedPeerCreate): FederatedPeer {
    if (input.name.includes('@') || /\s/.test(input.name)) {
      throw new FederationError(
        `Nom de pair invalide : « ${input.name} ». Ni arobase ni espace, puisqu'il sert dans une cible « agent@pair ».`,
      );
    }
    const now = nowIso();
    const peer: FederatedPeer = {
      ...input,
      id: makeId('peer'),
      health: 'unknown',
      openUntil: null,
      lastError: null,
      lastCheckedAt: null,
      detail: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertPeer(peer);
    this.bus.publish({ type: 'peer.updated', payload: peer });
    this.bus.log('info', 'federation', `Pair « ${peer.name} » déclaré (${peer.baseUrl})`);
    return peer;
  }

  update(id: string, patch: Partial<FederatedPeerCreate>): FederatedPeer | null {
    const current = this.store.getPeer(id);
    if (!current) return null;
    const updated: FederatedPeer = { ...current, ...patch, id, updatedAt: nowIso() };
    /* Réactiver ou reconfigurer un pair réarme le disjoncteur : l'opérateur qui
       touche à la configuration affirme que la voisine est joignable, et lui
       faire purger un délai hérité d'un incident passé n'aurait pas de sens. */
    this.failures.delete(id);
    updated.openUntil = null;
    if (updated.health === 'open') updated.health = 'unknown';
    this.store.updatePeer(updated);
    this.bus.publish({ type: 'peer.updated', payload: updated });
    return updated;
  }

  remove(id: string): boolean {
    const peer = this.store.getPeer(id);
    if (!peer) return false;
    this.store.deletePeer(id);
    this.failures.delete(id);
    this.inFlight.delete(id);
    this.bus.publish({ type: 'peer.deleted', payload: { id } });
    return true;
  }

  /**
   * Jeton d'un pair, lu dans l'environnement du serveur.
   *
   * 🔒 Jamais en base : la table ne contient que le **nom** de la variable.
   */
  private token(peer: FederatedPeer): string | null {
    return process.env[peer.tokenEnv]?.trim() || null;
  }

  /**
   * Vérifie qu'un pair est joignable et que le jeton est accepté.
   *
   * `/api/overview` plutôt que `/api/health` : la santé répond sans
   * authentification, donc elle ne dirait rien du jeton — et un jeton refusé est
   * précisément la panne la plus fréquente à la mise en place.
   */
  async test(id: string): Promise<FederatedPeer | null> {
    const peer = this.store.getPeer(id);
    if (!peer) return null;

    let health: PeerHealth = 'ready';
    let lastError: string | null = null;
    let detail: string | null = null;

    const token = this.token(peer);
    if (!token) {
      health = 'unauthorized';
      lastError = `La variable ${peer.tokenEnv} n’est pas définie dans l’environnement du serveur.`;
    } else {
      try {
        const res = await fetch(`${peer.baseUrl.replace(/\/+$/, '')}/api/overview`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        if (res.status === 401) {
          health = 'unauthorized';
          lastError = 'Jeton refusé par le pair.';
        } else if (!res.ok) {
          health = 'unreachable';
          lastError = `Réponse HTTP ${res.status}.`;
        } else {
          const body = (await res.json()) as { server?: { version?: string } };
          detail = body.server?.version ? `Maestro v${body.server.version}` : 'joignable';
        }
      } catch (err) {
        health = 'unreachable';
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    const updated: FederatedPeer = {
      ...peer,
      health,
      openUntil: health === 'ready' ? null : peer.openUntil,
      lastError,
      detail,
      lastCheckedAt: nowIso(),
      updatedAt: nowIso(),
    };
    if (health === 'ready') this.failures.delete(id);
    this.store.updatePeer(updated);
    this.bus.publish({ type: 'peer.updated', payload: updated });
    return updated;
  }

  /** Le disjoncteur est-il ouvert ? Le referme si son délai est écoulé. */
  private circuitOpen(peer: FederatedPeer, nowMs: number): boolean {
    if (!peer.openUntil) return false;
    const until = Date.parse(peer.openUntil);
    if (Number.isFinite(until) && until > nowMs) return true;
    /* Délai écoulé : on referme et on laisse passer une tentative. C'est le seul
       endroit où le disjoncteur se réarme, ce qui évite une minuterie par pair. */
    this.store.updatePeer({ ...peer, openUntil: null, health: 'unknown', updatedAt: nowIso() });
    this.failures.delete(peer.id);
    return false;
  }

  private recordFailure(peer: FederatedPeer, message: string): void {
    const count = (this.failures.get(peer.id) ?? 0) + 1;
    this.failures.set(peer.id, count);
    const opening = count >= FAILURES_BEFORE_OPEN;
    const updated: FederatedPeer = {
      ...peer,
      health: opening ? 'open' : 'unreachable',
      openUntil: opening ? new Date(Date.now() + OPEN_DURATION_MS).toISOString() : peer.openUntil,
      lastError: message,
      lastCheckedAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.updatePeer(updated);
    this.bus.publish({ type: 'peer.updated', payload: updated });
    if (opening) {
      this.bus.log(
        'warn',
        'federation',
        `Pair « ${peer.name} » écarté ${OPEN_DURATION_MS / 60000} min après ${count} échecs — ${message}`,
      );
    }
  }

  private recordSuccess(peer: FederatedPeer): void {
    if (this.failures.get(peer.id) === undefined && peer.health === 'ready') return;
    this.failures.delete(peer.id);
    const updated: FederatedPeer = {
      ...peer,
      health: 'ready',
      openUntil: null,
      lastError: null,
      lastCheckedAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.store.updatePeer(updated);
    this.bus.publish({ type: 'peer.updated', payload: updated });
  }

  /**
   * Délègue à un agent d'une autre instance.
   *
   * Rend le texte destiné à l'agent appelant : identifiant du run distant si la
   * délégation est asynchrone, réponse complète si elle est bloquante.
   */
  async delegate(input: {
    peerName: string;
    agentName: string;
    prompt: string;
    wait: boolean;
    /** Sauts déjà effectués par cette chaîne de délégation. */
    hops: number;
    /** Nom de l'agent local, repris dans le prompt pour la traçabilité. */
    fromAgent: string;
  }): Promise<string> {
    if (input.hops >= MAX_FEDERATION_HOPS) {
      throw new FederationError(
        `Délégation refusée : ${input.hops} saut(s) entre machines déjà effectué(s), ` +
          `la limite est de ${MAX_FEDERATION_HOPS}. Une chaîne plus longue tournerait en boucle sans que personne ne le voie.`,
      );
    }

    const peer = this.byName(input.peerName);
    if (!peer) {
      const names = this.list()
        .map((p) => p.name)
        .join(', ');
      throw new FederationError(
        `Pair « ${input.peerName} » inconnu. Pairs déclarés : ${names || '(aucun)'}`,
      );
    }
    if (!peer.enabled) throw new FederationError(`Pair « ${peer.name} » désactivé.`);
    if (this.circuitOpen(peer, Date.now())) {
      throw new FederationError(
        `Pair « ${peer.name} » momentanément écarté : ${peer.lastError ?? 'échecs répétés'}. Réessaie plus tard.`,
      );
    }

    const running = this.inFlight.get(peer.id) ?? 0;
    if (running >= peer.maxConcurrent) {
      throw new FederationError(
        `Pair « ${peer.name} » : ${running} délégation(s) déjà en vol, plafond ${peer.maxConcurrent}.`,
      );
    }

    const token = this.token(peer);
    if (!token) {
      throw new FederationError(
        `Pair « ${peer.name} » : la variable ${peer.tokenEnv} n’est pas définie côté serveur.`,
      );
    }

    const base = peer.baseUrl.replace(/\/+$/, '');
    this.inFlight.set(peer.id, running + 1);
    try {
      /* L'agent distant est désigné par son nom, pas par un identifiant : les
         identifiants sont propres à chaque instance, et un agent qui délègue ne
         connaît que des noms. */
      const remoteAgent = await this.resolveAgent(base, token, input.agentName, peer);

      const created = await this.call(base, token, peer, {
        path: '/api/runs',
        method: 'POST',
        hops: input.hops + 1,
        body: {
          agentId: remoteAgent,
          prompt: `Tâche déléguée depuis une autre instance Maestro, par l'agent « ${input.fromAgent} » :\n\n${input.prompt}`,
        },
      });
      const runId = (created as { id?: string }).id;
      if (!runId) throw new FederationError('Le pair n’a pas rendu d’identifiant de run.');

      this.recordSuccess(peer);
      this.bus.log(
        'info',
        'federation',
        `${input.fromAgent} → ${input.agentName}@${peer.name} (${runId})`,
      );

      if (!input.wait) {
        return `Délégation fédérée lancée : run ${runId} confié à « ${input.agentName} » sur « ${peer.name} ». Le résultat reste sur cette machine-là.`;
      }
      return await this.awaitRemote(base, token, peer, runId, input.agentName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof FederationError)) this.recordFailure(peer, message);
      throw err instanceof FederationError ? err : new FederationError(message);
    } finally {
      const current = this.inFlight.get(peer.id) ?? 1;
      this.inFlight.set(peer.id, Math.max(0, current - 1));
    }
  }

  /** Traduit un nom d'agent distant en identifiant, chez le pair. */
  private async resolveAgent(
    base: string,
    token: string,
    agentName: string,
    peer: FederatedPeer,
  ): Promise<string> {
    const agents = (await this.call(base, token, peer, {
      path: '/api/agents',
      method: 'GET',
      hops: 0,
    })) as { id: string; name: string }[];
    const normalise = (value: string) =>
      value
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
    const found = agents.find((a) => normalise(a.name) === normalise(agentName));
    if (!found) {
      throw new FederationError(
        `Agent « ${agentName} » absent de « ${peer.name} ». Agents disponibles là-bas : ${agents.map((a) => a.name).join(', ') || '(aucun)'}`,
      );
    }
    return found.id;
  }

  private async call(
    base: string,
    token: string,
    peer: FederatedPeer,
    options: { path: string; method: string; hops: number; body?: unknown },
  ): Promise<unknown> {
    const res = await fetch(`${base}${options.path}`, {
      method: options.method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        [HOPS_HEADER]: String(options.hops),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (res.status === 401) {
      throw new FederationError(`Pair « ${peer.name} » : jeton refusé.`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} sur ${options.path} — ${body.slice(0, 200)}`);
    }
    return (await res.json()) as unknown;
  }

  /**
   * Scrute un run distant jusqu'à son terme.
   *
   * Scrutation et non abonnement : ouvrir un WebSocket vers la voisine
   * demanderait de maintenir une connexion et de la reconnecter, pour une
   * attente qui dure au plus quelques minutes. Le coût d'une requête toutes les
   * cinq secondes est négligeable devant celui du run lui-même.
   */
  private async awaitRemote(
    base: string,
    token: string,
    peer: FederatedPeer,
    runId: string,
    agentName: string,
  ): Promise<string> {
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const payload = (await this.call(base, token, peer, {
        path: `/api/runs/${runId}`,
        method: 'GET',
        hops: 0,
      })) as {
        run?: {
          status?: string;
          endedAt?: string | null;
          resultText?: string | null;
          error?: string | null;
        };
      };
      const run = payload.run;
      if (!run?.endedAt) continue;
      if (run.status !== 'succeeded') {
        throw new FederationError(
          `Le run distant ${runId} s’est terminé en « ${run.status} »${run.error ? ` : ${run.error}` : ''}.`,
        );
      }
      return `Réponse de « ${agentName} » sur « ${peer.name} » :\n\n${run.resultText ?? '(aucun texte de résultat)'}`;
    }
    throw new FederationError(
      `Le run distant ${runId} n’a pas terminé dans le délai imparti. Il continue sur « ${peer.name} ».`,
    );
  }
}

/** Lit le nombre de sauts d'une requête entrante. */
export function readHops(headers: Record<string, unknown>): number {
  const raw = headers[HOPS_HEADER];
  const value = Number(typeof raw === 'string' ? raw : 0);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 10) : 0;
}
