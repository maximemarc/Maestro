/**
 * Graphe d'une collection RAG.
 *
 * Deux familles d'arêtes, et c'est ce mélange qui rend la vue utile :
 *
 * - la **structure** relie la collection à ses documents, et chaque document à
 *   ses passages. Elle donne un squelette lisible, sans lequel un nuage de
 *   points ne veut rien dire ;
 * - le **rapprochement lexical** relie deux passages qui partagent un
 *   vocabulaire rare. C'est lui qui fait apparaître les grappes de sujets, les
 *   quasi-doublons, et surtout les passages isolés — ceux qu'aucune recherche ne
 *   remonte jamais.
 *
 * Le rapprochement est calculé avec l'index plein texte déjà présent, et non par
 * comparaison de toutes les paires : à cinq cents passages, la comparaison
 * exhaustive ferait cent vingt mille calculs pour un résultat identique. Chaque
 * passage interroge l'index avec ses propres termes distinctifs, ce qui borne le
 * coût à une requête par passage.
 */
import type { RagGraph, RagGraphLink, RagGraphNode } from '@maestro/shared';
import type { Store, StoredChunk } from './db.ts';

/**
 * Plafond de passages représentés.
 *
 * Au-delà, la vue cesse d'être lisible bien avant de devenir lente : un graphe
 * de plusieurs milliers de nœuds est une tache. On borne, et on le dit.
 */
export const MAX_GRAPH_CHUNKS = 400;

/** Nombre de voisins retenus par passage. */
const NEIGHBOURS_PER_CHUNK = 3;
/** Termes distinctifs extraits d'un passage pour interroger l'index. */
const TERMS_PER_CHUNK = 6;
/** Longueur minimale d'un terme retenu : en dessous, il ne discrimine rien. */
const MIN_TERM_LENGTH = 4;
/** Part du corpus au-delà de laquelle un terme est trop répandu pour relier. */
const COMMON_TERM_RATIO = 0.33;

const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Mots outils, écartés avant toute mesure de rareté.
 *
 * Le filtre par fréquence ne suffit pas, et un test le montre : « après » est
 * présent dans deux passages sur neuf, donc assez rare pour passer le seuil, et
 * il a relié une note de clôture comptable à une note de jardinage. Sur un
 * corpus moyen le problème empire — un mot comme « pendant », présent dans dix
 * passages sur quatre-vingt-dix, reste sous le plafond d'un tiers et fabrique
 * des rapprochements que rien ne justifie.
 *
 * La liste ne contient que des mots de fonction : conjonctions, prépositions,
 * auxiliaires, déterminants. Aucun terme métier, dans aucune langue. Elle porte
 * sur le français et l'anglais parce que les deux cohabitent dans les documents
 * techniques indexés. Elle est volontairement courte : les mots de moins de
 * quatre lettres sont déjà écartés par la longueur.
 */
const STOP_WORDS = new Set([
  // Français — prépositions et conjonctions
  'dans',
  'pour',
  'avec',
  'sans',
  'sous',
  'vers',
  'chez',
  'hors',
  'entre',
  'après',
  'apres',
  'avant',
  'depuis',
  'pendant',
  'selon',
  'contre',
  'jusqu',
  'jusque',
  'mais',
  'donc',
  'ainsi',
  'alors',
  'comme',
  'quand',
  'lorsque',
  'puisque',
  'parce',
  'pourtant',
  'cependant',
  'toutefois',
  // Français — déterminants et pronoms
  'cette',
  'cela',
  'ceci',
  'celui',
  'celle',
  'ceux',
  'celles',
  'dont',
  'elle',
  'elles',
  'nous',
  'vous',
  'leur',
  'leurs',
  'notre',
  'votre',
  'nos',
  'vos',
  'autre',
  'autres',
  'quel',
  'quels',
  'quelle',
  'quelles',
  'tout',
  'tous',
  'toute',
  'toutes',
  'aucun',
  'aucune',
  'chaque',
  // Français — auxiliaires et adverbes
  'être',
  'etre',
  'sont',
  'était',
  'etait',
  'étaient',
  'etaient',
  'sera',
  'seront',
  'avoir',
  'avait',
  'avaient',
  'aura',
  'faire',
  'fait',
  'peut',
  'peuvent',
  'doit',
  'doivent',
  'plus',
  'moins',
  'même',
  'meme',
  'aussi',
  'bien',
  'très',
  'tres',
  'déjà',
  'deja',
  'encore',
  'jamais',
  'toujours',
  'beaucoup',
  // Anglais — les documents techniques indexés en contiennent
  'this',
  'that',
  'these',
  'those',
  'with',
  'from',
  'into',
  'they',
  'them',
  'their',
  'there',
  'then',
  'than',
  'have',
  'been',
  'will',
  'must',
  'should',
  'would',
  'could',
  'which',
  'when',
  'where',
  'while',
  'about',
  'after',
  'before',
  'during',
  'your',
  'does',
  'only',
  'also',
  'some',
  'such',
  'more',
  'most',
  'each',
  'both',
  'same',
  'very',
  'just',
  'well',
  'here',
  'what',
]);

/** Découpe un texte en termes normalisés, comme le fait l'index. */
function terms(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= MIN_TERM_LENGTH && !STOP_WORDS.has(w));
}

