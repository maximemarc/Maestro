import { describe, expect, it } from 'vitest';
import type { TrajectoryToolCall } from '@maestro/shared';
import {
  DEFAULT_DIALECT,
  TOOL_CALL_DIALECTS,
  isToolCallDialect,
  listDialects,
  parseToolCalls,
  renderToolCalls,
  renderToolResult,
  sampleFor,
} from './training-parsers.ts';

const SINGLE: TrajectoryToolCall[] = [
  { id: 'toolu_1', name: 'read_file', arguments: { path: 'src/a.ts', limit: 40 } },
];

const DOUBLE: TrajectoryToolCall[] = [
  { id: 'toolu_1', name: 'search', arguments: { query: 'écriture comptable', deep: true } },
  { id: 'toolu_2', name: 'write_file', arguments: { path: 'out.md', content: 'a\nb' } },
];

describe('registre des dialectes', () => {
  it('expose onze parseurs', () => {
    expect(TOOL_CALL_DIALECTS).toHaveLength(11);
    expect(new Set(TOOL_CALL_DIALECTS).size).toBe(11);
  });

  it('décrit chaque dialecte avec un exemple non vide', () => {
    for (const info of listDialects()) {
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.families.length).toBeGreaterThan(0);
      expect(info.sample.length).toBeGreaterThan(0);
    }
  });

  it('reconnaît les identifiants valides et rejette les autres', () => {
    expect(isToolCallDialect('hermes')).toBe(true);
    expect(isToolCallDialect('gpt2')).toBe(false);
    expect(isToolCallDialect('__proto__')).toBe(false);
  });
});

describe('aller-retour rendu → lecture', () => {
  /*
   * Le seul garde-fou possible contre une faute de frappe dans un marqueur :
   * un dialecte dont le rendu ne se relit pas est un dialecte cassé, et une
   * relecture silencieusement vide produirait un jeu de données sans appel
   * d'outil sans que rien ne le signale.
   */
  for (const dialect of TOOL_CALL_DIALECTS) {
    it(`${dialect} : un appel unique survit à l'aller-retour`, () => {
      const parsed = parseToolCalls(dialect, renderToolCalls(dialect, SINGLE));
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.name).toBe('read_file');
      expect(parsed[0]?.arguments).toEqual({ path: 'src/a.ts', limit: 40 });
    });

    it(`${dialect} : deux appels parallèles survivent dans l'ordre`, () => {
      const parsed = parseToolCalls(dialect, renderToolCalls(dialect, DOUBLE));
      expect(parsed.map((c) => c.name)).toEqual(['search', 'write_file']);
      expect(parsed[0]?.arguments).toEqual({ query: 'écriture comptable', deep: true });
      expect(parsed[1]?.arguments).toEqual({ path: 'out.md', content: 'a\nb' });
    });

    it(`${dialect} : ne trouve rien dans un texte ordinaire`, () => {
      expect(parseToolCalls(dialect, 'Bonjour, voici ma réponse en clair.')).toEqual([]);
    });

    it(`${dialect} : rend un retour d'outil non vide`, () => {
      expect(renderToolResult(dialect, 'read_file', 'contenu', false)).toContain('contenu');
      expect(renderToolResult(dialect, 'read_file', 'introuvable', true).length).toBeGreaterThan(0);
    });
  }

  it('ne rend rien quand il n’y a aucun appel', () => {
    for (const dialect of TOOL_CALL_DIALECTS) {
      expect(renderToolCalls(dialect, [])).toBe('');
    }
  });
});

