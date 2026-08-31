/**
 * Détection de l'invocation non interactive d'un moteur CLI.
 *
 * Le problème que ce module résout : les options non interactives de Codex,
 * d'OpenCode et de leurs semblables changent d'une version à l'autre. Une suite
 * d'arguments codée en dur marche sur la machine de celui qui l'a écrite et
 * échoue chez tous les autres, qui doivent alors corriger la configuration à la
 * main — ce qui suppose qu'ils sachent quoi corriger.
 *
 * La règle retenue est donc : **Maestro n'émet que ce que le binaire déclare
 * lui-même.** L'aide de la commande installée est lue, et chaque élément de la
 * ligne de commande n'est ajouté que s'il y figure. Une option disparue est
 * ignorée, une option renommée n'est pas inventée, et l'utilisateur n'a rien à
 * régler.
 *
 * Ce qui n'est **jamais** ajouté automatiquement : les contournements
 * d'approbation ou de bac à sable. Ils sont repérés et signalés, pas activés —
 * accorder ce droit à la place de l'opérateur serait une décision de sécurité
 * prise par une heuristique.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CLI_DEFAULTS, type ProviderKind } from '@maestro/shared';

const exec = promisify(execFile);

/** Une aide qui ne répond pas en quelques secondes ne répondra pas. */
const HELP_TIMEOUT_MS = 10_000;
/** Aides volumineuses : on borne pour ne pas garder un roman en mémoire. */
const HELP_MAX = 200_000;
/** Durée de validité d'une détection ; un outil mis à jour est repris rapidement. */
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface CliInvocation {
  /** Gabarit d'arguments : `{{prompt}}` et `{{model}}` y sont substitués. */
  args: string[];
  /** Sous-commande retenue, `null` si le binaire n'en déclare aucune connue. */
  subcommand: string | null;
  /** Options facultatives effectivement reconnues dans l'aide. */
  flags: string[];
  /** Comment le prompt est transmis. */
  promptMode: 'positional' | 'flag';
  /**
   * Options d'approbation ou de bac à sable repérées dans l'aide. Jamais
   * ajoutées ; listées pour que l'opérateur sache qu'elles existent.
   */
  approvalFlags: string[];
  /** Vrai quand l'aide n'a pas pu être lue : invocation minimale. */
  degraded: boolean;
}

/** Options d'auto-approbation reconnues, à signaler sans jamais les activer. */
const APPROVAL_FLAG_PATTERNS = [
  '--full-auto',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--auto-approve',
  '--allow-all',
  '--no-confirm',
  '--yes',
];

/** Options de transmission du prompt, par ordre de préférence. */
const PROMPT_FLAGS = ['--prompt', '--message', '--input'];

/**
 * Cherche une option dans un texte d'aide.
 *
 * La frontière de fin compte : sans elle, `--json` accrocherait
 * `--json-schema`, et Maestro passerait une option qui n'existe pas. Les formes
 * `--flag=valeur` et `--flag <valeur>` sont toutes deux reconnues.
 */
