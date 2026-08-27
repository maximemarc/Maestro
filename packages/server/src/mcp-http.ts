/**
 * Transport Streamable HTTP de la passerelle MCP : `POST /mcp`.
 *
 * **Mode sans état, un serveur par requête.** Le protocole autorise deux modes ;
 * celui-ci évite d'avoir à stocker des sessions MCP côté serveur, à les expirer,
 * et à les retrouver après un redémarrage. Le prix — reconstruire deux
 * gestionnaires par appel — est négligeable, et le bénéfice réel : le périmètre
 * d'un client est recalculé à chaque appel, donc retirer une collection à un
 * agent prend effet immédiatement.
 *
 * **Authentification.** Aucune vérification ici : le hook `onRequest` d'`index.ts`
 * couvre `/mcp` avant d'arriver dans ce module, avec le même jeton `Bearer` que
 * l'API REST. Un seul endroit qui décide, un seul endroit à auditer.
 *
 * **Pourquoi `reply.hijack()`.** Le transport du SDK écrit directement dans la
 * `ServerResponse` de Node (statut, en-têtes, corps, et flux SSE le cas
 * échéant). Sans `hijack`, Fastify considérerait la requête non traitée et
 * enverrait sa propre réponse par-dessus.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  AGENT_HEADER,
  GatewayError,
  createGatewayServer,
  resolveScope,
  type GatewayDeps,
} from './mcp-gateway.ts';

/** Corps d'erreur JSON-RPC, seule forme qu'un client MCP sait interpréter. */
function rpcError(code: number, message: string) {
  return { jsonrpc: '2.0' as const, error: { code, message }, id: null };
}

function agentRef(req: FastifyRequest): string | null {
  const raw = req.headers[AGENT_HEADER];
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw[0] ?? null;
  return null;
}

export function registerMcpGateway(app: FastifyInstance, deps: GatewayDeps): void {
  app.post('/mcp', async (req: FastifyRequest, reply: FastifyReply) => {
    let scope;
    try {
      scope = resolveScope(deps, agentRef(req));
    } catch (err) {
      /* Un en-tête d'agent erroné est une faute de configuration du client, pas
         un incident serveur : le dire en 400 avec le nom fautif évite une
         chasse au 500 muet. */
      const message = err instanceof GatewayError ? err.message : 'Périmètre indéterminable';
      return reply.code(400).send(rpcError(-32602, message));
    }

    const server = createGatewayServer(deps, scope);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Réponse JSON directe : sans flux serveur→client, le SSE n'apporte rien
      // et complique les clients qui se contentent d'un POST.
      enableJsonResponse: true,
    });

    reply.hijack();
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.bus.log('error', 'mcp', `Passerelle MCP : requête en échec — ${message}`);
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify(rpcError(-32603, 'Erreur interne de la passerelle')));
      } else {
        reply.raw.end();
      }
    }
  });

  /*
   * GET (flux SSE serveur→client) et DELETE (fin de session) n'ont pas de sens
   * en mode sans état. Un 405 explicite vaut mieux que le 404 du repli SPA, qui
   * ferait croire à un mauvais chemin.
   */
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .code(405)
      .send(rpcError(-32000, 'Passerelle sans état : utilise POST /mcp pour chaque requête.'));
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
