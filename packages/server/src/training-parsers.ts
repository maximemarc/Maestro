/**
 * Parseurs d'appels d'outils — une convention par famille de modèles.
 *
 * Deux modèles entraînés à appeler des outils ne les écrivent pas de la même
 * façon : Hermes encadre un JSON dans `<tool_call>`, Mistral préfixe un tableau
 * par `[TOOL_CALLS]`, Llama 3 émet le JSON nu, DeepSeek intercale des
 * séparateurs à pipes pleine largeur. Exporter une trajectoire dans la mauvaise
 * convention produit un jeu de données que le modèle cible ne sait pas lire :
 * il apprendrait une syntaxe qu'il n'émettra jamais à l'inférence.
 *
 * D'où ce registre. Chaque dialecte sait rendre un appel (`render`) et le
 * relire (`parse`) — le couple est vérifié par un aller-retour dans les tests,
 * ce qui est le seul garde-fou possible contre une faute de frappe dans un
 * marqueur.
 *
 * ⚠ Ces marqueurs suivent le gabarit de conversation publié par chaque famille
 * au moment de l'écriture. Un gabarit amont peut changer d'une version de
 * modèle à l'autre : avant un entraînement à enjeu, comparer le rendu de
 * `sampleFor()` au gabarit du modèle visé.
 */
import type { ToolCallDialect, ToolCallDialectInfo, TrajectoryToolCall } from '@maestro/shared';

/** Appel tel qu'un parseur le relit : sans identifiant, absent du texte rendu. */
export interface ParsedToolCall {
  name: string;
  arguments: unknown;
}

interface Dialect {
  label: string;
  families: string;
  /** Rend la totalité des appels d'un tour assistant. */
  render: (calls: TrajectoryToolCall[]) => string;
  /** Relit les appels contenus dans un texte. Tableau vide si aucun. */
  parse: (text: string) => ParsedToolCall[];
  /** Rend le retour d'un outil, tel que le tour suivant l'attend. */
  renderResult: (name: string, content: string, isError: boolean) => string;
}

// -- Utilitaires communs -----------------------------------------------------

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

/** Objet d'arguments, quoi qu'ait produit le modèle en amont. */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Extrait les objets JSON de premier niveau d'un texte.
 *
 * Une expression régulière ne suffit pas : `{"a": {"b": 1}}` contient des
 * accolades imbriquées, et `{"a": "}"}` en contient dans une chaîne. On compte
 * donc les accolades en ignorant celles qui sont entre guillemets.
 */
function extractJsonObjects(text: string): string[] {
  const found: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        found.push(text.slice(start, i + 1));
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return found;
}

/**
 * Relit une suite d'objets JSON en appels, quelle que soit la clé d'arguments.
 *
 * Les familles ne s'accordent pas : `arguments` chez Hermes et Mistral,
 * `parameters` chez Llama et Cohere, et le nom de l'outil s'appelle parfois
 * `tool_name`. Tout accepter en lecture coûte trois lignes et évite un parseur
 * par variante.
 */
function readCallObjects(chunks: string[]): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (const chunk of chunks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      continue;
    }
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      const rec = asRecord(entry);
      const name = rec.name ?? rec.tool_name ?? rec.function;
      if (typeof name !== 'string' || !name) continue;
      calls.push({ name, arguments: rec.arguments ?? rec.parameters ?? rec.args ?? {} });
    }
  }
  return calls;
}

