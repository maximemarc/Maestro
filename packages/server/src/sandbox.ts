/**
 * Confinement d'un agent.
 *
 * Maestro ne réimplémente pas d'isolation : Claude Code en a une, et c'est la
 * bonne — isolation du système de fichiers par chemin, filtrage de l'egress
 * réseau, seccomp. Ce module traduit la configuration d'un agent en réglages
 * pour le SDK, et rien d'autre.
 *
 * Le choix de ne pas envelopper chaque session dans un conteneur est délibéré.
 * Le SDK lance le binaire `claude` en sous-processus local ; l'intercepter pour
 * le faire tourner dans un conteneur signifierait réimplémenter le transport,
 * les permissions interceptées et le passage des serveurs MCP par-dessus une
 * frontière de conteneur. Le bac à sable natif offre les mêmes garanties de
 * confinement, plus finement, sans image à construire ni démon à faire tourner.
 * Qui veut malgré tout un conteneur enveloppe l'instance entière — voir le
 * Dockerfile et sa section du README.
 */
import { join } from 'node:path';
import type { AgentSandbox } from '@maestro/shared';

/**
 * Réglages tels que le SDK les attend.
 *
 * Décrit ici plutôt qu'importé : le type du SDK est une structure anonyme
 * profondément imbriquée, dont on n'emploie qu'une petite part. La signature
 * d'index est celle du SDK — il tolère des clés qu'il ne documente pas — et
 * sans elle l'objet n'est pas assignable à ses options. Elle affaiblit le
 * contrôle sur ce type précis ; c'est le prix de l'assignabilité, et les
 * champs nommés en dessous restent, eux, contrôlés.
 */
export interface SandboxSettings {
  [key: string]: unknown;
  enabled: true;
  failIfUnavailable: boolean;
  network: {
    allowedDomains: string[];
    strictAllowlist: boolean;
  };
  filesystem: {
    allowWrite: string[];
    denyRead: string[];
  };
}

export const DEFAULT_SANDBOX: AgentSandbox = {
  enabled: false,
  failIfUnavailable: false,
  allowedDomains: [],
  strictAllowlist: true,
  allowWrite: [],
  denyRead: [],
};

/**
 * Chemins que le confinement protège toujours.
 *
 * Le jeton donne un accès complet à l'API de Maestro, et la base contient tout
 * — agents, transcripts, approbations, jeux de données. Un agent confiné qui
 * pourrait les lire contournerait son propre confinement en une commande : il
 * lui suffirait d'appeler l'API avec le jeton pour se faire lancer un run non
 * confiné. Ces deux chemins ne sont donc pas négociables par configuration.
 */
export function alwaysProtected(dataDir: string): string[] {
  return [join(dataDir, 'token'), join(dataDir, 'maestro.db')];
}

/**
 * Traduit la configuration d'un agent en réglages SDK.
 *
 * Rend `undefined` quand le confinement est absent ou désactivé : l'appelant
 * n'ajoute alors rien aux options, et le comportement est identique à celui
 * d'avant l'existence de ce module.
 */
export function buildSandboxSettings(
  sandbox: AgentSandbox | null,
  opts: { dataDir: string },
): SandboxSettings | undefined {
  if (!sandbox?.enabled) return undefined;

  /*
   * Doublons écartés, ordre conservé.
   *
   * Les chemins protégés viennent en tête : ils ne dépendent pas de l'agent, et
   * les voir d'abord dans un journal de débogage dit tout de suite que la
   * protection systématique est bien là.
   */
  const denyRead = [...new Set([...alwaysProtected(opts.dataDir), ...sandbox.denyRead])].filter(
    (p) => p.trim().length > 0,
  );
  const allowWrite = [...new Set(sandbox.allowWrite)].filter((p) => p.trim().length > 0);
  const allowedDomains = [...new Set(sandbox.allowedDomains)].filter((d) => d.trim().length > 0);

  return {
    enabled: true,
    failIfUnavailable: sandbox.failIfUnavailable,
    network: { allowedDomains, strictAllowlist: sandbox.strictAllowlist },
    filesystem: { allowWrite, denyRead },
  };
}

/**
 * Résumé lisible d'un confinement, pour le journal au démarrage d'un run.
 *
 * Un confinement actif change ce que l'agent peut faire : le taire rendrait
 * incompréhensible une commande qui échoue pour cause de réseau coupé.
 */
export function describeSandbox(settings: SandboxSettings | undefined): string | null {
  if (!settings) return null;
  const network =
    settings.network.allowedDomains.length === 0
      ? 'réseau coupé'
      : `réseau limité à ${settings.network.allowedDomains.join(', ')}`;
  const write =
    settings.filesystem.allowWrite.length === 0
      ? 'écriture au workspace'
      : `écriture au workspace + ${settings.filesystem.allowWrite.length} chemin(s)`;
  const mode = settings.failIfUnavailable ? 'exigé' : 'au mieux';
  return `bac à sable ${mode} — ${network}, ${write}`;
}
