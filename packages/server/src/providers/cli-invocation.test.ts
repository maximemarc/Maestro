/**
 * Tests de la détection d'invocation.
 *
 * L'enjeu tient en une phrase : Maestro ne doit émettre que ce que le binaire
 * installé déclare. Une option ajoutée parce qu'elle existait dans une version
 * antérieure fait échouer le run chez l'utilisateur suivant, avec un message
 * d'erreur qui ne dit pas d'où vient le problème.
 *
 * Les aides ci-dessous imitent les trois styles répandus — clap (Rust),
 * commander (Node), cobra (Go) — pour vérifier que la reconnaissance ne dépend
 * pas d'un générateur particulier.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  detectInvocation,
  fallbackInvocation,
  hasFlag,
  hasSubcommand,
  parseInvocation,
} from './cli-invocation.ts';

/** Style clap : sous-commandes indentées, usage en tête. */
const CLAP_HELP = `Usage: outil [OPTIONS] <COMMAND>

Commands:
  exec     Run non-interactively
  login    Manage authentication
  help     Print this message

Options:
  -m, --model <MODEL>  Model to use
      --json           Emit events as JSONL
  -h, --help           Print help
`;

const CLAP_SUB_HELP = `Run non-interactively

Usage: outil exec [OPTIONS] [PROMPT]

Options:
  -m, --model <MODEL>          Model to use
      --json                   Emit events as JSONL
      --skip-git-repo-check    Allow running outside a git repository
      --full-auto              Approve every action without asking
  -h, --help                   Print help
`;

/** Style commander : « Commands: » puis descriptions alignées. */
const COMMANDER_HELP = `Usage: outil [options] [command]

Options:
  -v, --version       output the version number
  -h, --help          display help for command

Commands:
  run [options] <message>   send a message and print the reply
  serve                     start the server
`;

describe('reconnaissance d’une option', () => {
  it('reconnaît une option isolée', () => {
    expect(hasFlag(CLAP_SUB_HELP, '--json')).toBe(true);
  });

  it('ne confond pas une option avec le préfixe d’une autre', () => {
    // Sans frontière de fin, « --json » accrocherait « --json-schema » et
    // Maestro passerait une option qui n'existe pas.
    expect(hasFlag('  --json-schema <FILE>  Emit a schema', '--json')).toBe(false);
  });

  it('reconnaît une option écrite avec un égal', () => {
    expect(hasFlag('  --model=<MODEL>  Model to use', '--model')).toBe(true);
  });

  it('ne reconnaît pas une option absente', () => {
    expect(hasFlag(COMMANDER_HELP, '--skip-git-repo-check')).toBe(false);
  });
});

describe('reconnaissance d’une sous-commande', () => {
  it('reconnaît une sous-commande listée', () => {
    expect(hasSubcommand(CLAP_HELP, 'exec')).toBe(true);
    expect(hasSubcommand(COMMANDER_HELP, 'run')).toBe(true);
  });

  it('ne reconnaît pas une sous-commande absente', () => {
    expect(hasSubcommand(CLAP_HELP, 'run')).toBe(false);
  });

  it('ne se laisse pas prendre par un mot de description', () => {
    // « exec » apparaît dans une phrase, pas comme commande.
    const help = 'Usage: outil [options]\n\nOptions:\n  --help  how to exec a task remotely\n';
    expect(hasSubcommand(help, 'exec')).toBe(false);
  });
});