/** Retire les clôtures de bloc de code autour d'un JSON. */
function stripFences(text: string): string {
  return text.replaceAll(/```(?:json)?/g, '');
}

// -- Rendu et lecture « pythonic » -------------------------------------------

/** Rend une valeur JSON dans la syntaxe littérale de Python. */
function pyLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pyLiteral).join(', ')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${JSON.stringify(k)}: ${pyLiteral(v)}`)
    .join(', ')}}`;
}

/**
 * Relit un littéral Python en valeur JSON.
 *
 * Passer par `JSON.parse` après substitution des trois littéraux propres à
 * Python évite d'écrire un analyseur d'expressions. La substitution ignore ce
 * qui est entre guillemets, sans quoi la chaîne « True story » deviendrait du
 * JSON invalide.
 */
function fromPyLiteral(raw: string): unknown {
  const src = raw.trim();
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"' || ch === "'") inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      out += '"';
      continue;
    }
    if (src.startsWith('True', i)) {
      out += 'true';
      i += 3;
      continue;
    }
    if (src.startsWith('False', i)) {
      out += 'false';
      i += 4;
      continue;
    }
    if (src.startsWith('None', i)) {
      out += 'null';
      i += 3;
      continue;
    }
    out += ch;
  }
  try {
    return JSON.parse(out);
  } catch {
    return raw.trim();
  }
}

/** Découpe une liste d'arguments sur les virgules de premier niveau. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | null = null;
  let escaped = false;

  for (const ch of text) {
    if (quote) {
      current += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function renderPythonicCall(call: TrajectoryToolCall): string {
  const args = Object.entries(asRecord(call.arguments))
    .map(([k, v]) => `${k}=${pyLiteral(v)}`)
    .join(', ');
  return `${call.name}(${args})`;
}

function parsePythonicCalls(text: string): ParsedToolCall[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  const body = start >= 0 && end > start ? text.slice(start + 1, end) : text;

  const calls: ParsedToolCall[] = [];
  for (const rawCall of splitTopLevel(body, ',')) {
    const match = /^\s*([A-Za-z_][\w.]*)\s*\((.*)\)\s*$/s.exec(rawCall);
    if (!match) continue;
    const [, name, argsText] = match;
    if (!name) continue;
    const args: Record<string, unknown> = {};
    for (const pair of splitTopLevel(argsText ?? '', ',')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const key = pair.slice(0, eq).trim();
      if (!/^[A-Za-z_]\w*$/.test(key)) continue;
      args[key] = fromPyLiteral(pair.slice(eq + 1));
    }
    calls.push({ name, arguments: args });
  }
  return calls;
}

// -- Marqueurs DeepSeek ------------------------------------------------------

/*
 * Pipes pleine largeur (U+FF5C) et tiret bas culbuté (U+2581) : ce sont les
 * caractères réellement présents dans le gabarit DeepSeek, et non de simples
 * `|` et `_`. Les nommer en constantes évite qu'un éditeur ou un copier-coller
 * ne les normalise en silence.
 */
const DS_PIPE = '｜';
const DS_LOW = '▁';
const DS_CALLS_BEGIN = `<${DS_PIPE}tool${DS_LOW}calls${DS_LOW}begin${DS_PIPE}>`;
const DS_CALLS_END = `<${DS_PIPE}tool${DS_LOW}calls${DS_LOW}end${DS_PIPE}>`;
const DS_CALL_BEGIN = `<${DS_PIPE}tool${DS_LOW}call${DS_LOW}begin${DS_PIPE}>`;
const DS_CALL_END = `<${DS_PIPE}tool${DS_LOW}call${DS_LOW}end${DS_PIPE}>`;
const DS_SEP = `<${DS_PIPE}tool${DS_LOW}sep${DS_PIPE}>`;
const DS_OUTPUT_BEGIN = `<${DS_PIPE}tool${DS_LOW}output${DS_LOW}begin${DS_PIPE}>`;
const DS_OUTPUT_END = `<${DS_PIPE}tool${DS_LOW}output${DS_LOW}end${DS_PIPE}>`;

// -- Registre ----------------------------------------------------------------

const DIALECTS: Record<ToolCallDialect, Dialect> = {
  /** NousResearch Hermes 2/3, Qwen 2.5+, et la plupart des ajustements ChatML. */
  hermes: {
    label: 'Hermes / ChatML',
    families: 'Hermes 2-3, Qwen 2.5+, OpenHermes',
    render: (calls) =>
      calls
        .map(
          (c) =>
            `<tool_call>\n${json({ name: c.name, arguments: asRecord(c.arguments) })}\n</tool_call>`,
        )
        .join('\n'),
    parse: (text) => {
      const blocks = [...text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)].map(
        (m) => m[1] ?? '',
      );
      return readCallObjects(blocks.flatMap((b) => extractJsonObjects(b)));
    },
    renderResult: (_name, content, isError) =>
      `<tool_response>\n${isError ? `Erreur : ${content}` : content}\n</tool_response>`,
  },

  /**
   * Appels natifs de l'API OpenAI.
   *
   * Le seul dialecte sans marqueur textuel : les appels vivent dans un champ
   * structuré, pas dans le contenu. Le rendu sert donc au diagnostic et à
   * l'aller-retour, l'export `openai` écrivant les objets tels quels.
   */
  openai: {
    label: 'OpenAI (tool_calls natifs)',
    families: 'GPT-4o/4.1, endpoints compatibles OpenAI',
    render: (calls) =>
      json(
        calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: json(asRecord(c.arguments)) },
        })),
      ),
    parse: (text) => {
      const calls: ParsedToolCall[] = [];
      for (const chunk of extractJsonObjects(text)) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(chunk);
        } catch {
          continue;
        }
        const rec = asRecord(parsed);
        const fn = asRecord(rec.function);
        const name = fn.name ?? rec.name;
        if (typeof name !== 'string' || !name) continue;
        const rawArgs = fn.arguments ?? rec.arguments;
        let args: unknown = {};
        if (typeof rawArgs === 'string') {
          try {
            args = JSON.parse(rawArgs);
          } catch {
            args = {};
          }
        } else if (rawArgs) {
          args = rawArgs;
        }
        calls.push({ name, arguments: args });
      }
      return calls;
    },
    renderResult: (_name, content, isError) => (isError ? `Erreur : ${content}` : content),
  },

  mistral: {
    label: 'Mistral',
    families: 'Mistral Large/Small, Mixtral, Devstral',
    render: (calls) =>
      `[TOOL_CALLS] ${json(calls.map((c) => ({ name: c.name, arguments: asRecord(c.arguments) })))}`,
    parse: (text) => {
      const idx = text.indexOf('[TOOL_CALLS]');
      const body = idx >= 0 ? text.slice(idx + '[TOOL_CALLS]'.length) : text;
      return readCallObjects(extractJsonObjects(body));
    },
    renderResult: (_name, content, isError) =>
      `[TOOL_RESULTS] ${json({ content: isError ? `Erreur : ${content}` : content })}`,
  },

  /** Llama 3.1+ : JSON nu, clé `parameters`, appels parallèles séparés par « ; ». */
  llama3_json: {
    label: 'Llama 3 (JSON)',
    families: 'Llama 3.1, 3.3, dérivés',
    render: (calls) =>
      calls.map((c) => json({ name: c.name, parameters: asRecord(c.arguments) })).join('; '),
    parse: (text) => readCallObjects(extractJsonObjects(text)),
    renderResult: (_name, content, isError) => (isError ? `Erreur : ${content}` : content),
  },

  /**
   * Variante à balise Python de Llama 3.
   *
   * `<|python_tag|>` ouvre un appel d'outil intégré, `<|eom_id|>` le clôt en
   * signalant que le tour n'est pas fini — le modèle attend un retour d'outil,
   * là où `<|eot_id|>` mettrait fin à son tour.
   */
  llama3_python_tag: {
    label: 'Llama 3 (balise python)',
    families: 'Llama 3.1/3.2, outils intégrés',
    render: (calls) =>
      calls
        .map(
          (c) =>
            `<|python_tag|>${json({ name: c.name, parameters: asRecord(c.arguments) })}<|eom_id|>`,
        )
        .join(''),
    parse: (text) =>
      readCallObjects(
        extractJsonObjects(text.replaceAll('<|python_tag|>', '').replaceAll('<|eom_id|>', '')),
      ),
    renderResult: (_name, content, isError) =>
      `<|start_header_id|>ipython<|end_header_id|>\n\n${isError ? `Erreur : ${content}` : content}`,
  },

  /** Appels rendus comme des appels de fonction Python (ToolACE, Llama 3.2). */
  pythonic: {
    label: 'Pythonic',
    families: 'Llama 3.2, ToolACE, xLAM',
    render: (calls) => `[${calls.map(renderPythonicCall).join(', ')}]`,
    parse: parsePythonicCalls,
    renderResult: (_name, content, isError) => (isError ? `Erreur : ${content}` : content),
  },

  deepseek: {
    label: 'DeepSeek V3/R1',
    families: 'DeepSeek V3, R1',
    render: (calls) =>
      DS_CALLS_BEGIN +
      calls
        .map(
          (c) =>
            `${DS_CALL_BEGIN}function${DS_SEP}${c.name}\n\`\`\`json\n${json(asRecord(c.arguments))}\n\`\`\`${DS_CALL_END}`,
        )
        .join('') +
      DS_CALLS_END,
    parse: (text) => {
      const calls: ParsedToolCall[] = [];
      const pattern = new RegExp(`${DS_CALL_BEGIN}([\\s\\S]*?)${DS_CALL_END}`, 'g');
      for (const match of text.matchAll(pattern)) {
        const block = match[1] ?? '';
        const sep = block.indexOf(DS_SEP);
        if (sep < 0) continue;
        const rest = block.slice(sep + DS_SEP.length);
        const newline = rest.indexOf('\n');
        const name = (newline < 0 ? rest : rest.slice(0, newline)).trim();
        if (!name) continue;
        const [argsChunk] = extractJsonObjects(stripFences(newline < 0 ? '' : rest.slice(newline)));
        let args: unknown = {};
        if (argsChunk) {
          try {
            args = JSON.parse(argsChunk);
          } catch {
            args = {};
          }
        }
        calls.push({ name, arguments: args });
      }
      return calls;
    },
    renderResult: (_name, content, isError) =>
      `${DS_OUTPUT_BEGIN}${isError ? `Erreur : ${content}` : content}${DS_OUTPUT_END}`,
  },

  command_r: {
    label: 'Cohere Command R',
    families: 'Command R, R+',
    render: (calls) =>
      'Action: ```json\n' +
      json(calls.map((c) => ({ tool_name: c.name, parameters: asRecord(c.arguments) }))) +
      '\n```',
    parse: (text) => {
      const idx = text.indexOf('Action:');
      const body = idx >= 0 ? text.slice(idx + 'Action:'.length) : text;
      return readCallObjects(extractJsonObjects(stripFences(body)));
    },
    renderResult: (name, content, isError) =>
      `<results>\n${name}: ${isError ? `Erreur : ${content}` : content}\n</results>`,
  },

  granite: {
    label: 'IBM Granite',
    families: 'Granite 3.x',
    render: (calls) =>
      `<|tool_call|>${json(calls.map((c) => ({ name: c.name, arguments: asRecord(c.arguments) })))}`,
    parse: (text) => {
      const idx = text.indexOf('<|tool_call|>');
      const body = idx >= 0 ? text.slice(idx + '<|tool_call|>'.length) : text;
      return readCallObjects(extractJsonObjects(body));
    },
    renderResult: (_name, content, isError) => (isError ? `Erreur : ${content}` : content),
  },

  /** Functionary v3 : le nom précédé de « >>> », puis les arguments en JSON. */
  functionary: {
    label: 'Functionary v3',
    families: 'Functionary v3.x, dérivés Llama',
    render: (calls) => calls.map((c) => `>>>${c.name}\n${json(asRecord(c.arguments))}`).join('\n'),
    parse: (text) => {
      const calls: ParsedToolCall[] = [];
      for (const match of text.matchAll(/>>>\s*([A-Za-z_][\w.-]*)\s*\n([\s\S]*?)(?=\n>>>|$)/g)) {
        const name = match[1];
        if (!name) continue;
        const [chunk] = extractJsonObjects(match[2] ?? '');
        let args: unknown = {};
        if (chunk) {
          try {
            args = JSON.parse(chunk);
          } catch {
            args = {};
          }
        }
        calls.push({ name, arguments: args });
      }
      return calls;
    },
    renderResult: (_name, content, isError) => (isError ? `Erreur : ${content}` : content),
  },

  /**
   * Un objet JSON par ligne, sans marqueur.
   *
   * Le repli pour une architecture maison : aucun jeton spécial à réserver dans
   * le tokenizer, et un `json.loads` par ligne suffit à l'exploiter.
   */
  json_lines: {
    label: 'JSON par ligne',
    families: 'architectures maison, jeux de données neutres',
    render: (calls) =>
      calls.map((c) => json({ name: c.name, arguments: asRecord(c.arguments) })).join('\n'),
    parse: (text) => readCallObjects(extractJsonObjects(text)),
    renderResult: (_name, content, isError) => (isError ? `Erreur : ${content}` : content),
  },
};

