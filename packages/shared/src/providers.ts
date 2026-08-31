/**
 * Fournisseurs d'exécution, comptes et résilience.
 *
 * Maestro n'exécute plus « une session Claude Code » mais « une tentative sur
 * un compte d'un fournisseur ». Cette indirection est ce qui rend possibles le
 * repli sur un autre compte, la bascule vers un autre outil, et l'attente d'une
 * fenêtre de quota — trois réponses différentes à trois échecs différents,
 * qu'un simple `retry` confondrait.
 *
 * Convention : toutes les dates sont des chaînes ISO 8601 UTC.
 */

// ---------------------------------------------------------------------------
// Fournisseurs
// ---------------------------------------------------------------------------

/**
 * Acteur capable d'exécuter une tentative.
 *
 * `claude-sdk` est le seul à conserver les garanties historiques de Maestro :
 * permissions interceptées (`canUseTool`), streaming fin, coût réel. Les
 * moteurs CLI tiers exécutent le travail mais rendent la politique
 * d'approbation *déclarative* — c'est une perte de contrôle, affichée comme
 * telle dans l'interface plutôt que masquée.
 *
 * `http-api` n'a ni workspace ni outils fichiers : c'est un repli de rédaction
 * et de synthèse, pas un moteur de codage.
 */
export type ProviderKind = 'claude-sdk' | 'codex-cli' | 'opencode-cli' | 'http-api';

export const PROVIDER_KINDS: readonly ProviderKind[] = [
  'claude-sdk',
  'codex-cli',
  'opencode-cli',
  'http-api',
];

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  'claude-sdk': 'Claude Code',
  'codex-cli': 'Codex CLI',
  'opencode-cli': 'OpenCode CLI',
  'http-api': 'API HTTP',
};

/** Ce que le fournisseur sait faire — sert à prévenir avant de basculer. */
export interface ProviderCapabilities {
  /** Les demandes d'outils passent par le broker d'approbation Maestro. */
  interceptsPermissions: boolean;
  /** Le transcript distingue texte, réflexion, appels d'outils et résultats. */
  streamsToolCalls: boolean;
  /** Le fournisseur rend un coût en dollars exploitable. */
  reportsCost: boolean;
  /** Une session peut être reprise par identifiant chez ce fournisseur. */
  resumesSession: boolean;
  /** Le fournisseur agit sur les fichiers du workspace. */
  editsWorkspace: boolean;
}

export const PROVIDER_CAPABILITIES: Record<ProviderKind, ProviderCapabilities> = {
  'claude-sdk': {
    interceptsPermissions: true,
    streamsToolCalls: true,
    reportsCost: true,
    resumesSession: true,
    editsWorkspace: true,
  },
  'codex-cli': {
    interceptsPermissions: false,
    streamsToolCalls: true,
    reportsCost: false,
    resumesSession: false,
    editsWorkspace: true,
  },
  'opencode-cli': {
    interceptsPermissions: false,
    streamsToolCalls: false,
    reportsCost: false,
    resumesSession: false,
    editsWorkspace: true,
  },
  /* `reportsCost: false` : l'API rend des tokens, pas des dollars. Calculer un
     coût demanderait une table de prix par modèle et par service, qui vieillit
     mal — mieux vaut annoncer zéro que facturer faux. */
  'http-api': {
    interceptsPermissions: false,
    streamsToolCalls: false,
    reportsCost: false,
    resumesSession: false,
    editsWorkspace: false,
  },
};

/**
 * Invocation non interactive proposée par défaut pour les moteurs CLI.
 *
 * À confronter à la version installée : c'est le rôle du bouton « tester » de
 * l'assistant de configuration. Une commande fausse échoue immédiatement, avec
 * son stderr — plutôt que de laisser croire à un fournisseur disponible.
 */
export const CLI_DEFAULTS: Partial<
  Record<ProviderKind, { command: string; args: string[]; note: string }>