export function hasFlag(help: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,\\[])${escaped}([\\s,=\\]]|$)`, 'm').test(help);
}

/**
 * Cherche une sous-commande dans un texte d'aide.
 *
 * Restreint à un mot isolé en début de ligne indentée, ou cité dans la ligne
 * d'usage : c'est ainsi que les générateurs d'aide courants (clap, commander,
 * cobra) présentent les sous-commandes. Chercher le mot n'importe où
 * accrocherait une phrase de description.
 */
export function hasSubcommand(help: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /*
   * Le nom doit être suivi de ce qui suit un nom de commande, jamais d'un mot
   * ordinaire : sa signature d'arguments (`run [options] <message>`, style
   * commander), un alias (`plugin|plugins`), un écart de deux espaces avant la
   * description (style clap), ou la fin de ligne. Exiger seulement le double
   * espace ratait commander ; n'exiger qu'un espace ferait passer « exec a task
   * remotely » pour une sous-commande.
   */
  if (new RegExp(`^\\s{2,}${escaped}(\\s+[[<|-]|\\s{2,}|\\s*$)`, 'm').test(help)) return true;
  return new RegExp(`^\\s*(usage|utilisation)\\s*:.*\\b${escaped}\\b`, 'im').test(help);
}

/**
 * Déduit l'invocation d'un texte d'aide. Fonction pure : c'est elle qui porte
 * toute la logique, et c'est elle qu'on teste sur des aides réelles.
 *
 * `subHelp` est l'aide de la sous-commande quand elle a pu être lue ; elle est
 * plus précise que l'aide générale, où les options d'une sous-commande
 * n'apparaissent pas toujours.
 */
export function parseInvocation(
  kind: ProviderKind,
  help: string,
  subHelp: string | null,
): CliInvocation {
  const defaults = CLI_DEFAULTS[kind];
  const combined = subHelp ? `${help}\n${subHelp}` : help;

  const subcommand = defaults?.subcommands.find((name) => hasSubcommand(help, name)) ?? null;
  /* L'aide de la sous-commande prime : c'est elle qui décrit les options
     réellement acceptées par l'appel qu'on va faire. */
  const scope = subHelp ?? help;

  const flags = (defaults?.optionalFlags ?? []).filter((flag) => hasFlag(scope, flag));

  const promptFlag = PROMPT_FLAGS.find((flag) => hasFlag(scope, flag)) ?? null;
  /* Le positionnel est préféré quand il est possible : c'est la forme la plus
     répandue, et la seule qui ne se trompe pas de nom d'option. */
  const usesPositional = /\[?(PROMPT|prompt|MESSAGE|message)\]?/.test(usageLine(scope));
  const promptMode: CliInvocation['promptMode'] =
    usesPositional || !promptFlag ? 'positional' : 'flag';

  const args: string[] = [];
  if (subcommand) args.push(subcommand);
  args.push(...flags);
  if (hasFlag(scope, '--model')) args.push('--model', '{{model}}');
  if (promptMode === 'flag' && promptFlag) args.push(promptFlag, '{{prompt}}');
  else args.push('{{prompt}}');

  return {
    args,
    subcommand,
    flags,
    promptMode,
    approvalFlags: APPROVAL_FLAG_PATTERNS.filter((flag) => hasFlag(combined, flag)),
    degraded: false,
  };
}

/** Première ligne d'usage, où figurent les arguments positionnels. */
function usageLine(help: string): string {
  const match = /^\s*(usage|utilisation)\s*:.*$/im.exec(help);
  return match?.[0] ?? '';
}

/**
 * Invocation de repli quand l'aide est illisible.
 *
 * Volontairement minimale : la sous-commande candidate la plus probable et le
 * prompt. Elle a toutes les chances d'échouer sur un binaire exotique, et c'est
 * préférable à une suite d'options inventées qui échouerait de façon plus
 * obscure. Le drapeau `degraded` la signale dans l'interface.
 */
export function fallbackInvocation(kind: ProviderKind): CliInvocation {
  const subcommand = CLI_DEFAULTS[kind]?.subcommands[0] ?? null;
  return {
    args: subcommand ? [subcommand, '{{prompt}}'] : ['{{prompt}}'],
    subcommand,
    flags: [],
    promptMode: 'positional',
    approvalFlags: [],
    degraded: true,
  };
}

interface CacheEntry {
  at: number;
  invocation: CliInvocation;
}

const cache = new Map<string, CacheEntry>();

/** Vide le cache de détection — appelé quand l'opérateur teste un compte. */
export function forgetInvocation(command?: string): void {
  if (command === undefined) cache.clear();
  else for (const key of [...cache.keys()]) if (key.endsWith(`:${command}`)) cache.delete(key);
}

/**
 * Lit l'aide du binaire installé et en déduit l'invocation.
 *
 * Le résultat est mis en cache : détecter à chaque tentative ajouterait deux
 * lancements de processus au chemin critique d'un run, pour une réponse qui ne
 * change qu'à la mise à jour de l'outil.
 */
export async function detectInvocation(
  kind: ProviderKind,
  command: string,
  options: { refresh?: boolean } = {},
): Promise<CliInvocation> {
  const key = `${kind}:${command}`;
  const cached = cache.get(key);
  if (!options.refresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.invocation;
  }

  const help = await readHelp(command, []);
  if (help === null) {
    const invocation = fallbackInvocation(kind);
    cache.set(key, { at: Date.now(), invocation });
    return invocation;
  }

  const subcommand = CLI_DEFAULTS[kind]?.subcommands.find((name) => hasSubcommand(help, name));
  const subHelp = subcommand ? await readHelp(command, [subcommand]) : null;

  const invocation = parseInvocation(kind, help, subHelp);
  cache.set(key, { at: Date.now(), invocation });
  return invocation;
}

/**
 * Exécute `<command> [sub] --help`.
 *
 * Une sortie non nulle n'est pas rejetée : plusieurs CLI impriment leur aide
 * puis sortent en code 1 ou 2. Ce qui compte est d'avoir du texte à lire.
 */
async function readHelp(command: string, prefix: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await exec(command, [...prefix, '--help'], {
      timeout: HELP_TIMEOUT_MS,
      maxBuffer: HELP_MAX,
    });
    const text = `${stdout}\n${stderr}`.trim();
    return text || null;
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string };
    const text = `${failed.stdout ?? ''}\n${failed.stderr ?? ''}`.trim();
    return text || null;
  }
}
