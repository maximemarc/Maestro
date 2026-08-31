/**
 * Collections RAG : ingestion, découpe, index et recherche hybride.
 *
 * La recherche combine deux moteurs qui ne se trompent pas de la même façon :
 *
 * - BM25 (FTS5) trouve les termes exacts. Sur un corpus métier — références
 *   réglementaires, noms de comptes, identifiants — c'est souvent lui qui a
 *   raison, et il fonctionne sans clé ni réseau.
 * - Les embeddings trouvent les reformulations, là où le lexical échoue parce
 *   que la question n'emploie aucun mot du document.
 *
 * Les deux classements sont fusionnés par rang réciproque (RRF) plutôt que par
 * addition de scores : BM25 rend des valeurs négatives non bornées et le
 * cosinus vit dans [-1, 1]. Les additionner demanderait une normalisation
 * arbitraire, alors que la position dans chaque liste est directement
 * comparable.
 *
 * La partie sémantique est facultative : sans clé d'API, la recherche reste
 * lexicale et le dit (`semanticUsed: false`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type {
  RagChunkView,
  RagCollection,
  RagDocument,
  RagMaintenanceReport,
  RagHit,
  RagSearchResult,
  RagSourceKind,
} from '@maestro/shared';
import type { AgentService } from './agents.ts';
import type { Bus } from './bus.ts';
import type { Store } from './db.ts';
import { cosine, embed, embeddingModel, embeddingsAvailable } from './rag-embeddings.ts';
import { makeId, nowIso } from './util.ts';

export class RagError extends Error {}

/** Bornes de découpe : en dehors, l'index perd son intérêt. */
const CHUNK_SIZE_MIN = 300;
const CHUNK_SIZE_MAX = 4000;
const OVERLAP_MAX_RATIO = 0.5;

/** Plafonds d'ingestion, pour qu'un dossier mal ciblé ne remplisse pas la base. */
const MAX_DOC_BYTES = 4 * 1024 * 1024;
const MAX_FILES_PER_DIRECTORY = 500;
const URL_TIMEOUT_MS = 20_000;

/**
 * Octet nul, marque d'un fichier binaire mal étiqueté.
 *
 * Construit plutôt qu'écrit en littéral : un octet nul dans un fichier source
 * est invisible à la relecture et casse la plupart des outils de diff.
 */
const NUL_BYTE = String.fromCharCode(0);

/** Diacritiques combinants, retirés après normalisation NFD. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/** Extensions considérées comme du texte lisible. */
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.rst',
  '.adoc',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.html',
  '.htm',
  '.php',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.sql',
  '.sh',
  '.twig',
  '.css',
  '.xml',
]);

/** Combien de candidats chaque moteur remonte avant fusion. */
const CANDIDATES_PER_ENGINE = 30;
/** Constante de lissage du RRF. 60 est la valeur de la publication d'origine. */
const RRF_K = 60;

/**
 * Taille des tranches de vecteurs lues lors d'une recherche sémantique.
 *
 * La collection n'est jamais chargée entière : à quatre kilo-octets par
 * morceau, cinquante mille morceaux représenteraient deux cents mégaoctets par
 * requête. On lit par tranches et on ne garde qu'un classement borné.
 */
const EMBEDDING_SCAN_BATCH = 512;

// ---------------------------------------------------------------------------
// Découpe
// ---------------------------------------------------------------------------

/**
 * Découpe un texte en morceaux qui se recouvrent.
 *
 * La coupure cherche d'abord une fin de paragraphe, puis une fin de phrase,
 * dans le dernier quart de la fenêtre. Couper au caractère près sépare une
 * définition de son sujet, et le morceau devient inutilisable seul : c'est
 * précisément ce qu'un RAG doit éviter, puisque le modèle ne verra que le
 * morceau.
 */