describe('marqueurs propres à chaque famille', () => {
  it('Hermes encadre le JSON dans <tool_call>', () => {
    const out = renderToolCalls('hermes', SINGLE);
    expect(out.startsWith('<tool_call>')).toBe(true);
    expect(out.endsWith('</tool_call>')).toBe(true);
  });

  it('Mistral préfixe un tableau par [TOOL_CALLS]', () => {
    expect(renderToolCalls('mistral', SINGLE)).toMatch(/^\[TOOL_CALLS] \[/);
  });

  it('Llama 3 emploie la clé parameters, non arguments', () => {
    const out = renderToolCalls('llama3_json', SINGLE);
    expect(out).toContain('"parameters"');
    expect(out).not.toContain('"arguments"');
  });

  it('la balise python de Llama ferme sur <|eom_id|>', () => {
    const out = renderToolCalls('llama3_python_tag', SINGLE);
    expect(out.startsWith('<|python_tag|>')).toBe(true);
    expect(out.endsWith('<|eom_id|>')).toBe(true);
  });

  it('DeepSeek emploie les pipes pleine largeur du gabarit amont', () => {
    const out = renderToolCalls('deepseek', SINGLE);
    expect(out).toContain('｜');
    expect(out).toContain('▁');
    expect(out).not.toContain('<|tool_calls_begin|>');
  });

  it('Command R rend une action en bloc JSON avec tool_name', () => {
    const out = renderToolCalls('command_r', SINGLE);
    expect(out.startsWith('Action: ```json')).toBe(true);
    expect(out).toContain('"tool_name"');
  });

  it('Granite ouvre sur <|tool_call|>', () => {
    expect(renderToolCalls('granite', SINGLE).startsWith('<|tool_call|>')).toBe(true);
  });

  it('Functionary préfixe le nom par >>>', () => {
    expect(renderToolCalls('functionary', SINGLE).startsWith('>>>read_file\n')).toBe(true);
  });

  it('OpenAI rend des tool_calls dont les arguments sont une chaîne JSON', () => {
    const parsed = JSON.parse(renderToolCalls('openai', SINGLE)) as Array<{
      id: string;
      function: { name: string; arguments: string };
    }>;
    expect(parsed[0]?.id).toBe('toolu_1');
    expect(typeof parsed[0]?.function.arguments).toBe('string');
    expect(JSON.parse(parsed[0]?.function.arguments ?? '{}')).toEqual({
      path: 'src/a.ts',
      limit: 40,
    });
  });

  it('json_lines écrit un objet par ligne', () => {
    expect(renderToolCalls('json_lines', DOUBLE).split('\n')).toHaveLength(2);
  });

  it('le dialecte par défaut est Hermes', () => {
    expect(DEFAULT_DIALECT).toBe('hermes');
    expect(sampleFor('hermes')).toContain('read_file');
  });
});

describe('dialecte pythonic', () => {
  it('rend des arguments nommés en littéraux Python', () => {
    const out = renderToolCalls('pythonic', [
      { id: 'c1', name: 'f', arguments: { flag: true, none: null, list: [1, 'deux'] } },
    ]);
    expect(out).toBe('[f(flag=True, none=None, list=[1, "deux"])]');
  });

  it('relit les littéraux Python en valeurs JSON', () => {
    const parsed = parseToolCalls('pythonic', '[f(flag=True, none=None, n=1.5)]');
    expect(parsed[0]?.arguments).toEqual({ flag: true, none: null, n: 1.5 });
  });

  it('ne se laisse pas troubler par une virgule dans une chaîne', () => {
    const parsed = parseToolCalls('pythonic', '[send(text="bonjour, monde", to="a@b.c")]');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.arguments).toEqual({ text: 'bonjour, monde', to: 'a@b.c' });
  });

  it('conserve les littéraux Python apparaissant dans une chaîne', () => {
    const parsed = parseToolCalls('pythonic', '[log(msg="True story, None left")]');
    expect(parsed[0]?.arguments).toEqual({ msg: 'True story, None left' });
  });
});

describe('robustesse de la lecture', () => {
  it('lit un objet contenant une accolade dans une chaîne', () => {
    const parsed = parseToolCalls(
      'hermes',
      '<tool_call>{"name":"f","arguments":{"s":"}"}}</tool_call>',
    );
    expect(parsed[0]?.arguments).toEqual({ s: '}' });
  });

  it('lit des arguments imbriqués', () => {
    const nested = { filter: { and: [{ eq: 1 }] } };
    const parsed = parseToolCalls(
      'hermes',
      renderToolCalls('hermes', [{ id: 'c1', name: 'query', arguments: nested }]),
    );
    expect(parsed[0]?.arguments).toEqual(nested);
  });

  it('ignore un bloc au JSON invalide sans lever', () => {
    expect(parseToolCalls('hermes', '<tool_call>{ceci n’est pas du JSON}</tool_call>')).toEqual([]);
  });

  it('accepte en lecture la clé arguments là où le rendu emploie parameters', () => {
    const parsed = parseToolCalls('llama3_json', '{"name":"f","arguments":{"a":1}}');
    expect(parsed[0]?.arguments).toEqual({ a: 1 });
  });
});
