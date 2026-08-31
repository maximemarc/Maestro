/**
 * Adaptateur d'API HTTP — Anthropic Messages, ou tout service compatible
 * OpenAI (OpenRouter, Ollama, LM Studio, vLLM).
 *
 * Ce fournisseur **n'a pas d'outils** : ni lecture, ni écriture, ni commande.
 * Il ne remplace pas un moteur de codage, il tient le rôle de dernier recours
 * pour ce qui peut se faire en un aller-retour — résumer, reformuler, trancher
 * — quand tous les comptes agentiques sont épuisés. Le proposer comme repli
 * d'une tâche d'édition produirait un run vert qui n'a rien modifié : c'est
 * pour ça que `PROVIDER_CAPABILITIES` déclare `editsWorkspace: false` et que
 * l'interface le signale.
 *
 * Le coût n'est pas calculé : il faudrait une table de prix par modèle et par
 * fournisseur, qui vieillit mal. Les tokens, eux, sont rapportés tels quels.
 */
import {
  API_BASE_URLS,
  PROVIDER_LABELS,
  type ApiFlavor,
  type ProviderAccount,
  type ProviderProbe,
} from '@maestro/shared';
import { truncate } from '../util.ts';
import {
  ZERO_USAGE,
  type AttemptContext,
  type AttemptOutcome,
  type ProviderAdapter,
} from './adapter.ts';

/** Plafond de sortie ; l'API Anthropic exige `max_tokens`, elle n'a pas de défaut. */
const MAX_OUTPUT_TOKENS = 8192;

export class HttpApiAdapter implements ProviderAdapter {
  readonly kind = 'http-api' as const;

  async probe(account?: ProviderAccount | null): Promise<ProviderProbe> {
    const label = PROVIDER_LABELS['http-api'];
    const envName = account?.apiKeyEnv ?? null;
    /* Les noms seulement : rendre la valeur reviendrait à publier la clé dans
       une réponse d'API et, de là, dans les journaux du navigateur. */
    const envCandidates = Object.keys(process.env).filter(
      (name) => /_API_KEY$|^ANTHROPIC_|^OPENAI_|^OPENROUTER_/.test(name) && process.env[name],
    );

    const hasKey = envName ? Boolean(process.env[envName]) : false;
    return {
      kind: 'http-api',
      label,
      binaryPath: null,
      version: null,
      detectedProfiles: [],
      envCandidates,
      ready: hasKey,
      hint: envName
        ? hasKey
          ? null
          : `La variable ${envName} n’est pas définie dans l’environnement du serveur.`
        : 'Choisis la variable d’environnement qui porte la clé ; sa valeur ne sera ni stockée ni affichée.',
      // Appel HTTP direct : il n'y a pas de ligne de commande à déduire.
      invocation: null,
      invocationDegraded: false,
    };
  }

  async execute(ctx: AttemptContext): Promise<AttemptOutcome> {
    const flavor: ApiFlavor = ctx.account?.apiFlavor ?? 'anthropic';
    const baseUrl = (ctx.account?.baseUrl ?? API_BASE_URLS[flavor]).replace(/\/+$/, '');
    const envName =
      ctx.account?.apiKeyEnv ?? (flavor === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
    const apiKey = ctx.env[envName];

    if (!apiKey) {
      return {
        status: 'failed',
        sessionId: null,
        resultText: null,
        error: `Clé absente : la variable ${envName} n’est pas définie côté serveur`,
        failureSignal: { hint: 'auth' },
        usage: { ...ZERO_USAGE },
      };
    }

    ctx.emit('init', {
      text: `Moteur API HTTP (${flavor}) — ${baseUrl}, modèle ${ctx.model}. Aucun outil : ce fournisseur ne modifie pas le workspace.`,
    });

    const timeout = ctx.timeoutSec && ctx.timeoutSec > 0 ? ctx.timeoutSec * 1000 : 600_000;
    /* Distinguer « le run a été annulé » de « mon propre délai a expiré » : les
       deux se présentent comme un signal avorté, mais l'un est une décision
       humaine et l'autre un garde-fou. Les confondre effaçait le motif réel
       dans le transcript. */
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctx.abort.abort();
    }, timeout);