export function chunkText(text: string, size: number, overlap: number): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean === '') return [];
  if (clean.length <= size) return [clean];

  /*
   * Le recouvrement est borné ici, et pas seulement à la création d'une
   * collection.
   *
   * Avec un recouvrement égal à la fenêtre, le pas d'avancement tombait à un
   * caractère : mille caractères donnaient neuf cents morceaux presque
   * identiques, ce qui gonfle l'index sans rien améliorer et fait remonter le
   * même passage neuf cents fois. L'invariant appartient à la boucle qu'il
   * protège, pas à son appelant.
   */
  const boundedOverlap = Math.min(Math.max(0, overlap), Math.floor(size * OVERLAP_MAX_RATIO));
  const chunks: string[] = [];
  const step = Math.max(1, size - boundedOverlap);
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const floor = Math.floor(size * 0.75);
      const breakAt = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('\n'),
        window.lastIndexOf('. '),
      );
      if (breakAt > floor) end = start + breakAt + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece !== '') chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(start + step, end - boundedOverlap);
  }
  return chunks;
}

/**
 * Prépare une requête utilisateur pour FTS5.
 *
 * Le langage de requête de FTS5 a une syntaxe : un guillemet ou un astérisque
 * saisi par un agent provoquerait une erreur SQL. On ne garde donc que les mots
 * et on les joint par OR, le classement BM25 faisant remonter les passages qui
 * en contiennent le plus.
 */
