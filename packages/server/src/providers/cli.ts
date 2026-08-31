/**
 * Adaptateur générique pour les moteurs CLI tiers (Codex, OpenCode).
 *
 * Un seul adaptateur pour deux outils : ce qui les distingue tient dans la
 * commande et le format de sortie, pas dans le cycle de vie. Écrire deux
 * classes identiques à un tableau d'arguments près n'apporterait rien.
 *
 * ⚠ Ce que Maestro perd en passant par un CLI tiers, et qu'il faut afficher
 * plutôt que masquer :
 *
 *  - **les permissions ne sont plus interceptées.** Aucun de ces outils n'offre
 *    d'équivalent à `canUseTool`. La politique d'approbation d'un agent devient
 *    *déclarative* : Maestro ne peut plus l'appliquer, seulement l'afficher.
 *    C'est une régression de sécurité réelle, portée par `PROVIDER_CAPABILITIES`
 *    et signalée dans l'interface.
 *  - **le coût n'est pas rapporté.** Les tentatives sur ces moteurs comptent
 *    zéro dollar, ce qui fausserait une analytique qui les mélangerait au SDK.
 *  - **le transcript est plus grossier** : ce qui n'est pas reconnu comme
 *    structuré atterrit en texte.
 */
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CLI_DEFAULTS,
  PROVIDER_LABELS,
  type ProviderAccount,
  type ProviderKind,
  type ProviderProbe,
} from '@maestro/shared';
import { truncate } from '../util.ts';
import {
  renderArgs,
  ZERO_USAGE,
  type AttemptContext,
  type AttemptOutcome,
  type ProviderAdapter,
} from './adapter.ts';
import { detectInvocation, type CliInvocation } from './cli-invocation.ts';

const exec = promisify(execFile);

/** Sorties conservées en mémoire : de quoi diagnostiquer, pas de quoi saturer. */
const STDERR_TAIL = 4000;
const STDOUT_MAX = 400_000;
/**
 * Délai laissé aux tuyaux pour se fermer après la mort du processus.
 *
 * Assez pour récupérer la fin d'une sortie qui traîne, assez court pour qu'une
 * annulation reste ressentie comme immédiate.
 */
const ORPHAN_GRACE_MS = 500;

export class CliAdapter implements ProviderAdapter {
  constructor(public readonly kind: ProviderKind) {}

  async probe(account?: ProviderAccount | null): Promise<ProviderProbe> {
    const defaults = CLI_DEFAULTS[this.kind];
    const command = account?.command ?? defaults?.command ?? this.kind;
    const label = PROVIDER_LABELS[this.kind];

    const binaryPath = await resolveBinary(command);
    if (!binaryPath) {
      return {
        kind: this.kind,
        label,
        binaryPath: null,
        version: null,
        detectedProfiles: [],
        envCandidates: [],
        ready: false,
        hint: `« ${command} » est absent du PATH du serveur Maestro.`,
        invocation: null,
        invocationDegraded: false,
      };
    }

    const version = await readVersion(command);
    /* La sonde force la relecture de l'aide : c'est le geste par lequel
       l'opérateur demande un état à jour, typiquement après avoir mis l'outil à
       jour. Servir un cache ici viderait le bouton de son sens. */
    const invocation = await detectInvocation(this.kind, command, { refresh: true });

    return {
      kind: this.kind,
      label,
      binaryPath,
      version,
      detectedProfiles: [],
      envCandidates: [],
      ready: true,
      hint: buildHint(defaults?.note ?? null, invocation),
      invocation: invocation.args,
      invocationDegraded: invocation.degraded,
    };
  }

