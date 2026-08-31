/**
 * Schéma SQL et migrations additives.
 *
 * Sorti de `db.ts` parce que c'est de la **donnée**, pas du comportement, et
 * parce que c'est l'endroit que chaque fonctionnalité modifie : sur la fusion
 * de trois branches, six conflits sur treize venaient de ce seul fichier — dont
 * un qui compilait et cassait toute création d'agent.
 *
 * 🔒 Les migrations sont **additives et idempotentes**, et le restent :
 * `CREATE TABLE IF NOT EXISTS` ne touche pas une table existante, et chaque
 * colonne ajoutée est vérifiée avant d'être créée. Une migration destructive
 * ici s'appliquerait au démarrage, sans confirmation ni retour possible.
 */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🤖',
  description TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT 'sonnet',
  engine TEXT NOT NULL DEFAULT 'sdk',
  permission_mode TEXT NOT NULL DEFAULT 'default',
  approval_policy TEXT NOT NULL DEFAULT 'guarded',
  system_prompt TEXT,
  cli_agent TEXT,
  parent_agent_id TEXT,
  plugin_ids TEXT NOT NULL DEFAULT '[]',
  workspace_dir TEXT NOT NULL,
  memory_enabled INTEGER NOT NULL DEFAULT 1,
  allowed_tools TEXT,
  disallowed_tools TEXT,
  max_turns INTEGER,
  timeout_sec INTEGER,
  token_budget INTEGER,
  color TEXT NOT NULL DEFAULT '#22d3ee',
  pinned TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  origin TEXT NOT NULL,
  origin_id TEXT,
  parent_run_id TEXT,
  prompt TEXT NOT NULL,
  skill_id TEXT,
  status TEXT NOT NULL,
  session_id TEXT,
  model TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'sdk',
  tmux_session TEXT,
  num_turns INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  result_text TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

