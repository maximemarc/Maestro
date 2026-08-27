/**
 * Tests de la logique RAG indépendante de la base.
 *
 * La découpe et la préparation de requête sont les deux endroits où une erreur
 * ne provoque aucune exception : l'index se remplit, la recherche répond, et
 * les résultats sont simplement mauvais.
 */
import { describe, expect, it } from 'vitest';
import { chunkText, toFtsQuery } from './rag.ts';
import { cosine } from './rag-embeddings.ts';

describe('chunkText', () => {
  it('rend le texte entier quand il tient dans la fenêtre', () => {
    expect(chunkText('court', 100, 10)).toEqual(['court']);
  });

  it('rend une liste vide sur un texte vide', () => {
    expect(chunkText('   ', 100, 10)).toEqual([]);
  });

  it('couvre tout le texte, sans perte', () => {
    const text = Array.from({ length: 60 }, (_, i) => `phrase numero ${i}.`).join(' ');
    const chunks = chunkText(text, 200, 40);
    expect(chunks.length).toBeGreaterThan(1);
    /* Chaque phrase doit se retrouver dans au moins un morceau : un découpage
       qui perd du contenu rend une partie du corpus introuvable. */
    for (let i = 0; i < 60; i++) {
      expect(chunks.some((c) => c.includes(`phrase numero ${i}.`))).toBe(true);
    }
  });

  it('coupe de préférence sur une fin de phrase', () => {
    const text = `${'a'.repeat(180)}. ${'b'.repeat(180)}`;
    const chunks = chunkText(text, 200, 20);
    expect(chunks[0]!.endsWith('.')).toBe(true);
  });

  it('progresse même avec un recouvrement égal à la fenêtre', () => {
    /* Sans le garde-fou `step >= 1`, ce cas bouclerait indéfiniment. */
    const chunks = chunkText('x'.repeat(1000), 100, 100);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.length).toBeLessThan(200);
  });
});

describe('toFtsQuery', () => {
  it('retire les accents pour coller au tokenizer de l’index', () => {
    expect(toFtsQuery('Écritures comptables')).toBe('"ecritures" OR "comptables"');
  });

  it('neutralise la syntaxe FTS5 saisie par un agent', () => {
    /* Un astérisque ou une parenthèse non échappés font échouer la requête SQL,
       et l'agent n'a aucun moyen de le comprendre. */
    const out = toFtsQuery('liasse* AND (fiscale OR "gaec")');
    expect(out).not.toContain('*');
    expect(out).not.toContain('(');
    expect(out).toContain('"liasse"');
    expect(out).toContain('"fiscale"');
  });

  it('ignore les mots d’une seule lettre', () => {
    expect(toFtsQuery('a b liasse')).toBe('"liasse"');
  });

  it('rend une chaîne vide quand il ne reste rien d’indexable', () => {
    expect(toFtsQuery('!!! ?')).toBe('');
  });
});

describe('cosine', () => {
  it('vaut 1 pour deux vecteurs colinéaires', () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([2, 4, 6]);
    expect(cosine(a, b)).toBeCloseTo(1, 5);
  });

  it('vaut 0 pour deux vecteurs orthogonaux', () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 5);
  });

  it('rend 0 plutôt que NaN sur un vecteur nul', () => {
    expect(cosine(Float32Array.from([0, 0]), Float32Array.from([1, 1]))).toBe(0);
  });

  it('rend 0 sur des dimensions incompatibles, au lieu de comparer à moitié', () => {
    expect(cosine(Float32Array.from([1, 2]), Float32Array.from([1, 2, 3]))).toBe(0);
  });
});
