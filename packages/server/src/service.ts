/**
 * Installation de Maestro comme service géré par le système.
 *
 * Maestro est un orchestrateur : il doit tourner en continu, survivre à une
 * fermeture de terminal et repartir après un redémarrage. Jusqu'ici il se
 * lançait à la main, ce qui contredisait sa propre promesse — un cron qui ne
 * tourne que quand une fenêtre est ouverte ne surveille rien.
 *
 * ## Le choix qui structure tout : un service *utilisateur*, pas système
 *
 * Maestro réutilise l'authentification Claude de la machine, qui vit dans le
 * répertoire personnel de l'utilisateur (`~/.claude`, ou les profils de comptes
 * sous `<dataDir>/accounts`). Une unité système tournant sous `root` ou sous un
 * compte de service n'aurait accès à aucun abonnement : elle démarrerait, puis
 * échouerait sur « Not logged in » à chaque run.
 *
 * D'où une unité `systemd --user` sous Linux et un LaunchAgent sous macOS. La
 * contrepartie, dite franchement : un service utilisateur s'arrête à la
 * déconnexion, sauf si l'on active la persistance (`loginctl enable-linger`).
 * L'installateur le fait, et le rappelle.
 *
 * 🔒 Deux garde-fous portés par l'unité générée :
 *
 * - `MAESTRO_HOST=127.0.0.1` — un service qui démarre au boot et écoute sur
 *   toutes les interfaces exposerait son API à tout le réseau derrière un seul
 *   jeton. Publier se fait par un reverse proxy, délibérément.
 * - **aucun secret n'est écrit dans l'unité.** Les variables sensibles restent
 *   dans le fichier dotenv du dépôt, chargé au démarrage par Node lui-même.
 *   Les inscrire dans l'unité les rendrait lisibles par tout utilisateur de la
 *   machine — un fichier d'unité n'est pas un coffre.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** Nom du service, commun aux deux plateformes. */
export const SERVICE_NAME = 'maestro';
/** Étiquette LaunchAgent : convention d'un identifiant inversé. */
export const LAUNCH_LABEL = 'fr.cerfrance.maestro';

export type SupportedPlatform = 'linux' | 'darwin';

export interface ServiceContext {
  /** Racine du dépôt, d'où le service est lancé. */
  repoDir: string;
  /** Binaire Node qui exécutera le service — celui-là même, pas un autre. */
  nodePath: string;
  /** Chemin du point d'entrée, relatif au dépôt. */
  entry: string;
  /** Fichier dotenv chargé s'il existe. */
  envFile: string;
  home: string;
  user: string;
}

/**
 * Contexte déduit de l'exécution courante.
 *
 * `process.execPath` et non `node` : la machine peut avoir plusieurs versions
 * installées, et le service doit repartir sur celle avec laquelle on l'a
 * installé — pas sur celle qu'un PATH de service, très réduit, trouverait par
 * hasard.
 */
export function currentContext(overrides: Partial<ServiceContext> = {}): ServiceContext {
  const repoDir = overrides.repoDir ?? resolve(import.meta.dirname, '..', '..', '..');
  return {
    repoDir,
    nodePath: overrides.nodePath ?? process.execPath,
    entry: overrides.entry ?? 'packages/server/src/index.ts',
    envFile: overrides.envFile ?? join(repoDir, '.env'),
    home: overrides.home ?? homedir(),
    user: overrides.user ?? userInfo().username,
  };
}

/**
 * Arguments de lancement, identiques sur les deux plateformes.
 *
 * `--import tsx` plutôt que le binaire `node_modules/.bin/tsx` : cela laisse
 * passer les options de Node — dont le chargement du dotenv — et ne dépend
 * d'aucun chemin interne à tsx, qui change d'une version à l'autre.
 *
 * `--env-file-if-exists` et non `--env-file` : une installation sans dotenv est
 * parfaitement valide, et Node refuse de démarrer si le fichier manque.
 */
export function execArgs(ctx: ServiceContext): string[] {
  return [
    ctx.nodePath,
    `--env-file-if-exists=${ctx.envFile}`,
    '--import',
    'tsx',
    join(ctx.repoDir, ctx.entry),
  ];
}

// ---------------------------------------------------------------------------
// systemd (Linux)
// ---------------------------------------------------------------------------

