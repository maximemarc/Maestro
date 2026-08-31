/**
 * Accès à la base pour le RAG : collections, documents, morceaux, index.
 *
 * Sorti de `db.ts` en **sous-magasin** et non en façade déléguée. La différence
 * compte : une façade de 148 méthodes qui délèguent ajouterait de l'indirection
 * sans rien structurer pour l'appelant, alors qu'un `store.rag.listDocuments()`
 * dit d'où vient la donnée. Le prix est un changement d'API, payable ici parce
 * que trois fichiers seulement appelaient ces méthodes.
 *
 * Le domaine s'y prêtait : mesuré avant de couper, il ne dépendait que du
 * handle SQLite et d'un fragment de requête privé — aucun appel croisé avec les
 * 125 autres méthodes de `Store`.
 *
 * Les noms perdent leur préfixe « Rag », redondant derrière `store.rag.`.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { RagCollection, RagDocument } from '@maestro/shared';
import {
  num,
  rowToRagCollection,
  rowToRagDocument,
  rowToStoredChunk,
  str,
  strOrNull,
  toFloat32,
  type SqlRow,
  type StoredChunk,
} from './rows.ts';

export class RagStore {
  constructor(private db: DatabaseSync) {}

  /**
   * Les compteurs sont calculés en sous-requêtes plutôt que stockés : une
   * colonne dénormalisée finit toujours par mentir après une suppression en
   * cascade, et le coût est négligeable sur des dizaines de collections.
   */
  private readonly ragCollectionSelect = `
    SELECT c.*,
      (SELECT COUNT(*) FROM rag_documents d WHERE d.collection_id = c.id) AS document_count,
      (SELECT COUNT(*) FROM rag_chunks k WHERE k.collection_id = c.id) AS chunk_count,
      (SELECT COUNT(*) FROM rag_chunks k
        WHERE k.collection_id = c.id AND k.embedding IS NOT NULL) AS embedded_chunk_count
    FROM rag_collections c`;

  /**
   * Morceaux dont le vecteur vient d'un autre modèle que celui configuré.
   *
   * Comptés à part de ceux qui n'ont aucun vecteur : les deux appellent une
   * revectorisation, mais seul ce cas-ci ment à l'utilisateur en apparaissant
   * comme « déjà vectorisé ».
   */
  countStaleEmbeddings(collectionId: string, model: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM rag_chunks
         WHERE collection_id = ? AND embedding IS NOT NULL
           AND (embedding_model IS NULL OR embedding_model != ?)`,
      )
      .get(collectionId, model) as SqlRow | undefined;
    return row ? num(row.n) : 0;
  }

  listCollections(): RagCollection[] {
    return (this.db.prepare(`${this.ragCollectionSelect} ORDER BY c.name`).all() as SqlRow[]).map(
      rowToRagCollection,
    );
  }

  getCollection(id: string): RagCollection | null {
    const row = this.db.prepare(`${this.ragCollectionSelect} WHERE c.id = ?`).get(id) as
      SqlRow | undefined;
    return row ? rowToRagCollection(row) : null;
  }

  getCollectionBySlug(slug: string): RagCollection | null {
    const row = this.db.prepare(`${this.ragCollectionSelect} WHERE c.slug = ?`).get(slug) as
      SqlRow | undefined;
    return row ? rowToRagCollection(row) : null;
  }

  upsertCollection(c: RagCollection): void {
    this.db
      .prepare(
        `INSERT INTO rag_collections
           (id, slug, name, description, chunk_size, chunk_overlap, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           slug=excluded.slug, name=excluded.name, description=excluded.description,
           chunk_size=excluded.chunk_size, chunk_overlap=excluded.chunk_overlap,
           updated_at=excluded.updated_at`,
      )
      .run(
        c.id,
        c.slug,
        c.name,
        c.description,
        c.chunkSize,
        c.chunkOverlap,
        c.createdAt,
        c.updatedAt,
      );
  }

  deleteCollection(id: string): boolean {
    /* L'index plein texte n'a pas de clé étrangère : il faut le nettoyer avant
       que la cascade ne fasse disparaître les morceaux qui le référencent. */
    this.db
      .prepare(
        'DELETE FROM rag_fts WHERE chunk_id IN (SELECT id FROM rag_chunks WHERE collection_id = ?)',
      )
      .run(id);
    const res = this.db.prepare('DELETE FROM rag_collections WHERE id = ?').run(id);
    return num(res.changes) > 0;
  }

  // --- Documents ----------------------------------------------------------

  listDocuments(collectionId: string): RagDocument[] {
    const rows = this.db
      .prepare(
        `SELECT d.*,
           (SELECT COUNT(*) FROM rag_chunks k WHERE k.document_id = d.id) AS chunk_count
         FROM rag_documents d WHERE d.collection_id = ? ORDER BY d.created_at DESC`,
      )
      .all(collectionId) as SqlRow[];
    return rows.map(rowToRagDocument);
  }

  getDocument(id: string): RagDocument | null {
    const row = this.db
      .prepare(
        `SELECT d.*,
           (SELECT COUNT(*) FROM rag_chunks k WHERE k.document_id = d.id) AS chunk_count
         FROM rag_documents d WHERE d.id = ?`,
      )
      .get(id) as SqlRow | undefined;
    return row ? rowToRagDocument(row) : null;
  }

  /** Cherche un document par son origine, pour réingérer sans dupliquer. */
  findDocumentBySource(collectionId: string, source: string): RagDocument | null {
    if (source === '') return null;
    const row = this.db
      .prepare(
        `SELECT d.*, 0 AS chunk_count FROM rag_documents d
         WHERE d.collection_id = ? AND d.source = ?`,
      )
      .get(collectionId, source) as SqlRow | undefined;
    return row ? rowToRagDocument(row) : null;
  }

  /**
   * Enregistre un document et son contenu d'origine.
   *
   * Le contenu est conservé pour permettre la réindexation : redécouper sans
   * lui obligerait à retrouver la source, ce qui est impossible pour un texte
   * collé.
   */
  insertDocument(doc: RagDocument, content: string): void {
    this.db
      .prepare(
        `INSERT INTO rag_documents
           (id, collection_id, title, source_kind, source, ingest_root, bytes, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        doc.id,
        doc.collectionId,
        doc.title,
        doc.sourceKind,
        doc.source,
        doc.ingestRoot,
        doc.bytes,
        content,
        doc.createdAt,
      );
  }

  /** Documents d'une collection avec leur contenu, pour une réindexation. */
  listDocumentsWithContent(
    collectionId: string,
  ): Array<{ doc: RagDocument; content: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT d.*, 0 AS chunk_count FROM rag_documents d
         WHERE d.collection_id = ? ORDER BY d.created_at`,
      )
      .all(collectionId) as SqlRow[];
    return rows.map((r) => ({ doc: rowToRagDocument(r), content: strOrNull(r.content) }));
  }

  /** Racines d'ingestion relisibles d'une collection, pour un rafraîchissement. */
  listIngestRoots(
    collectionId: string,
  ): Array<{ sourceKind: RagDocument['sourceKind']; ingestRoot: string }> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT source_kind, ingest_root FROM rag_documents
         WHERE collection_id = ? AND ingest_root IS NOT NULL AND ingest_root != ''
           AND source_kind IN ('file', 'directory', 'url', 'workspace')`,
      )
      .all(collectionId) as SqlRow[];
    return rows.map((r) => ({
      sourceKind: str(r.source_kind) as RagDocument['sourceKind'],
      ingestRoot: str(r.ingest_root),
    }));
  }

  /** Documents issus d'une racine donnée, pour repérer ceux qui ont disparu. */
  listDocumentsByRoot(collectionId: string, ingestRoot: string): RagDocument[] {
    const rows = this.db
      .prepare(
        `SELECT d.*, 0 AS chunk_count FROM rag_documents d
         WHERE d.collection_id = ? AND d.ingest_root = ?`,
      )
      .all(collectionId, ingestRoot) as SqlRow[];
    return rows.map(rowToRagDocument);
  }

  /** Tous les morceaux d'une collection, bornés, pour construire le graphe. */
  listChunksOfCollection(collectionId: string, limit: number): StoredChunk[] {
    const rows = this.db
      .prepare(
        `SELECT k.*, d.title AS document_title FROM rag_chunks k
         JOIN rag_documents d ON d.id = k.document_id
         WHERE k.collection_id = ?
         ORDER BY d.created_at, k.chunk_index LIMIT ?`,
      )
      .all(collectionId, limit) as SqlRow[];
    return rows.map(rowToStoredChunk);
  }

  /** Morceaux d'un document, pour inspecter le découpage. */
  listChunksOfDocument(documentId: string): StoredChunk[] {
    const rows = this.db
      .prepare(
        `SELECT k.*, d.title AS document_title FROM rag_chunks k
         JOIN rag_documents d ON d.id = k.document_id
         WHERE k.document_id = ? ORDER BY k.chunk_index`,
      )
      .all(documentId) as SqlRow[];
    return rows.map(rowToStoredChunk);
  }

  /**
   * Retire les morceaux d'un document, index compris.
   *
   * Séparé de la suppression du document : une réindexation remplace la découpe
   * sans toucher au document ni à son contenu.
   */
  deleteChunksOfDocument(documentId: string): void {
    this.db
      .prepare(
        'DELETE FROM rag_fts WHERE chunk_id IN (SELECT id FROM rag_chunks WHERE document_id = ?)',
      )
      .run(documentId);
    this.db.prepare('DELETE FROM rag_chunks WHERE document_id = ?').run(documentId);
  }

  deleteDocument(id: string): boolean {
    this.db
      .prepare(
        'DELETE FROM rag_fts WHERE chunk_id IN (SELECT id FROM rag_chunks WHERE document_id = ?)',
      )
      .run(id);
    const res = this.db.prepare('DELETE FROM rag_documents WHERE id = ?').run(id);
    return num(res.changes) > 0;
  }

  // --- Morceaux et index --------------------------------------------------

  /**
   * Insère les morceaux d'un document et les indexe dans le même mouvement.
   *
   * Une transaction : un morceau présent dans rag_chunks mais absent de
   * rag_fts serait invisible à la recherche sans qu'aucun compteur ne le
   * signale.
   */
  insertChunks(
    chunks: Array<{
      id: string;
      collectionId: string;
      documentId: string;
      chunkIndex: number;
      content: string;
    }>,
    createdAt: string,
  ): void {
    const insChunk = this.db.prepare(
      `INSERT INTO rag_chunks (id, collection_id, document_id, chunk_index, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insFts = this.db.prepare('INSERT INTO rag_fts (content, chunk_id) VALUES (?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const c of chunks) {
        insChunk.run(c.id, c.collectionId, c.documentId, c.chunkIndex, c.content, createdAt);
        insFts.run(c.content, c.id);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  setChunkEmbedding(chunkId: string, vector: Float32Array, model: string): void {
    this.db
      .prepare('UPDATE rag_chunks SET embedding = ?, embedding_model = ? WHERE id = ?')
      .run(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength), model, chunkId);
  }

  /**
   * Morceaux à (re)vectoriser : sans vecteur, ou vecteur produit par un autre
   * modèle que celui configuré aujourd'hui.
   */
  listChunksNeedingEmbedding(collectionId: string, model: string, limit: number): StoredChunk[] {
    const rows = this.db
      .prepare(
        `SELECT k.*, d.title AS document_title FROM rag_chunks k
         JOIN rag_documents d ON d.id = k.document_id
         WHERE k.collection_id = ?
           AND (k.embedding IS NULL OR k.embedding_model IS NULL OR k.embedding_model != ?)
         ORDER BY k.created_at LIMIT ?`,
      )
      .all(collectionId, model, limit) as SqlRow[];
    return rows.map(rowToStoredChunk);
  }

  /**
   * Parcourt les vecteurs d'une collection par lots.
   *
   * Charger la collection entière coûtait quatre kilo-octets par morceau, soit
   * deux cents mégaoctets à cinquante mille morceaux, à chaque requête. En
   * lisant par tranches et en ne gardant qu'un classement borné, l'appelant
   * garde le même résultat exact pour une empreinte mémoire constante.
   *
   * Seuls l'identifiant et le vecteur sont lus : le texte du morceau est
   * récupéré à la fin, pour les seuls passages retenus.
   */
  forEachEmbeddedChunk(
    collectionId: string,
    model: string,
    batchSize: number,
    visit: (chunkId: string, vector: Float32Array) => void,
  ): number {
    let offset = 0;
    let seen = 0;
    for (;;) {
      const rows = this.db
        .prepare(
          `SELECT id, embedding FROM rag_chunks
           WHERE collection_id = ? AND embedding IS NOT NULL AND embedding_model = ?
           ORDER BY rowid LIMIT ? OFFSET ?`,
        )
        .all(collectionId, model, batchSize, offset) as SqlRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        const vector = toFloat32(row.embedding);
        if (vector) {
          visit(str(row.id), vector);
          seen++;
        }
      }
      offset += rows.length;
      if (rows.length < batchSize) break;
    }
    return seen;
  }

  getChunksByIds(ids: string[]): StoredChunk[] {
    if (ids.length === 0) return [];
    const holes = ids.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT k.*, d.title AS document_title FROM rag_chunks k
         JOIN rag_documents d ON d.id = k.document_id
         WHERE k.id IN (${holes})`,
      )
      .all(...ids) as SqlRow[];
    return rows.map(rowToStoredChunk);
  }

  /**
   * Recherche lexicale BM25 dans une collection.
   *
   * bm25() renvoie un score NÉGATIF, d'autant plus bas que le passage est
   * pertinent. On le retourne tel quel : c'est l'appelant qui fusionne, et
   * inverser ici masquerait la convention de SQLite.
   */
  searchLexical(
    collectionId: string,
    ftsQuery: string,
    limit: number,
  ): Array<{ chunkId: string; score: number }> {
    const rows = this.db
      .prepare(
        `SELECT f.chunk_id AS chunk_id, bm25(rag_fts) AS score
         FROM rag_fts f
         JOIN rag_chunks k ON k.id = f.chunk_id
         WHERE rag_fts MATCH ? AND k.collection_id = ?
         ORDER BY score LIMIT ?`,
      )
      .all(ftsQuery, collectionId, limit) as SqlRow[];
    return rows.map((r) => ({ chunkId: str(r.chunk_id), score: num(r.score) }));
  }
}