    try {
      const response =
        flavor === 'anthropic'
          ? await this.callAnthropic(ctx, baseUrl, apiKey)
          : await this.callOpenAi(ctx, baseUrl, apiKey);

      if (!response.ok) {
        return {
          status: 'failed',
          sessionId: null,
          resultText: null,
          error: response.body,
          failureSignal: { status: response.status, headers: response.headers },
          usage: { ...ZERO_USAGE },
        };
      }

      if (response.text) ctx.emit('assistant_text', { text: truncate(response.text, 8000) });
      ctx.onUsage(response.usage);
      return {
        status: 'succeeded',
        sessionId: null,
        resultText: response.text,
        error: null,
        usage: response.usage,
      };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      const aborted = ctx.abort.signal.aborted;
      return {
        status: 'failed',
        sessionId: null,
        resultText: null,
        error: timedOut
          ? `Délai maximal dépassé (${ctx.timeoutSec} s)`
          : aborted
            ? 'Interrompu'
            : error.message,
        failureSignal: timedOut
          ? { hint: 'budget' }
          : aborted
            ? { hint: 'cancelled' }
            : { code: error.code ?? null },
        usage: { ...ZERO_USAGE },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async callAnthropic(
    ctx: AttemptContext,
    baseUrl: string,
    apiKey: string,
  ): Promise<ApiResponse> {
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      signal: ctx.abort.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ctx.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        ...(ctx.agent.systemPrompt ? { system: ctx.agent.systemPrompt } : {}),
        messages: [{ role: 'user', content: ctx.prompt }],
      }),
    });

    const headers = headersToObject(res.headers);
    const raw = await res.text();
    if (!res.ok)
      return {
        ok: false,
        status: res.status,
        headers,
        body: raw,
        text: '',
        usage: { ...ZERO_USAGE },
      };

    const json = safeJson(raw);
    const blocks = Array.isArray(json?.content) ? json.content : [];
    const text = blocks
      .filter((b): b is { type: string; text: string } => isTextBlock(b))
      .map((b) => b.text)
      .join('');
    const usage = (json?.usage ?? {}) as Record<string, number>;
    return {
      ok: true,
      status: res.status,
      headers,
      body: raw,
      text,
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
        costUsd: 0,
        numTurns: 1,
      },
    };
  }

  private async callOpenAi(
    ctx: AttemptContext,
    baseUrl: string,
    apiKey: string,
  ): Promise<ApiResponse> {
    const messages: { role: string; content: string }[] = [];
    if (ctx.agent.systemPrompt) messages.push({ role: 'system', content: ctx.agent.systemPrompt });
    messages.push({ role: 'user', content: ctx.prompt });

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      signal: ctx.abort.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: ctx.model, messages, max_tokens: MAX_OUTPUT_TOKENS }),
    });

    const headers = headersToObject(res.headers);
    const raw = await res.text();
    if (!res.ok)
      return {
        ok: false,
        status: res.status,
        headers,
        body: raw,
        text: '',
        usage: { ...ZERO_USAGE },
      };

    const json = safeJson(raw);
    const choices = Array.isArray(json?.choices) ? json.choices : [];
    const first = choices[0] as { message?: { content?: unknown } } | undefined;
    const text = typeof first?.message?.content === 'string' ? first.message.content : '';
    const usage = (json?.usage ?? {}) as Record<string, number>;
    return {
      ok: true,
      status: res.status,
      headers,
      body: raw,
      text,
      usage: {
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        numTurns: 1,
      },
    };
  }
}

interface ApiResponse {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
  text: string;
  usage: typeof ZERO_USAGE;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isTextBlock(block: unknown): block is { type: string; text: string } {
  return (
    typeof block === 'object' &&
    block !== null &&
    'type' in block &&
    (block as { type: unknown }).type === 'text' &&
    typeof (block as { text?: unknown }).text === 'string'
  );
}
