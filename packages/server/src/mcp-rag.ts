/**
 * Serveur MCP « rag » : donne aux agents l'accès aux collections documentaires.
 *
 * Un seul serveur, deux outils, plutôt qu'un serveur par collection : le modèle
 * n'a qu'un outil à apprendre, et la liste des collections devient une donnée
 * qu'il consulte au lieu d'un ensemble d'outils qu'il doit deviner.
 *
 * Le périmètre est fermé côté serveur : seules les collections activées sur
 * l'agent sont visibles et interrogeables. Un agent ne peut pas atteindre une
 * collection qu'on ne lui a pas confiée, même en devinant son identifiant.
 *
 * Les descriptions d'outils et le rendu des résultats sont exportés : la
 * passerelle MCP (`mcp-gateway.ts`), qui sert les clients tiers, les réutilise
 * tels quels. Un agent Codex et un agent Maestro doivent lire la même chose
 * pour le même corpus — sinon deux formulations divergent silencieusement et
 * les réponses cessent d'être comparables.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { RagCollection, RagSearchResult } from '@maestro/shared';
import type { RagService } from './rag.ts';

/** Longueur maximale d'un passage rendu à l'agent, pour borner le contexte. */
const HIT_MAX_CHARS = 2000;

/** Nombre de passages rendus quand l'appelant ne précise rien. */
export const RAG_DEFAULT_TOP_K = 5;
/** Plafond dur : au-delà, le contexte se remplit plus vite qu'il n'informe. */
export const RAG_MAX_TOP_K = 10;

export const RAG_COLLECTIONS_DESCRIPTION =
  'Lister les bases documentaires interrogeables, avec leur volume.';
export const RAG_SEARCH_DESCRIPTION =
  'Chercher des passages dans une base documentaire. La recherche croise les termes exacts et le sens : formule la requête comme une question ou une liste de mots-clés, sans syntaxe particulière.';

function text(message: string) {
  return { content: [{ type: 'text' as const, text: message }] };
}

function failure(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

/** Rendu de la liste des collections autorisées. */
export function formatCollectionList(allowed: RagCollection[]): string {
  const lines = allowed.map(
    (c) =>
      `- ${c.slug} : ${c.name}${c.description ? ` — ${c.description}` : ''} (${c.documentCount} document(s), ${c.chunkCount} passage(s))`,
  );
  return `Bases documentaires disponibles :\n${lines.join('\n')}`;
}

/**
 * Rendu d'une recherche, y compris le cas « rien trouvé ».
 *
 * Le titre du document et l'indice du passage sont donnés à chaque extrait :
 * sans eux, l'agent ne peut pas citer sa source, et une synthèse non sourcée
 * est inexploitable pour l'utilisateur.
 */
export function formatSearchResult(
  collection: RagCollection,
  query: string,
  result: RagSearchResult,
): string {
  if (result.hits.length === 0) {
    return `Aucun passage trouvé dans « ${collection.name} » pour : ${query}. Reformule avec d'autres termes, ou vérifie que la base contient bien ce sujet.`;
  }

  const blocks = result.hits.map((hit, index) => {
    const body =
      hit.content.length > HIT_MAX_CHARS ? `${hit.content.slice(0, HIT_MAX_CHARS)}…` : hit.content;
    return `[${index + 1}] ${hit.documentTitle} (passage ${hit.chunkIndex + 1})\n${body}`;
  });

  const mode = result.semanticUsed ? 'lexicale et sémantique' : 'lexicale seule';
  return `${result.hits.length} passage(s) de « ${collection.name} », recherche ${mode} :\n\n${blocks.join('\n\n---\n\n')}`;
}

/**
 * Construit le serveur pour un jeu de collections autorisées.
 *
 * Retourne null si l'agent n'en a aucune : déclarer un serveur avec des outils
 * qui répondent toujours « aucune collection » gaspille du contexte et invite le
 * modèle à insister.
 */
export function buildRagServer(rag: RagService, allowed: RagCollection[]) {
  if (allowed.length === 0) return null;

  const bySlug = new Map(allowed.map((c) => [c.slug, c]));
  const slugs = allowed.map((c) => c.slug);

  const listCollections = tool('rag_collections', RAG_COLLECTIONS_DESCRIPTION, {}, async () =>
    text(formatCollectionList(allowed)),
  );

  const search = tool(
    'rag_search',
    RAG_SEARCH_DESCRIPTION,
    {
      collection: z
        .enum(slugs as [string, ...string[]])
        .describe('Identifiant de la base, tel que rendu par rag_collections.'),
      query: z.string().min(2).describe('Question ou mots-clés.'),
      topK: z
        .number()
        .int()
        .min(1)
        .max(RAG_MAX_TOP_K)
        .default(RAG_DEFAULT_TOP_K)
        .describe('Nombre de passages souhaités.'),
    },
    async (args) => {
      const collection = bySlug.get(args.collection);
      if (!collection) return failure(`Base inconnue ou non autorisée : ${args.collection}`);

      try {
        const result = await rag.search(collection.id, args.query, args.topK);
        return text(formatSearchResult(collection, args.query, result));
      } catch (err) {
        return failure(err instanceof Error ? err.message : String(err));
      }
    },
  );

  return createSdkMcpServer({ name: 'rag', version: '1.0.0', tools: [listCollections, search] });
}