/**
 * Sélectionne les termes qui peuvent rapprocher ce passage d'un autre.
 *
 * Le réflexe est de prendre les termes les plus rares, puisqu'ils
 * caractérisent le passage. C'est une erreur, et elle est mesurable : un terme
 * présent dans un seul passage ne peut par construction en désigner aucun
 * autre. Interroger l'index avec ces termes ne ramenait que le passage
 * lui-même, et le graphe restait un arbre — soixante-quatorze passages isolés
 * sur quatre-vingt-neuf, sur un corpus qui parle pourtant sans arrêt des mêmes
 * sujets.
 *
 * On garde donc les termes d'une rareté intermédiaire : assez peu répandus pour
 * discriminer, assez partagés pour relier. En dessous de deux passages, un terme
 * ne relie rien ; au-delà d'un tiers du corpus, il relie tout et ne dit plus
 * rien.
 */
function distinctiveTerms(
  chunk: StoredChunk,
  documentFrequency: Map<string, number>,
  chunkCount: number,
): string[] {
  const tooCommon = Math.max(3, Math.ceil(chunkCount * COMMON_TERM_RATIO));
  const counts = new Map<string, number>();
  for (const term of terms(chunk.content)) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }

  const usable = [...counts.entries()].filter(([term]) => {
    const df = documentFrequency.get(term) ?? 0;
    return df >= 2 && df <= tooCommon;
  });

  /* À rareté comparable, un terme répété dans le passage le caractérise mieux :
     c'est le tf de tf-idf, et il sert ici à trancher les ex æquo. */
  return usable
    .sort((a, b) => {
      const dfa = documentFrequency.get(a[0]) ?? 0;
      const dfb = documentFrequency.get(b[0]) ?? 0;
      if (dfa !== dfb) return dfa - dfb;
      return b[1] - a[1];
    })
    .slice(0, TERMS_PER_CHUNK)
    .map(([term]) => term);
}

/** Clé d'arête indépendante du sens, pour ne pas relier deux fois les mêmes. */
function edgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export function buildRagGraph(store: Store, collectionId: string): RagGraph {
  const collection = store.getRagCollection(collectionId);
  if (!collection) {
    return { nodes: [], links: [], truncated: false, totalChunks: 0, isolatedCount: 0 };
  }

  const documents = store.listRagDocuments(collectionId);
  const chunks = store.listChunksOfCollection(collectionId, MAX_GRAPH_CHUNKS);

  const nodes: RagGraphNode[] = [
    {
      id: collection.id,
      kind: 'collection',
      label: collection.name,
      documentId: null,
      chars: 0,
      chunkIndex: null,
    },
  ];
  const links: RagGraphLink[] = [];

  /* Seuls les documents dont un passage est représenté entrent dans le graphe :
     un document sans passage visible n'apporterait qu'un nœud pendant. */
  const chunkIds = new Set(chunks.map((c) => c.id));
  const documentsWithChunks = new Set(chunks.map((c) => c.documentId));

  for (const doc of documents) {
    if (!documentsWithChunks.has(doc.id)) continue;
    nodes.push({
      id: doc.id,
      kind: 'document',
      label: doc.title,
      documentId: null,
      chars: doc.bytes,
      chunkIndex: null,
    });
    links.push({ source: collection.id, target: doc.id, kind: 'contains', weight: 1 });
  }

  for (const chunk of chunks) {
    nodes.push({
      id: chunk.id,
      kind: 'chunk',
      label: `${chunk.documentTitle} · ${chunk.chunkIndex + 1}`,
      documentId: chunk.documentId,
      chars: chunk.content.length,
      chunkIndex: chunk.chunkIndex,
    });
    links.push({ source: chunk.documentId, target: chunk.id, kind: 'contains', weight: 1 });
  }

  /* --- Rapprochements lexicaux ------------------------------------------ */

  const documentFrequency = new Map<string, number>();
  for (const chunk of chunks) {
    for (const term of new Set(terms(chunk.content))) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const seen = new Set<string>();
  const connected = new Set<string>();

  for (const chunk of chunks) {
    const selected = distinctiveTerms(chunk, documentFrequency, chunks.length);
    if (selected.length === 0) continue;
    const query = selected.map((t) => `"${t}"`).join(' OR ');

    let hits;
    try {
      hits = store.searchRagLexical(collectionId, query, NEIGHBOURS_PER_CHUNK + 1);
    } catch {
      /* Une requête que l'index refuse ne doit pas emporter tout le graphe :
         ce passage restera simplement sans voisin. */
      continue;
    }

    /* bm25 rend un score négatif, d'autant plus bas que le passage est
       pertinent. Le meilleur voisin sert d'échelle : le poids exprime la
       proximité relative, ce qui suffit à moduler l'épaisseur d'un trait. */
    const best = hits.find((h) => h.chunkId !== chunk.id)?.score ?? -1;
    let kept = 0;
    for (const hit of hits) {
      if (hit.chunkId === chunk.id || !chunkIds.has(hit.chunkId)) continue;
      if (kept >= NEIGHBOURS_PER_CHUNK) break;
      const key = edgeKey(chunk.id, hit.chunkId);
      if (seen.has(key)) {
        kept++;
        continue;
      }
      seen.add(key);
      const weight = best === 0 ? 1 : Math.min(1, Math.max(0.15, hit.score / best));
      links.push({
        source: chunk.id,
        target: hit.chunkId,
        kind: 'similar',
        weight: Number(weight.toFixed(3)),
      });
      connected.add(chunk.id);
      connected.add(hit.chunkId);
      kept++;
    }
  }

  return {
    nodes,
    links,
    truncated: collection.chunkCount > chunks.length,
    totalChunks: collection.chunkCount,
    isolatedCount: chunks.filter((c) => !connected.has(c.id)).length,
  };
}
