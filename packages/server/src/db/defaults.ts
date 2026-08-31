/**
 * Valeurs par défaut des réglages, et clés des états rangés à part.
 *
 * 🔒 Un défaut est une décision de produit : `retentionDays: null` ne purge
 * rien, `notifyAllRuns: false` ne publie rien. Les regrouper ici les rend
 * lisibles d'un coup d'œil, au lieu d'être noyés au milieu du schéma.
 */
import type { OnboardingState, Settings } from '@maestro/shared';

export const DEFAULT_SETTINGS: Settings = {
  instanceName: 'Maestro',
  notifyAllRuns: false,
  approvalTimeoutSec: 900,
  maxConcurrentRuns: 4,
  maxAgentDepth: 2,
  fullTrajectoryCapture: false,
  /*
   * Rétention illimitée par défaut.
   *
   * Une purge automatique sur une base existante détruirait des transcripts que
   * personne n'a demandé à perdre. C'est un réglage qu'on active en connaissance
   * de cause ; l'interface indique la taille de la base pour que la décision se
   * prenne sur un chiffre.
   */
  retentionDays: null,
  defaultResiliencePolicyId: null,
};

/**
 * État de l'assistant de configuration.
 *
 * Rangé dans la table `settings` sous une clé dédiée plutôt que dans `Settings` :
 * c'est un état de parcours, pas un réglage. Le mélanger aux réglages
 * l'exposerait à être réinitialisé par un formulaire qui n'en sait rien.
 */
export const ONBOARDING_KEY = 'onboarding';

/** Configuration du battement de cœur, rangée à côté de l'onboarding. */
export const HEARTBEAT_KEY = 'heartbeat';

export const DEFAULT_ONBOARDING: OnboardingState = {
  completed: false,
  step: 'welcome',
  completedAt: null,
  skipped: [],
};
