/**
 * Pont tmux : exécute un run dans une session tmux attachable (CLI claude
 * interactif), pour reprendre la main dans un vrai terminal à tout moment.
 */
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { TmuxSessionInfo } from '@maestro/shared';

const exec = promisify(execFile);

export const TMUX_PREFIX = 'maestro-';

/** Quote un argument pour un shell POSIX (rien ne s'échappe dans '…' sauf '). */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export class TmuxBridge {
  private ready: boolean | null = null;

  async available(): Promise<boolean> {
    if (this.ready !== null) return this.ready;
    try {
      await exec('tmux', ['-V']);
      this.ready = true;
    } catch {
      this.ready = false;
    }
    return this.ready;
  }

  sessionName(runId: string): string {
    return `${TMUX_PREFIX}${runId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  }

  /**
   * Crée la session détachée dans le workspace et lance `claude` avec le prompt
   * en argument (soumis immédiatement, contrairement à send-keys qui dépend de
   * l'écran d'accueil du CLI). La sortie du pane est journalisée dans
   * <cwd>/.maestro/tmux-<name>.log. La session reste vivante (REPL interactif)
   * jusqu'à sortie de l'utilisateur, annulation ou timeout.
   *
   * `cliAgent` fait tourner la session sous une définition d'agent Claude Code
   * native (`claude --agent <nom>`) : persona, outils autorisés, hooks et skills
   * d'origine s'appliquent, sans que Maestro les recopie.
   */
  async createRunSession(
    name: string,
    cwd: string,
    prompt: string,
    opts: {
      cliAgent?: string | null;
      model?: string | null;
      permissionMode?: string | null;
      pluginDirs?: string[];
    } = {},
  ): Promise<string> {
    mkdirSync(join(cwd, '.maestro'), { recursive: true });
    const logFile = join(cwd, '.maestro', `tmux-${name}.log`);
    // tmux exécute la commande via un shell : tout argument doit être échappé.
    const argv = ['claude'];
    if (opts.cliAgent) argv.push('--agent', shellQuote(opts.cliAgent));
    if (opts.model) argv.push('--model', shellQuote(opts.model));
    if (opts.permissionMode) argv.push('--permission-mode', shellQuote(opts.permissionMode));
    // --plugin-dir est répétable et ne vaut que pour cette session.
    for (const dir of opts.pluginDirs ?? []) argv.push('--plugin-dir', shellQuote(dir));
    argv.push(shellQuote(prompt));
    // 80×24 (défaut d'une session détachée) tronque la sortie du TUI : on élargit.
    await exec('tmux', [
      'new-session',
      '-d',
      '-x',
      '200',
      '-y',
      '50',
      '-s',
      name,
      '-c',
      cwd,
      argv.join(' '),
    ]);
    await exec('tmux', ['pipe-pane', '-t', name, '-o', `cat >> ${shellQuote(logFile)}`]);
    await this.dismissStartupDialogs(name);
    return logFile;
  }

  /**
   * Écarte les avis ponctuels du CLI (nouveautés de version…) qui attendent une
   * touche et bloqueraient une session non surveillée.
   *
   * Une touche n'est envoyée que si un dialogue est effectivement à l'écran,
   * repéré par son pied de page : sur une session déjà au travail, un Échap
   * interromprait le modèle. Le dialogue de confiance d'un dossier est exclu —
   * Échap y vaut « quitter », et approuver un dépôt reste une décision humaine.
   */
  private async dismissStartupDialogs(name: string, maxAttempts = 8): Promise<number> {
    let dismissed = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, 900));
      const pane = await this.capture(name, 60);
      if (!pane) continue;
      const awaitingKey = pane.includes('Esc to cancel') || pane.includes('Enter to confirm');
      if (!awaitingKey) {
        // Plus rien en attente : si un dialogue a déjà été écarté, c'est fini.
        if (dismissed > 0) break;
        continue;
      }
      if (/trust this folder|Is this a project you created/i.test(pane)) {
        // Laisser la main : l'approbation d'un dépôt ne s'automatise pas.
        return dismissed;
      }
      await exec('tmux', ['send-keys', '-t', name, 'Escape']);
      dismissed++;
    }
    return dismissed;
  }

  async isAlive(name: string): Promise<boolean> {
    try {
      await exec('tmux', ['has-session', '-t', name]);
      return true;
    } catch {
      return false;
    }
  }

  async capture(name: string, lines = 40): Promise<string | null> {
    try {
      const { stdout } = await exec('tmux', ['capture-pane', '-p', '-t', name]);
      return stdout.split('\n').slice(-lines).join('\n').trimEnd();
    } catch {
      return null;
    }
  }

  async readLogTail(logFile: string, maxChars = 4000): Promise<string | null> {
    try {
      const content = await readFile(logFile, 'utf8');
      /* Nettoie les séquences d'échappement ANSI pour un résultat lisible.
         Le caractère ESC est un caractère de contrôle : c'est précisément ce
         qu'il faut retirer, la règle ne s'applique pas ici. */
      // eslint-disable-next-line no-control-regex
      const clean = content.replace(/\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
      return clean.slice(-maxChars).trim() || null;
    } catch {
      return null;
    }
  }

  async kill(name: string): Promise<void> {
    try {
      await exec('tmux', ['kill-session', '-t', name]);
    } catch {
      // Session déjà terminée : rien à faire.
    }
  }

  async list(): Promise<TmuxSessionInfo[]> {
    if (!(await this.available())) return [];
    try {
      const { stdout } = await exec('tmux', [
        'list-sessions',
        '-F',
        '#{session_name}\t#{session_created}\t#{session_attached}',
      ]);
      const sessions: TmuxSessionInfo[] = [];
      for (const line of stdout.trim().split('\n')) {
        const [name, created, attached] = line.split('\t');
        if (!name?.startsWith(TMUX_PREFIX)) continue;
        sessions.push({
          name,
          agentId: null,
          runId: null,
          createdAt: created ? new Date(Number(created) * 1000).toISOString() : '',
          attached: attached === '1',
          preview: await this.capture(name, 12),
        });
      }
      return sessions;
    } catch {
      return [];
    }
  }
}
