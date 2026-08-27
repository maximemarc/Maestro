/**
 * Test de connexion d'un serveur MCP externe.
 *
 * Le SDK n'expose pas de client MCP autonome : on parle donc le protocole
 * directement, ce qui suffit largement pour la question posée — le serveur
 * répond-il, et quels outils annonce-t-il. Deux messages JSON-RPC 2.0 :
 * `initialize`, puis `tools/list`.
 *
 * Sans ce test, l'asymétrie était gênante : un outil maison s'essaie depuis
 * l'interface, un serveur externe ne se vérifiait qu'au milieu du run d'un
 * agent, où l'échec se noie dans un transcript.
 */
import { spawn } from 'node:child_process';
import type { McpServerDef, McpProbeResult } from '@maestro/shared';

/** Version du protocole annoncée. Un serveur trop récent la renégocie. */
const PROTOCOL_VERSION = '2024-11-05';
const PROBE_TIMEOUT_MS = 15_000;

const CLIENT_INFO = { name: 'maestro', version: '0.1.0' };

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function initializeRequest(id: number) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    },
  };
}

function toolsListRequest(id: number) {
  return { jsonrpc: '2.0' as const, id, method: 'tools/list', params: {} };
}

/** Extrait les noms d'outils d'une réponse `tools/list`. */
function toolNames(result: unknown): string[] {
  const tools = (result as { tools?: Array<{ name?: string }> } | undefined)?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => String(t.name ?? '?'));
}

/** Nom et version annoncés par le serveur, s'il les donne. */
function serverLabel(result: unknown): string | null {
  const info = (result as { serverInfo?: { name?: string; version?: string } } | undefined)
    ?.serverInfo;
  if (!info?.name) return null;
  return info.version ? `${info.name} ${info.version}` : info.name;
}

/**
 * Sonde un serveur stdio.
 *
 * Le transport est du JSON-RPC délimité par des sauts de ligne. On lit le flux
 * jusqu'à obtenir les deux réponses attendues, puis on tue le processus : le
 * but est de vérifier qu'il démarre et se présente, pas de le garder en vie.
 */
async function probeStdio(def: McpServerDef): Promise<McpProbeResult> {
  const started = Date.now();
  if (!def.command) return fail('Aucune commande à exécuter.', started);

  return new Promise<McpProbeResult>((resolve) => {
    let child;
    try {
      child = spawn(def.command!, def.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...def.env },
      });
    } catch (err) {
      resolve(fail(err instanceof Error ? err.message : String(err), started));
      return;
    }

    let buffer = '';
    let stderrTail = '';
    let initialized: unknown = null;
    let settled = false;

    const finish = (result: McpProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish(
        fail(
          `Aucune réponse en ${PROBE_TIMEOUT_MS / 1000} s.${stderrTail ? ` Sortie d'erreur : ${stderrTail.slice(-300)}` : ''}`,
          started,
        ),
      );
    }, PROBE_TIMEOUT_MS);

    child.on('error', (err: Error) => finish(fail(err.message, started)));
    child.on('exit', (code) => {
      finish(
        fail(
          `Le processus s'est arrêté (code ${code}).${stderrTail ? ` Sortie d'erreur : ${stderrTail.slice(-300)}` : ''}`,
          started,
        ),
      );
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        if (line === '') continue;

        let message: JsonRpcResponse;
        try {
          message = JSON.parse(line) as JsonRpcResponse;
        } catch {
          /* Un serveur bavard écrit parfois des traces sur stdout : on ignore
             ce qui n'est pas du JSON plutôt que d'échouer là-dessus. */
          continue;
        }
        if (message.error) {
          finish(fail(`Le serveur a répondu une erreur : ${message.error.message}`, started));
          return;
        }
        if (message.id === 1) {
          initialized = message.result;
          /* La notification `initialized` est attendue par le protocole avant
             tout autre appel. */
          child.stdin?.write(
            `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
          );
          child.stdin?.write(`${JSON.stringify(toolsListRequest(2))}\n`);
          continue;
        }
        if (message.id === 2) {
          finish({
            ok: true,
            serverInfo: serverLabel(initialized),
            tools: toolNames(message.result),
            message: 'Connexion établie.',
            durationMs: Date.now() - started,
          });
          return;
        }
      }
    });

    child.stdin?.on('error', () => {
      /* Le processus a fermé son entrée : l'événement exit dira pourquoi. */
    });
    child.stdin?.write(`${JSON.stringify(initializeRequest(1))}\n`);
  });
}

/**
 * Sonde un serveur HTTP.
 *
 * Transport « streamable HTTP » : les requêtes JSON-RPC sont postées sur l'URL,
 * la réponse arrive en JSON ou en flux d'événements selon le serveur. On accepte
 * les deux et on extrait la première charge utile JSON.
 */
async function probeHttp(def: McpServerDef): Promise<McpProbeResult> {
  const started = Date.now();
  if (!def.url) return fail('Aucune URL à interroger.', started);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const post = async (body: unknown, sessionId: string | null) => {
      const response = await fetch(def.url!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...def.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} : ${raw.slice(0, 300)}`);
      }
      return {
        session: response.headers.get('mcp-session-id'),
        payload: parseRpcPayload(raw),
      };
    };

    const init = await post(initializeRequest(1), null);
    if (init.payload?.error) {
      return fail(`Le serveur a répondu une erreur : ${init.payload.error.message}`, started);
    }
    const list = await post(toolsListRequest(2), init.session);
    if (list.payload?.error) {
      return fail(`Le serveur a répondu une erreur : ${list.payload.error.message}`, started);
    }
    return {
      ok: true,
      serverInfo: serverLabel(init.payload?.result),
      tools: toolNames(list.payload?.result),
      message: 'Connexion établie.',
      durationMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return fail(`Aucune réponse en ${PROBE_TIMEOUT_MS / 1000} s.`, started);
    }
    return fail(err instanceof Error ? err.message : String(err), started);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extrait la charge utile JSON-RPC d'une réponse.
 *
 * Un serveur peut répondre en JSON simple, ou en flux d'événements où chaque
 * message est préfixé de `data:`. On accepte les deux formes.
 */
function parseRpcPayload(raw: string): JsonRpcResponse | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcResponse[];
      return Array.isArray(parsed) ? (parsed[0] ?? null) : parsed;
    } catch {
      return null;
    }
  }
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      return JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
    } catch {
      continue;
    }
  }
  return null;
}

function fail(message: string, started: number): McpProbeResult {
  return { ok: false, serverInfo: null, tools: [], message, durationMs: Date.now() - started };
}

/** Sonde un serveur externe selon son transport. */
export async function probeMcpServer(def: McpServerDef): Promise<McpProbeResult> {
  if (def.kind !== 'external') {
    return fail(
      "Un serveur maison n'a pas de connexion à tester : essaie ses outils un par un.",
      Date.now(),
    );
  }
  if (def.transport === 'stdio') return probeStdio(def);
  if (def.transport === 'http') return probeHttp(def);
  /*
   * Le transport sse historique ouvre d'abord un flux persistant pour obtenir
   * l'adresse de publication : le sonder demanderait une machine à états
   * complète. Plutôt qu'un test approximatif dont l'échec ne voudrait rien
   * dire, on le déclare non testé.
   */
  return fail(
    "Le transport sse n'est pas sondé ici : il exige un flux persistant. Le serveur sera contacté normalement au lancement d'un run.",
    Date.now(),
  );
}