  async execute(ctx: AttemptContext): Promise<AttemptOutcome> {
    const defaults = CLI_DEFAULTS[this.kind];
    const command = ctx.account?.command ?? defaults?.command ?? this.kind;

    /*
     * Gabarit d'arguments : celui du compte s'il est renseigné, sinon celui
     * déduit de l'aide du binaire installé. L'ordre compte — une valeur saisie
     * par l'opérateur est un choix explicite, la détection ne doit pas le
     * contredire.
     */
    const detected = ctx.account?.args ? null : await detectInvocation(this.kind, command);
    const template = ctx.account?.args ?? detected?.args ?? ['{{prompt}}'];
    const args = renderArgs(template, {
      prompt: ctx.prompt,
      model: ctx.model,
      cwd: ctx.workspaceDir,
    });

    /* La ligne affichée est la vraie, modèle substitué, mais le prompt reste
       masqué : il fait des milliers de caractères et se lit déjà plus haut. */
    const shown = renderArgs(template, {
      prompt: '{{prompt}}',
      model: ctx.model,
      cwd: ctx.workspaceDir,
    });
    ctx.emit('init', {
      text:
        `Moteur ${PROVIDER_LABELS[this.kind]} — ${command} ${describeArgs(shown)} ` +
        `(permissions non interceptées)` +
        (detected?.degraded
          ? ' ⚠ aide de la commande illisible : invocation minimale, la session peut rester interactive.'
          : ''),
    });

    return await new Promise<AttemptOutcome>((resolve) => {
      let stdout = '';
      let stderr = '';
      let pending = '';
      let settled = false;
      let timedOut = false;

      /*
       * `detached` place le fils dans son propre groupe de processus.
       *
       * Sans cela, tuer le fils laisse ses petits-enfants en vie : un agent CLI
       * lance des sous-processus, et l'un d'eux continuerait d'écrire dans le
       * workspace alors que le run est annulé. Le groupe permet de tous les
       * viser d'un coup.
       */
      const child = spawn(command, args, {
        cwd: ctx.workspaceDir,
        env: ctx.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });

      const finish = (outcome: AttemptOutcome): void => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        ctx.abort.signal.removeEventListener('abort', onAbort);
        resolve(outcome);
      };

      const killGroup = (signal: NodeJS.Signals): void => {
        try {
          if (child.pid) process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch {
          /* Groupe déjà éteint : rien à faire, et surtout rien à signaler. */
        }
      };

      function onAbort(): void {
        killGroup('SIGTERM');
        // Un CLI qui ignore SIGTERM ne doit pas retenir le run indéfiniment.
        setTimeout(() => killGroup('SIGKILL'), 3000).unref();
      }
      ctx.abort.signal.addEventListener('abort', onAbort, { once: true });

      /*
       * Délai maximal, appliqué ici et pas ailleurs.
       *
       * Le garde-fou de temps du moteur n'existait que dans le chemin SDK : un
       * CLI resté bloqué — attente d'une confirmation que personne ne donnera,
       * réseau suspendu — aurait immobilisé son agent sans fin, puisqu'un agent
       * n'exécute qu'un run à la fois.
       */
      const timeoutMs = ctx.timeoutSec && ctx.timeoutSec > 0 ? ctx.timeoutSec * 1000 : 0;
      const timeoutTimer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            killGroup('SIGTERM');
            setTimeout(() => killGroup('SIGKILL'), 3000).unref();
          }, timeoutMs)
        : null;

      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (stdout.length < STDOUT_MAX) stdout += text;
        pending += text;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) emitLine(ctx, line);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        finish({
          status: 'failed',
          sessionId: null,
          resultText: null,
          error: `Lancement de « ${command} » impossible : ${err.message}`,
          failureSignal: { code: err.code ?? null, hint: err.code === 'ENOENT' ? 'fatal' : null },
          usage: { ...ZERO_USAGE },
        });
      });

      /*
       * `close` attend la fermeture des tuyaux, `exit` la fin du processus.
       *
       * Les deux ne coïncident pas : un petit-fils qui hérite de stdout garde
       * les tuyaux ouverts après la mort de son parent, et `close` n'arrive
       * jamais. Vérifié en test — un `sh -c "sleep 30"` tué laisse le run
       * suspendu indéfiniment. On attend donc `close` pour ne rien perdre de la
       * sortie, mais `exit` arme un délai de grâce qui tranche.
       */
      child.on('exit', (code) => {
        setTimeout(() => {
          if (settled) return;
          onClose(code);
        }, ORPHAN_GRACE_MS).unref();
      });

      child.on('close', onClose);

      function onClose(code: number | null): void {
        if (settled) return;
        if (pending.trim()) emitLine(ctx, pending);
        const text = extractText(stdout);
        if (timedOut) {
          /* Un délai dépassé est un garde-fou Maestro, pas un incident du
             fournisseur : le rejouer ailleurs relancerait la même course
             contre le même chronomètre. */
          finish({
            status: 'failed',
            sessionId: null,
            resultText: text || null,
            error: `Délai maximal dépassé (${ctx.timeoutSec} s)`,
            failureSignal: { hint: 'budget' },
            usage: { ...ZERO_USAGE },
          });
          return;
        }
        if (ctx.abort.signal.aborted) {
          finish({
            status: 'failed',
            sessionId: null,
            resultText: text || null,
            error: 'Interrompu',
            failureSignal: { hint: 'cancelled' },
            usage: { ...ZERO_USAGE },
          });
          return;
        }
        if (code === 0) {
          finish({
            status: 'succeeded',
            sessionId: null,
            resultText: text,
            error: null,
            usage: { ...ZERO_USAGE },
          });
          return;
        }
        /* Le message remis à la classification joint stderr et stdout : les CLI
           écrivent leur limite d'usage indifféremment sur l'un ou l'autre. */
        finish({
          status: 'failed',
          sessionId: null,
          resultText: text || null,
          error: `${command} a terminé avec le code ${code}\n${stderr.slice(-1500)}`,
          failureSignal: { code: null },
          usage: { ...ZERO_USAGE },
        });
      }
    });
  }
}