export function unitPath(ctx: ServiceContext): string {
  return join(ctx.home, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
}

export function systemdUnit(ctx: ServiceContext): string {
  return `[Unit]
Description=Maestro — poste de commandement d'agents IA
Documentation=file://${join(ctx.repoDir, 'README.md')}
# Un réseau simplement « configuré » ne suffit pas : Maestro joint des API dès
# son démarrage, et repartir avant que la route par défaut existe produit une
# première minute d'échecs inutiles.
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ctx.repoDir}
ExecStart=${execArgs(ctx).join(' ')}
Environment=NODE_ENV=production
# Un service exposé sur toutes les interfaces n'aurait que son jeton pour
# barrière. Ce qui doit être publié passe par un reverse proxy.
Environment=MAESTRO_HOST=127.0.0.1

# « on-failure » et non « always » : un arrêt demandé (systemctl stop) sort en
# code 0 et ne doit pas être relancé, sinon le service devient impossible à
# arrêter.
Restart=on-failure
RestartSec=5

# Maestro traite SIGTERM : il clôt ses sessions, ferme la base, puis sort. Le
# délai laisse ce travail se faire avant que systemd ne tue le processus.
KillSignal=SIGTERM
TimeoutStopSec=30

StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=default.target
`;
}

// ---------------------------------------------------------------------------
// LaunchAgent (macOS)
// ---------------------------------------------------------------------------

export function plistPath(ctx: ServiceContext): string {
  return join(ctx.home, 'Library', 'LaunchAgents', `${LAUNCH_LABEL}.plist`);
}

export function logPath(ctx: ServiceContext): string {
  return join(ctx.home, 'Library', 'Logs', `${SERVICE_NAME}.log`);
}

/**
 * LaunchAgent macOS.
 *
 * `KeepAlive` conditionnel sur `SuccessfulExit: false` reproduit le
 * `Restart=on-failure` de systemd : un arrêt propre reste un arrêt. Un
 * `KeepAlive` inconditionnel relancerait le service aussitôt après un
 * `launchctl unload`, ce qui donne l'impression d'un service increvable.
 *
 * launchd n'a pas d'équivalent d'`EnvironmentFile` : c'est Node qui charge le
 * dotenv, ce qui évite d'écrire des secrets dans un plist lisible par tous.
 */
export function launchAgentPlist(ctx: ServiceContext): string {
  const args = execArgs(ctx)
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(ctx.repoDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>MAESTRO_HOST</key>
    <string>127.0.0.1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath(ctx))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath(ctx))}</string>
</dict>
</plist>
`;
}

export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

export interface InstallReport {
  platform: SupportedPlatform;
  /** Fichier écrit. */
  file: string;
  /** Commandes lancées, dans l'ordre, pour que l'opérateur sache quoi défaire. */
  commands: string[];
  /** Avertissements — ce qui a échoué sans empêcher l'installation. */
  warnings: string[];
  hints: string[];
}

function detectPlatform(): SupportedPlatform {
  const current = platform();
  if (current === 'linux' || current === 'darwin') return current;
  throw new Error(
    `Plateforme « ${current} » non gérée : Maestro sait s'installer en service sous Linux (systemd) et macOS (launchd). ` +
      `Ailleurs, lance-le avec « npm start » et confie-le au gestionnaire de service de ton système.`,
  );
}

/** Écrit un fichier en créant son répertoire, sans écraser en silence. */
function writeUnit(path: string, content: string, warnings: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && readFileSync(path, 'utf8') !== content) {
    warnings.push(`Unité existante remplacée : ${path}`);
  }
  writeFileSync(path, content, { mode: 0o644 });
}

/**
 * Lance une commande d'administration du service.
 *
 * Un échec n'interrompt pas l'installation : le fichier d'unité, lui, est déjà
 * écrit et utilisable à la main. Sur une machine sans session utilisateur —
 * conteneur, connexion SSH sans `systemd --user` — `systemctl --user` échoue
 * alors que tout le reste est correct. Signaler valait mieux qu'abandonner.
 */
function tryRun(command: string, args: string[], report: InstallReport): void {
  report.commands.push(`${command} ${args.join(' ')}`);
  try {
    execFileSync(command, args, { stdio: 'pipe' });
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    report.warnings.push(`« ${command} ${args.join(' ')} » a échoué : ${detail}`);
  }
}

