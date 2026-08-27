/**
 * Test d'intégration du transport HTTP de la passerelle.
 *
 * Les tests de `mcp-gateway.test.ts` valident la logique ; celui-ci valide le
 * branchement, seul endroit où une erreur ne se voit pas à la lecture : Fastify
 * parse le corps mais c'est le transport du SDK qui écrit la réponse, ce qui
 * exige `reply.hijack()`. Un vrai client MCP fait ici un vrai handshake sur un
 * vrai port — la seule manière de s'en assurer.
 */
import { webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentConfig, McpServerDef, RagCollection } from '@maestro/shared';
import type { AgentService } from './agents.ts';
import type { Bus } from './bus.ts';
import type { GatewayDeps } from './mcp-gateway.ts';
import { registerMcpGateway } from './mcp-http.ts';
import type { RagService } from './rag.ts';

/* Le contexte d'exécution de Vitest sous Node 18 n'expose pas `crypto` global,
   dont le transport du SDK se sert pour ses identifiants de requête. Le serveur
   réel n'a pas ce manque (Node l'expose depuis la 19, et 18.19 en local) : le
   comblement appartient donc au test, pas au code. */
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
}

const COLLECTION: RagCollection = {
  id: 'col-1',
  slug: 'compta',
  name: 'Comptabilité',
  description: 'Plan comptable',
  documentCount: 1,
  chunkCount: 4,
  chunkSize: 1200,
  chunkOverlap: 150,
  embeddedChunkCount: 4,
  staleChunkCount: 0,
  createdAt: '2026-08-27T00:00:00.000Z',
  updatedAt: '2026-08-27T00:00:00.000Z',
};

const AGENT = {
  id: 'agent-1',
  name: 'Comptabilité',
  ragCollectionIds: ['col-1'],
  mcpServerIds: [],
  // Doublure réduite aux champs lus par la passerelle.
} as unknown as AgentConfig;

const deps: GatewayDeps = {
  rag: {
    list: () => [COLLECTION],
    collectionsForAgent: (ids: string[]) => (ids.includes('col-1') ? [COLLECTION] : []),
    search: async () => ({
      hits: [
        { content: 'Les immobilisations s’amortissent…', documentTitle: 'PCG', chunkIndex: 0 },
      ],
      semanticUsed: false,
      durationMs: 2,
    }),
  } as unknown as RagService,
  agents: {
    get: (id: string) => (id === 'agent-1' ? AGENT : null),
    list: () => [AGENT],
  } as unknown as AgentService,
  bus: { log: () => {} } as unknown as Bus,
  listServers: (): McpServerDef[] => [],
  version: '0.1.0',
};

let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerMcpGateway(app, deps);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
});

afterAll(async () => {
  await app.close();
});

async function connect(headers: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(baseUrl), { requestInit: { headers } }),
  );
  return client;
}

describe('POST /mcp', () => {
  it('répond au handshake et liste les outils', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['rag_collections', 'rag_search']);
    await client.close();
  });

  it('exécute une recherche et rend le passage avec sa source', async () => {
    const client = await connect();
    const result = await client.callTool({
      name: 'rag_search',
      arguments: { collection: 'compta', query: 'amortissement' },
    });
    const content = result.content as { type: string; text: string }[];
    expect(content[0]?.text).toContain('PCG');
    expect(content[0]?.text).toContain('immobilisations');
    await client.close();
  });

  it('applique le périmètre de l’en-tête X-Maestro-Agent', async () => {
    const client = await connect({ 'X-Maestro-Agent': 'Comptabilité' });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('rag_search');
    await client.close();
  });

  it('rejette un agent inconnu en 400, sans ouvrir le périmètre complet', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'X-Maestro-Agent': 'fantôme',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('fantôme');
  });

  it('répond 405 sur GET, le mode sans état n’ayant pas de flux serveur', async () => {
    const response = await fetch(baseUrl, { headers: { accept: 'text/event-stream' } });
    expect(response.status).toBe(405);
  });
});
