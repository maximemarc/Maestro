/**
 * Import d'une skill, d'un subagent ou d'un plugin depuis une source distante.
 *
 * Deux parcours d'exploration selon le `kind` du connecteur — recherche dans un
 * catalogue, ou saisie d'une référence de dépôt — qui convergent tous les deux
 * sur une prévisualisation obligatoire avant installation.
 *
 * Le socle (constantes, formateurs) et les éléments de présentation vivent sous
 * `catalog/` : ce fichier faisait 981 lignes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, MagnifyingGlass, Plug } from '@phosphor-icons/react';
import type {
  AgentConfig,
  ConnectorSearchQuery,
  ImportTarget,
  PluginInstall,
  RemotePluginPreview,
  RemoteSkill,
  RemoteSkillPreview,
  SkillConnector,
  SkillDef,
} from '@maestro/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { EmptyState, ErrorText, Modal } from './ui';
import {
  AGENT_MODELS,
  BLANK_AGENT_FORM,
  CATALOG_TYPE,
  DEFAULT_AGENT_COLOR,
  DEFAULT_AGENT_EMOJI,
  INITIAL_FILTERS,
  MODAL_TITLE,
  PAGE_SIZE,
  SEARCH_DEBOUNCE_MS,
  errText,
  fmtBytes,
  fmtCount,
  hexColorOr,
  knownModelOr,
  slugify,
  type AgentDraftForm,
  type SearchFilters,
} from './catalog/shared';
import { ArrowSquareOut } from '@phosphor-icons/react';
import { LabeledField, ResultRow, ScrollPre, WarnBox } from './catalog/parts';

/**
 * Callbacks distincts par cible : un nom unique par variante permet à
 * TypeScript de discriminer sur `target` sans ambiguïté de typage contextuel,
 * et laisse l'appel existant (skill, sans `target`) inchangé.
 */
export type SkillImportModalProps =
  | { target?: 'skill'; onClose: () => void; onImported: (skill: SkillDef) => void }
  | { target: 'agent'; onClose: () => void; onAgentImported: (agent: AgentConfig) => void }
  | { target: 'plugin'; onClose: () => void; onPluginImported: (plugin: PluginInstall) => void };

/* L'inventaire d'un plugin est aussi affiché par la page Paramètres : le point
   d'import public reste ce module. */
export { PluginInventoryBadges } from './catalog/parts';
import { PluginInventoryBadges } from './catalog/parts';

