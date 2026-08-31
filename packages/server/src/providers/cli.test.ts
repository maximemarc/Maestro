/**
 * Tests de l'adaptateur CLI générique.
 *
 * Ni Codex ni OpenCode ne sont installés sur la machine de développement — et
 * ils ne le seront pas sur toutes celles qui font tourner la CI. Plutôt que de
 * ne rien vérifier, on branche l'adaptateur sur `sh`, qui est partout : la
 * commande, les arguments, le découpage de la sortie, le code de retour,
 * stderr et l'interruption sont exactement le même code, quel que soit le
 * binaire au bout.
 *
 * Ce que ces tests ne prouvent pas, et qu'il faut dire : que les arguments non
 * interactifs proposés par défaut pour Codex et OpenCode soient les bons. Cela
 * ne se vérifie qu'avec les binaires en face.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AgentConfig,
  ProviderAccount,
  Run,
  RunEventKind,
  RunEventPayload,
} from '@maestro/shared';
import { renderArgs, type AttemptContext } from './adapter.ts';
import { CliAdapter } from './cli.ts';
import { forgetInvocation } from './cli-invocation.ts';

function shellAccount(script: string): ProviderAccount {
  return {
    id: 'acc_sh',
    name: 'Faux CLI',
    kind: 'codex-cli',
    enabled: true,
    authMode: 'inherit',
    configDir: null,
    apiKeyEnv: null,
    baseUrl: null,
    apiFlavor: null,
    model: null,
    command: 'sh',
    args: ['-c', script],
    env: {},
    priority: 10,
    dailyCostLimitUsd: null,
    health: 'ready',
    cooldownUntil: null,
    lastError: null,
    lastCheckedAt: null,
    detail: null,
    createdAt: '',
    updatedAt: '',
  };
}

interface Captured {
  kind: RunEventKind;
  payload: RunEventPayload;
}

function context(account: ProviderAccount, captured: Captured[]): AttemptContext {
  return {
    run: { id: 'run_1', agentId: 'ag_1' } as Run,
    agent: { id: 'ag_1', name: 'Agent', systemPrompt: null } as AgentConfig,
    account,
    model: 'sonnet',
    prompt: 'fais quelque chose',
    resumeSessionId: null,
    workspaceDir: process.cwd(),
    timeoutSec: 30,
    abort: new AbortController(),
    env: { ...process.env },
    emit: (kind, payload) => captured.push({ kind, payload }),
    onUsage: () => undefined,
  };
}

describe('gabarit d’arguments', () => {
  it('substitue prompt, modèle et répertoire', () => {
    const args = renderArgs(['exec', '--model', '{{model}}', '--cd', '{{cwd}}', '{{prompt}}'], {
      prompt: 'analyse ceci',
      model: 'opus',
      cwd: '/tmp/atelier',
    });
    expect(args).toEqual(['exec', '--model', 'opus', '--cd', '/tmp/atelier', 'analyse ceci']);
  });

  it('passe le prompt en un seul argument, quels que soient ses espaces', () => {
    // Un prompt découpé par le shell arriverait tronqué au moteur.
    const args = renderArgs(['{{prompt}}'], {
      prompt: 'plusieurs mots "et des guillemets"',
      model: 'sonnet',
      cwd: '/tmp',
    });
    expect(args).toHaveLength(1);
    expect(args[0]).toContain('guillemets');
  });
});

describe('exécution', () => {
  it('réussit et rend la sortie comme résultat', async () => {
    const captured: Captured[] = [];
    const account = shellAccount('echo "travail terminé"');
    const outcome = await new CliAdapter('codex-cli').execute(context(account, captured));
    expect(outcome.status).toBe('succeeded');
    expect(outcome.resultText).toContain('travail terminé');
  });

  it('projette une sortie JSON par ligne sur le transcript', async () => {
    const captured: Captured[] = [];
    const account = shellAccount(
      `printf '%s\\n' '{"type":"message","text":"je commence"}' '{"tool":"Read","input":{"path":"a.ts"}}'`,
    );
    await new CliAdapter('codex-cli').execute(context(account, captured));
    expect(
      captured.some((e) => e.kind === 'assistant_text' && e.payload.text === 'je commence'),
    ).toBe(true);
    expect(captured.some((e) => e.kind === 'tool_use' && e.payload.toolName === 'Read')).toBe(true);
  });

  it('traite une ligne non JSON comme du texte plutôt que de la perdre', async () => {
    const captured: Captured[] = [];
    const account = shellAccount('echo "sortie brute non structurée"');
    await new CliAdapter('opencode-cli').execute(context(account, captured));
    expect(
      captured.some(
        (e) => e.kind === 'assistant_text' && e.payload.text === 'sortie brute non structurée',
      ),
    ).toBe(true);
  });

  it('échoue avec stderr quand le code de retour est non nul', async () => {
    const captured: Captured[] = [];
    const account = shellAccount('echo "limite atteinte" >&2; exit 3');
    const outcome = await new CliAdapter('codex-cli').execute(context(account, captured));
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('code 3');
    // stderr doit remonter : c'est souvent là que le fournisseur écrit son motif.
    expect(outcome.error).toContain('limite atteinte');
  });

  it('signale une commande introuvable sans laisser croire à un incident réseau', async () => {
    const captured: Captured[] = [];
    const account = { ...shellAccount(''), command: 'binaire-qui-nexiste-pas-maestro' };
    const outcome = await new CliAdapter('codex-cli').execute(context(account, captured));
    expect(outcome.status).toBe('failed');
    expect(outcome.failureSignal?.code).toBe('ENOENT');
    expect(outcome.failureSignal?.hint).toBe('fatal');
  });

  it('s’interrompt à l’annulation', async () => {
    const captured: Captured[] = [];
    const account = shellAccount('sleep 30');
    const ctx = context(account, captured);
    const promise = new CliAdapter('codex-cli').execute(ctx);
    setTimeout(() => ctx.abort.abort(), 50);
    const outcome = await promise;
    expect(outcome.status).toBe('failed');
    expect(outcome.failureSignal?.hint).toBe('cancelled');
  });

  it('annonce dans le transcript que les permissions ne sont pas interceptées', async () => {
    // L'opérateur doit voir la perte de contrôle, pas la découvrir après coup.
    const captured: Captured[] = [];
    await new CliAdapter('codex-cli').execute(context(shellAccount('true'), captured));
    const init = captured.find((e) => e.kind === 'init');
    expect(init?.payload.text).toContain('permissions non interceptées');
  });
});

describe('invocation automatique', () => {
  /*
   * Un compte sans arguments ne doit pas exiger de configuration : Maestro lit
   * l'aide du binaire et en déduit la ligne de commande. Le faux outil
   * ci-dessous déclare une sous-commande `exec` et l'option `--json`, et
   * imprime ce qu'il a reçu — de quoi vérifier que l'invocation construite est
   * bien celle qui part.
   */
  const dir = mkdtempSync(join(tmpdir(), 'maestro-cliexec-'));
  const binary = join(dir, 'faux-outil');

  beforeAll(() => {
    writeFileSync(
      binary,
      `#!/bin/sh
if [ "$1" = "--help" ]; then
  echo "Usage: faux-outil [OPTIONS] <COMMAND>"
  echo ""
  echo "Commands:"
  echo "  exec     Run non-interactively"
  exit 0
fi
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then
  echo "Usage: faux-outil exec [OPTIONS] [PROMPT]"
  echo ""
  echo "Options:"
  echo "      --json           Emit JSONL"
  exit 0
fi
echo "recu: $*"
`,
      { mode: 0o755 },
    );
    forgetInvocation();
  });

  afterAll(() => {
    forgetInvocation();
    rmSync(dir, { recursive: true, force: true });
  });

  it('déduit la ligne de commande quand le compte n’en impose pas', async () => {
    const captured: Captured[] = [];
    const account = { ...shellAccount(''), command: binary, args: null };
    const outcome = await new CliAdapter('codex-cli').execute(context(account, captured));
    expect(outcome.status).toBe('succeeded');
    // `--json` est déclaré par l'aide, `--model` ne l'est pas : il est omis.
    expect(outcome.resultText).toContain('exec --json');
    expect(outcome.resultText).not.toContain('--model');
    expect(outcome.resultText).toContain('fais quelque chose');
  });

  it('respecte les arguments imposés par le compte, sans détection', async () => {
    // Une valeur saisie par l'opérateur est un choix explicite ; la détection
    // ne doit pas le contredire.
    const captured: Captured[] = [];
    const account = { ...shellAccount(''), command: binary, args: ['{{prompt}}'] };
    const outcome = await new CliAdapter('codex-cli').execute(context(account, captured));
    expect(outcome.resultText).toContain('recu: fais quelque chose');
    expect(outcome.resultText).not.toContain('exec');
  });
});

