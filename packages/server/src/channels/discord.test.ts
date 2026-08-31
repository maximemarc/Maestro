import { describe, expect, it } from 'vitest';
import { splitForDiscord } from './discord.ts';

describe('découpage pour Discord', () => {
  /*
   * La limite de 2 000 caractères est dure : au-delà, l'API refuse le message
   * entier. Un rapport d'agent la dépasse souvent, et l'échec est silencieux
   * côté canal — d'où ce découpage plutôt qu'une troncature.
   */
  it('laisse passer un texte court', () => {
    expect(splitForDiscord('bonjour')).toEqual(['bonjour']);
  });

  it('laisse passer un texte exactement à la limite', () => {
    const text = 'x'.repeat(2000);
    expect(splitForDiscord(text)).toEqual([text]);
  });

  it('découpe au-delà de la limite, chaque morceau étant acceptable', () => {
    const chunks = splitForDiscord('y'.repeat(5000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
  });

  it('ne perd aucun caractère hors sauts de ligne de coupe', () => {
    const text = 'z'.repeat(4500);
    expect(splitForDiscord(text).join('')).toBe(text);
  });

  /* Trancher au milieu d'un mot rend un rapport pénible à lire ; couper sur un
     saut de ligne préserve aussi les blocs de code. */
  it('préfère couper sur un saut de ligne', () => {
    const paragraph = `${'a'.repeat(1500)}\n${'b'.repeat(1500)}`;
    const chunks = splitForDiscord(paragraph);
    expect(chunks[0]).toBe('a'.repeat(1500));
    expect(chunks[1]).toBe('b'.repeat(1500));
  });

  it('coupe net quand aucun saut de ligne n’est exploitable', () => {
    /* Un saut trop tôt dans la fenêtre produirait des morceaux minuscules :
       on préfère alors la coupe franche. */
    const text = `a\n${'b'.repeat(3000)}`;
    const chunks = splitForDiscord(text);
    expect(chunks[0]?.length).toBe(2000);
  });

  it('termine sur un nombre fini de morceaux, même sur un texte très long', () => {
    const chunks = splitForDiscord('c'.repeat(50_000));
    expect(chunks.length).toBe(25);
  });

  it('respecte une limite personnalisée', () => {
    const chunks = splitForDiscord('d'.repeat(25), 10);
    expect(chunks).toEqual(['d'.repeat(10), 'd'.repeat(10), 'd'.repeat(5)]);
  });
});
