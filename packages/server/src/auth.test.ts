import { describe, expect, it } from 'vitest';
import type { Identity } from './access-tokens.ts';
import { authorize, deniedBody, type AuthRequest } from './auth.ts';

const TOKEN = 'jeton-de-test-suffisamment-long';

/**
 * Résolveur de test.
 *
 * `authorize` ne connaît plus le jeton attendu : elle délègue la
 * reconnaissance, ce qui lui permet d'ignorer d'où vient l'identité — un jeton
 * de configuration ou un jeton nommé en base.
 */
const resolve = (presented: string): Identity | null =>
  presented === TOKEN ? { kind: 'instance', label: 'instance', tokenId: null } : null;

function req(url: string, patch: Partial<AuthRequest> = {}): AuthRequest {
  return { url, headers: {}, query: {}, ...patch };
}

const bearer = { authorization: `Bearer ${TOKEN}` };

describe('périmètre protégé', () => {
  /*
   * Protéger les chemins statiques empêcherait le navigateur de charger la page
   * de connexion — celle où l'on saisit justement le jeton.
   */
  it('laisse passer l’interface statique', () => {
    expect(authorize(req('/'), resolve).kind).toBe('public');
    expect(authorize(req('/assets/index.js'), resolve).kind).toBe('public');
    expect(authorize(req('/runs/run_1'), resolve).kind).toBe('public');
  });

  /*
   * /api/health est ouvert délibérément : une sonde de conteneur doit pouvoir
   * constater que le service répond sans détenir un jeton qui, lui, permet de
   * lancer des agents.
   */
  it('laisse passer la sonde de santé', () => {
    expect(authorize(req('/api/health'), resolve).kind).toBe('public');
  });

  it('protège l’API, la passerelle MCP et le WebSocket', () => {
    expect(authorize(req('/api/agents'), resolve).kind).toBe('denied');
    expect(authorize(req('/mcp'), resolve).kind).toBe('denied');
    expect(authorize(req('/ws'), resolve).kind).toBe('denied');
  });
});

describe('jeton en en-tête', () => {
  it('accepte le bon jeton', () => {
    expect(authorize(req('/api/agents', { headers: bearer }), resolve).kind).toBe('allowed');
  });

  it('refuse un jeton faux, absent, ou mal préfixé', () => {
    expect(
      authorize(req('/api/agents', { headers: { authorization: 'Bearer faux' } }), resolve).kind,
    ).toBe('denied');
    expect(authorize(req('/api/agents'), resolve).kind).toBe('denied');
    expect(authorize(req('/api/agents', { headers: { authorization: TOKEN } }), resolve).kind).toBe(
      'denied',
    );
  });

  it('refuse un préfixe correct du jeton', () => {
    const court = `Bearer ${TOKEN.slice(0, 10)}`;
    expect(authorize(req('/api/agents', { headers: { authorization: court } }), resolve).kind).toBe(
      'denied',
    );
  });

  it('refuse un en-tête qui n’est pas une chaîne', () => {
    expect(authorize(req('/api/agents', { headers: { authorization: 42 } }), resolve).kind).toBe(
      'denied',
    );
  });
});

describe('jeton en paramètre de requête', () => {
  /*
   * 🔒 La règle qui compte : l'API des navigateurs interdit un en-tête sur une
   * connexion WebSocket, le paramètre y est donc incontournable. Ailleurs il
   * fuirait dans les journaux du serveur, ceux du reverse proxy et l'historique
   * du navigateur.
   */
  it('est accepté sur /ws', () => {
    expect(authorize(req('/ws', { query: { token: TOKEN } }), resolve).kind).toBe('allowed');
  });

  it('est refusé sur l’API', () => {
    expect(authorize(req('/api/agents', { query: { token: TOKEN } }), resolve).kind).toBe('denied');
  });

  it('est refusé sur la passerelle MCP', () => {
    expect(authorize(req('/mcp', { query: { token: TOKEN } }), resolve).kind).toBe('denied');
  });

  it('refuse un mauvais jeton même sur /ws', () => {
    expect(authorize(req('/ws', { query: { token: 'faux' } }), resolve).kind).toBe('denied');
  });

  it('tolère une requête sans paramètre', () => {
    expect(authorize(req('/ws', { query: undefined }), resolve).kind).toBe('denied');
  });
});

describe('forme du refus', () => {
  /*
   * Un client MCP ne sait lire qu'une enveloppe JSON-RPC : lui répondre dans sa
   * langue lui permet d'afficher la cause au lieu d'un « erreur inconnue ».
   */
  it('parle JSON-RPC à la passerelle MCP', () => {
    const outcome = authorize(req('/mcp'), resolve);
    expect(outcome).toEqual({ kind: 'denied', shape: 'jsonrpc' });
    expect(deniedBody('jsonrpc')).toMatchObject({ jsonrpc: '2.0', id: null });
  });

  it('parle REST à l’API et au WebSocket', () => {
    expect(authorize(req('/api/agents'), resolve)).toEqual({ kind: 'denied', shape: 'rest' });
    expect(authorize(req('/ws'), resolve)).toEqual({ kind: 'denied', shape: 'rest' });
    expect(deniedBody('rest')).toEqual({ error: 'Jeton invalide ou manquant' });
  });
});