export function SkillImportModal(props: SkillImportModalProps) {
  const target: ImportTarget = props.target ?? 'skill';
  const agents = useStore((s) => s.agents);

  const [connectors, setConnectors] = useState<SkillConnector[]>([]);
  const [connectorsLoading, setConnectorsLoading] = useState(true);
  const [connectorsError, setConnectorsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState('');

  const [filters, setFilters] = useState<SearchFilters>(INITIAL_FILTERS);
  const [results, setResults] = useState<RemoteSkill[]>([]);
  const [total, setTotal] = useState(0);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  /** Une recherche a déjà abouti : distingue « vide » de « pas encore chargé ». */
  const [searched, setSearched] = useState(false);

  const [gitRef, setGitRef] = useState('');

  const [preview, setPreview] = useState<RemoteSkillPreview | null>(null);
  const [pluginPreview, setPluginPreview] = useState<RemotePluginPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [installSlug, setInstallSlug] = useState('');
  const [installScope, setInstallScope] = useState<'global' | 'agent'>('global');
  const [installAgentId, setInstallAgentId] = useState('');
  const [agentForm, setAgentForm] = useState<AgentDraftForm>(BLANK_AGENT_FORM);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  /** Jetons de requête : une réponse tardive ne doit pas écraser une plus récente. */
  const searchToken = useRef(0);
  const previewToken = useRef(0);

  const connector = connectors.find((c) => c.id === selectedId) ?? null;
  const connectorKind = connector?.kind ?? null;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.listConnectors();
        if (cancelled) return;
        setConnectors(list);
        setSelectedId(list[0]?.id ?? '');
      } catch (err) {
        if (!cancelled) setConnectorsError(errText(err));
      } finally {
        if (!cancelled) setConnectorsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runSearch = useCallback(
    async (connectorId: string, f: SearchFilters, offset: number, append: boolean) => {
      const token = ++searchToken.current;
      setSearching(true);
      setSearchError(null);
      const query: ConnectorSearchQuery = {
        ...(f.q.trim() ? { q: f.q.trim() } : {}),
        ...(f.category ? { category: f.category } : {}),
        type: CATALOG_TYPE[target],
        ...(f.featured ? { featured: true } : {}),
        sort: f.sort,
        limit: PAGE_SIZE,
        offset,
      };
      try {
        const res = await api.searchConnector(connectorId, query);
        if (token !== searchToken.current) return;
        setResults((prev) => (append ? [...prev, ...res.results] : res.results));
        setTotal(res.total);
        setSearched(true);
      } catch (err) {
        if (token !== searchToken.current) return;
        setSearchError(errText(err));
        if (!append) setResults([]);
      } finally {
        if (token === searchToken.current) setSearching(false);
      }
    },
    [target],
  );

  // Recherche différée : une frappe ne déclenche pas un appel par caractère.
  useEffect(() => {
    if (!selectedId || connectorKind !== 'catalog') return;
    const timer = window.setTimeout(() => {
      void runSearch(selectedId, filters, 0, false);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [selectedId, connectorKind, filters, runSearch]);

  const selectConnector = (id: string) => {
    if (id === selectedId) return;
    searchToken.current += 1;
    previewToken.current += 1;
    setSelectedId(id);
    setFilters(INITIAL_FILTERS);
    setResults([]);
    setTotal(0);
    setSearched(false);
    setSearching(false);
    setSearchError(null);
    setGitRef('');
    setPreview(null);
    setPluginPreview(null);
    setPreviewError(null);
    setPreviewLoading(false);
    setInstallError(null);
  };

  const loadPreview = async (connectorId: string, ref: string) => {
    const token = ++previewToken.current;
    setPreviewLoading(true);
    setPreviewError(null);
    setInstallError(null);
    try {
      if (target === 'plugin') {
        const res = await api.previewRemotePlugin(connectorId, ref);
        if (token !== previewToken.current) return;
        setPluginPreview(res);
        setInstallSlug(slugify(res.name) || slugify(res.repo));
      } else {
        const res = await api.previewRemoteSkill(connectorId, ref);
        if (token !== previewToken.current) return;
        setPreview(res);
        setInstallSlug(res.suggestedSlug);
        setInstallScope('global');
        setInstallAgentId(agents[0]?.id ?? '');
        setAgentForm({
          ...BLANK_AGENT_FORM,
          name: res.name,
          color: hexColorOr(res.agentDraft?.color, DEFAULT_AGENT_COLOR),
          model: knownModelOr(res.agentDraft?.model, BLANK_AGENT_FORM.model),
        });
      }
    } catch (err) {
      if (token !== previewToken.current) return;
      setPreviewError(errText(err));
    } finally {
      if (token === previewToken.current) setPreviewLoading(false);
    }
  };

  const backToBrowse = () => {
    previewToken.current += 1;
    setPreview(null);
    setPluginPreview(null);
    setPreviewError(null);
    setPreviewLoading(false);
    setInstallError(null);
  };

  const setAgentField = <K extends keyof AgentDraftForm>(key: K, value: AgentDraftForm[K]) =>
    setAgentForm((f) => ({ ...f, [key]: value }));

  const submitSkillInstall = async (onImported: (skill: SkillDef) => void) => {
    if (!preview) return;
    const slug = installSlug.trim();
    if (!slug) {
      setInstallError('Le slug est obligatoire.');
      return;
    }
    if (installScope === 'agent' && !installAgentId) {
      setInstallError('Choisis un agent pour une skill de portée « agent ».');
      return;
    }
    setInstalling(true);
    setInstallError(null);
    try {
      const skill = await api.installRemoteSkill(preview.connectorId, {
        ref: preview.ref,
        slug,
        scope: installScope,
        agentId: installScope === 'agent' ? installAgentId : null,
      });
      onImported(skill);
    } catch (err) {
      setInstallError(errText(err));
    } finally {
      setInstalling(false);
    }
  };

  const submitAgentInstall = async (onAgentImported: (agent: AgentConfig) => void) => {
    if (!preview) return;
    const name = agentForm.name.trim();
    if (!name) {
      setInstallError("Le nom de l'agent est obligatoire.");
      return;
    }
    setInstalling(true);
    setInstallError(null);
    try {
      const agent = await api.installRemoteAgent(preview.connectorId, {
        ref: preview.ref,
        name,
        emoji: agentForm.emoji.trim() || DEFAULT_AGENT_EMOJI,
        color: agentForm.color,
        model: agentForm.model,
        engine: agentForm.engine,
        approvalPolicy: agentForm.approvalPolicy,
        parentAgentId: agentForm.parentAgentId || null,
      });
      onAgentImported(agent);
    } catch (err) {
      setInstallError(errText(err));
    } finally {
      setInstalling(false);
    }
  };

  const submitPluginInstall = async (onPluginImported: (plugin: PluginInstall) => void) => {
    if (!pluginPreview) return;
    const slug = installSlug.trim();
    if (!slug) {
      setInstallError('Le slug est obligatoire.');
      return;
    }
    setInstalling(true);
    setInstallError(null);
    try {
      const plugin = await api.installRemotePlugin(pluginPreview.connectorId, {
        ref: pluginPreview.ref,
        slug,
      });
      onPluginImported(plugin);
    } catch (err) {
      setInstallError(errText(err));
    } finally {
      setInstalling(false);
    }
  };

  const submitInstall = async () => {
    if (props.target === 'agent') {
      await submitAgentInstall(props.onAgentImported);
      return;
    }
    if (props.target === 'plugin') {
      await submitPluginInstall(props.onPluginImported);
      return;
    }
    await submitSkillInstall(props.onImported);
  };

  const showPreviewStep = preview !== null || pluginPreview !== null || previewLoading;
  const gitRefLabel =
    target === 'plugin'
      ? 'Référence du plugin'
      : target === 'agent'
        ? 'Référence du subagent'
        : 'Référence de la skill';
  const gitRefHint =
    target === 'plugin'
      ? "owner/repo d'un dépôt de plugin Claude Code, ou URL de son manifeste"
      : target === 'agent'
        ? 'URL GitHub du fichier markdown du subagent, ou owner/repo/chemin/agent.md'
        : "URL GitHub d'un SKILL.md, ou owner/repo/chemin/SKILL.md";
  const gitRefPlaceholder =
    target === 'plugin'
      ? 'owner/repo'
      : target === 'agent'
        ? 'owner/repo/agents/mon-agent.md'
        : 'owner/repo/skills/ma-skill/SKILL.md';
  const installLabel = target === 'plugin' ? 'Installer' : 'Importer';
  const installBusyLabel = target === 'plugin' ? 'Installation…' : 'Import…';

  return (
    <Modal wide title={MODAL_TITLE[target]} onClose={props.onClose}>
      {connectorsError && <ErrorText>{connectorsError}</ErrorText>}
      {connectorsLoading && <div className="text-muted">Chargement des connecteurs…</div>}

      {!connectorsLoading && !connectorsError && connectors.length === 0 && (
        <EmptyState
          icon={<Plug size={28} />}
          title="Aucun connecteur disponible"
          hint="Le serveur n'expose aucune source distante."
        />
      )}

      {connectors.length > 0 && (
        <>
          <div className="tabs">
            {connectors.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`tab${c.id === selectedId ? ' active' : ''}`}
                onClick={() => selectConnector(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>

          {connector && (
            <div className="col gap-1 mb-4">
              <div className="text-muted text-sm">{connector.description}</div>
              <div className="row gap-3 wrap text-sm">
                <a href={connector.homepage} target="_blank" rel="noreferrer">
                  {connector.homepage}
                  <ArrowSquareOut />
                </a>
                {connector.totalItems !== null && (
                  <span className="badge">{fmtCount(connector.totalItems)} entrées</span>
                )}
                <span className="badge accent">type : {CATALOG_TYPE[target]}</span>
              </div>
            </div>
          )}
        </>
      )}

      {/* Étape 1 : parcours du catalogue ou saisie d'une référence. */}
      {connector && !showPreviewStep && connector.kind === 'catalog' && (
        <div className="col">
          <LabeledField
            id="catalog-q"
            label="Recherche"
            hint="Laisse vide pour afficher les entrées les plus populaires."
          >
            <input
              id="catalog-q"
              className="input"
              value={filters.q}
              placeholder="revue de code, terraform, sql…"
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            />
          </LabeledField>

          <div className="grid cols-2">
            <LabeledField id="catalog-category" label="Catégorie">
              <select
                id="catalog-category"
                className="select"
                value={filters.category}
                onChange={(e) => setFilters({ ...filters, category: e.target.value })}
              >
                <option value="">Toutes</option>
                {connector.categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </LabeledField>
            <LabeledField id="catalog-sort" label="Tri">
              <select
                id="catalog-sort"
                className="select"
                value={filters.sort}
                onChange={(e) =>
                  setFilters({ ...filters, sort: e.target.value === 'newest' ? 'newest' : 'stars' })
                }
              >
                <option value="stars">Popularité (étoiles)</option>
                <option value="newest">Plus récentes</option>
              </select>
            </LabeledField>
          </div>

          <div className="checkbox-row">
            <input
              id="catalog-featured"
              type="checkbox"
              checked={filters.featured}
              onChange={(e) => setFilters({ ...filters, featured: e.target.checked })}
            />
            <label className="field-label" htmlFor="catalog-featured">
              Uniquement les sélections humaines
            </label>
          </div>

          {searchError && <ErrorText>{searchError}</ErrorText>}

          {searching && results.length === 0 && (
            <div className="text-muted">Recherche en cours…</div>
          )}

          {!searching && searched && results.length === 0 && !searchError && (
            <EmptyState
              icon={<MagnifyingGlass size={28} />}
              title="Aucun résultat"
              hint="Élargis la recherche ou retire un filtre."
            />
          )}

          {results.length > 0 && (
            <>
              <div className="text-faint text-sm">
                {fmtCount(results.length)} affichée{results.length > 1 ? 's' : ''} sur{' '}
                {fmtCount(total)}
              </div>
              <div className="col gap-2">
                {results.map((item) => (
                  <ResultRow
                    key={`${item.connectorId}:${item.ref}`}
                    item={item}
                    busy={previewLoading}
                    onPreview={() => void loadPreview(item.connectorId, item.ref)}
                  />
                ))}
              </div>
              {results.length < total && (
                <button
                  className="btn"
                  disabled={searching}
                  onClick={() => void runSearch(connector.id, filters, results.length, true)}
                >
                  {searching ? 'Chargement…' : 'Charger plus'}
                </button>
              )}
            </>
          )}

          {previewError && <ErrorText>{previewError}</ErrorText>}
        </div>
      )}

      {connector && !showPreviewStep && connector.kind === 'git' && (
        <div className="col">
          <LabeledField id="git-ref" label={gitRefLabel} hint={gitRefHint}>
            <input
              id="git-ref"
              className="input mono"
              value={gitRef}
              placeholder={gitRefPlaceholder}
              onChange={(e) => setGitRef(e.target.value)}
            />
          </LabeledField>
          {previewError && <ErrorText>{previewError}</ErrorText>}
          <div className="row">
            <button
              className="btn primary"
              disabled={!gitRef.trim()}
              onClick={() => void loadPreview(connector.id, gitRef.trim())}
            >
              Prévisualiser
            </button>
          </div>
        </div>
      )}

      {/* Étape 2 : prévisualisation obligatoire, puis installation. */}
      {showPreviewStep && (
        <div className="col">
          <div className="row">
            <button className="btn sm ghost" onClick={backToBrowse}>
              <ArrowLeft />
              Retour
            </button>
          </div>

          {previewLoading && <div className="text-muted">Lecture du contenu distant…</div>}

          {/* --- Composant markdown : skill ou subagent --------------------- */}
          {preview && target !== 'plugin' && (
            <>
              <div className="card col gap-2 tile-card">
                <div className="row gap-2 wrap">
                  <strong>{preview.name}</strong>
                  <span className="badge accent">{preview.componentType}</span>
                  {preview.repo && <span className="badge mono">{preview.repo}</span>}
                </div>
                {preview.description && (
                  <div className="text-muted text-sm">{preview.description}</div>
                )}
                <div className="row gap-3 wrap">
                  <code className="break-all">
                    <a href={preview.resolvedUrl} target="_blank" rel="noreferrer">
                      {preview.resolvedUrl}
                    </a>
                  </code>
                  <span className="badge">{fmtBytes(preview.sizeBytes)}</span>
                </div>
              </div>

              {target === 'agent' ? (
                <WarnBox>
                  Un subagent importé devient un agent Maestro : son prompt sera exécuté avec tes
                  outils (fichiers, shell, réseau) selon la politique d'approbation choisie
                  ci-dessous. Relis-le intégralement, a fortiori s'il vient d'une source tierce.
                </WarnBox>
              ) : (
                <WarnBox>
                  Une skill est une consigne injectée dans un agent qui a accès à tes outils
                  (fichiers, shell, réseau). Relis-la intégralement avant de l'importer, a fortiori
                  lorsqu'elle vient d'une source tierce.
                </WarnBox>
              )}

              {target === 'agent' && preview.agentDraft && preview.agentDraft.tools.length > 0 && (
                <div className="col gap-2">
                  <div className="text-faint text-sm">Outils déclarés par le subagent</div>
                  <div className="row gap-2 wrap">
                    {preview.agentDraft.tools.map((tool) => (
                      <span key={tool} className="badge violet mono">
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <ScrollPre>{preview.content}</ScrollPre>

              {target === 'agent' ? (
                <>
                  <div className="grid cols-3">
                    <LabeledField id="agent-name" label="Nom">
                      <input
                        id="agent-name"
                        className="input"
                        value={agentForm.name}
                        onChange={(e) => setAgentField('name', e.target.value)}
                      />
                    </LabeledField>
                    <LabeledField id="agent-emoji" label="Emoji">
                      <input
                        id="agent-emoji"
                        className="input"
                        value={agentForm.emoji}
                        placeholder={DEFAULT_AGENT_EMOJI}
                        onChange={(e) => setAgentField('emoji', e.target.value)}
                      />
                    </LabeledField>
                    <LabeledField id="agent-color" label="Couleur">
                      <input
                        id="agent-color"
                        className="input"
                        type="color"
                        value={agentForm.color}

                        onChange={(e) => setAgentField('color', e.target.value)}
                      />
                    </LabeledField>
                  </div>
                  <div className="grid cols-2">
                    <LabeledField id="agent-model" label="Modèle">
                      <select
                        id="agent-model"
                        className="select"
                        value={agentForm.model}
                        onChange={(e) => setAgentField('model', e.target.value)}
                      >
                        {AGENT_MODELS.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </LabeledField>
                    <LabeledField id="agent-engine" label="Moteur">
                      <select
                        id="agent-engine"
                        className="select"
                        value={agentForm.engine}
                        onChange={(e) =>
                          setAgentField('engine', e.target.value === 'tmux' ? 'tmux' : 'sdk')
                        }
                      >
                        <option value="sdk">SDK</option>
                        <option value="tmux">tmux</option>
                      </select>
                    </LabeledField>
                  </div>
                  <div className="grid cols-2">
                    <LabeledField id="agent-approval" label="Politique d'approbation">
                      <select
                        id="agent-approval"
                        className="select"
                        value={agentForm.approvalPolicy}
                        onChange={(e) =>
                          setAgentField(
                            'approvalPolicy',
                            e.target.value === 'auto'
                              ? 'auto'
                              : e.target.value === 'ask'
                                ? 'ask'
                                : 'guarded',
                          )
                        }
                      >
                        <option value="auto">auto : tout passe</option>
                        <option value="guarded">guarded : lecture libre, écriture approuvée</option>
                        <option value="ask">ask : tout approuvé</option>
                      </select>
                    </LabeledField>
                    <LabeledField
                      id="agent-parent"
                      label="Agent parent (optionnel)"
                      hint="Rattache le nouvel agent comme subagent d'un agent existant."
                    >
                      <select
                        id="agent-parent"
                        className="select"
                        value={agentForm.parentAgentId}
                        onChange={(e) => setAgentField('parentAgentId', e.target.value)}
                      >
                        <option value="">Aucun (premier niveau)</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.emoji} {a.name}
                          </option>
                        ))}
                      </select>
                    </LabeledField>
                  </div>
                </>
              ) : (
                <div className="grid cols-3">
                  <LabeledField id="install-slug" label="Slug" hint="Minuscules et tirets.">
                    <input
                      id="install-slug"
                      className="input mono"
                      value={installSlug}
                      onChange={(e) => setInstallSlug(slugify(e.target.value))}
                    />
                  </LabeledField>
                  <LabeledField id="install-scope" label="Portée">
                    <select
                      id="install-scope"
                      className="select"
                      value={installScope}
                      onChange={(e) =>
                        setInstallScope(e.target.value === 'agent' ? 'agent' : 'global')
                      }
                    >
                      <option value="global">Globale : tous les agents</option>
                      <option value="agent">Agent : un seul agent</option>
                    </select>
                  </LabeledField>
                  {installScope === 'agent' && (
                    <LabeledField id="install-agent" label="Agent">
                      <select
                        id="install-agent"
                        className="select"
                        value={installAgentId}
                        onChange={(e) => setInstallAgentId(e.target.value)}
                      >
                        <option value="">Choisir un agent</option>
                        {agents.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.emoji} {a.name}
                          </option>
                        ))}
                      </select>
                    </LabeledField>
                  )}
                </div>
              )}
            </>
          )}

          {/* --- Plugin : manifeste et inventaire --------------------------- */}
          {pluginPreview && target === 'plugin' && (
            <>
              <div className="card col gap-2 tile-card">
                <div className="row gap-2 wrap">
                  <strong>{pluginPreview.name}</strong>
                  {pluginPreview.version && (
                    <span className="badge accent">v{pluginPreview.version}</span>
                  )}
                  <span className="badge mono">{pluginPreview.repo}</span>
                  {pluginPreview.author && (
                    <span className="badge">par {pluginPreview.author}</span>
                  )}
                </div>
                {pluginPreview.description && (
                  <div className="text-muted text-sm">{pluginPreview.description}</div>
                )}
                <code className="break-all">
                  <a href={pluginPreview.resolvedUrl} target="_blank" rel="noreferrer">
                    {pluginPreview.resolvedUrl}
                  </a>
                </code>
                <PluginInventoryBadges inventory={pluginPreview.inventory} />
              </div>

              <WarnBox>
                Installer un plugin clone un dépôt tiers en local et charge ses skills, agents,
                commandes et hooks dans les sessions qui l'activent.
                {pluginPreview.inventory.mcpServers > 0 && (
                  <>
                    {' '}
                    Ce plugin déclare {fmtCount(pluginPreview.inventory.mcpServers)} serveur
                    {pluginPreview.inventory.mcpServers > 1 ? 's' : ''} MCP : il ouvrira donc des
                    connexions sortantes.
                  </>
                )}{' '}
                Relis le manifeste avant d'installer.
              </WarnBox>

              <ScrollPre>{pluginPreview.manifest}</ScrollPre>

              <LabeledField
                id="plugin-slug"
                label="Slug"
                hint="Nom du répertoire local du plugin, en minuscules et tirets."
              >
                <input
                  id="plugin-slug"
                  className="input mono"
                  value={installSlug}
                  onChange={(e) => setInstallSlug(slugify(e.target.value))}
                />
              </LabeledField>
            </>
          )}

          {(preview || pluginPreview) && (
            <>
              {installError && (
                <div className="error-text" role="alert">
                  {installError}
                </div>
              )}
              <div className="modal-actions">
                <button type="button" className="btn ghost" onClick={props.onClose}>
                  Annuler
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={installing}
                  onClick={() => void submitInstall()}
                >
                  {installing ? installBusyLabel : installLabel}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