describe('délai maximal', () => {
  it('interrompt un moteur qui ne rend jamais la main', async () => {
    /* Le garde-fou de temps n'existait que dans le chemin SDK : un CLI bloqué
       aurait immobilisé son agent indéfiniment, puisqu'un agent n'exécute qu'un
       run à la fois. */
    const captured: Captured[] = [];
    const ctx = context(shellAccount('sleep 30'), captured);
    ctx.timeoutSec = 1;
    const outcome = await new CliAdapter('codex-cli').execute(ctx);
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('Délai maximal dépassé');
    expect(outcome.failureSignal?.hint).toBe('budget');
  }, 15_000);
});

describe('sonde', () => {
  it('rend le chemin du binaire quand il existe', async () => {
    const probe = await new CliAdapter('codex-cli').probe({
      ...shellAccount('true'),
      command: 'sh',
    });
    expect(probe.binaryPath).toBeTruthy();
    expect(probe.ready).toBe(true);
  });

  it('dit clairement ce qui manque quand le binaire est absent', async () => {
    const probe = await new CliAdapter('codex-cli').probe({
      ...shellAccount(''),
      command: 'binaire-qui-nexiste-pas-maestro',
    });
    expect(probe.ready).toBe(false);
    expect(probe.hint).toContain('absent du PATH');
  });
});