> = {
  'codex-cli': {
    command: 'codex',
    args: ['exec', '--json', '--skip-git-repo-check', '--model', '{{model}}', '{{prompt}}'],
    note: 'Sortie attendue en JSON par ligne sur stdout.',
  },
  'opencode-cli': {
    command: 'opencode',
    args: ['run', '--model', '{{model}}', '{{prompt}}'],
    note: 'Sortie texte brut ; le transcript sera plus grossier qu’avec le SDK.',
  },
};

/** Racines d'API par défaut selon le dialecte d'un compte `http-api`. */
export const API_BASE_URLS: Record<ApiFlavor, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
};

// ---------------------------------------------------------------------------
// Comptes
// ---------------------------------------------------------------------------

/**
 * Comment une tentative s'authentifie.
 *
 * - `profile` : un répertoire de configuration dédié (`CLAUDE_CONFIG_DIR`), qui
 *   porte sa propre session d'abonnement. C'est le mécanisme du multi-comptes
 *   Claude : deux profils = deux quotas.
 * - `api-key-env` : le **nom** d'une variable d'environnement du serveur. La
 *   valeur n'entre jamais en base ni dans une réponse d'API — même règle que
 *   pour les clés d'embeddings du RAG.
 * - `inherit` : l'environnement ambiant du serveur, c'est-à-dire le
 *   comportement historique de Maestro avant les comptes.
 */
export type ProviderAuthMode = 'profile' | 'api-key-env' | 'inherit';

/** Dialecte HTTP d'un compte `http-api`. */
export type ApiFlavor = 'anthropic' | 'openai';

/**
 * Santé d'un compte, telle que le routeur la voit au moment de choisir.
 *
 * `cooldown` et `exhausted` diffèrent par l'horizon : le premier se rouvre en
 * secondes (429 ponctuel), le second à une heure connue ou inconnue (quota
 * d'abonnement). Les confondre ferait attendre des heures pour une saturation
 * passagère, ou marteler un compte épuisé.
 */
export type ProviderHealth =
  'unknown' | 'ready' | 'cooldown' | 'exhausted' | 'unauthenticated' | 'error' | 'disabled';

