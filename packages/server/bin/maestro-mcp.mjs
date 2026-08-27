#!/usr/bin/env node
/**
 * `maestro-mcp` — pont stdio vers la passerelle MCP de Maestro.
 *
 * Les clients MCP locaux (Codex CLI, OpenCode, Goose, Cursor, Zed…) savent tous
 * lancer un processus et lui parler en stdio ; tous ne savent pas encore parler
 * Streamable HTTP avec un en-tête d'authentification. Ce pont comble l'écart :
 * il expose en stdio ce que `POST /mcp` expose en HTTP.
 *
 * C'est un relais, pas une copie : il interroge le serveur pour connaître les
 * outils, et transmet les appels tels quels. Aucune logique métier ici — donc
 * rien à re-synchroniser quand la passerelle évolue.
 *
 * Écrit en JavaScript, sans types, pour une raison précise : le client tiers
 * lance `node .../maestro-mcp.mjs` directement, sans tsx ni build. Un binaire
 * qui exige une chaîne de compilation n'est pas un binaire.
 *
 * Configuration, par variables d'environnement :
 *
 *   MAESTRO_URL    base du serveur          (défaut http://127.0.0.1:4520)
 *   MAESTRO_TOKEN  jeton d'accès            (défaut : <dataDir>/token)
 *   MAESTRO_AGENT  agent au nom duquel agir (optionnel ; restreint le périmètre)
 *   MAESTRO_DATA_DIR  répertoire de données (défaut ~/.maestro)
 *
 * Toute sortie de diagnostic va sur stderr : stdout appartient au protocole.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const VERSION = '0.1.0';

function fail(message) {
  process.stderr.write(`maestro-mcp : ${message}\n`);
  process.exit(1);
}

/**
 * Jeton d'accès.
 *
 * Le fichier `<dataDir>/token` est lu en repli parce que le serveur l'y écrit
 * déjà : sans ce repli, le même secret devrait être recopié dans la
 * configuration de chaque client, et chaque copie est un endroit où il fuite.
 */
function resolveToken() {
  const fromEnv = process.env.MAESTRO_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const dataDir = process.env.MAESTRO_DATA_DIR ?? join(homedir(), '.maestro');
  const tokenFile = join(dataDir, 'token');
  if (existsSync(tokenFile)) {
    const stored = readFileSync(tokenFile, 'utf8').trim();
    if (stored) return stored;
  }
  return null;
}

const baseUrl = (process.env.MAESTRO_URL ?? 'http://127.0.0.1:4520').replace(/\/+$/, '');
const token = resolveToken();
const agent = process.env.MAESTRO_AGENT?.trim();

if (!token) {
  fail(
    "aucun jeton. Renseigne MAESTRO_TOKEN, ou lance Maestro une fois pour qu'il écrive <dataDir>/token.",
  );
}

const headers = { Authorization: `Bearer ${token}` };
if (agent) headers['X-Maestro-Agent'] = agent;

const upstream = new Client({ name: 'maestro-mcp-bridge', version: VERSION });
const upstreamTransport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
  requestInit: { headers },
});

try {
  await upstream.connect(upstreamTransport);
} catch (err) {
  /* Message orienté cause probable : dans 90 % des cas le serveur est éteint ou
     le port diffère, et l'erreur brute du fetch ne le dit pas clairement. */
  fail(
    `connexion à ${baseUrl}/mcp impossible (${err instanceof Error ? err.message : String(err)}). ` +
      'Vérifie que Maestro tourne, que MAESTRO_URL pointe le bon port et que le jeton est valide.',
  );
}

const local = new Server({ name: 'maestro', version: VERSION }, { capabilities: { tools: {} } });

local.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await upstream.listTools();
  return { tools };
});

local.setRequestHandler(CallToolRequestSchema, async (request) => {
  /* Le résultat amont est déjà au format du protocole (contenu + isError) :
     le renvoyer tel quel préserve les erreurs d'outil, qu'une reconstruction
     transformerait en échec de transport. */
  return upstream.callTool({
    name: request.params.name,
    arguments: request.params.arguments ?? {},
  });
});

await local.connect(new StdioServerTransport());

const shutdown = async () => {
  await local.close().catch(() => {});
  await upstream.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
