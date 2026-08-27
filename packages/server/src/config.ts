import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface MaestroConfig {
  port: number;
  dataDir: string;
  dbPath: string;
  workspacesDir: string;
  globalSkillsDir: string;
  builtinSkillsDir: string;
  /** ~/.claude/skills — skills Claude Code natives (lien vers claude-index). */
  nativeSkillsDir: string;
  /** <dataDir>/plugins — plugins clonés, chargés par session. */
  pluginsDir: string;
  /** ~/.claude/projects — transcripts de sessions, source du radar. */
  claudeProjectsDir: string;
  authToken: string;
  /**
   * Origines autorisées à appeler l'API depuis un navigateur.
   *
   * Le front est servi par ce même serveur (et le dev passe par le proxy Vite) :
   * aucun usage connu n'a besoin d'origine croisée. La liste reste ouverte par
   * configuration pour l'installation qui sert l'interface ailleurs.
   */
  allowedOrigins: string[];
  telegramBotToken: string | null;
  telegramChatIds: string[];
  version: string;
}

function ensureDir(path: string): string {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  return path;
}

function resolveAuthToken(dataDir: string): string {
  const fromEnv = process.env.MAESTRO_TOKEN;
  if (fromEnv && fromEnv.length >= 8) return fromEnv;
  const tokenFile = join(dataDir, 'token');
  if (existsSync(tokenFile)) {
    const stored = readFileSync(tokenFile, 'utf8').trim();
    if (stored.length >= 8) return stored;
  }
  const generated = randomBytes(24).toString('base64url');
  writeFileSync(tokenFile, generated + '\n', { mode: 0o600 });
  return generated;
}

export function loadConfig(): MaestroConfig {
  const dataDir = ensureDir(process.env.MAESTRO_DATA_DIR ?? join(homedir(), '.maestro'));
  const workspacesDir = ensureDir(join(dataDir, 'workspaces'));
  const globalSkillsDir = ensureDir(join(dataDir, 'skills'));
  // Skills livrés avec l'application (lecture seule), à la racine du dépôt.
  const builtinSkillsDir = new URL('../../../assets/skills', import.meta.url).pathname;
  const nativeSkillsDir = join(homedir(), '.claude', 'skills');
  const pluginsDir = ensureDir(join(dataDir, 'plugins'));
  const claudeProjectsDir = join(homedir(), '.claude', 'projects');

  /* Origines locales par défaut : le serveur lui-même et le port de dev Vite.
     Refléter n'importe quelle origine (`origin: true`) était plus large que
     nécessaire — inoffensif tant que l'authentification n'est pas ambiante,
     dangereux dès qu'elle le deviendrait, et gratuit à resserrer maintenant. */
  const configuredOrigins = (process.env.MAESTRO_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const port = Number(process.env.MAESTRO_PORT ?? 4520);
  const allowedOrigins =
    configuredOrigins.length > 0
      ? configuredOrigins
      : [
          `http://localhost:${port}`,
          `http://127.0.0.1:${port}`,
          'http://localhost:4521',
          'http://127.0.0.1:4521',
        ];

  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
  const telegramChatIds = (process.env.TELEGRAM_CHAT_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    port,
    dataDir,
    dbPath: join(dataDir, 'maestro.db'),
    workspacesDir,
    globalSkillsDir,
    builtinSkillsDir,
    nativeSkillsDir,
    pluginsDir,
    claudeProjectsDir,
    authToken: resolveAuthToken(dataDir),
    allowedOrigins,
    telegramBotToken,
    telegramChatIds,
    version: '0.1.0',
  };
}
