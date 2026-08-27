/**
 * Tests de l'import de configurations MCP.
 *
 * Deux garanties : la prévisualisation ne laisse sortir aucune valeur sensible,
 * et le format est reconnu tel qu'il existe réellement dans les fichiers — avec
 * ou sans champ `type`, à la racine ou sous un projet.
 */
import { describe, expect, it } from 'vitest';
import { previewImport, readConfig, selectForImport } from './mcp-import.ts';
import { McpError } from './mcp-registry.ts';

const CONFIG = {
  mcpServers: {
    filesystem: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { API_TOKEN: 'jeton-tres-secret' },
    },
    distant: {
      type: 'http',
      url: 'https://api.exemple.fr/mcp',
      headers: { authorization: 'Bearer autre-secret' },
    },
    inutilisable: { env: { K: 'v' } },
  },
  projects: {
    '/un/projet': {
      mcpServers: { flux: { type: 'sse', url: 'https://sse.exemple.fr/mcp' } },
    },
  },
};

describe('previewImport', () => {
  it('déduit stdio ou http sans champ type explicite', () => {
    const found = previewImport(CONFIG, []);
    expect(found.find((c) => c.name === 'filesystem')?.transport).toBe('stdio');
    expect(found.find((c) => c.name === 'distant')?.transport).toBe('http');
  });

  it('fusionne les serveurs déclarés sous un projet', () => {
    expect(previewImport(CONFIG, []).map((c) => c.name)).toContain('flux');
  });

  it('signale une entrée inexploitable au lieu de la taire', () => {
    const entry = previewImport(CONFIG, []).find((c) => c.name === 'inutilisable');
    expect(entry?.importable).toBe(false);
    expect(entry?.summary).toContain('ignorée');
  });

  it('ne laisse fuir aucune valeur sensible, seulement leur nombre', () => {
    const found = previewImport(CONFIG, []);
    const serialised = JSON.stringify(found);
    expect(serialised).not.toContain('jeton-tres-secret');
    expect(serialised).not.toContain('autre-secret');
    expect(found.find((c) => c.name === 'filesystem')?.secretCount).toBe(1);
    expect(found.find((c) => c.name === 'distant')?.secretCount).toBe(1);
  });

  it('marque ce qui existe déjà, pour ne pas le réimporter par mégarde', () => {
    const existing = [{ slug: 'filesystem' }] as Parameters<typeof previewImport>[1];
    const found = previewImport(CONFIG, existing);
    expect(found.find((c) => c.name === 'filesystem')?.alreadyPresent).toBe(true);
    expect(found.find((c) => c.name === 'distant')?.alreadyPresent).toBe(false);
  });
});

describe('selectForImport', () => {
  it('ne retient que les noms demandés, avec leurs secrets', () => {
    const selected = selectForImport(CONFIG, ['distant']);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.url).toBe('https://api.exemple.fr/mcp');
    /* Ici les valeurs réelles sont nécessaires : c'est ce qui sera enregistré,
       côté serveur, sans passer par le client. */
    expect(selected[0]!.headers.authorization).toBe('Bearer autre-secret');
  });

  it('ignore un nom inconnu sans échouer', () => {
    expect(selectForImport(CONFIG, ['absent'])).toHaveLength(0);
  });
});

describe('readConfig', () => {
  it('refuse un contenu qui n’est pas du JSON', () => {
    expect(() => readConfig({ json: 'pas du json' })).toThrow(McpError);
  });

  it('refuse une source vide', () => {
    expect(() => readConfig({})).toThrow(McpError);
  });

  it('refuse un chemin illisible', () => {
    expect(() => readConfig({ path: '/chemin/qui/nexiste/pas.json' })).toThrow(McpError);
  });
});
