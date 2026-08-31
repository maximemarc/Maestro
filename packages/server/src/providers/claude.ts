/**
 * Sonde du fournisseur Claude Code, et gestion des profils multi-comptes.
 *
 * Le mécanisme, vérifié sur la machine avant d'être codé : `CLAUDE_CONFIG_DIR`
 * isole entièrement l'authentification, et `claude auth status` répond en JSON.
 * Un répertoire par compte suffit donc à faire cohabiter deux abonnements —
 * chacun avec son propre quota, ce qui est précisément l'intérêt.
 *
 * L'exécution, elle, n'est pas ici : le fournisseur `claude-sdk` reste tissé
 * dans `runs.ts` avec les serveurs MCP, les plugins et le broker
 * d'approbations. Ce fichier ne fournit que ce qui s'en détache proprement —
 * détection, création de profil, connexion.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PROVIDER_LABELS, type DetectedProfile, type ProviderProbe } from '@maestro/shared';
import { resolveBinary } from './cli.ts';

const exec = promisify(execFile);

/** `claude auth status` doit répondre vite ; au-delà, le profil est considéré muet. */
const STATUS_TIMEOUT_MS = 15_000;

/** Forme rendue par `claude auth status`, réduite à ce dont Maestro se sert. */
interface AuthStatus {
  loggedIn?: boolean;
  authMethod?: string;
  subscriptionType?: string;
  email?: string;
  orgName?: string;
}

/**
 * Interroge un répertoire de configuration.
 *
 * `configDir` null interroge le profil par défaut de l'utilisateur qui fait
 * tourner le serveur — celui avec lequel Maestro fonctionne déjà aujourd'hui.
 */
export async function readAuthStatus(configDir: string | null): Promise<DetectedProfile | null> {
  const env = { ...process.env };
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;

  let stdout: string;
  try {
    ({ stdout } = await exec('claude', ['auth', 'status'], { env, timeout: STATUS_TIMEOUT_MS }));
  } catch (err) {
    /*
     * Sortie non nulle ≠ absence de réponse.
     *
     * Vérifié sur la machine : un profil non connecté fait sortir
     * `claude auth status` en code 1, tout en imprimant un JSON parfaitement
     * valide. Ne lire que le cas nominal faisait conclure « la commande n'a pas
     * répondu » là où la réponse était « ce profil n'est pas authentifié » —
     * deux diagnostics qui n'appellent pas du tout la même action de la part de
     * l'opérateur.
     */
    const failed = err as { stdout?: string };
    if (typeof failed.stdout !== 'string' || failed.stdout.trim() === '') return null;
    stdout = failed.stdout;
  }

  try {
    const status = JSON.parse(stdout) as AuthStatus;
    return {
      configDir: configDir ?? '(défaut)',
      loggedIn: status.loggedIn === true,
      authMethod: status.authMethod ?? null,
      subscriptionType: status.subscriptionType ?? null,
      /* L'identité sert à distinguer deux comptes dans l'interface — c'est tout
         son intérêt. Elle ne part ni dans le bus d'événements ni dans les
         journaux : une donnée personnelle n'a rien à faire dans un flux
         diffusé à tous les clients connectés. */
      account: status.email ?? status.orgName ?? null,
    };
  } catch {
    return null;
  }
}

/** Répertoire d'accueil des profils créés par Maestro. */
export function profilesDir(dataDir: string): string {
  return join(dataDir, 'accounts');
}

/**
 * Crée le répertoire d'un profil, sans l'authentifier.
 *
 * La connexion reste une action humaine : elle ouvre un navigateur et demande
 * un code. Maestro prépare le terrain et donne la commande à lancer, il ne
 * pilote pas une authentification à la place de l'opérateur.
 */
export function createProfileDir(dataDir: string, slug: string): string {
  const safe = slug
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  if (!safe) throw new Error('Nom de profil vide après normalisation');
  const dir = join(profilesDir(dataDir), safe);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Commande à exécuter par l'opérateur pour authentifier un profil. */
export function loginCommand(configDir: string): string {
  return `CLAUDE_CONFIG_DIR=${configDir} claude auth login`;
}

/**
 * Sonde complète : binaire, version, profils connus.
 *
 * Les profils explorés sont ceux que Maestro a créés, plus le profil par
 * défaut. On ne balaie pas le disque à la recherche d'autres répertoires de
 * configuration : ce serait lent, et surtout indiscret.
 */
export async function probeClaude(dataDir: string): Promise<ProviderProbe> {
  const binaryPath = await resolveBinary('claude');
  if (!binaryPath) {
    return {
      kind: 'claude-sdk',
      label: PROVIDER_LABELS['claude-sdk'],
      binaryPath: null,
      version: null,
      detectedProfiles: [],
      envCandidates: envCandidates(),
      ready: false,
      hint: 'Le binaire « claude » est absent du PATH du serveur Maestro.',
      invocation: null,
      invocationDegraded: false,
    };
  }

  let version: string | null = null;
  try {
    const { stdout } = await exec('claude', ['--version'], { timeout: 10_000 });
    version = stdout.trim().split('\n')[0] ?? null;
  } catch {
    version = null;
  }

  const candidates: (string | null)[] = [null];
  const dir = profilesDir(dataDir);
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(dir, entry.name));
    }
  }

  const detected: DetectedProfile[] = [];
  for (const candidate of candidates) {
    const profile = await readAuthStatus(candidate);
    if (profile) detected.push(profile);
  }

  const loggedIn = detected.filter((p) => p.loggedIn).length;
  return {
    kind: 'claude-sdk',
    label: PROVIDER_LABELS['claude-sdk'],
    binaryPath,
    version,
    detectedProfiles: detected,
    envCandidates: envCandidates(),
    ready: loggedIn > 0 || envCandidates().length > 0,
    hint:
      loggedIn > 0
        ? null
        : 'Aucun profil authentifié : lance `claude auth login`, ou déclare un compte sur clé d’API.',
    /* Ce fournisseur ne passe pas par une ligne de commande construite par
       Maestro : le SDK pilote la session lui-même. */
    invocation: null,
    invocationDegraded: false,
  };
}

/** Noms de variables susceptibles de porter une authentification Anthropic. */
function envCandidates(): string[] {
  return ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].filter((name) =>
    Boolean(process.env[name]),
  );
}
