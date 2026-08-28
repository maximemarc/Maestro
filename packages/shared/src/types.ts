/**
 * Modèle de domaine Maestro — partagé entre le serveur et le front.
 * Convention : toutes les dates sont des chaînes ISO 8601 UTC.
 */

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/** Alias de modèles acceptés par Claude Code ; une chaîne libre reste permise. */
export const MODEL_CHOICES = ['sonnet', 'opus', 'haiku'] as const;

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/**
 * Politique du broker d'approbations Maestro (par-dessus le permissionMode SDK) :
 * - 'auto'    : tout est approuvé automatiquement (journalisé) ;
 * - 'ask'     : chaque outil sensible attend une approbation humaine (web/Telegram) ;
 * - 'guarded' : lecture auto-approuvée, écriture/exécution demandent approbation.
 */
export type ApprovalPolicy = 'auto' | 'ask' | 'guarded';

export type AgentEngine = 'sdk' | 'tmux';

export interface AgentConfig {
  id: string;
  name: string;
  /** Emoji avatar affiché dans l'UI et le graphe. */
  emoji: string;
  description: string;
  /** Alias ('sonnet' | 'opus' | 'haiku') ou identifiant complet de modèle. */
  model: string;
  engine: AgentEngine;
  permissionMode: PermissionMode;
  approvalPolicy: ApprovalPolicy;
  /** Contenu du CLAUDE.md dédié, matérialisé dans le workspace de l'agent. */
  systemPrompt: string | null;
  /**
   * Nom d'une définition d'agent Claude Code native (~/.claude/agents, ex.
   * « symfony-expert »). Quand il est renseigné, la session s'exécute AVEC cette
   * définition : persona, restrictions d'outils, hooks et skills d'origine.
   * Moteur sdk → options.agent ; moteur tmux → claude --agent <nom>.
   */
  cliAgent: string | null;
  /**
   * Plugins Claude Code chargés par cet agent (identifiants d'installations
   * Maestro). Session-scopé : `--plugin-dir` en tmux, `plugins` en SDK.
   */
  pluginIds: string[];
  /** Serveurs MCP déclarés à chaque session de cet agent. */
  mcpServerIds: string[];
  /** Collections RAG interrogeables par cet agent via l'outil rag_search. */
  ragCollectionIds: string[];
  /**
   * Agent dont celui-ci est un subagent. Reflète la topologie réelle de
   * délégation : Maestro → lead → experts. `null` = agent de premier niveau,
   * rattaché directement à l'orchestrateur.
   */
  parentAgentId: string | null;
  /** Répertoire de travail dédié (créé sous <dataDir>/workspaces/<id> si null). */
  workspaceDir: string;
  /** Mémoire persistante MEMORY.md maintenue par l'agent entre les runs. */
  memoryEnabled: boolean;
  allowedTools: string[] | null;
  disallowedTools: string[] | null;
  /** Garde-fous. null = illimité. */
  maxTurns: number | null;
  timeoutSec: number | null;
  /** Budget de tokens (entrée+sortie) par run ; le run est interrompu au-delà. */
  tokenBudget: number | null;
  /**
   * Bac à sable d'exécution. `null` = aucun confinement, le comportement par
   * défaut et historique. Voir {@link AgentSandbox}.
   */
  sandbox: AgentSandbox | null;
  /** Couleur hexadécimale du nœud dans le graphe Mission Control. */
  color: string;
  /** Position épinglée dans le graphe (null = libre, pilotée par la simulation). */
  pinned: { x: number; y: number } | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AgentCreate = Omit<AgentConfig, 'id' | 'workspaceDir' | 'createdAt' | 'updatedAt'> & {
  workspaceDir?: string | null;
};

/**
 * Confinement d'un agent, par agent et jamais imposé.
 *
 * Le bac à sable est celui de Claude Code lui-même : isolation du système de
 * fichiers, filtrage de l'egress réseau et seccomp, appliqués aux commandes que
 * l'agent lance. C'est un cran plus fin qu'un conteneur — il distingue lecture
 * et écriture par chemin, et laisse la session parler à l'API pendant que les
 * commandes, elles, restent enfermées. Un conteneur, quand on en veut un
 * malgré tout, enveloppe l'instance entière (voir le Dockerfile).
 *
 * `enabled: false` ou `sandbox: null` : Maestro se comporte exactement comme
 * avant. Le confinement est une décision par agent, prise pour un agent dont on
 * n'est pas sûr — pas un péage que tous les autres paient.
 */
export interface AgentSandbox {
  enabled: boolean;
  /**
   * Refuser de démarrer si le bac à sable est indisponible.
   *
   * Faux par défaut, comme le SDK : sur une plateforme non gérée, l'agent
   * tourne alors sans confinement avec un avertissement. Le passer à vrai fait
   * du confinement une condition d'exécution — le bon choix pour un agent
   * précisément jugé risqué, où « dégradé en silence » est le pire des cas.
   */
  failIfUnavailable: boolean;
  /**
   * Domaines joignables par les commandes. Vide = aucune sortie réseau.
   * Accepte les jokers de Claude Code (`*.exemple.fr`).
   */
  allowedDomains: string[];
  /** Refuser tout hôte hors liste au lieu de demander une approbation. */
  strictAllowlist: boolean;
  /** Chemins ouverts en écriture en plus du workspace de l'agent. */
  allowWrite: string[];
  /** Chemins interdits en lecture, en plus des protections systématiques. */
  denyRead: string[];
}

/** Gabarits d'agents proposés à la création. */
export interface AgentTemplate {
  slug: string;
  name: string;
  emoji: string;
  description: string;
  model: string;
  systemPrompt: string;
  approvalPolicy: ApprovalPolicy;
  color: string;
}

// ---------------------------------------------------------------------------
// Runs (exécutions)
// ---------------------------------------------------------------------------

export type RunOrigin =
  | 'manual'
  | 'routine'
  | 'kanban'
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'pipeline'
  | 'agent'
  /** Échantillon d'un lot de génération de données d'entraînement. */
  | 'training';

/** Origines conversationnelles : celles dont on notifie la fin dans le canal. */
export const CHAT_ORIGINS: readonly RunOrigin[] = ['telegram', 'discord', 'slack'];

export type RunStatus =
  'queued' | 'running' | 'waiting_approval' | 'succeeded' | 'failed' | 'cancelled' | 'timeout';

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting_approval'];

export interface Run {
  id: string;
  agentId: string;
  origin: RunOrigin;
  /** Identifiant de la source (routineId, taskId, pipelineRunId, runId parent…). */
  originId: string | null;
  parentRunId: string | null;
  prompt: string;
  skillId: string | null;
  status: RunStatus;
  /** session_id Claude Code — permet la reprise de session. */
  sessionId: string | null;
  model: string;
  engine: AgentEngine;
  /** Nom de la session tmux quand engine = 'tmux'. */
  tmuxSession: string | null;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  resultText: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/** Événement du flux d'un run — persisté pour le transcript et rejoué dans l'UI. */
export type RunEventKind =
  | 'init'
  | 'assistant_text'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'permission_request'
  | 'permission_result'
  | 'result'
  | 'error'
  | 'info';

export interface RunEvent {
  id: number;
  runId: string;
  agentId: string;
  ts: string;
  kind: RunEventKind;
  /** Charge utile JSON — la forme dépend de kind (voir protocol.ts). */
  payload: RunEventPayload;
}

export type RunEventPayload = {
  /** Texte assistant, contenu thinking, message d'erreur ou d'info. */
  text?: string;
  /** kind = tool_use / tool_result / permission_*. */
  toolName?: string;
  toolInput?: unknown;
  toolUseId?: string;
  isError?: boolean;
  /** kind = init. */
  sessionId?: string;
  model?: string;
  tools?: string[];
  /** kind = result. */
  usage?: TokenUsage;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  /** kind = permission_result. */
  decision?: 'allowed' | 'denied';
  resolvedBy?: string;
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// ---------------------------------------------------------------------------
// Approbations (permissions)
// ---------------------------------------------------------------------------

export type ApprovalStatus = 'pending' | 'allowed' | 'denied' | 'expired';
export type ApprovalResolver = 'web' | 'telegram' | 'policy' | 'timeout';

export interface Approval {
  id: string;
  runId: string;
  agentId: string;
  toolName: string;
  /** Entrée de l'outil telle que soumise par l'agent. */
  input: unknown;
  status: ApprovalStatus;
  resolvedBy: ApprovalResolver | null;
  note: string | null;
  requestedAt: string;
  resolvedAt: string | null;
}

// ---------------------------------------------------------------------------
// Kanban
// ---------------------------------------------------------------------------

/**
 * Motif d'échec des runs clôturés au démarrage du serveur.
 *
 * Un run laissé « actif » par un arrêt brutal est marqué en échec au démarrage
 * suivant. Ce n'est pas une défaillance de l'agent, et surtout ce n'est pas une
 * demande adressée à l'humain : l'accueil s'en sert pour écarter ces runs de la
 * file d'arbitrage. La constante est partagée précisément pour que le message
 * produit par le serveur et le filtre appliqué par l'interface ne puissent pas
 * diverger.
 */
export const RUN_INTERRUPTED_BY_RESTART = 'Interrompu par un redémarrage du serveur';

export const KANBAN_COLUMNS = ['backlog', 'running', 'review', 'done'] as const;
export type KanbanColumn = (typeof KANBAN_COLUMNS)[number];

export interface KanbanTask {
  id: string;
  title: string;
  description: string;
  column: KanbanColumn;
  /** Ordre d'affichage dans la colonne (croissant). */
  position: number;
  priority: 0 | 1 | 2;
  labels: string[];
  agentId: string | null;
  /** Dernier run associé à la carte. */
  runId: string | null;
  /** Si vrai, l'assignation à un agent déclenche immédiatement un run. */
  autoRun: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/**
 * - 'builtin' : livrés avec Maestro, lecture seule ;
 * - 'native'  : skills Claude Code de ~/.claude/skills (claude-index), lecture
 *   seule et JAMAIS recopiées : le CLI les charge lui-même, Maestro n'y fait que
 *   référence pour les rendre sélectionnables ;
 * - 'global'  : partagés par tous les agents (<dataDir>/skills) ;
 * - 'agent'   : propres au workspace d'un agent.
 */
export type SkillScope = 'builtin' | 'native' | 'global' | 'agent';

export interface SkillDef {
  /** Identifiant unique : `<scope>:<slug>` ou `agent:<agentId>:<slug>`. */
  id: string;
  /**
   * Provenance d'une skill importée depuis un connecteur (URL du fichier
   * d'origine). Conservée dans le frontmatter du fichier, pour qu'une skill
   * tierce reste traçable après coup.
   */
  sourceUrl: string | null;
  slug: string;
  scope: SkillScope;
  agentId: string | null;
  name: string;
  description: string;
  /** Corps markdown (sans le frontmatter). */
  content: string;
  filePath: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Connecteurs de skills (catalogues distants)
// ---------------------------------------------------------------------------

/**
 * Source distante depuis laquelle importer des skills.
 * - 'catalog' : annuaire interrogeable (recherche + facettes) ;
 * - 'git'     : import direct d'un fichier d'un dépôt, par référence.
 */
export type ConnectorKind = 'catalog' | 'git';

export interface SkillConnector {
  id: string;
  name: string;
  description: string;
  kind: ConnectorKind;
  /** Page d'accueil, pour que l'utilisateur puisse juger la source. */
  homepage: string;
  /** Hôtes que le serveur s'autorise à contacter pour ce connecteur. */
  hosts: string[];
  /** Facettes proposées par le catalogue (vides pour un connecteur 'git'). */
  categories: string[];
  types: string[];
  /** Renseigné une fois le catalogue interrogé au moins une fois. */
  totalItems: number | null;
}

/** Nature de ce qu'on importe. Détermine la cible d'installation. */
export type ImportTarget = 'skill' | 'agent' | 'plugin';

/**
 * Plugin Claude Code installé : un répertoire local, cloné depuis un dépôt,
 * chargé par session (`--plugin-dir` en CLI, `plugins: [{type:'local'}]` en SDK).
 */
export interface PluginInstall {
  id: string;
  slug: string;
  name: string;
  description: string;
  version: string | null;
  /** `owner/repo` d'origine. */
  repo: string | null;
  sourceUrl: string | null;
  /** Répertoire local, sous <dataDir>/plugins. */
  path: string;
  /** Révision clonée (SHA court) : ce qui tourne réellement. */
  revision: string | null;
  /** Inventaire des composants déclarés (skills, agents, commandes, hooks). */
  inventory: PluginInventory;
  installedAt: string;
  updatedAt: string;
}

export interface PluginInventory {
  skills: number;
  agents: number;
  commands: number;
  hooks: number;
  /** Le plugin déclare-t-il des serveurs MCP (à connaître avant de l'activer) ? */
  mcpServers: number;
}

/** Entrée de catalogue, normalisée entre connecteurs. */
export interface RemoteSkill {
  connectorId: string;
  /** Référence opaque à repasser au connecteur pour lire le contenu. */
  ref: string;
  slug: string;
  name: string;
  description: string;
  category: string | null;
  /** skill, subagent, plugin, command… selon le catalogue. */
  type: string;
  stars: number | null;
  featured: boolean;
  /** Signaux de fiabilité publiés par le catalogue. */
  confidence: string | null;
  origin: string | null;
  repo: string | null;
  sourceUrl: string | null;
}

export interface RemoteSkillSearch {
  total: number;
  limit: number;
  offset: number;
  results: RemoteSkill[];
}

/**
 * Contenu résolu d'un composant markdown distant (skill ou subagent), avant
 * import. Le nom reste historique ; `componentType` distingue les deux cas.
 */
export interface RemoteSkillPreview {
  connectorId: string;
  ref: string;
  name: string;
  description: string;
  /** Slug proposé pour l'import, dérivé du contenu ou de la référence. */
  suggestedSlug: string;
  content: string;
  /** URL exacte d'où le contenu a été lu (traçabilité). */
  resolvedUrl: string;
  sizeBytes: number;
  /** Type déclaré par le catalogue : skill, subagent, command… */
  componentType: string;
  repo: string | null;
  /**
   * Frontmatter exploitable quand le composant est un subagent : sert à
   * préremplir le formulaire de création d'agent sans que l'utilisateur
   * recopie quoi que ce soit.
   */
  agentDraft: {
    tools: string[];
    model: string | null;
    color: string | null;
  } | null;
}

/** Manifeste résolu d'un plugin distant, avant clonage. */
export interface RemotePluginPreview {
  connectorId: string;
  ref: string;
  repo: string;
  cloneUrl: string;
  name: string;
  description: string;
  version: string | null;
  author: string | null;
  /** URL du manifeste effectivement lu. */
  resolvedUrl: string;
  /** Inventaire déduit du manifeste, avant clonage. */
  inventory: PluginInventory;
  /** Manifeste brut, pour relecture humaine. */
  manifest: string;
}

// ---------------------------------------------------------------------------
// Routines (cron)
// ---------------------------------------------------------------------------

export interface Routine {
  id: string;
  name: string;
  agentId: string;
  skillId: string | null;
  prompt: string;
  /** Expression cron à 5 ou 6 champs. */
  cronExpr: string;
  enabled: boolean;
  timeoutSec: number | null;
  /** Notifier (Telegram + event log) à la fin de chaque déclenchement. */
  notify: boolean;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Pipelines (chaînes d'agents)
// ---------------------------------------------------------------------------

export interface PipelineStep {
  id: string;
  name: string;
  agentId: string;
  skillId: string | null;
  /**
   * Gabarit de prompt. Variables : {{input}} (entrée du pipeline),
   * {{prev}} (sortie de l'étape précédente), {{steps.<name>}} (sortie d'une étape nommée).
   */
  promptTemplate: string;
}

export interface Pipeline {
  id: string;
  name: string;
  description: string;
  steps: PipelineStep[];
  createdAt: string;
  updatedAt: string;
}

export type PipelineRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface PipelineStepRun {
  stepId: string;
  runId: string | null;
  status: RunStatus | 'pending';
  output: string | null;
}

export interface PipelineRun {
  id: string;
  pipelineId: string;
  status: PipelineRunStatus;
  input: string;
  currentStepIndex: number;
  stepRuns: PipelineStepRun[];
  startedAt: string;
  endedAt: string | null;
}

// ---------------------------------------------------------------------------
// tmux
// ---------------------------------------------------------------------------

export interface TmuxSessionInfo {
  name: string;
  agentId: string | null;
  runId: string | null;
  createdAt: string;
  attached: boolean;
  /** Dernières lignes du pane (capture-pane), pour l'aperçu UI. */
  preview: string | null;
}

// ---------------------------------------------------------------------------
// Radar de sessions (détection des agents de code actifs sur la machine)
// ---------------------------------------------------------------------------

/** Outil de codage agentique reconnu par le radar. */
export type AgentToolKind =
  'claude-code' | 'codex' | 'gemini' | 'aider' | 'cursor' | 'opencode' | 'goose' | 'other';

/**
 * Fraîcheur d'une session :
 * - 'active' : activité il y a moins de 2 min, ou processus en train de calculer ;
 * - 'idle'   : session vivante mais silencieuse depuis moins de 30 min ;
 * - 'stale'  : plus rien depuis longtemps — probablement terminée.
 */
export type SessionFreshness = 'active' | 'idle' | 'stale';

/** D'où vient l'information : plusieurs sources peuvent se recouper. */
export type DetectionSource = 'transcript' | 'process' | 'tmux';

/**
 * Session d'agent de code détectée sur la machine, qu'elle soit pilotée par
 * Maestro ou lancée à la main dans un terminal.
 *
 * 🔒 Seules des métadonnées sont collectées (chemin, branche, horodatage,
 * version) : jamais le contenu des messages d'une session.
 */
export interface DetectedSession {
  /** Identifiant stable entre deux balayages. */
  id: string;
  tool: AgentToolKind;
  toolLabel: string;
  sessionId: string | null;
  cwd: string | null;
  /** Dernier segment du cwd, pour l'affichage. */
  project: string | null;
  gitBranch: string | null;
  version: string | null;
  /** Mode de lancement rapporté par l'outil (cli, sdk, vscode…). */
  entrypoint: string | null;
  pid: number | null;
  cpuPercent: number | null;
  uptimeSec: number | null;
  lastActivityAt: string | null;
  freshness: SessionFreshness;
  sources: DetectionSource[];
  /** Renseigné quand la session est un run Maestro, et non une session externe. */
  managed: { agentId: string; agentName: string; agentEmoji: string; runId: string | null } | null;
}

export interface RadarSnapshot {
  scannedAt: string;
  /** Durée du balayage, pour juger du coût de la détection. */
  scanDurationMs: number;
  sessions: DetectedSession[];
  /** Outils dont le binaire est présent sur la machine (installés). */
  toolsInstalled: AgentToolKind[];
  /** Le radar est-il actif (balayage périodique) ? */
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Métriques & event log
// ---------------------------------------------------------------------------

export interface MetricsSnapshot {
  ts: string;
  uptimeSec: number;
  activeRuns: number;
  queuedRuns: number;
  pendingApprovals: number;
  /** Débit d'événements par seconde (fenêtre glissante). */
  eventsPerSec: number;
  /** Cumul du jour courant. */
  todayInputTokens: number;
  todayOutputTokens: number;
  todayCostUsd: number;
  connectedClients: number;
}

export interface AgentStats {
  agentId: string;
  totalRuns: number;
  succeeded: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  avgDurationMs: number;
  lastRunAt: string | null;
}

export interface TokensByBucket {
  /** Clé du groupe : date (YYYY-MM-DD), agentId ou modèle. */
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  runs: number;
}

export type LogLevel = 'info' | 'success' | 'warn' | 'error';

/** Ligne du journal d'événements Mission Control. */
export interface LogLine {
  id: number;
  ts: string;
  level: LogLevel;
  source: string;
  message: string;
  agentId: string | null;
  runId: string | null;
}

// ---------------------------------------------------------------------------
// Paramètres
// ---------------------------------------------------------------------------

export interface Settings {
  /** Nom d'instance affiché dans l'UI. */
  instanceName: string;
  /**
   * Notifier la fin de tous les runs sur les canaux de messagerie, et pas
   * seulement ceux qui en viennent. Le réglage s'appelait
   * `telegramNotifyAllRuns` quand Telegram était le seul canal ; l'ancienne clé
   * est reprise à la lecture, personne ne perd son choix.
   */
  notifyAllRuns: boolean;
  /** Délai (s) avant expiration automatique d'une approbation en attente. */
  approvalTimeoutSec: number;
  /** Nombre max de runs simultanés toutes files confondues. */
  maxConcurrentRuns: number;
  /** Profondeur max de délégation agent→agent (anti-boucle). */
  maxAgentDepth: number;
  /**
   * Capture intégrale des retours d'outils et de la réflexion.
   *
   * Par défaut, un retour d'outil est raccourci à la capture : c'est un
   * transcript qu'on lit à l'écran, pas une archive. Pour produire des données
   * d'entraînement, ce raccourcissement est nuisible — un modèle entraîné sur
   * des observations coupées apprend à s'arrêter au milieu d'un résultat. Le
   * réglage lève la limite au prix d'une base plus volumineuse.
   */
  fullTrajectoryCapture: boolean;
  /**
   * Rétention des événements de runs et du journal, en jours.
   *
   * `null` ou 0 = conservation illimitée, le comportement historique. Rien ne
   * purgeait ces deux tables, ce qui restait indolore sur quelques dizaines de
   * runs — mais un lot d'entraînement de mille échantillons avec capture
   * intégrale écrit des centaines de mégaoctets, et la base ne rend jamais
   * l'espace d'elle-même.
   */
  retentionDays: number | null;
}

export interface ServerInfo {
  version: string;
  startedAt: string;
  dataDir: string;
  telegramEnabled: boolean;
  tmuxAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Serveurs MCP
// ---------------------------------------------------------------------------

/**
 * Un serveur MCP est soit externe, soit défini dans Maestro.
 *
 * `external` : un vrai serveur MCP que l'utilisateur possède déjà. Maestro ne
 * fait que le déclarer au SDK, en `stdio` (processus local) ou en `http`/`sse`
 * (service distant).
 *
 * `custom` : l'utilisateur décrit ses outils dans l'interface, et Maestro
 * construit un serveur MCP in-process. C'est le « MCP simplifié » : pas de
 * dépôt à écrire, pas de processus à faire tourner.
 */
export type McpServerKind = 'external' | 'custom';

export type McpTransport = 'stdio' | 'http' | 'sse';

/** Type d'un paramètre d'outil, projeté sur un schéma Zod côté serveur. */
export type McpParamType = 'string' | 'number' | 'boolean';

export interface McpToolParam {
  name: string;
  type: McpParamType;
  description: string;
  required: boolean;
  /** Valeurs autorisées ; vide = libre. Ne s'applique qu'au type `string`. */
  enumValues: string[];
}

/**
 * Ce que fait un outil maison quand l'agent l'appelle.
 *
 * Deux actions seulement, et c'est un choix de sécurité : un formulaire qui
 * accepterait une commande shell donnerait l'exécution de code arbitraire à un
 * modèle. L'agent a déjà Bash, sous contrôle d'approbation.
 */
export type McpActionKind = 'http' | 'text';

export interface McpHttpAction {
  kind: 'http';
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /**
   * URL gabarit. 🔒 L'origine (schéma, hôte, port) doit être littérale : seuls
   * le chemin, la requête et le corps acceptent des `{{paramètres}}`. Sans
   * cette règle, un agent pourrait rediriger l'appel vers n'importe quel hôte,
   * y compris un service interne.
   */
  urlTemplate: string;
  /** En-têtes fixes. Les valeurs sensibles sont masquées à la lecture. */
  headers: Record<string, string>;
  /** Corps gabarit, ignoré en GET et DELETE. */
  bodyTemplate: string;
  /** Chemin JSON à extraire de la réponse (ex. `data.items`). Vide = brut. */
  responsePath: string;
  timeoutMs: number;
}

export interface McpTextAction {
  kind: 'text';
  /** Texte renvoyé, avec interpolation des `{{paramètres}}`. */
  template: string;
}

export type McpAction = McpHttpAction | McpTextAction;

export interface McpToolDef {
  name: string;
  description: string;
  params: McpToolParam[];
  action: McpAction;
  /**
   * Force une approbation humaine à chaque appel, quelle que soit la politique
   * de l'agent.
   *
   * Un outil qui consulte et un outil qui supprime n'appellent pas la même
   * vigilance, alors que la politique de l'agent les traite par le même motif de
   * nom. Cette case donne le grain manquant sans complexifier les politiques.
   */
  requiresApproval: boolean;
}

export interface McpServerDef {
  id: string;
  slug: string;
  name: string;
  description: string;
  kind: McpServerKind;
  enabled: boolean;

  // --- kind === 'external' ------------------------------------------------
  transport: McpTransport | null;
  /** stdio : exécutable et arguments. */
  command: string | null;
  args: string[];
  /** stdio : variables d'environnement. Valeurs masquées à la lecture. */
  env: Record<string, string>;
  /** http / sse : point d'entrée. */
  url: string | null;
  /** http / sse : en-têtes. Valeurs masquées à la lecture. */
  headers: Record<string, string>;

  // --- kind === 'custom' --------------------------------------------------
  tools: McpToolDef[];

  createdAt: string;
  updatedAt: string;
}

/**
 * Serveur MCP prêt à déclarer, issu du catalogue livré.
 *
 * Un raccourci, pas une dépendance : ces serveurs se déclarent aussi à la main.
 * Le catalogue dispense seulement de connaître le nom de paquet, les arguments
 * et les variables d'environnement de chacun.
 */
export type McpPresetCategory =
  'navigateur' | 'web' | 'fichiers' | 'raisonnement' | 'développement';

export interface McpPresetEnvKey {
  key: string;
  /** À quoi sert la variable, et où l'obtenir. */
  hint: string;
  required: boolean;
}

export interface McpPreset {
  slug: string;
  name: string;
  description: string;
  category: McpPresetCategory;
  /** Runtime attendu sur la machine — un runtime absent fait échouer le serveur. */
  runtime: 'npx' | 'uvx';
  command: string;
  args: string[];
  envKeys: McpPresetEnvKey[];
  /** Ce que le serveur donne à l'agent, en une phrase. */
  grants: string;
  homepage: string;
}

/** Résultat d'un essai d'outil depuis l'interface, avant de l'ouvrir aux agents. */
export interface McpToolTrial {
  ok: boolean;
  output: string;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// RAG
// ---------------------------------------------------------------------------

/** Origine d'un document ingéré, conservée pour pouvoir réindexer. */
export type RagSourceKind = 'text' | 'file' | 'directory' | 'url' | 'workspace';

export interface RagCollection {
  id: string;
  slug: string;
  name: string;
  description: string;
  /** Taille de découpe visée, en caractères. */
  chunkSize: number;
  /** Recouvrement entre deux morceaux consécutifs, en caractères. */
  chunkOverlap: number;
  documentCount: number;
  chunkCount: number;
  /** Morceaux effectivement porteurs d'un vecteur, si des embeddings existent. */
  embeddedChunkCount: number;
  /**
   * Morceaux dont le vecteur vient d'un autre modèle que celui configuré.
   *
   * Comptés à part : ils apparaîtraient sinon comme « déjà vectorisés » alors
   * qu'ils ne participent plus au classement sémantique.
   */
  staleChunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RagDocument {
  id: string;
  collectionId: string;
  title: string;
  sourceKind: RagSourceKind;
  /** Chemin, URL ou identifiant d'agent selon l'origine. Vide pour un collage. */
  source: string;
  /**
   * Ce que l'utilisateur a désigné à l'ingestion.
   *
   * Distinct de `source` : ingérer un dossier crée un document par fichier,
   * chacun avec son propre chemin, mais tous avec la même racine. C'est elle
   * qui permet de rafraîchir en repérant aussi les fichiers ajoutés depuis.
   */
  ingestRoot: string | null;
  bytes: number;
  chunkCount: number;
  createdAt: string;
}

/** Un morceau tel qu'il a été découpé, pour inspecter l'index. */
export interface RagChunkView {
  chunkIndex: number;
  content: string;
  chars: number;
  /** Vrai si ce morceau porte un vecteur utilisable avec le modèle courant. */
  embedded: boolean;
}

/** Un passage retrouvé, tel qu'il est rendu à l'agent comme à l'interface. */
export interface RagHit {
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  /** Score de fusion des deux moteurs. Plus haut = plus pertinent. */
  score: number;
  /** Moteurs qui ont remonté ce passage. */
  matchedBy: Array<'lexical' | 'semantic'>;
}

/** Compte rendu d'une réindexation ou d'un rafraîchissement. */
export interface RagMaintenanceReport {
  /** Documents redécoupés ou relus. */
  documents: number;
  chunks: number;
  /** Documents dont la source a disparu et qui ont été retirés. */
  removed: number;
  /** Documents qu'on n'a pas pu traiter, avec la raison. */
  skipped: Array<{ source: string; reason: string }>;
}

export interface RagSearchResult {
  hits: RagHit[];
  /** Vrai si la partie sémantique a réellement participé au classement. */
  semanticUsed: boolean;
  durationMs: number;
}

/**
 * État du moteur d'embeddings, affiché tel quel dans l'interface.
 *
 * 🔒 La clé d'API ne vient jamais de la base : elle est lue dans
 * l'environnement du serveur. L'interface n'en voit que la présence.
 */
export interface RagEmbeddingStatus {
  /** `voyage`, `openai`, ou null si aucune clé n'est configurée. */
  provider: string | null;
  model: string | null;
  available: boolean;
  /** Nom de la variable d'environnement attendue, pour le message d'aide. */
  envVar: string;
}

/** Résultat d'un test de connexion à un serveur MCP externe. */
export interface McpProbeResult {
  ok: boolean;
  /** Nom et version annoncés par le serveur, s'il se présente. */
  serverInfo: string | null;
  /** Outils réellement exposés : la vraie réponse à « qu'apporte ce serveur ». */
  tools: string[];
  message: string;
  durationMs: number;
}

/**
 * Un serveur repéré dans une configuration existante, avant import.
 *
 * 🔒 Aucune valeur sensible : seul leur nombre est indiqué, pour que
 * l'utilisateur sache qu'il en importe.
 */
export interface McpImportCandidate {
  name: string;
  slug: string;
  transport: McpTransport | null;
  /** Commande complète ou URL, pour reconnaître le serveur. */
  summary: string;
  /** Nombre de variables d'environnement et d'en-têtes portés. */
  secretCount: number;
  /** Vrai si un serveur du même identifiant existe déjà dans Maestro. */
  alreadyPresent: boolean;
  importable: boolean;
}

// ---------------------------------------------------------------------------
// Graphe d'une collection RAG
// ---------------------------------------------------------------------------

export type RagGraphNodeKind = 'collection' | 'document' | 'chunk';

export interface RagGraphNode {
  id: string;
  kind: RagGraphNodeKind;
  label: string;
  /** Document parent, pour un morceau. */
  documentId: string | null;
  /** Longueur du morceau, qui dimensionne le nœud. */
  chars: number;
  /** Numéro du passage dans son document, pour le désigner. */
  chunkIndex: number | null;
}

/**
 * Une arête du graphe.
 *
 * `contains` porte la structure — collection, document, passage. `similar`
 * porte le sens : deux passages qui parlent de la même chose. C'est la seconde
 * qui rend le graphe utile, la première qui le rend lisible.
 */
export interface RagGraphLink {
  source: string;
  target: string;
  kind: 'contains' | 'similar';
  /** Force du rapprochement, entre 0 et 1. Vaut 1 pour la structure. */
  weight: number;
}

export interface RagGraph {
  nodes: RagGraphNode[];
  links: RagGraphLink[];
  /** Vrai si le graphe est borné : tous les passages n'y figurent pas. */
  truncated: boolean;
  totalChunks: number;
  /**
   * Passages qu'aucun rapprochement ne relie.
   *
   * Ce sont souvent ceux qu'aucune recherche ne remonte : soit ils traitent
   * d'un sujet unique dans le corpus, soit leur découpe les a rendus
   * inexploitables. Les compter les rend visibles.
   */
  isolatedCount: number;
}

// ---------------------------------------------------------------------------
// Modifications produites dans le répertoire d'un agent
// ---------------------------------------------------------------------------

export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  additions: number;
  deletions: number;
  /**
   * Vrai si le fichier était déjà modifié au démarrage du run.
   *
   * Distinction indispensable : imputer à un agent le travail en cours d'un
   * humain rendrait le diff trompeur, et personne ne s'y fierait deux fois.
   */
  preexisting: boolean;
}

export interface WorkspaceChanges {
  /** Faux quand le répertoire de l'agent n'est pas un dépôt git ; `reason` l'explique. */
  available: boolean;
  reason: string | null;
  branch: string | null;
  /** HEAD au démarrage du run, pour signaler un commit survenu pendant. */
  baseSha: string | null;
  files: ChangedFile[];
  diff: string;
  diffTruncated: boolean;
}

/** Résultat d'une livraison sur une branche neuve. */
export interface CommitResult {
  branch: string;
  sha: string;
  files: number;
}

// ---------------------------------------------------------------------------
// Données d'entraînement (MLOps)
// ---------------------------------------------------------------------------

/**
 * Un tour de trajectoire : ce qu'un modèle doit apprendre à produire.
 *
 * Volontairement plus pauvre que le format d'un fournisseur : c'est la forme
 * canonique interne, dont dérivent tous les exports. Elle ne connaît ni
 * ShareGPT ni OpenAI — chaque export sait la lire, elle n'en connaît aucun.
 */
export type TrajectoryRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TrajectoryToolCall {
  /** Identifiant du bloc `tool_use`, seul lien fiable vers son résultat. */
  id: string;
  name: string;
  arguments: unknown;
}

export interface TrajectoryTurn {
  role: TrajectoryRole;
  /** Texte du tour. Vide sur un tour assistant purement outil. */
  content: string;
  /** Contenu de réflexion, séparé du texte : la plupart des formats l'excluent. */
  thinking?: string;
  /** role = assistant. */
  toolCalls?: TrajectoryToolCall[];
  /** role = tool. */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /**
   * Vrai si le contenu a été raccourci — à la capture ou à la compression.
   * Un export silencieusement tronqué produit des données d'entraînement
   * fausses : le modèle apprendrait à s'arrêter au milieu d'un résultat.
   */
  truncated?: boolean;
}

/** Trajectoire complète d'un run, prête à exporter. */
export interface Trajectory {
  runId: string;
  agentId: string;
  agentName: string;
  model: string;
  status: RunStatus;
  turns: TrajectoryTurn[];
  /** Outils réellement appelés, dans l'ordre de première apparition. */
  toolsUsed: string[];
  /** Estimation du poids en tokens de la trajectoire rendue. */
  estimatedTokens: number;
  usage: TokenUsage;
  costUsd: number;
  durationMs: number | null;
  createdAt: string;
}

/** Compte rendu d'une compression : ce qui a été sacrifié, et pourquoi. */
export interface TrajectoryCompression {
  applied: boolean;
  /**
   * Faux quand la compression n'a pas suffi à tenir le budget.
   *
   * Le budget est un objectif, pas une garantie : une trajectoire faite d'un
   * seul tour très long ne peut pas rétrécir davantage sans perdre la paire
   * consigne/réponse qui fait tout son intérêt. Le taire laisserait croire à un
   * corpus calibré qui ne l'est pas.
   */
  withinBudget: boolean;
  tokenBudget: number | null;
  tokensBefore: number;
  tokensAfter: number;
  droppedThinkingTurns: number;
  truncatedToolResults: number;
  droppedTurns: number;
}

/**
 * Format d'export.
 *
 * `sharegpt` : le format de fine-tuning le plus largement accepté (Axolotl,
 * LLaMA-Factory, Unsloth). `openai` : messages + tool_calls natifs, pour un
 * fine-tuning d'API. `atropos` : rollouts scorés pour l'apprentissage par
 * renforcement. `raw` : la forme canonique, sans perte, pour outiller soi-même.
 */
export type TrainingExportFormat = 'sharegpt' | 'openai' | 'atropos' | 'raw';

/** Nom d'un parseur d'appels d'outils — voir training-parsers.ts. */
export type ToolCallDialect =
  | 'hermes'
  | 'openai'
  | 'mistral'
  | 'llama3_json'
  | 'llama3_python_tag'
  | 'pythonic'
  | 'deepseek'
  | 'command_r'
  | 'granite'
  | 'functionary'
  | 'json_lines';

export interface ToolCallDialectInfo {
  id: ToolCallDialect;
  label: string;
  /** Familles de modèles qui attendent cette convention. */
  families: string;
  /** Exemple rendu, pour que l'UI montre ce qui sera écrit. */
  sample: string;
}

export interface TrainingExportRequest {
  format: TrainingExportFormat;
  dialect?: ToolCallDialect;
  /** Restreint aux runs d'un lot. Exclusif avec `runIds`. */
  batchId?: string | null;
  runIds?: string[];
  /** Budget de tokens par trajectoire ; au-delà, compression. */
  tokenBudget?: number | null;
  /** Exclut les runs en échec — vrai par défaut. */
  onlySucceeded?: boolean;
  includeThinking?: boolean;
  /** N'exporte que les trajectoires ayant appelé au moins un outil. */
  requireToolCalls?: boolean;
}

/** Aperçu d'un export : de quoi décider avant d'écrire un fichier. */
export interface TrainingExportPreview {
  format: TrainingExportFormat;
  dialect: ToolCallDialect;
  /** Trajectoires retenues. */
  count: number;
  /** Trajectoires écartées, par motif. */
  skipped: Array<{ runId: string; reason: string }>;
  totalEstimatedTokens: number;
  compression: TrajectoryCompression;
  /** Les deux premières lignes du JSONL, telles qu'elles seront écrites. */
  sample: string[];
}

// -- Lots de génération -----------------------------------------------------

export type TrainingBatchStatus =
  | 'draft'
  | 'running'
  | 'paused'
  | 'succeeded'
  /**
   * Terminé, mais avec des échecs.
   *
   * Un lot de mille échantillons dont trente-sept ont échoué n'est ni un succès
   * ni un échec : marqué « succeeded » il mentait, marqué « failed » il aurait
   * fait jeter neuf cent soixante-trois trajectoires exploitables.
   */
  | 'partial'
  | 'failed'
  | 'cancelled';

export type TrainingItemStatus =
  'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

/**
 * Pondération d'un outil dans un lot.
 *
 * Le poids ne force rien — un modèle reste libre de ses appels. Il pilote la
 * consigne injectée dans le prompt et le tirage des variantes, ce qui suffit à
 * déséquilibrer volontairement un jeu de données (par ex. 70 % de lectures,
 * 30 % d'écritures).
 */
export interface ToolWeight {
  tool: string;
  weight: number;
}

export interface TrainingBatchSpec {
  /**
   * Agents qui exécutent le lot.
   *
   * Plusieurs, et non un seul, parce qu'un agent n'exécute jamais deux runs à
   * la fois : son workspace est unique. Le parallélisme réel d'un lot vaut donc
   * min(workers, agents du pool).
   */
  agentIds: string[];
  /** Gabarits de prompt. `{{var}}` est substitué depuis `variables`. */
  promptTemplates: string[];
  /** Jeux de valeurs tirés pour peupler les gabarits. */
  variables: Record<string, string[]>;
  /** Nombre d'échantillons à produire. */
  samples: number;
  /** Générations menées de front, bornée par la taille du pool d'agents. */
  workers: number;
  /** Tentatives par échantillon avant abandon. */
  maxAttempts: number;
  toolWeights: ToolWeight[];
  /** Délai maximal par échantillon, en secondes. */
  timeoutSec: number | null;
  /** Skill jointe à chaque run du lot. */
  skillId: string | null;
  /**
   * Notation automatique des trajectoires (récompense pour l'apprentissage
   * par renforcement). Sans elle, un export Atropos n'a pas de score.
   */
  grader: TrainingGraderSpec | null;
}

export interface TrainingGraderSpec {
  agentId: string;
  /**
   * Consigne du juge. `{{prompt}}` et `{{result}}` sont substitués. Le juge
   * doit terminer sa réponse par un nombre entre 0 et 1.
   */
  promptTemplate: string;
}

export interface TrainingBatch {
  id: string;
  name: string;
  description: string;
  status: TrainingBatchStatus;
  spec: TrainingBatchSpec;
  /** Compteurs dérivés des items, calculés à la lecture. */
  counts: Record<TrainingItemStatus, number>;
  /** Nombre d'échantillons déjà engendrés — le point de reprise. */
  checkpointIndex: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface TrainingItem {
  id: string;
  batchId: string;
  index: number;
  agentId: string;
  prompt: string;
  runId: string | null;
  status: TrainingItemStatus;
  attempts: number;
  /** Récompense dans [0,1] — juge automatique ou notation humaine. */
  score: number | null;
  scoreSource: 'grader' | 'human' | null;
  toolCallCount: number;
  totalTokens: number;
  costUsd: number;
  error: string | null;
  createdAt: string;
  endedAt: string | null;
}

/**
 * Banc de non-regression : ce que rend la comparaison de deux lots.
 *
 * Le verdict est une phrase, pas un score : un banc dont il faut interpreter
 * soi-meme les chiffres ne sert a rien — il doit dire s'il faut garder le
 * changement.
 */
export interface ComparisonSide {
  status: TrainingItemStatus;
  score: number | null;
  toolCallCount: number;
  totalTokens: number;
  costUsd: number;
  runId: string | null;
}

export type CaseVerdict = 'amélioré' | 'dégradé' | 'stable' | 'incomparable';

export interface CaseComparison {
  index: number;
  prompt: string;
  baseline: ComparisonSide | null;
  candidate: ComparisonSide | null;
  scoreDelta: number | null;
  verdict: CaseVerdict;
}

export interface BatchComparison {
  comparable: boolean;
  reason: string | null;
  cases: CaseComparison[];
  summary: {
    improved: number;
    regressed: number;
    unchanged: number;
    incomparable: number;
    baselineMean: number | null;
    candidateMean: number | null;
    meanDelta: number | null;
    costDelta: number;
    tokenDelta: number;
  };
  /** Phrase de synthese, ajoutee par l'API. */
  verdict: string;
}
