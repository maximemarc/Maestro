/**
 * Tests du registre MCP.
 *
 * Deux garanties comptent plus que les autres : l'origine d'une URL ne peut pas
 * être choisie par l'agent, et un secret déjà enregistré ne peut pas être
 * effacé par un aller-retour dans l'interface. Les deux se cassent en silence.
 */
import { describe, expect, it } from 'vitest';
import {
  assertLiteralOrigin,
  interpolate,
  pluck,
  redact,
  SECRET_MASK,
  slugify,
  validateTool,
  McpError,
} from './mcp-registry.ts';
import type { McpServerDef, McpToolDef } from '@maestro/shared';

function httpTool(overrides: Partial<McpToolDef> = {}): McpToolDef {
  return {
    name: 'appel',
    description: 'Appelle un service interne.',
    params: [],
    action: {
      kind: 'http',
      method: 'GET',
      urlTemplate: 'https://api.exemple.fr/v1/clients',
      headers: {},
      bodyTemplate: '',
      responsePath: '',
      timeoutMs: 15000,
    },
    requiresApproval: false,
    ...overrides,
  };
}

describe('origine littérale des URL', () => {
  it('accepte un paramètre dans le chemin et la requête', () => {
    expect(() =>
      assertLiteralOrigin('https://api.exemple.fr/v1/clients/{{siret}}?mode={{mode}}'),
    ).not.toThrow();
  });

  it("refuse un hôte paramétrable, qui laisserait l'agent choisir sa cible", () => {
    expect(() => assertLiteralOrigin('http://{{hote}}/data')).toThrow(McpError);
    expect(() => assertLiteralOrigin('https://{{sous}}.exemple.fr/data')).toThrow(McpError);
  });

  it('refuse un port paramétrable', () => {
    expect(() => assertLiteralOrigin('http://interne:{{port}}/data')).toThrow(McpError);
  });

  it('refuse un schéma autre que http ou https', () => {
    expect(() => assertLiteralOrigin('file:///etc/passwd')).toThrow(McpError);
    expect(() => assertLiteralOrigin('ftp://exemple.fr/x')).toThrow(McpError);
  });
});

describe('validation des outils', () => {
  it('exige une description : sans elle, le modèle ne sait pas quand appeler', () => {
    expect(() => validateTool(httpTool({ description: '  ' }))).toThrow(McpError);
  });

  it('refuse un nom qui casserait le nommage mcp__serveur__outil', () => {
    expect(() => validateTool(httpTool({ name: 'Mon-Outil' }))).toThrow(McpError);
    expect(() => validateTool(httpTool({ name: 'mon_outil_2' }))).not.toThrow();
  });

  it('refuse deux paramètres de même nom', () => {
    const tool = httpTool({
      params: [
        { name: 'x', type: 'string', description: '', required: true, enumValues: [] },
        { name: 'x', type: 'number', description: '', required: false, enumValues: [] },
      ],
    });
    expect(() => validateTool(tool)).toThrow(McpError);
  });

  it("refuse une énumération sur un paramètre qui n'est pas du texte", () => {
    const tool = httpTool({
      params: [{ name: 'n', type: 'number', description: '', required: true, enumValues: ['1'] }],
    });
    expect(() => validateTool(tool)).toThrow(McpError);
  });

  it('refuse un délai hors bornes', () => {
    const tool = httpTool();
    if (tool.action.kind !== 'http') throw new Error('action inattendue');
    tool.action.timeoutMs = 500;
    expect(() => validateTool(tool)).toThrow(McpError);
  });
});

describe('interpolation', () => {
  it('encode les valeurs destinées à une URL', () => {
    const out = interpolate('https://x.fr/q?s={{v}}', { v: 'a&b=c' }, true);
    expect(out).toBe('https://x.fr/q?s=a%26b%3Dc');
  });

  it("n'encode pas un corps de requête", () => {
    expect(interpolate('{"a":"{{v}}"}', { v: 'é&' }, false)).toBe('{"a":"é&"}');
  });

  it('laisse visible un paramètre inconnu plutôt que de produire une URL fausse', () => {
    expect(interpolate('https://x.fr/{{absent}}', {}, true)).toBe('https://x.fr/{{absent}}');
  });
});

describe('extraction dans la réponse', () => {
  it('suit un chemin pointé', () => {
    expect(pluck({ data: { items: [1, 2] } }, 'data.items')).toEqual([1, 2]);
  });

  it('rend la réponse entière si le chemin est vide', () => {
    expect(pluck({ a: 1 }, '')).toEqual({ a: 1 });
  });

  it('rend undefined sur un chemin absent, pour que l’appelant le signale', () => {
    expect(pluck({ a: 1 }, 'b.c')).toBeUndefined();
  });
});

describe('masquage des secrets', () => {
  const def: McpServerDef = {
    id: 'mcp_1',
    slug: 'interne',
    name: 'Interne',
    description: '',
    kind: 'external',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: [],
    env: { API_TOKEN: 'valeur-tres-secrete' },
    url: null,
    headers: { authorization: 'Bearer abc' },
    tools: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('ne laisse sortir aucune valeur sensible', () => {
    const view = redact(def);
    expect(view.env.API_TOKEN).toBe(SECRET_MASK);
    expect(view.headers.authorization).toBe(SECRET_MASK);
    expect(JSON.stringify(view)).not.toContain('valeur-tres-secrete');
    expect(JSON.stringify(view)).not.toContain('Bearer abc');
  });

  it('conserve les clés, pour que l’interface sache quoi afficher', () => {
    expect(Object.keys(redact(def).env)).toEqual(['API_TOKEN']);
  });

  it('masque aussi les en-têtes des outils maison', () => {
    const custom: McpServerDef = {
      ...def,
      kind: 'custom',
      tools: [
        httpTool({
          action: {
            kind: 'http',
            method: 'GET',
            urlTemplate: 'https://x.fr',
            headers: { authorization: 'Bearer zzz' },
            bodyTemplate: '',
            responsePath: '',
            timeoutMs: 15000,
          },
        }),
      ],
    };
    expect(JSON.stringify(redact(custom))).not.toContain('Bearer zzz');
  });
});

describe('slugify', () => {
  it('retire les accents et normalise les séparateurs', () => {
    expect(slugify('Procédures Comptables 2026')).toBe('procedures-comptables-2026');
  });

  it('ne laisse pas de tiret aux extrémités', () => {
    expect(slugify('  -- Écritures --  ')).toBe('ecritures');
  });
});