describe('invocation déduite', () => {
  it('assemble sous-commande, options déclarées et prompt positionnel', () => {
    const inv = parseInvocation('codex-cli', CLAP_HELP, CLAP_SUB_HELP);
    expect(inv.args).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--model',
      '{{model}}',
      '{{prompt}}',
    ]);
    expect(inv.degraded).toBe(false);
  });

  it('n’ajoute que les options que l’aide déclare', () => {
    // Même outil, version sans --skip-git-repo-check : l'option disparaît de
    // l'invocation au lieu de faire échouer le lancement.
    const trimmed = CLAP_SUB_HELP.replace(/.*--skip-git-repo-check.*\n/, '');
    const inv = parseInvocation('codex-cli', CLAP_HELP, trimmed);
    expect(inv.args).not.toContain('--skip-git-repo-check');
    expect(inv.args).toContain('--json');
  });

  it('omet --model quand l’outil ne le propose pas', () => {
    const help = 'Usage: outil [options] [PROMPT]\n\nOptions:\n  -h, --help  help\n';
    const inv = parseInvocation('opencode-cli', help, help);
    expect(inv.args).not.toContain('--model');
    expect(inv.args).toEqual(['{{prompt}}']);
  });

  it('n’invente pas de sous-commande absente', () => {
    const help = 'Usage: outil [options] [PROMPT]\n\nOptions:\n  -h, --help  help\n';
    const inv = parseInvocation('codex-cli', help, null);
    expect(inv.subcommand).toBeNull();
  });

  it('utilise une option de prompt quand il n’y a pas de positionnel', () => {
    const help = `Usage: outil run [options]

Options:
      --prompt <TEXT>  the instruction to run
  -m, --model <MODEL>  model to use
`;
    const listing = 'Usage: outil [options] [command]\n\nCommands:\n  run   run something\n';
    const inv = parseInvocation('opencode-cli', listing, help);
    expect(inv.promptMode).toBe('flag');
    expect(inv.args).toEqual(['run', '--model', '{{model}}', '--prompt', '{{prompt}}']);
  });

  it('préfère le positionnel quand les deux formes existent', () => {
    // Le positionnel est la forme la plus répandue, et la seule qui ne se
    // trompe pas de nom d'option.
    const help = `Usage: outil run [options] [PROMPT]

Options:
      --prompt <TEXT>  alternative to the positional argument
`;
    const listing = 'Usage: outil [options] [command]\n\nCommands:\n  run   run something\n';
    const inv = parseInvocation('opencode-cli', listing, help);
    expect(inv.promptMode).toBe('positional');
    expect(inv.args[inv.args.length - 1]).toBe('{{prompt}}');
  });

  it('repère les options d’auto-approbation sans jamais les ajouter', () => {
    /* Décision de sécurité : exécuter sans confirmation appartient à
       l'opérateur. Sur ces moteurs, Maestro n'intercepte déjà plus les outils —
       ajouter le contournement à sa place cumulerait les deux abandons. */
    const inv = parseInvocation('codex-cli', CLAP_HELP, CLAP_SUB_HELP);
    expect(inv.approvalFlags).toContain('--full-auto');
    expect(inv.args).not.toContain('--full-auto');
  });
});

describe('lecture de l’aide d’un vrai binaire', () => {
  /*
   * Un faux CLI écrit sur disque, avec deux pièges répandus : l'aide part sur
   * stderr, et la commande sort en code 1. Un lecteur qui n'accepterait que le
   * cas nominal conclurait « aide illisible » et retomberait sur l'invocation
   * dégradée alors que tout était là.
   */
  const dir = mkdtempSync(join(tmpdir(), 'maestro-cli-'));
  const binary = join(dir, 'faux-outil');

  beforeAll(() => {
    writeFileSync(
      binary,
      `#!/bin/sh
if [ "$1" = "exec" ]; then
  echo "Usage: faux-outil exec [OPTIONS] [PROMPT]" >&2
  echo "" >&2
  echo "Options:" >&2
  echo "  -m, --model <MODEL>  Model to use" >&2
  echo "      --json           Emit JSONL" >&2
  exit 1
fi
echo "Usage: faux-outil [OPTIONS] <COMMAND>" >&2
echo "" >&2
echo "Commands:" >&2
echo "  exec     Run non-interactively" >&2
exit 1
`,
      { mode: 0o755 },
    );
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('lit une aide servie sur stderr avec un code de retour non nul', async () => {
    const inv = await detectInvocation('codex-cli', binary, { refresh: true });
    expect(inv.degraded).toBe(false);
    expect(inv.args).toEqual(['exec', '--json', '--model', '{{model}}', '{{prompt}}']);
  });

  it('retombe sur l’invocation dégradée quand le binaire n’existe pas', async () => {
    const inv = await detectInvocation('codex-cli', join(dir, 'absent'), { refresh: true });
    expect(inv.degraded).toBe(true);
  });
});

describe('repli quand l’aide est illisible', () => {
  it('rend une invocation minimale, signalée comme dégradée', () => {
    const inv = fallbackInvocation('codex-cli');
    expect(inv.args).toEqual(['exec', '{{prompt}}']);
    expect(inv.degraded).toBe(true);
  });

  it('se réduit au prompt pour un fournisseur sans sous-commande connue', () => {
    const inv = fallbackInvocation('http-api');
    expect(inv.args).toEqual(['{{prompt}}']);
  });
});