/**
 * Projette une ligne de sortie sur le transcript.
 *
 * Les formats JSON diffèrent d'un outil à l'autre et d'une version à l'autre :
 * on ne reconnaît que des formes très générales, et tout le reste passe en
 * texte. Deviner plus finement produirait un transcript faux le jour où le
 * format bouge, ce qui est pire qu'un transcript grossier.
 */
function emitLine(ctx: AttemptContext, rawLine: string): void {
  const line = rawLine.trim();
  if (!line) return;
  if (!line.startsWith('{')) {
    ctx.emit('assistant_text', { text: truncate(line, 2000) });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    ctx.emit('assistant_text', { text: truncate(line, 2000) });
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const obj = parsed as Record<string, unknown>;

  const toolName = pickString(obj, ['tool', 'tool_name', 'name']);
  if (toolName && pickString(obj, ['type']) !== 'message') {
    ctx.emit('tool_use', { toolName, toolInput: obj.input ?? obj.arguments ?? null });
    return;
  }

  const text = pickString(obj, ['text', 'message', 'content', 'delta', 'output']);
  if (text) ctx.emit('assistant_text', { text: truncate(text, 2000) });
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

/**
 * Résultat final d'un run CLI.
 *
 * Faute de champ « résultat » universel, la sortie brute fait foi. Elle est
 * tronquée par la fin : c'est là que se trouve la conclusion.
 */
function extractText(stdout: string): string {
  const clean = stdout.trim();
  return clean.length > 20_000 ? `…${clean.slice(-20_000)}` : clean;
}

/**
 * Message de la sonde.
 *
 * Il dit trois choses, dans cet ordre : ce que Maestro a déduit, ce qu'il n'a
 * pas pu déduire, et ce que l'opérateur peut vouloir ajouter lui-même. Les
 * options d'auto-approbation sont mentionnées mais jamais activées : les
 * ajouter à la place de l'opérateur reviendrait à décider pour lui d'exécuter
 * sans confirmation, sur un moteur où Maestro ne peut de toute façon plus
 * intercepter les outils.
 */
function buildHint(note: string | null, invocation: CliInvocation): string | null {
  const parts: string[] = [];
  if (invocation.degraded) {
    parts.push(
      'L’aide de la commande n’a pas pu être lue : invocation minimale, la session risque de rester interactive. Renseigne les arguments à la main sur le compte.',
    );
  } else {
    parts.push(note ?? 'Invocation déduite de l’aide de la commande installée.');
    if (!invocation.subcommand) {
      parts.push(
        'Aucune sous-commande non interactive reconnue : le binaire sera appelé directement.',
      );
    }
  }
  if (invocation.approvalFlags.length > 0) {
    parts.push(
      `Options d’auto-approbation disponibles sur cet outil (${invocation.approvalFlags.join(', ')}) — non ajoutées : c’est à toi de décider, Maestro n’intercepte pas les outils de ce moteur.`,
    );
  }
  return parts.join(' ') || null;
}

/** Rend un gabarit d'arguments lisible dans le transcript. */
function describeArgs(template: readonly string[]): string {
  return template.map((arg) => (arg === '{{prompt}}' ? '<prompt>' : arg)).join(' ');
}

export async function resolveBinary(command: string): Promise<string | null> {
  try {
    const { stdout } = await exec('command', ['-v', command], { shell: '/bin/sh' });
    const path = stdout.trim().split('\n')[0];
    return path || null;
  } catch {
    return null;
  }
}

async function readVersion(command: string): Promise<string | null> {
  try {
    const { stdout } = await exec(command, ['--version'], { timeout: 5000 });
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}