CREATE TABLE IF NOT EXISTS run_git_base (
  run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
  head TEXT,
  branch TEXT,
  dirty TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id),
  agent_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT 'null',
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_by TEXT,
  note TEXT,
  requested_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  column_name TEXT NOT NULL DEFAULT 'backlog',
  position REAL NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 1,
  labels TEXT NOT NULL DEFAULT '[]',
  agent_id TEXT,
  run_id TEXT,
  auto_run INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  skill_id TEXT,
  prompt TEXT NOT NULL,
  cron_expr TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  timeout_sec INTEGER,
  notify INTEGER NOT NULL DEFAULT 1,
  last_fired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '',
  current_step_index INTEGER NOT NULL DEFAULT 0,
  step_runs TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  agent_id TEXT,
  run_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(id DESC);

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version TEXT,
  repo TEXT,
  source_url TEXT,
  path TEXT NOT NULL,
  revision TEXT,
  inventory TEXT NOT NULL DEFAULT '{}',
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  transport TEXT,
  command TEXT,
  args TEXT NOT NULL DEFAULT '[]',
  env TEXT NOT NULL DEFAULT '{}',
  url TEXT,
  headers TEXT NOT NULL DEFAULT '{}',
  tools TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rag_collections (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  chunk_size INTEGER NOT NULL DEFAULT 1200,
  chunk_overlap INTEGER NOT NULL DEFAULT 150,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rag_documents (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES rag_collections(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rag_documents_collection ON rag_documents(collection_id);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES rag_collections(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  /* Vecteur d'embedding sérialisé en Float32 ; NULL tant qu'aucun moteur
     d'embeddings n'est configuré. */
  embedding BLOB,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_collection ON rag_chunks(collection_id);
CREATE INDEX IF NOT EXISTS idx_rag_chunks_document ON rag_chunks(document_id);

/*
 * Index plein texte des morceaux.
 *
 * L'option unicode61 remove_diacritics 2 est indispensable : sans lui, « liasse
 * fiscale » ne retrouve pas « Liasse Fiscale », et « ecriture » ne retrouve pas
 * « écriture ». Sur un corpus francophone, c'est la différence entre un index
 * utile et un index qui ne trouve rien.
 *
 * La table garde sa propre copie du texte plutôt que de pointer sur rag_chunks.
 * Cela coûte de l'espace disque, et permet en échange de supprimer une entrée
 * par un DELETE ... WHERE chunk_id = ? ; avec une table externe, il faudrait
 * rejouer le contenu exact d'origine pour désindexer, ce qui casse dès qu'une
 * réindexation change la découpe.
 */
CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(
  content,
  chunk_id UNINDEXED,
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS provider_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  auth_mode TEXT NOT NULL DEFAULT 'inherit',
  config_dir TEXT,
  api_key_env TEXT,
  base_url TEXT,
  api_flavor TEXT,
  model TEXT,
  command TEXT,
  args TEXT,
  env TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 100,
  daily_cost_limit_usd REAL,
  health TEXT NOT NULL DEFAULT 'unknown',
  cooldown_until TEXT,
  last_error TEXT,
  last_checked_at TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resilience_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  targets TEXT NOT NULL DEFAULT '[]',
  max_attempts_per_target INTEGER NOT NULL DEFAULT 2,
  max_total_attempts INTEGER NOT NULL DEFAULT 4,
  backoff_initial_ms INTEGER NOT NULL DEFAULT 2000,
  backoff_factor REAL NOT NULL DEFAULT 3,
  backoff_max_ms INTEGER NOT NULL DEFAULT 60000,
  backoff_jitter INTEGER NOT NULL DEFAULT 1,
  quota_wait_max_sec INTEGER NOT NULL DEFAULT 900,
  switch_on_error INTEGER NOT NULL DEFAULT 1,
  handoff_threshold_pct INTEGER NOT NULL DEFAULT 80,
  quota_pressure_pct INTEGER NOT NULL DEFAULT 85,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

/*
 * Tentatives d'un run.
 *
 * Table à part plutôt que colonnes de la table runs : un run réussi du premier
 * coup n’a rien à porter, et un run qui a basculé trois fois ne tient pas dans
 * une ligne. C’est aussi la seule trace qui explique pourquoi un run a fini
 * ailleurs que là où il avait commencé.
 */
CREATE TABLE IF NOT EXISTS run_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  account_id TEXT,
  account_name TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  failure_class TEXT,
  error TEXT,
  waited_ms INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_attempts_run ON run_attempts(run_id, idx);

CREATE TABLE IF NOT EXISTS session_handoffs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  summary TEXT NOT NULL,
  degraded INTEGER NOT NULL DEFAULT 0,
  source_kind TEXT NOT NULL,
  source_account_id TEXT,
  source_session_id TEXT,
  tokens_at_capture INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs_run ON session_handoffs(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_agent ON session_handoffs(agent_id, created_at);

/*
 * Historique des battements de cœur.
 *
 * Table à part des runs : un battement sauté par un garde-fou n'a pas de run —
 * c'est même le cas le plus fréquent, et le plus utile à voir. Le forcer dans
 * la table runs obligerait à créer des runs fantômes, ou à perdre la trace des sauts.
 */
CREATE TABLE IF NOT EXISTS heartbeat_beats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason TEXT,
  run_id TEXT,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_beats_at ON heartbeat_beats(at DESC);

/*
 * Instances voisines auxquelles déléguer du travail.
 * 🔒 La colonne token_env porte le NOM d une variable d environnement, jamais un
 * jeton : celui d un pair ouvre son API complète, et n a rien à faire dans un
 * fichier de base sauvegardé et recopié.
 */
CREATE TABLE IF NOT EXISTS federated_peers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  base_url TEXT NOT NULL,
  token_env TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  max_concurrent INTEGER NOT NULL DEFAULT 2,
  health TEXT NOT NULL DEFAULT 'unknown',
  open_until TEXT,
  last_error TEXT,
  last_checked_at TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS training_batches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  spec TEXT NOT NULL DEFAULT '{}',
  checkpoint_index INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);

/*
 * Un échantillon du lot, et son point de reprise.
 *
 * La colonne s'appelle « idx » et non « index » : le mot est réservé en SQL, et
 * le devis d'identifiant qu'il faudrait sinon poser à chaque requête est une
 * source d'erreur permanente pour un gain nul.
 *
 * Chaque ligne est son propre checkpoint : l'état d'un échantillon est écrit
 * dès qu'il change, jamais à la fin du lot. Un arrêt brutal au millième
 * échantillon ne coûte donc que celui-là.
 */
CREATE TABLE IF NOT EXISTS training_items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES training_batches(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  score REAL,
  score_source TEXT,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_training_items_batch ON training_items(batch_id, idx);
CREATE INDEX IF NOT EXISTS idx_training_items_status ON training_items(batch_id, status);

CREATE TABLE IF NOT EXISTS access_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  /* 🔒 Empreinte SHA-256, jamais la valeur : un vol de base ne donne aucun accès. */
  token_hash TEXT NOT NULL UNIQUE,
  preview TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_access_tokens_hash ON access_tokens(token_hash);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Colonnes ajoutées après coup, à créer si elles manquent.
 *
 * `CREATE TABLE IF NOT EXISTS` ne fait rien sur une table déjà présente : une
 * colonne introduite plus tard doit donc être déclarée ici, sans quoi une base
 * existante ne la verra jamais apparaître.
 */
export const ADDED_COLUMNS: Array<[table: string, column: string, ddl: string]> = [
  ['agents', 'cli_agent', 'ALTER TABLE agents ADD COLUMN cli_agent TEXT'],
  ['agents', 'parent_agent_id', 'ALTER TABLE agents ADD COLUMN parent_agent_id TEXT'],
  ['agents', 'plugin_ids', "ALTER TABLE agents ADD COLUMN plugin_ids TEXT NOT NULL DEFAULT '[]'"],
  [
    'agents',
    'mcp_server_ids',
    "ALTER TABLE agents ADD COLUMN mcp_server_ids TEXT NOT NULL DEFAULT '[]'",
  ],
  [
    'agents',
    'rag_collection_ids',
    "ALTER TABLE agents ADD COLUMN rag_collection_ids TEXT NOT NULL DEFAULT '[]'",
  ],
  /*
   * Le contenu d'origine du document.
   *
   * Il manquait, et cela rendait la réindexation impossible : seuls les
   * morceaux découpés étaient conservés, or le recouvrement interdit de
   * reconstituer le texte à partir d'eux. Changer la taille de découpe
   * obligeait donc à retrouver la source ailleurs, et pour un texte collé
   * il n'y en avait pas.
   */
  ['rag_documents', 'content', 'ALTER TABLE rag_documents ADD COLUMN content TEXT'],
  /*
   * Ce que l'utilisateur a désigné à l'ingestion, par opposition au chemin
   * de chaque fichier trouvé dedans. Sans cette racine, rafraîchir un
   * dossier ne peut relire que les fichiers déjà connus, et manque ceux
   * qui y ont été ajoutés depuis.
   */
  ['rag_documents', 'ingest_root', 'ALTER TABLE rag_documents ADD COLUMN ingest_root TEXT'],
  /*
   * Modèle qui a produit le vecteur.
   *
   * Deux fournisseurs ne rendent pas la même dimension (1024 pour Voyage,
   * 1536 pour OpenAI) : sans cette colonne, changer de fournisseur laissait
   * les anciens vecteurs en place, incomparables et silencieusement inutiles.
   */
  ['rag_chunks', 'embedding_model', 'ALTER TABLE rag_chunks ADD COLUMN embedding_model TEXT'],
  /*
   * Politique de résilience d'un agent : ordre des comptes, retries,
   * attente de quota. Nullable, et c'est voulu — un agent sans politique
   * garde exactement le comportement d'avant les fournisseurs multiples.
   */
  ['agents', 'resilience_policy_id', 'ALTER TABLE agents ADD COLUMN resilience_policy_id TEXT'],
  /*
   * Fournisseur et compte effectifs d'un run.
   *
   * Le défaut `claude-sdk` sur les lignes existantes n'est pas une
   * supposition : avant ce lot, Maestro ne savait exécuter que ça.
   */
  [
    'runs',
    'provider_kind',
    "ALTER TABLE runs ADD COLUMN provider_kind TEXT NOT NULL DEFAULT 'claude-sdk'",
  ],
  ['runs', 'account_id', 'ALTER TABLE runs ADD COLUMN account_id TEXT'],
  ['runs', 'account_name', 'ALTER TABLE runs ADD COLUMN account_name TEXT'],
  ['runs', 'attempt_count', 'ALTER TABLE runs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1'],
  /*
   * Anticipation des quotas : fenêtre de mesure, plafond déclaré, plafond
   * appris. Le plafond appris est nullable et le reste tant qu'un compte
   * n'a pas heurté sa limite — on ne devine pas de valeur de départ.
   */
  [
    'provider_accounts',
    'usage_window_sec',
    'ALTER TABLE provider_accounts ADD COLUMN usage_window_sec INTEGER NOT NULL DEFAULT 18000',
  ],
  [
    'provider_accounts',
    'window_token_limit',
    'ALTER TABLE provider_accounts ADD COLUMN window_token_limit INTEGER',
  ],
  [
    'provider_accounts',
    'learned_token_limit',
    'ALTER TABLE provider_accounts ADD COLUMN learned_token_limit INTEGER',
  ],
  ['provider_accounts', 'learned_at', 'ALTER TABLE provider_accounts ADD COLUMN learned_at TEXT'],
  [
    'resilience_policies',
    'quota_pressure_pct',
    'ALTER TABLE resilience_policies ADD COLUMN quota_pressure_pct INTEGER NOT NULL DEFAULT 85',
  ],
  /*
   * Confinement de l'agent, en JSON, nul par défaut.
   *
   * Nul et non un objet désactivé : une base existante ne doit pas voir
   * apparaître un bac à sable, même inactif, sur des agents créés avant
   * qu'il existe. L'absence est le comportement historique, et elle se lit.
   */
  ['agents', 'sandbox', 'ALTER TABLE agents ADD COLUMN sandbox TEXT'],
  /*
   * Qui a tranché une approbation, et pas seulement par où.
   *
   * Nulle sur les approbations antérieures : on ne peut pas inventer une
   * identité après coup, et prétendre le contraire serait pire que
   * l'absence d'information.
   */
  ['approvals', 'resolved_by_label', 'ALTER TABLE approvals ADD COLUMN resolved_by_label TEXT'],
];
