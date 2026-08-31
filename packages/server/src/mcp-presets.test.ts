import { describe, expect, it } from 'vitest';
import {
  findMcpPreset,
  mcpPresets,
  missingRequiredEnv,
  presetToServerInput,
} from './mcp-presets.ts';

describe('catalogue', () => {
  it('n’est pas vide et n’a pas de slug en double', () => {
    const slugs = mcpPresets().map((p) => p.slug);
    expect(slugs.length).toBeGreaterThan(5);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('décrit chaque preset de façon exploitable', () => {
    for (const preset of mcpPresets()) {
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
      expect(preset.grants.length).toBeGreaterThan(0);
      expect(preset.command.length).toBeGreaterThan(0);
      expect(preset.args.length).toBeGreaterThan(0);
      expect(preset.homepage.startsWith('https://')).toBe(true);
    }
  });

  /*
   * Sans `-y`, npx demande confirmation avant d'installer un paquet absent du
   * cache. Sur un serveur lancé en sous-processus, personne ne voit la question
   * et la session reste bloquée jusqu'au délai d'attente.
   */
  it('passe -y à chaque invocation npx', () => {
    for (const preset of mcpPresets()) {
      if (preset.command !== 'npx') continue;
      expect(preset.args[0]).toBe('-y');
    }
  });

  it('couvre le navigateur et la recherche web', () => {
    const categories = new Set(mcpPresets().map((p) => p.category));
    expect(categories.has('navigateur')).toBe(true);
    expect(categories.has('web')).toBe(true);
  });

  it('retrouve un preset par slug, et rien pour un inconnu', () => {
    expect(findMcpPreset('playwright')?.name).toBe('Playwright');
    expect(findMcpPreset('inexistant')).toBeNull();
  });
});

describe('traduction en déclaration de serveur', () => {
  it('produit une déclaration stdio complète', () => {
    const preset = findMcpPreset('playwright')!;
    const input = presetToServerInput(preset);
    expect(input.kind).toBe('external');
    expect(input.transport).toBe('stdio');
    expect(input.command).toBe('npx');
    expect(input.enabled).toBe(true);
    expect(input.url).toBeNull();
    expect(input.tools).toEqual([]);
  });

  /*
   * Recopier une carte libre ferait entrer dans la configuration du serveur des
   * secrets qui n'ont rien à y faire — et qu'on ne saurait plus expliquer six
   * mois plus tard en relisant la fiche.
   */
  it('ne retient que les variables déclarées par le preset', () => {
    const preset = findMcpPreset('brave-search')!;
    const input = presetToServerInput(preset, {
      env: { BRAVE_API_KEY: 'clé', AWS_SECRET_ACCESS_KEY: 'à ne pas recopier' },
    });
    expect(input.env).toEqual({ BRAVE_API_KEY: 'clé' });
  });

  it('écarte une variable vide', () => {
    const preset = findMcpPreset('brave-search')!;
    expect(presetToServerInput(preset, { env: { BRAVE_API_KEY: '   ' } }).env).toEqual({});
  });

  it('accepte des arguments qui remplacent ceux du preset', () => {
    const preset = findMcpPreset('filesystem')!;
    const input = presetToServerInput(preset, {
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/srv/data'],
    });
    expect(input.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '/srv/data']);
  });

  it('garde les arguments du preset si aucun n’est fourni', () => {
    const preset = findMcpPreset('memory')!;
    expect(presetToServerInput(preset, { args: [] }).args).toEqual(preset.args);
  });
});

describe('variables requises', () => {
  it('signale celles qui manquent', () => {
    const preset = findMcpPreset('browserbase')!;
    expect(missingRequiredEnv(preset, {})).toEqual([
      'BROWSERBASE_API_KEY',
      'BROWSERBASE_PROJECT_ID',
    ]);
  });

  it('ne signale rien quand tout est fourni', () => {
    const preset = findMcpPreset('browserbase')!;
    expect(
      missingRequiredEnv(preset, {
        BROWSERBASE_API_KEY: 'a',
        BROWSERBASE_PROJECT_ID: 'b',
      }),
    ).toEqual([]);
  });

  it('ne signale rien pour un preset sans variable', () => {
    expect(missingRequiredEnv(findMcpPreset('playwright')!, {})).toEqual([]);
  });
});
