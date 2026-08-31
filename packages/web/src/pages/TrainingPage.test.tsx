/**
 * Saisies libres de la page Entraînement.
 *
 * Les variables et la distribution d'outils sont saisies en texte : c'est ce
 * qui rend le formulaire tenable — dix variables en dix lignes plutôt que dix
 * sous-formulaires. Mais une lecture trop permissive fabrique un lot muet, et
 * une lecture trop stricte rejette une saisie raisonnable. Ces deux fonctions
 * décident donc du contenu réel du jeu de données.
 */
import { describe, expect, it } from 'vitest';
import {
  formatToolWeights,
  formatVariables,
  parseToolWeights,
  parseVariables,
} from './TrainingPage';

describe('lecture des variables', () => {
  it('lit une variable et ses valeurs', () => {
    expect(parseVariables('sujet: le bilan, la TVA')).toEqual({
      sujet: ['le bilan', 'la TVA'],
    });
  });

  it('lit plusieurs lignes', () => {
    expect(parseVariables('a: 1, 2\nb: 3')).toEqual({ a: ['1', '2'], b: ['3'] });
  });

  it('rogne les espaces autour des valeurs', () => {
    expect(parseVariables('  sujet :   x ,  y  ')).toEqual({ sujet: ['x', 'y'] });
  });

  /* Une ligne sans deux-points n'est pas une variable : la retenir avec une clé
     vide fabriquerait un marqueur que rien ne substitue. */
  it('ignore une ligne sans séparateur', () => {
    expect(parseVariables('juste du texte')).toEqual({});
  });

  it('ignore une variable sans valeur', () => {
    expect(parseVariables('sujet:')).toEqual({});
    expect(parseVariables('sujet:   ,  ')).toEqual({});
  });

  it('ignore une clé vide', () => {
    expect(parseVariables(': valeur')).toEqual({});
  });

  it('conserve les deux-points d’une valeur', () => {
    expect(parseVariables('url: https://exemple.fr')).toEqual({
      url: ['https://exemple.fr'],
    });
  });

  /* Aller-retour : le formulaire réaffiche ce qu'il a enregistré, et une saisie
     qui ne se relit pas ferait perdre la configuration à la première édition. */
  it('fait l’aller-retour avec le formatage', () => {
    const variables = { sujet: ['le bilan', 'la TVA'], type: ['annuel'] };
    expect(parseVariables(formatVariables(variables))).toEqual(variables);
  });
});

describe('lecture des pondérations d’outils', () => {
  it('lit « outil: poids »', () => {
    expect(parseToolWeights('Read: 70\nWrite: 30')).toEqual([
      { tool: 'Read', weight: 70 },
      { tool: 'Write', weight: 30 },
    ]);
  });

  it('accepte l’espace ou le signe égal comme séparateur', () => {
    expect(parseToolWeights('Read 70')).toEqual([{ tool: 'Read', weight: 70 }]);
    expect(parseToolWeights('Read=70')).toEqual([{ tool: 'Read', weight: 70 }]);
  });

  it('accepte un poids décimal, virgule comprise', () => {
    expect(parseToolWeights('Read: 0,5')).toEqual([{ tool: 'Read', weight: 0.5 }]);
  });

  it('accepte un nom d’outil MCP complet', () => {
    expect(parseToolWeights('mcp__github__search: 10')).toEqual([
      { tool: 'mcp__github__search', weight: 10 },
    ]);
  });

  it('ignore une ligne mal formée plutôt que d’inventer un poids', () => {
    expect(parseToolWeights('Read')).toEqual([]);
    expect(parseToolWeights('Read: beaucoup')).toEqual([]);
    expect(parseToolWeights('')).toEqual([]);
  });

  it('fait l’aller-retour avec le formatage', () => {
    const weights = [
      { tool: 'Read', weight: 70 },
      { tool: 'Write', weight: 30 },
    ];
    expect(parseToolWeights(formatToolWeights(weights))).toEqual(weights);
  });
});
