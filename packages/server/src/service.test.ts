/**
 * Tests de l'installation en service.
 *
 * Ce qui doit tenir, parce qu'une erreur ici ne se voit qu'au prochain
 * redémarrage de la machine — c'est-à-dire trop tard :
 *
 * - le service repart sur **le même Node** que celui qui l'a installé, pas sur
 *   celui qu'un PATH réduit trouverait par hasard ;
 * - il écoute sur la **boucle locale**, pas sur toutes les interfaces ;
 * - **aucun secret** n'entre dans le fichier d'unité, lisible par les autres
 *   utilisateurs de la machine ;
 * - un arrêt demandé n'est **pas** relancé, sinon le service devient
 *   impossible à arrêter.
 */
import { describe, expect, it } from 'vitest';
import {
  currentContext,
  execArgs,
  launchAgentPlist,
  logPath,
  plistPath,
  systemdUnit,
  unitPath,
  type ServiceContext,
} from './service.ts';

function ctx(overrides: Partial<ServiceContext> = {}): ServiceContext {
  return currentContext({
    repoDir: '/opt/maestro',
    nodePath: '/usr/local/n/versions/node/22.23.2/bin/node',
    envFile: '/opt/maestro/.env',
    home: '/home/alice',
    user: 'alice',
    ...overrides,
  });
}

describe('invocation', () => {
  it('lance le même Node que celui de l’installation', () => {
    /* Une machine porte souvent plusieurs versions ; l'environnement d'un
       service est trop réduit pour retrouver la bonne par le PATH. */
    expect(execArgs(ctx())[0]).toBe('/usr/local/n/versions/node/22.23.2/bin/node');
  });

  it('charge le dotenv sans exiger qu’il existe', () => {
    // Une installation sans dotenv est valide ; --env-file ferait échouer le
    // démarrage là où --env-file-if-exists laisse passer.
    const args = execArgs(ctx());
    expect(args).toContain('--env-file-if-exists=/opt/maestro/.env');
    expect(args).not.toContain('--env-file=/opt/maestro/.env');
  });

  it('passe par --import tsx, sans dépendre d’un chemin interne', () => {
    /* Le binaire node_modules/.bin/tsx interdirait les options de Node — dont
       le chargement du dotenv — et un chemin dans tsx/dist changerait de version
       en version. */
    const args = execArgs(ctx());
    expect(args).toContain('--import');
    expect(args).toContain('tsx');
    expect(args.at(-1)).toBe('/opt/maestro/packages/server/src/index.ts');
  });
});

describe('unité systemd', () => {
  const unit = systemdUnit(ctx());

  it('s’installe pour l’utilisateur, pas pour le système', () => {
    /* Maestro réutilise l'authentification Claude du répertoire personnel :
       une unité système sous root n'aurait aucun abonnement. */
    expect(unitPath(ctx())).toBe('/home/alice/.config/systemd/user/maestro.service');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toContain('multi-user.target');
  });

  it('écoute sur la boucle locale', () => {
    expect(unit).toContain('Environment=MAESTRO_HOST=127.0.0.1');
  });

  it('ne relance pas un arrêt demandé', () => {
    // Restart=always rendrait « systemctl stop » sans effet durable.
    expect(unit).toContain('Restart=on-failure');
    expect(unit).not.toContain('Restart=always');
  });

  it('laisse le temps à un arrêt propre', () => {
    expect(unit).toContain('KillSignal=SIGTERM');
    expect(unit).toContain('TimeoutStopSec=30');
  });

  it('attend un réseau joignable, pas seulement configuré', () => {
    expect(unit).toContain('After=network-online.target');
    expect(unit).toContain('Wants=network-online.target');
  });

  it('ne contient aucun secret', () => {
    /* Un fichier d'unité est lisible par les autres utilisateurs : les
       variables sensibles restent dans le dotenv, chargé par Node. */
    const suspicious = ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN', 'MAESTRO_TOKEN', 'WEBHOOK_URL'];
    for (const name of suspicious) expect(unit).not.toContain(name);
  });
});

describe('LaunchAgent macOS', () => {
  const plist = launchAgentPlist(ctx());

  it('se pose dans les LaunchAgents de l’utilisateur', () => {
    expect(plistPath(ctx())).toBe('/home/alice/Library/LaunchAgents/fr.cerfrance.maestro.plist');
  });

  it('reproduit le « on-failure » de systemd', () => {
    // Un KeepAlive inconditionnel relancerait le service après un unload.
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<false/>');
  });

  it('journalise dans un fichier, launchd n’ayant pas de journal', () => {
    expect(plist).toContain(logPath(ctx()));
  });

  it('n’inline aucun secret : launchd n’a pas d’EnvironmentFile', () => {
    /* C'est Node qui charge le dotenv, ce qui évite d'écrire des secrets dans
       un plist en clair. */
    expect(plist).toContain('MAESTRO_HOST');
    expect(plist).not.toContain('ANTHROPIC_API_KEY');
  });

  it('échappe le XML des chemins', () => {
    const exotic = launchAgentPlist(ctx({ repoDir: '/opt/maestro & co' }));
    expect(exotic).toContain('/opt/maestro &amp; co');
  });
});

describe('contexte déduit', () => {
  it('repère la racine du dépôt depuis l’emplacement du module', () => {
    // Sans cela, l'unité pointerait sur le répertoire courant du shell qui a
    // lancé l'installation — n'importe où.
    const real = currentContext();
    expect(real.entry).toBe('packages/server/src/index.ts');
    expect(real.repoDir.endsWith('/packages')).toBe(false);
    expect(real.envFile.endsWith('/.env')).toBe(true);
  });
});
