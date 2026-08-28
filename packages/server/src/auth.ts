/**
 * Décision d'authentification, isolée pour être vérifiable.
 *
 * Cette logique vivait au milieu de l'assemblage du serveur, où rien ne pouvait
 * la tester : c'est pourtant le seul rempart entre l'extérieur et le lancement
 * d'agents. Les règles qu'elle porte ne sont pas déductibles à la lecture d'un
 * `if` — d'où ce module, et ses tests.
 */

/** Ce dont la décision a besoin d'une requête, et rien de plus. */
import type { Identity } from './access-tokens.ts';

export interface AuthRequest {
  url: string;
  headers: Record<string, unknown>;
  query: unknown;
}

export type AuthOutcome =
  /** Chemin public ou hors périmètre protégé : laisser passer sans contrôle. */
  | { kind: 'public' }
  /** Autorisé, avec l'identité qui suivra la requête jusqu'à ses effets. */
  | { kind: 'allowed'; identity: Identity }
  /** Refus, avec la forme d'erreur attendue par le client. */
  | { kind: 'denied'; shape: 'rest' | 'jsonrpc' };

/**
 * Résout un jeton présenté en identité.
 *
 * Injecté plutôt que codé ici : ce module ne doit connaître ni la base ni le
 * fichier de configuration, sous peine de redevenir intestable — ce qu'il était.
 */
export type IdentityResolver = (presented: string) => Identity | null;

/**
 * Tranche une requête.
 *
 * Trois règles portent la sécurité de l'instance :
 *
 *  1. Seuls `/api/*`, `/mcp` et `/ws` sont protégés. Le reste, c'est l'interface
 *     statique — la protéger empêcherait le navigateur de charger la page de
 *     connexion, où l'on saisit justement le jeton.
 *  2. `/api/health` reste ouvert, et délibérément : un orchestrateur ou une
 *     sonde de conteneur doit pouvoir constater que le service répond sans
 *     détenir un jeton qui, lui, permet de lancer des agents.
 *  3. 🔒 Le jeton en paramètre de requête n'est accepté que sur `/ws`. L'API des
 *     navigateurs interdit un en-tête sur une connexion WebSocket, il y est donc
 *     incontournable ; partout ailleurs il fuirait dans les journaux du serveur,
 *     ceux du reverse proxy et l'historique du navigateur.
 */
export function authorize(req: AuthRequest, resolve: IdentityResolver): AuthOutcome {
  const url = req.url;
  const isWebSocket = url.startsWith('/ws');
  const isGateway = url.startsWith('/mcp');
  const isApi = url.startsWith('/api/');

  if (!isWebSocket && !isGateway && !isApi) return { kind: 'public' };
  if (url.startsWith('/api/health')) return { kind: 'public' };

  const header = req.headers['authorization'];
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const identity = resolve(header.slice('Bearer '.length));
    if (identity) return { kind: 'allowed', identity };
  }

  if (isWebSocket) {
    const token = (req.query as { token?: string } | undefined)?.token;
    if (typeof token === 'string') {
      const identity = resolve(token);
      if (identity) return { kind: 'allowed', identity };
    }
  }

  // Un client MCP ne sait lire qu'une enveloppe JSON-RPC : lui répondre dans sa
  // langue lui permet d'afficher la cause au lieu d'un « erreur inconnue ».
  return { kind: 'denied', shape: isGateway ? 'jsonrpc' : 'rest' };
}

/** Corps de refus, selon la forme attendue. */
export function deniedBody(shape: 'rest' | 'jsonrpc'): unknown {
  return shape === 'jsonrpc'
    ? {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Jeton invalide ou manquant' },
        id: null,
      }
    : { error: 'Jeton invalide ou manquant' };
}