export function install(ctx = currentContext()): InstallReport {
  const target = detectPlatform();
  const report: InstallReport = {
    platform: target,
    file: '',
    commands: [],
    warnings: [],
    hints: [],
  };

  if (target === 'linux') {
    report.file = unitPath(ctx);
    writeUnit(report.file, systemdUnit(ctx), report.warnings);
    tryRun('systemctl', ['--user', 'daemon-reload'], report);
    tryRun('systemctl', ['--user', 'enable', '--now', `${SERVICE_NAME}.service`], report);
    /* Sans persistance, le service s'arrête à la déconnexion — ce qui vide de
       son sens l'idée d'un orchestrateur qui tourne en continu. */
    tryRun('loginctl', ['enable-linger', ctx.user], report);
    report.hints.push(
      `État   : systemctl --user status ${SERVICE_NAME}`,
      `Journal : journalctl --user -u ${SERVICE_NAME} -f`,
      `Arrêt  : systemctl --user stop ${SERVICE_NAME}`,
    );
  } else {
    report.file = plistPath(ctx);
    mkdirSync(dirname(logPath(ctx)), { recursive: true });
    writeUnit(report.file, launchAgentPlist(ctx), report.warnings);
    tryRun('launchctl', ['unload', report.file], report);
    tryRun('launchctl', ['load', '-w', report.file], report);
    report.hints.push(
      `État   : launchctl list | grep ${LAUNCH_LABEL}`,
      `Journal : tail -f ${logPath(ctx)}`,
      `Arrêt  : launchctl unload ${report.file}`,
    );
  }

  report.hints.push(
    `Le service écoute sur 127.0.0.1:${process.env.MAESTRO_PORT ?? 4520} — publie-le par un reverse proxy si besoin.`,
  );
  return report;
}

export function uninstall(ctx = currentContext()): InstallReport {
  const target = detectPlatform();
  const report: InstallReport = {
    platform: target,
    file: '',
    commands: [],
    warnings: [],
    hints: [],
  };

  if (target === 'linux') {
    report.file = unitPath(ctx);
    tryRun('systemctl', ['--user', 'disable', '--now', `${SERVICE_NAME}.service`], report);
    if (existsSync(report.file)) rmSync(report.file);
    tryRun('systemctl', ['--user', 'daemon-reload'], report);
    /* La persistance n'est pas retirée : elle peut servir à d'autres services
       de cet utilisateur, et la couper à leur place serait un effet de bord. */
    report.hints.push(
      `La persistance de session reste active. Pour la retirer : loginctl disable-linger ${ctx.user}`,
    );
  } else {
    report.file = plistPath(ctx);
    tryRun('launchctl', ['unload', report.file], report);
    if (existsSync(report.file)) rmSync(report.file);
  }

  report.hints.push('Les données de Maestro sont intactes : rien n’a été supprimé sous dataDir.');
  return report;
}

/**
 * État du service, tel que le gestionnaire le rapporte.
 *
 * Sans contexte : le nom du service suffit à l'interroger, et prendre un
 * contexte laisserait croire qu'on peut consulter l'état d'une autre
 * installation — ce que ni systemd ni launchd ne permettent par unité nommée.
 */
export function status(): string {
  const target = detectPlatform();
  try {
    if (target === 'linux') {
      return execFileSync('systemctl', ['--user', 'status', `${SERVICE_NAME}.service`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }
    return execFileSync('launchctl', ['list'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes(LAUNCH_LABEL))
      .join('\n');
  } catch (err) {
    /* `systemctl status` sort en code non nul quand le service est arrêté :
       ce n'est pas une panne de la commande, c'est sa réponse. */
    const failed = err as { stdout?: string; message?: string };
    return failed.stdout?.toString() || failed.message || 'Service non installé.';
  }
}

// ---------------------------------------------------------------------------
// Ligne de commande
// ---------------------------------------------------------------------------

const USAGE = `Usage : npm run service -- <commande>

  install     installe et démarre Maestro comme service utilisateur
  uninstall   arrête et retire le service (les données sont conservées)
  status      état rapporté par le gestionnaire de service
  print       affiche l'unité qui serait écrite, sans rien installer
`;

function printReport(report: InstallReport, action: string): void {
  console.log(`\n  ${action} — ${report.platform === 'linux' ? 'systemd (user)' : 'launchd'}`);
  console.log(`  Fichier : ${report.file}`);
  for (const command of report.commands) console.log(`  → ${command}`);
  for (const warning of report.warnings) console.log(`  ⚠ ${warning}`);
  for (const hint of report.hints) console.log(`  ${hint}`);
  console.log('');
}

/** Point d'entrée CLI, isolé pour rester testable. */
export function main(argv: string[]): number {
  const command = argv[2];
  try {
    switch (command) {
      case 'install':
        printReport(install(), 'Service installé');
        return 0;
      case 'uninstall':
        printReport(uninstall(), 'Service retiré');
        return 0;
      case 'status':
        console.log(status());
        return 0;
      case 'print': {
        const ctx = currentContext();
        console.log(platform() === 'darwin' ? launchAgentPlist(ctx) : systemdUnit(ctx));
        return 0;
      }
      default:
        console.log(USAGE);
        return command === undefined ? 0 : 1;
    }
  } catch (err) {
    console.error(`\n  ✖ ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/* Exécuté seulement en ligne de commande : importé par les tests, ce module ne
   doit rien lancer. */
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  process.exit(main(process.argv));
}
