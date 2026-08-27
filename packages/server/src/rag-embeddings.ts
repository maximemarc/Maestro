/**
 * Moteur d'embeddings, optionnel et enfichable.
 *
 * 🔒 La clé d'API ne vient jamais de la base ni de l'interface : elle est lue
 * dans l'environnement du serveur, comme le jeton Telegram. L'interface n'en
 * connaît que la présence, et une clé absente n'est pas une erreur — la
 * recherche fonctionne alors en lexical seul.
 *
 * Deux fournisseurs suffisent : Voyage, recommandé par Anthropic pour ses
 * modèles, et OpenAI, le plus répandu. Le premier configuré gagne.
 */
import type { RagEmbeddingStatus } from '@maestro/shared';

/** Taille de lot : au-delà, les API refusent ou ralentissent fortement. */
export const EMBED_BATCH_SIZE = 64;
const EMBED_TIMEOUT_MS = 60_000;

interface Provider {
  name: string;
  model: string;
  envVar: string;
  apiKey: string;
  embed(texts: string[], kind: 'document' | 'query'): Promise<Float32Array[]>;
}

function voyage(apiKey: string): Provider {
  const model = 'voyage-3.5-lite';
  return {
    name: 'voyage',
    model,
    envVar: 'VOYAGE_API_KEY',
    apiKey,
    async embed(texts, kind) {
      const response = await postJson(
        'https://api.voyageai.com/v1/embeddings',
        { authorization: `Bearer ${apiKey}` },
        /* Voyage distingue le vecteur d'un document de celui d'une requête :
           utiliser le même type des deux côtés dégrade nettement le rappel. */
        { model, input: texts, input_type: kind === 'query' ? 'query' : 'document' },
      );
      const data = (response as { data?: Array<{ embedding: number[] }> }).data ?? [];
      return data.map((d) => Float32Array.from(d.embedding));
    },
  };
}

function openai(apiKey: string): Provider {
  const model = 'text-embedding-3-small';
  return {
    name: 'openai',
    model,
    envVar: 'OPENAI_API_KEY',
    apiKey,
    async embed(texts) {
      const response = await postJson(
        'https://api.openai.com/v1/embeddings',
        { authorization: `Bearer ${apiKey}` },
        { model, input: texts },
      );
      const data = (response as { data?: Array<{ embedding: number[] }> }).data ?? [];
      return data.map((d) => Float32Array.from(d.embedding));
    },
  };
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Embeddings : HTTP ${response.status} ${raw.slice(0, 300)}`);
    }
    return JSON.parse(raw);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Résout le fournisseur à partir de l'environnement.
 *
 * Lu à chaque appel plutôt que mémorisé : ajouter la clé et redémarrer le
 * serveur suffit, et l'état affiché dans l'interface ne peut pas être périmé.
 */
function resolveProvider(): Provider | null {
  const voyageKey = process.env.VOYAGE_API_KEY?.trim();
  if (voyageKey) return voyage(voyageKey);
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  if (openaiKey) return openai(openaiKey);
  return null;
}

export function embeddingStatus(): RagEmbeddingStatus {
  const provider = resolveProvider();
  if (!provider) {
    return {
      provider: null,
      model: null,
      available: false,
      envVar: 'VOYAGE_API_KEY ou OPENAI_API_KEY',
    };
  }
  return {
    provider: provider.name,
    model: provider.model,
    available: true,
    envVar: provider.envVar,
  };
}

export function embeddingsAvailable(): boolean {
  return resolveProvider() !== null;
}

/**
 * Identifiant du modèle courant, ou null si aucun fournisseur n'est configuré.
 *
 * Il est stocké avec chaque vecteur : deux fournisseurs ne rendent pas la même
 * dimension, et comparer des vecteurs de dimensions différentes ne produit pas
 * une erreur mais un score nul, donc une dégradation invisible.
 */
export function embeddingModel(): string | null {
  return resolveProvider()?.model ?? null;
}

/** Vectorise des textes. Retourne null si aucun fournisseur n'est configuré. */
export async function embed(
  texts: string[],
  kind: 'document' | 'query',
): Promise<Float32Array[] | null> {
  const provider = resolveProvider();
  if (!provider || texts.length === 0) return null;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await provider.embed(batch, kind);
    if (vectors.length !== batch.length) {
      throw new Error(
        `Embeddings : ${vectors.length} vecteurs pour ${batch.length} textes, réponse incohérente.`,
      );
    }
    out.push(...vectors);
  }
  return out;
}

/**
 * Similarité cosinus.
 *
 * Les vecteurs des deux fournisseurs sont déjà normalisés, mais on divise
 * quand même par les normes : un vecteur non normalisé produirait sinon des
 * scores hors [-1, 1] qui casseraient silencieusement le classement.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
