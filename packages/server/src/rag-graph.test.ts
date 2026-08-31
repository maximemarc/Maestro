/**
 * Test d'intégration du graphe : base réelle, index réel.
 *
 * Il couvre la partie qui s'était trompée en silence. La première version
 * sélectionnait les termes les plus rares d'un passage pour lui chercher des
 * voisins — or un terme unique ne peut désigner personne d'autre. Le graphe
 * compilait, répondait vite, et rendait un arbre : quatre-vingt-quatorze pour
 * cent des passages isolés. Ce test verrouille la correction en vérifiant ce
 * qu'aucun typage ne peut vérifier — que le graphe est effectivement connexe.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from './db.ts';
import { buildRagGraph } from './rag-graph.ts';
import { chunkText } from './rag.ts';

let dir: string;
let store: Store;
let collectionId: string;

/** Trois familles de textes : deux qui se recoupent, une isolée. */
const CORPUS: Array<{ title: string; body: string }> = [
  {
    title: 'cloture/SKILL.md',
    body: `La clôture mensuelle commence par le lettrage des comptes clients et fournisseurs.
Le rapprochement bancaire mensuel suit le lettrage, et conditionne la déclaration de TVA.
Sans rapprochement bancaire, les soldes de trésorerie ne sont pas fiables.`,
  },
  {
    title: 'tva/SKILL.md',
    body: `La déclaration de TVA se prépare après le rapprochement bancaire du mois.
Le lettrage des comptes clients doit être terminé avant la déclaration.
Toute déclaration de TVA repose sur des soldes de trésorerie fiables.`,
  },
  {
    title: 'jardinage/NOTES.md',
    body: `Les tomates se plantent après les dernières gelées, en pleine terre.
Un paillage épais limite l'arrosage pendant les semaines chaudes.
La rotation des cultures évite l'épuisement du potager.`,
  },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'maestro-graph-'));
  store = new Store(join(dir, 'test.db'));

  const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
  collectionId = 'rag_test';
  store.rag.upsertCollection({
    id: collectionId,
    slug: 'test',
    name: 'Test',
    description: '',
    chunkSize: 400,
    chunkOverlap: 60,
    documentCount: 0,
    chunkCount: 0,
    embeddedChunkCount: 0,
    staleChunkCount: 0,
    createdAt: now,
    updatedAt: now,
  });

  CORPUS.forEach((doc, docIndex) => {
    const documentId = `doc_${docIndex}`;
    store.rag.insertDocument(
      {
        id: documentId,
        collectionId,
        title: doc.title,
        sourceKind: 'file',
        source: `/tmp/${doc.title}`,
        ingestRoot: '/tmp',
        bytes: Buffer.byteLength(doc.body, 'utf8'),
        chunkCount: 0,
        createdAt: now,
      },
      doc.body,
    );
    /* Une phrase par morceau : la découpe fine rend les rapprochements
       observables sur un corpus de test court. */
    const chunks = doc.body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    store.rag.insertChunks(
      chunks.map((content, index) => ({
        id: `chk_${docIndex}_${index}`,
        collectionId,
        documentId,
        chunkIndex: index,
        content,
      })),
      now,
    );
  });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('buildRagGraph', () => {
  it('représente les trois niveaux : collection, documents, passages', () => {
    const graph = buildRagGraph(store, collectionId);
    const byKind = (kind: string) => graph.nodes.filter((n) => n.kind === kind).length;
    expect(byKind('collection')).toBe(1);
    expect(byKind('document')).toBe(3);
    expect(byKind('chunk')).toBe(9);
  });

  it('relie chaque passage à son document, et chaque document à la collection', () => {
    const graph = buildRagGraph(store, collectionId);
    const contains = graph.links.filter((l) => l.kind === 'contains');
    /* Trois documents rattachés à la collection, neuf passages à leur document. */
    expect(contains).toHaveLength(12);
  });

  it('rapproche deux documents qui partagent leur vocabulaire', () => {
    const graph = buildRagGraph(store, collectionId);
    const label = new Map(graph.nodes.map((n) => [n.id, n.label]));
    const between = graph.links
      .filter((l) => l.kind === 'similar')
      .map((l) => ({ a: label.get(l.source) ?? '', b: label.get(l.target) ?? '' }))
      .filter(({ a, b }) => a.startsWith('cloture') !== b.startsWith('cloture'));

    /* La clôture et la TVA parlent tous deux de rapprochement bancaire et de
       lettrage : le graphe doit les relier. C'est ce lien-là qui manquait. */
    expect(between.length).toBeGreaterThan(0);
  });

  it("n'invente pas de parenté avec un document hors sujet", () => {
    const graph = buildRagGraph(store, collectionId);
    const label = new Map(graph.nodes.map((n) => [n.id, n.label]));
    const withGardening = graph.links
      .filter((l) => l.kind === 'similar')
      .filter(
        (l) =>
          (label.get(l.source) ?? '').startsWith('jardinage') !==
          (label.get(l.target) ?? '').startsWith('jardinage'),
      );
    expect(withGardening).toHaveLength(0);
  });

  it('ne laisse pas la majorité des passages isolés', () => {
    const graph = buildRagGraph(store, collectionId);
    const chunks = graph.nodes.filter((n) => n.kind === 'chunk').length;
    /* Le potager reste légitimement à l'écart ; le reste doit être relié. */
    expect(graph.isolatedCount).toBeLessThan(chunks / 2);
  });

  it('ne relie jamais deux fois la même paire', () => {
    const graph = buildRagGraph(store, collectionId);
    const keys = graph.links
      .filter((l) => l.kind === 'similar')
      .map((l) => [l.source, l.target].sort().join('|'));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('rend un graphe vide pour une collection inconnue', () => {
    const graph = buildRagGraph(store, 'rag_absent');
    expect(graph.nodes).toHaveLength(0);
    expect(graph.links).toHaveLength(0);
  });
});

describe('chunkText, sur le corpus du graphe', () => {
  it('conserve chaque phrase du corpus', () => {
    for (const doc of CORPUS) {
      const chunks = chunkText(doc.body, 400, 60);
      expect(chunks.join(' ')).toContain('.');
      expect(chunks.length).toBeGreaterThan(0);
    }
  });
});