export const TOOL_CALL_DIALECTS = Object.keys(DIALECTS) as ToolCallDialect[];

export const DEFAULT_DIALECT: ToolCallDialect = 'hermes';

export function isToolCallDialect(value: string): value is ToolCallDialect {
  return Object.hasOwn(DIALECTS, value);
}

export function renderToolCalls(dialect: ToolCallDialect, calls: TrajectoryToolCall[]): string {
  if (calls.length === 0) return '';
  return DIALECTS[dialect].render(calls);
}

export function parseToolCalls(dialect: ToolCallDialect, text: string): ParsedToolCall[] {
  return DIALECTS[dialect].parse(text);
}

export function renderToolResult(
  dialect: ToolCallDialect,
  name: string,
  content: string,
  isError: boolean,
): string {
  return DIALECTS[dialect].renderResult(name, content, isError);
}

const SAMPLE_CALL: TrajectoryToolCall = {
  id: 'toolu_01',
  name: 'read_file',
  arguments: { path: 'src/index.ts', limit: 40 },
};

/** Rendu de référence d'un dialecte, tel que l'UI le montre avant export. */
export function sampleFor(dialect: ToolCallDialect): string {
  return renderToolCalls(dialect, [SAMPLE_CALL]);
}

export function listDialects(): ToolCallDialectInfo[] {
  return TOOL_CALL_DIALECTS.map((id) => ({
    id,
    label: DIALECTS[id].label,
    families: DIALECTS[id].families,
    sample: sampleFor(id),
  }));
}