export interface ProviderAccount {
  id: string;
  /** Libellé opérateur (« Claude perso », « Claude équipe », « OpenRouter »). */
  name: string;
  kind: ProviderKind;
  enabled: boolean;
  authMode: ProviderAuthMode;
  /** `profile` : répertoire de configuration dédié. */
  configDir: string | null;
  /** `api-key-env` : nom de la variable d'environnement. Jamais sa valeur. */
  apiKeyEnv: string | null;
  /** `http-api` : racine de l'API (défaut selon le dialecte). */
  baseUrl: string | null;
  apiFlavor: ApiFlavor | null;
  /** Modèle imposé par ce compte ; null = celui de l'agent ou de la cible. */
  model: string | null;
  /**
   * `*-cli` : commande à lancer. `null` = valeur par défaut de l'adaptateur.
   *
   * Ces valeurs par défaut sont des **propositions**, pas un contrat : les
   * options non interactives de Codex et d'OpenCode changent d'une version à
   * l'autre, et Maestro ne peut pas les vérifier sans le binaire. Rendre la
   * commande éditable coûte un champ et évite de livrer un adaptateur qui
   * échouera silencieusement sur la version d'à côté.
   */
  command: string | null;
  /** Gabarit d'arguments ; variables {{prompt}}, {{model}}, {{cwd}}. */
  args: string[] | null;
  /** Variables d'environnement supplémentaires, non secrètes (proxy, région…). */
  env: Record<string, string>;
  /** Ordre de préférence global ; le plus petit gagne à politique égale. */
  priority: number;
  /**
   * Plafond de dépense quotidien en dollars. Atteint, le compte devient
   * `exhausted` jusqu'à la fin de la journée — un garde-fou de facture, pas un
   * quota fournisseur.
   */
  dailyCostLimitUsd: number | null;
  health: ProviderHealth;
  /** Instant de réouverture quand `health` vaut `cooldown` ou `exhausted`. */
  cooldownUntil: string | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  /** Résumé lisible issu de la dernière sonde (« abonnement team », « binaire absent »). */
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProviderAccountCreate = Omit<
  ProviderAccount,
  | 'id'
  | 'health'
  | 'cooldownUntil'
  | 'lastError'
  | 'lastCheckedAt'
  | 'detail'
  | 'createdAt'
  | 'updatedAt'
>;

// ---------------------------------------------------------------------------
// Classification des échecs
// ---------------------------------------------------------------------------

/**
 * Nature d'un échec de tentative. C'est la pièce maîtresse : la réponse
 * (réessayer, attendre, basculer, abandonner) découle entièrement d'elle.
 */
export type FailureClass =
  /** Limite d'usage d'un abonnement ou d'une organisation ; horizon en heures. */
  | 'quota'
  /** Saturation ponctuelle (429) ; horizon en secondes. */
  | 'rate_limit'
  /** Fournisseur surchargé ou indisponible (503/529). */
  | 'overloaded'
  /** Authentification invalide, expirée ou absente. Réessayer ne sert à rien. */
  | 'auth'
  /** Fenêtre de contexte dépassée : il faut résumer, pas réessayer à l'identique. */
  | 'context'
  /** Réseau, coupure, DNS, délai d'appel. */
  | 'transient'
  /** Garde-fou Maestro atteint (tokens, tours, coût) — pas un incident fournisseur. */
  | 'budget'
  /** Annulation humaine ou arrêt du serveur. */
  | 'cancelled'
  /** Tout le reste : erreur applicative, prompt refusé, bug. */
  | 'fatal';

/** Décision du routeur pour la tentative suivante. */
export type RecoveryAction = 'retry_same' | 'wait_then_retry' | 'switch_account' | 'give_up';

export interface FailureVerdict {
  klass: FailureClass;
  /** Message d'origine, tronqué, tel qu'affiché dans le transcript. */
  message: string;
  /**
   * Réouverture annoncée par le fournisseur, quand il la donne (« resets at 5pm »).
   * Absente, l'attente retombe sur le backoff, jamais sur une durée devinée.
   */
  retryAfterMs: number | null;
  /** Vrai si le compte doit être marqué indisponible au-delà de cette tentative. */
  poisonsAccount: boolean;
}

// ---------------------------------------------------------------------------
// Politique de résilience
// ---------------------------------------------------------------------------

/** Une cible = un compte, éventuellement avec un modèle imposé. */
export interface ResilienceTarget {
  accountId: string;
  model: string | null;
}

/**
 * Politique nommée, réutilisable par plusieurs agents et étapes de pipeline.
 *
 * Elle décrit un ordre de préférence et des bornes, pas une suite d'actions :
 * c'est la classification de l'échec qui choisit l'action, la politique qui
 * dit jusqu'où aller.
 */
export interface ResiliencePolicy {
  id: string;
  name: string;
  description: string;
  /** Ordre de préférence. Vide = environnement ambiant, comme avant les comptes. */
  targets: ResilienceTarget[];
  /** Tentatives sur une même cible avant de passer à la suivante. */
  maxAttemptsPerTarget: number;
  /** Plafond absolu de tentatives, bascules comprises. */
  maxTotalAttempts: number;
  backoffInitialMs: number;
  backoffFactor: number;
  backoffMaxMs: number;
  /** Bruit aléatoire sur l'attente : évite que N runs repartent à la même seconde. */
  backoffJitter: boolean;
  /**
   * Attente maximale acceptée pour une réouverture de quota annoncée. Au-delà,
   * on bascule plutôt que d'immobiliser un run pendant des heures.
   */
  quotaWaitMaxSec: number;
  /** Basculer de compte sur un échec qui n'est pas un quota (réseau, surcharge). */
  switchOnError: boolean;
  /**
   * Pourcentage du budget de tokens à partir duquel un résumé de reprise est
   * capturé, avant le blocage. 0 désactive la capture anticipée — le filet de
   * sécurité, lui, reste toujours actif.
   */
  handoffThresholdPct: number;
  createdAt: string;
  updatedAt: string;
}

export type ResiliencePolicyCreate = Omit<ResiliencePolicy, 'id' | 'createdAt' | 'updatedAt'>;

// ---------------------------------------------------------------------------
// Tentatives
// ---------------------------------------------------------------------------

export type AttemptStatus = 'running' | 'succeeded' | 'failed';

/**
 * Une tentative d'exécution d'un run sur une cible donnée.
 *
 * Le nom du compte est dénormalisé : un historique qui perdrait la trace d'une
 * bascule le jour où le compte est supprimé ne servirait plus à comprendre ce
 * qui s'est passé.
 */
export interface RunAttempt {
  id: number;
  runId: string;
  /** 1 pour la première tentative. */
  index: number;
  accountId: string | null;
  accountName: string;
  providerKind: ProviderKind;
  model: string;
  status: AttemptStatus;
  failureClass: FailureClass | null;
  error: string | null;
  /** Attente appliquée avant de démarrer cette tentative. */
  waitedMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
}

// ---------------------------------------------------------------------------
// Handoff — reprise sur un autre moteur
// ---------------------------------------------------------------------------

export type HandoffReason = 'threshold' | 'quota' | 'context' | 'switch' | 'manual';

/**
 * Résumé de session permettant de reprendre le travail ailleurs.
 *
 * Une reprise sur le même compte réutilise l'identifiant de session du
 * fournisseur ; une reprise ailleurs n'a rien à reprendre — d'où ce résumé,
 * réinjecté en préambule du prompt.
 */
export interface SessionHandoff {
  id: string;
  runId: string;
  agentId: string;
  reason: HandoffReason;
  /** Texte réinjectable tel quel. */
  summary: string;
  /**
   * Vrai quand le résumé a été reconstruit mécaniquement depuis les événements
   * du run, faute de fournisseur disponible pour le rédiger. C'est le cas
   * fréquent : quand tous les comptes sont en quota, plus personne ne peut
   * résumer. Un résumé dégradé vaut mieux qu'une reprise à l'aveugle, mais il
   * doit être signalé comme tel.
   */
  degraded: boolean;
  sourceKind: ProviderKind;
  sourceAccountId: string | null;
  sourceSessionId: string | null;
  tokensAtCapture: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Sonde & onboarding
// ---------------------------------------------------------------------------

/** Profil d'authentification découvert sur la machine. */
export interface DetectedProfile {
  configDir: string;
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
  /** Identifiant du compte tel que rendu par l'outil (courriel, organisation). */
  account: string | null;
}

export interface ProviderProbe {
  kind: ProviderKind;
  label: string;
  /** Chemin du binaire dans le PATH, null s'il est absent. */
  binaryPath: string | null;
  version: string | null;
  detectedProfiles: DetectedProfile[];
  /**
   * Noms des variables d'environnement pertinentes présentes sur le serveur.
   * Les noms seulement — exposer la valeur reviendrait à publier la clé.
   */
  envCandidates: string[];
  /** Utilisable en l'état, sans configuration supplémentaire. */
  ready: boolean;
  /** Ce qui manque, en une phrase actionnable. */
  hint: string | null;
}

export type OnboardingStep = 'welcome' | 'providers' | 'accounts' | 'policy' | 'done';

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  'welcome',
  'providers',
  'accounts',
  'policy',
  'done',
];

export interface OnboardingState {
  completed: boolean;
  step: OnboardingStep;
  completedAt: string | null;
  /** Étapes explicitement passées, pour ne pas les reproposer. */
  skipped: OnboardingStep[];
}
