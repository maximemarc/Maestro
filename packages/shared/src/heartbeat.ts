/**
 * Battement de cœur : l'autonomie proactive de l'orchestrateur.
 *
 * Une routine cron **déclenche** un prompt écrit d'avance. Un battement, lui,
 * **fait délibérer** : Maestro dresse un état des lieux, le confie à un agent
 * avec ses consignes permanentes, et cet agent décide s'il y a lieu d'agir — ou
 * de ne rien faire. La différence tient dans le dernier point : un cron agit
 * toujours, un battement peut conclure que tout va bien.
 *
 * ## Ce que ça engage, dit avant tout le reste
 *
 * 🔒 Un orchestrateur qui délibère **dépense des tokens de sa propre
 * initiative**, sans que personne n'ait rien demandé. C'est un changement de
 * nature, pas une commodité de plus. Les garde-fous ci-dessous ne sont donc pas
 * décoratifs : ils sont la condition pour que la fonctionnalité soit
 * acceptable.
 *
 * - **désactivé par défaut**, et il le reste jusqu'à un geste explicite ;
 * - un **agent dédié**, dont la politique d'approbation et les outils autorisés
 *   bornent ce que la délibération peut faire ;
 * - un **plancher de fréquence** : battre toutes les minutes coûterait plus que
 *   ce que la délibération rapporte ;
 * - un **plafond quotidien** de battements ;
 * - **le budget de tokens de l'agent** fait office de plafond par battement —
 *   un battement *est* un run, inutile d'inventer un second compteur ;
 * - **rien pendant qu'un run tourne** : empiler une délibération sur du travail
 *   en cours produit des décisions prises sur un état déjà périmé.
 */

/** Ce qu'un battement a produit. */
export type BeatOutcome =
  /** L'agent a agi : carte créée, délégation lancée, mémoire écrite. */
  | 'acted'
  /** L'agent a conclu qu'il n'y avait rien à faire. C'est un succès. */
  | 'idle'
  /** Un garde-fou a empêché le battement. Aucun token dépensé. */
  | 'skipped'
  | 'failed';

export interface HeartbeatConfig {
  enabled: boolean;
  /** Agent qui délibère. `null` = non configuré, le battement ne part pas. */
  agentId: string | null;
  /** Rythme, en expression cron. */
  cronExpr: string;
  /** Plafond de battements par jour, garde-fou de facture. */
  dailyMax: number;
  /**
   * Ne pas battre pendant qu'un run tourne.
   *
   * Recommandé : une délibération lancée au milieu d'un travail en cours juge
   * un état qui aura changé avant qu'elle ne conclue.
   */
  skipWhenBusy: boolean;
  /**
   * Ne pas battre quand le compte du fournisseur approche de sa limite.
   *
   * Le travail demandé par un humain passe avant la délibération spontanée :
   * consommer la fin d'un quota pour un battement serait le pire arbitrage.
   */
  skipUnderQuotaPressure: boolean;
  updatedAt: string;
}

export const HEARTBEAT_DEFAULTS: HeartbeatConfig = {
  enabled: false,
  agentId: null,
  /* Toutes les heures : assez pour réagir dans la journée, assez rare pour que
     le coût reste marginal. */
  cronExpr: '0 * * * *',
  dailyMax: 24,
  skipWhenBusy: true,
  skipUnderQuotaPressure: true,
  updatedAt: '',
};

/** Intervalle minimal entre deux battements, en secondes. */
export const HEARTBEAT_MIN_INTERVAL_SEC = 300;

export interface Beat {
  id: number;
  at: string;
  outcome: BeatOutcome;
  /** Motif d'un saut, ou d'un échec. */
  reason: string | null;
  /** Run de délibération ; `null` quand le battement a été sauté. */
  runId: string | null;
  /**
   * Ce que l'agent dit avoir fait.
   *
   * Conservé et **réinjecté dans les battements suivants** : sans cette
   * mémoire, un agent recrée la même carte kanban à chaque heure, faute de
   * savoir qu'il l'a déjà créée. C'est le mode d'échec principal de ce genre de
   * boucle.
   */
  summary: string | null;
}

/** État des lieux confié à l'agent, tel qu'il apparaît aussi dans l'interface. */
export interface SituationReport {
  at: string;
  activeRuns: number;
  queuedRuns: number;
  pendingApprovals: number;
  /** Cartes par colonne du kanban. */
  tasksByColumn: Record<string, number>;
  /** Runs terminés en échec depuis le battement précédent. */
  recentFailures: { runId: string; agentName: string; error: string }[];
  /** Comptes dont la fenêtre de consommation est chargée. */
  pressuredAccounts: { name: string; pressurePct: number }[];
  /** Derniers battements, pour que l'agent sache ce qu'il a déjà fait. */
  previousBeats: { at: string; outcome: BeatOutcome; summary: string | null }[];
}