export function toFtsQuery(query: string): string {
  const words = query
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
  if (words.length === 0) return '';
  return words.map((w) => `"${w}"`).join(' OR ');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface CollectionInput {
  name: string;
  slug: string;
  description: string;
  chunkSize: number;
  chunkOverlap: number;
}

export interface IngestInput {
  sourceKind: RagSourceKind;
  /** Titre imposé ; à défaut, il est déduit de l'origine. */
  title?: string;
  /** Contenu, pour `text`. */
  content?: string;
  /** Chemin, URL ou identifiant d'agent selon l'origine. */
  source?: string;
}

export interface IngestReport {
  documents: RagDocument[];
  chunks: number;
  /** Fichiers écartés, avec la raison : un import silencieux ment. */
  skipped: Array<{ source: string; reason: string }>;
}

export class RagService {
  constructor(
    private store: Store,
    private bus: Bus,
    private agents: AgentService,
  ) {}

  /**
   * Complète une collection avec le nombre de morceaux périmés.
   *
   * Ce compte dépend du modèle configuré au moment de la lecture, que la base
   * ignore : elle ne stocke que le modèle de chaque vecteur.
   */
  private withStale(collection: RagCollection): RagCollection {
    const model = embeddingModel();
    if (!model) return collection;
    return {
      ...collection,
      staleChunkCount: this.store.rag.countStaleEmbeddings(collection.id, model),
    };
  }

  list(): RagCollection[] {
    return this.store.rag.listCollections().map((c) => this.withStale(c));
  }

  get(id: string): RagCollection | null {
    const collection = this.store.rag.getCollection(id);
    return collection ? this.withStale(collection) : null;
  }

  documents(collectionId: string): RagDocument[] {
    return this.store.rag.listDocuments(collectionId);
  }

  create(input: CollectionInput): RagCollection {
    const collection = this.normalise(input, null);
    if (this.store.rag.getCollectionBySlug(collection.slug)) {
      throw new RagError(`Une collection porte déjà l'identifiant « ${collection.slug} ».`);
    }
    this.store.rag.upsertCollection(collection);
    const saved = this.get(collection.id)!;
    this.bus.log('info', 'rag', `Collection « ${saved.name} » créée`);
    this.bus.publish({ type: 'rag.updated', payload: saved });
    return saved;
  }

  update(id: string, input: CollectionInput): RagCollection {
    const existing = this.store.rag.getCollection(id);
    if (!existing) throw new RagError('Collection introuvable.');
    const collection = this.normalise(input, existing);
    const clash = this.store.rag.getCollectionBySlug(collection.slug);
    if (clash && clash.id !== id) {
      throw new RagError(`Une collection porte déjà l'identifiant « ${collection.slug} ».`);
    }
    this.store.rag.upsertCollection(collection);
    const saved = this.get(id)!;
    this.bus.publish({ type: 'rag.updated', payload: saved });
    return saved;
  }

  remove(id: string): void {
    const existing = this.store.rag.getCollection(id);
    if (!existing) throw new RagError('Collection introuvable.');
    this.store.detachRagCollectionFromAgents(id);
    this.store.rag.deleteCollection(id);
    this.bus.log('warn', 'rag', `Collection « ${existing.name} » supprimée`);
    this.bus.publish({ type: 'rag.deleted', payload: { id } });
  }

  removeDocument(collectionId: string, documentId: string): void {
    const doc = this.store.rag.getDocument(documentId);
    if (!doc || doc.collectionId !== collectionId) throw new RagError('Document introuvable.');
    this.store.rag.deleteDocument(documentId);
    const saved = this.get(collectionId);
    if (saved) this.bus.publish({ type: 'rag.updated', payload: saved });
  }

  private normalise(input: CollectionInput, existing: RagCollection | null): RagCollection {
    const name = input.name.trim();
    if (name === '') throw new RagError('Le nom de la collection est obligatoire.');
    const slug = slugifyRag(input.slug.trim() === '' ? name : input.slug);
    if (slug.length < 2) throw new RagError(`Identifiant invalide : « ${slug} ».`);
    const chunkSize = clampInt(input.chunkSize, CHUNK_SIZE_MIN, CHUNK_SIZE_MAX, 1200);
    /* Un recouvrement de la moitié de la fenêtre double déjà le volume indexé :
       au-delà, on paie de l'espace pour du bruit. */
    const chunkOverlap = clampInt(
      input.chunkOverlap,
      0,
      Math.floor(chunkSize * OVERLAP_MAX_RATIO),
      150,
    );
    const now = nowIso();
    return {
      id: existing?.id ?? makeId('rag'),
      slug,
      name,
      description: input.description.trim(),
      chunkSize,
      chunkOverlap,
      documentCount: existing?.documentCount ?? 0,
      chunkCount: existing?.chunkCount ?? 0,
      embeddedChunkCount: existing?.embeddedChunkCount ?? 0,
      staleChunkCount: existing?.staleChunkCount ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  // --- Ingestion ----------------------------------------------------------

  /**
   * Ingère une source dans une collection.
   *
   * Un document déjà présent avec la même origine est remplacé, pas dupliqué :
   * réindexer un fichier modifié est le geste courant, et laisser deux versions
   * dans l'index ferait remonter des passages périmés.
   */
  async ingest(collectionId: string, input: IngestInput): Promise<IngestReport> {
    const collection = this.store.rag.getCollection(collectionId);
    if (!collection) throw new RagError('Collection introuvable.');

    const pieces = await this.readSource(input);
    const report: IngestReport = { documents: [], chunks: 0, skipped: pieces.skipped };

    for (const piece of pieces.docs) {
      const previous = this.store.rag.findDocumentBySource(collectionId, piece.source);
      if (previous) this.store.rag.deleteDocument(previous.id);

      const chunks = chunkText(piece.content, collection.chunkSize, collection.chunkOverlap);
      if (chunks.length === 0) {
        report.skipped.push({ source: piece.source || piece.title, reason: 'contenu vide' });
        continue;
      }

      const doc: RagDocument = {
        id: makeId('doc'),
        collectionId,
        title: piece.title,
        sourceKind: input.sourceKind,
        source: piece.source,
        /* Ce que l'utilisateur a désigné, et non le fichier trouvé dedans. */
        ingestRoot: (input.source ?? '').trim() || null,
        bytes: Buffer.byteLength(piece.content, 'utf8'),
        chunkCount: chunks.length,
        createdAt: nowIso(),
      };
      this.store.rag.insertDocument(doc, piece.content);
      this.store.rag.insertChunks(
        chunks.map((content, index) => ({
          id: makeId('chk'),
          collectionId,
          documentId: doc.id,
          chunkIndex: index,
          content,
        })),
        doc.createdAt,
      );
      report.documents.push(doc);
      report.chunks += chunks.length;
    }

    this.bus.log(
      'info',
      'rag',
      `${report.documents.length} document(s), ${report.chunks} morceau(x) indexés dans « ${collection.name} »`,
    );

    /* Les vecteurs sont calculés après coup : l'ingestion doit rendre la main
       même si l'API d'embeddings est lente ou absente, et la recherche
       lexicale fonctionne déjà. */
    if (embeddingsAvailable() && report.chunks > 0) {
      void this.backfillEmbeddings(collectionId).catch((err: unknown) => {
        this.bus.log(
          'error',
          'rag',
          `Vectorisation interrompue : ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    const saved = this.get(collectionId);
    if (saved) this.bus.publish({ type: 'rag.updated', payload: saved });
    return report;
  }

  /**
   * Réindexe une collection depuis le contenu conservé.
   *
   * C'est la seule façon d'appliquer une nouvelle taille de découpe à ce qui est
   * déjà là. Les documents ingérés avant que le contenu ne soit conservé sont
   * signalés au lieu d'être silencieusement laissés de côté : leur découpe reste
   * celle d'origine, et l'utilisateur doit le savoir.
   */
  async reindex(collectionId: string): Promise<RagMaintenanceReport> {
    const collection = this.store.rag.getCollection(collectionId);
    if (!collection) throw new RagError('Collection introuvable.');

    const report: RagMaintenanceReport = { documents: 0, chunks: 0, removed: 0, skipped: [] };
    for (const { doc, content } of this.store.rag.listDocumentsWithContent(collectionId)) {
      if (content === null) {
        report.skipped.push({
          source: doc.source || doc.title,
          reason: 'contenu non conservé : document ingéré avant cette version, à réingérer',
        });
        continue;
      }
      const chunks = chunkText(content, collection.chunkSize, collection.chunkOverlap);
      if (chunks.length === 0) {
        report.skipped.push({ source: doc.source || doc.title, reason: 'contenu vide' });
        continue;
      }
      /* Les anciens morceaux et leurs entrées d'index partent d'abord : garder
         les deux découpes ferait remonter deux fois le même passage. */
      this.store.rag.deleteChunksOfDocument(doc.id);
      this.store.rag.insertChunks(
        chunks.map((text, index) => ({
          id: makeId('chk'),
          collectionId,
          documentId: doc.id,
          chunkIndex: index,
          content: text,
        })),
        nowIso(),
      );
      report.documents++;
      report.chunks += chunks.length;
    }

    this.bus.log(
      'info',
      'rag',
      `Réindexation de « ${collection.name} » : ${report.documents} document(s), ${report.chunks} morceau(x)`,
    );
    this.afterMutation(collectionId);
    return report;
  }

  /**
   * Relit les sources relisibles d'une collection.
   *
   * Le rafraîchissement part des racines d'ingestion, pas des documents : un
   * dossier réingéré fait apparaître les fichiers ajoutés depuis, ce qu'une
   * simple relecture document par document ne verrait jamais. Les documents dont
   * le fichier a disparu sont retirés, sinon l'index continuerait de proposer
   * des passages qui n'existent plus.
   */
  async refresh(collectionId: string): Promise<RagMaintenanceReport> {
    const collection = this.store.rag.getCollection(collectionId);
    if (!collection) throw new RagError('Collection introuvable.');

    const report: RagMaintenanceReport = { documents: 0, chunks: 0, removed: 0, skipped: [] };
    for (const root of this.store.rag.listIngestRoots(collectionId)) {
      const before = this.store.rag.listDocumentsByRoot(collectionId, root.ingestRoot);
      let ingested;
      try {
        ingested = await this.ingest(collectionId, {
          sourceKind: root.sourceKind,
          source: root.ingestRoot,
        });
      } catch (err) {
        report.skipped.push({
          source: root.ingestRoot,
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      report.documents += ingested.documents.length;
      report.chunks += ingested.chunks;
      report.skipped.push(...ingested.skipped);

      const stillThere = new Set(ingested.documents.map((d) => d.source));
      for (const old of before) {
        if (old.source !== '' && !stillThere.has(old.source)) {
          this.store.rag.deleteDocument(old.id);
          report.removed++;
        }
      }
    }

    this.bus.log(
      'info',
      'rag',
      `Rafraîchissement de « ${collection.name} » : ${report.documents} document(s), ${report.removed} retiré(s)`,
    );
    this.afterMutation(collectionId);
    return report;
  }

  /** Morceaux d'un document, pour voir comment il a été découpé. */
  chunksOfDocument(collectionId: string, documentId: string): RagChunkView[] {
    const doc = this.store.rag.getDocument(documentId);
    if (!doc || doc.collectionId !== collectionId) throw new RagError('Document introuvable.');
    const model = embeddingModel();
    return this.store.rag.listChunksOfDocument(documentId).map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      chars: chunk.content.length,
      embedded: chunk.embedding !== null && chunk.embeddingModel === model,
    }));
  }

  /** Publie l'état à jour d'une collection après une mutation. */
  private afterMutation(collectionId: string): void {
    const saved = this.get(collectionId);
    if (saved) this.bus.publish({ type: 'rag.updated', payload: saved });
  }

  /** Lit une source et retourne un ou plusieurs documents à indexer. */
  private async readSource(input: IngestInput): Promise<{
    docs: Array<{ title: string; source: string; content: string }>;
    skipped: Array<{ source: string; reason: string }>;
  }> {
    const skipped: Array<{ source: string; reason: string }> = [];

    if (input.sourceKind === 'text') {
      const content = input.content ?? '';
      if (content.trim() === '') throw new RagError('Le contenu collé est vide.');
      return { docs: [{ title: input.title?.trim() || 'Note', source: '', content }], skipped };
    }

    if (input.sourceKind === 'url') {
      const raw = (input.source ?? '').trim();
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        throw new RagError(`URL invalide : ${raw}`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new RagError('Seuls http et https sont acceptés.');
      }
      const content = await fetchText(parsed.toString());
      return {
        docs: [
          {
            title: input.title?.trim() || parsed.hostname + parsed.pathname,
            source: raw,
            content,
          },
        ],
        skipped,
      };
    }

    if (input.sourceKind === 'workspace') {
      const agentId = (input.source ?? '').trim();
      const agent = this.agents.get(agentId);
      if (!agent) throw new RagError(`Agent introuvable : ${agentId}`);
      return { docs: this.readDirectory(agent.workspaceDir, skipped), skipped };
    }

    /* `file` et `directory` : un chemin sur la machine. Aucun garde-fou de
       racine ici, et c'est assumé : Maestro tourne avec les droits de son
       utilisateur, qui peut déjà lire ces fichiers. Indexer ne lui ouvre rien
       de nouveau, cela rend seulement consultable ce qu'il choisit d'indexer. */
    const path = resolve((input.source ?? '').trim());
    if (path === '') throw new RagError('Le chemin est obligatoire.');
    let info;
    try {
      info = statSync(path);
    } catch {
      throw new RagError(`Chemin illisible : ${path}`);
    }
    if (info.isDirectory()) return { docs: this.readDirectory(path, skipped), skipped };
    const doc = this.readFile(path, skipped);
    return { docs: doc ? [doc] : [], skipped };
  }

  /**
   * Lit un fichier et en fait un document.
   *
   * `root` sert à construire le titre : dans un arbre de conventions où chaque
   * dossier contient un `SKILL.md`, prendre le seul nom de fichier donne
   * trente documents homonymes, et l'agent ne peut plus citer sa source. Le
   * chemin relatif à la racine ingérée est court et discriminant.
   */
  private readFile(
    path: string,
    skipped: Array<{ source: string; reason: string }>,
    root?: string,
  ): { title: string; source: string; content: string } | null {
    const ext = extname(path).toLowerCase();
    if (ext !== '' && !TEXT_EXTENSIONS.has(ext)) {
      skipped.push({ source: path, reason: `extension non textuelle (${ext})` });
      return null;
    }
    let info;
    try {
      info = statSync(path);
    } catch {
      skipped.push({ source: path, reason: 'illisible' });
      return null;
    }
    if (info.size > MAX_DOC_BYTES) {
      skipped.push({
        source: path,
        reason: `trop volumineux (${Math.round(info.size / 1024)} ko)`,
      });
      return null;
    }
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      skipped.push({ source: path, reason: 'illisible' });
      return null;
    }
    /* Un fichier binaire mal étiqueté contient des octets nuls : l'indexer
       remplirait l'index de bruit sans jamais rien retrouver. */
    if (content.includes(NUL_BYTE)) {
      skipped.push({ source: path, reason: 'contenu binaire' });
      return null;
    }
    return { title: relativeTitle(path, root), source: path, content };
  }

  private readDirectory(
    root: string,
    skipped: Array<{ source: string; reason: string }>,
  ): Array<{ title: string; source: string; content: string }> {
    const docs: Array<{ title: string; source: string; content: string }> = [];
    const stack = [root];
    const ignored = new Set(['node_modules', '.git', 'dist', 'vendor', '.venv', '__pycache__']);

    while (stack.length > 0 && docs.length < MAX_FILES_PER_DIRECTORY) {
      const dir = stack.pop()!;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        skipped.push({ source: dir, reason: 'répertoire illisible' });
        continue;
      }
      for (const entry of entries) {
        if (entry.startsWith('.') || ignored.has(entry)) continue;
        const full = join(dir, entry);
        let info;
        try {
          info = statSync(full);
        } catch {
          continue;
        }
        if (info.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (docs.length >= MAX_FILES_PER_DIRECTORY) break;
        const doc = this.readFile(full, skipped, root);
        if (doc) docs.push(doc);
      }
    }
    if (docs.length >= MAX_FILES_PER_DIRECTORY) {
      skipped.push({
        source: root,
        reason: `plafond de ${MAX_FILES_PER_DIRECTORY} fichiers atteint`,
      });
    }
    return docs;
  }

  // --- Vecteurs -----------------------------------------------------------

  /**
   * Calcule les vecteurs manquants d'une collection, par lots.
   *
   * Reprend là où elle s'était arrêtée : une coupure réseau au milieu laisse
   * une collection partiellement vectorisée, et le prochain appel termine le
   * travail sans tout recalculer.
   */
  async backfillEmbeddings(collectionId: string): Promise<{ embedded: number }> {
    if (!embeddingsAvailable()) return { embedded: 0 };
    const model = embeddingModel();
    if (!model) return { embedded: 0 };
    let embedded = 0;
    for (;;) {
      /* Sont repris les morceaux sans vecteur ET ceux vectorisés par un autre
         modèle : après un changement de fournisseur, les anciens vecteurs sont
         d'une autre dimension, donc incomparables. */
      const pending = this.store.rag.listChunksNeedingEmbedding(collectionId, model, 64);
      if (pending.length === 0) break;
      const vectors = await embed(
        pending.map((c) => c.content),
        'document',
      );
      if (!vectors) break;
      for (let i = 0; i < pending.length; i++) {
        this.store.rag.setChunkEmbedding(pending[i]!.id, vectors[i]!, model);
      }
      embedded += pending.length;
    }
    if (embedded > 0) {
      this.bus.log('info', 'rag', `${embedded} morceau(x) vectorisés`);
      this.afterMutation(collectionId);
    }
    return { embedded };
  }

  // --- Recherche ----------------------------------------------------------

  /**
   * Recherche hybride dans une collection.
   *
   * Fusion par rang réciproque : un passage bien classé par un seul moteur
   * remonte quand même, un passage trouvé par les deux remonte plus haut. C'est
   * le comportement attendu, le lexical et le sémantique se complètent au lieu
   * de se départager.
   */
  async search(collectionId: string, query: string, topK: number): Promise<RagSearchResult> {
    const started = Date.now();
    const collection = this.store.rag.getCollection(collectionId);
    if (!collection) throw new RagError('Collection introuvable.');
    const limit = clampInt(topK, 1, 20, 5);

    const ranks = new Map<string, { rrf: number; matchedBy: Set<'lexical' | 'semantic'> }>();
    const bump = (chunkId: string, position: number, engine: 'lexical' | 'semantic') => {
      const entry = ranks.get(chunkId) ?? { rrf: 0, matchedBy: new Set<'lexical' | 'semantic'>() };
      entry.rrf += 1 / (RRF_K + position + 1);
      entry.matchedBy.add(engine);
      ranks.set(chunkId, entry);
    };

    const ftsQuery = toFtsQuery(query);
    if (ftsQuery !== '') {
      const lexical = this.store.rag.searchLexical(collectionId, ftsQuery, CANDIDATES_PER_ENGINE);
      lexical.forEach((hit, index) => bump(hit.chunkId, index, 'lexical'));
    }

    let semanticUsed = false;
    const model = embeddingModel();
    if (model) {
      const queryVectors = await embed([query], 'query');
      const queryVector = queryVectors?.[0];
      if (queryVector) {
        /*
         * Classement borné : on parcourt les vecteurs par tranches et on ne
         * retient que les meilleurs candidats. L'insertion dans un tableau
         * trié de trente éléments coûte moins qu'une structure dédiée, et
         * l'empreinte mémoire ne dépend plus de la taille de la collection.
         */
        const best: Array<{ chunkId: string; score: number }> = [];
        const scanned = this.store.rag.forEachEmbeddedChunk(
          collectionId,
          model,
          EMBEDDING_SCAN_BATCH,
          (chunkId, vector) => {
            const score = cosine(queryVector, vector);
            if (best.length < CANDIDATES_PER_ENGINE) {
              best.push({ chunkId, score });
              best.sort((a, b) => b.score - a.score);
              return;
            }
            if (score <= best[best.length - 1]!.score) return;
            best[best.length - 1] = { chunkId, score };
            best.sort((a, b) => b.score - a.score);
          },
        );
        if (scanned > 0) {
          best.forEach((entry, index) => bump(entry.chunkId, index, 'semantic'));
          semanticUsed = true;
        }
      }
    }

    const ordered = [...ranks.entries()].sort((a, b) => b[1].rrf - a[1].rrf).slice(0, limit);
    const chunks = new Map(
      this.store.rag.getChunksByIds(ordered.map(([id]) => id)).map((c) => [c.id, c]),
    );

    const hits: RagHit[] = [];
    for (const [chunkId, entry] of ordered) {
      const chunk = chunks.get(chunkId);
      if (!chunk) continue;
      hits.push({
        documentId: chunk.documentId,
        documentTitle: chunk.documentTitle,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        score: Number(entry.rrf.toFixed(6)),
        matchedBy: [...entry.matchedBy],
      });
    }

    return { hits, semanticUsed, durationMs: Date.now() - started };
  }

  /** Collections effectivement interrogeables par un agent. */
  collectionsForAgent(ids: string[]): RagCollection[] {
    const out: RagCollection[] = [];
    for (const id of ids) {
      const collection = this.store.rag.getCollection(id);
      if (collection) out.push(collection);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

/**
 * Titre d'un fichier, relatif à la racine ingérée quand elle est connue.
 *
 * Le nom seul suffit pour un fichier isolé. Dans un arbre, c'est le chemin
 * relatif qui distingue `glossaire-metier/SKILL.md` de
 * `phpunit-conventions/SKILL.md` — et c'est ce titre que l'agent citera.
 */
function relativeTitle(path: string, root?: string): string {
  const name = path.split('/').pop() ?? path;
  if (!root) return name;
  const normalisedRoot = root.endsWith('/') ? root : `${root}/`;
  if (!path.startsWith(normalisedRoot)) return name;
  const relative = path.slice(normalisedRoot.length);
  return relative === '' ? name : relative;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  const n = Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function slugifyRag(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * Télécharge une page et en extrait le texte.
 *
 * Le retrait des balises est volontairement grossier : indexer du HTML brut
 * remplirait l'index de noms de classes CSS, et embarquer un analyseur complet
 * pour de la documentation publique serait disproportionné.
 */
async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), URL_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw new RagError(`HTTP ${response.status} sur ${url}`);
    const raw = await response.text();
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('html')) return raw;
    return raw
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } finally {
    clearTimeout(timer);
  }
}
