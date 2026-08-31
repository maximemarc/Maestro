/**
 * Onglet Configuration : identité, modèle, garde-fous, plugins chargés.
 */
import { useEffect, useMemo, useState } from 'react';
import type {
  AgentConfig,
  AgentEngine,
  ApprovalPolicy,
  PermissionMode,
  PluginInstall,
} from '@maestro/shared';
import { api } from '../../lib/api';
import { useStore } from '../../lib/store';
import { Field } from '../../components/ui';
import {
  APPROVAL_POLICY_LABELS,
  PERMISSION_MODE_LABELS,
  TabError,
  errorMessage,
  parseOptionalInt,
  parseToolList,
  toForm,
  toSandbox,
  type ConfigForm,
} from './shared';

export function ConfigTab({ agent }: { agent: AgentConfig }) {
  const agents = useStore((s) => s.agents);
  const mcpServers = useStore((s) => s.mcpServers);
  const ragCollections = useStore((s) => s.ragCollections);
  // Un descendant ne peut pas devenir le parent de son ancêtre : cela créerait
  // un cycle que le graphe devrait ensuite rattraper.
  const eligibleParents = useMemo(() => {
    const isDescendant = (candidate: AgentConfig): boolean => {
      const seen = new Set<string>();
      let cursor: string | null = candidate.parentAgentId;
      while (cursor && !seen.has(cursor)) {
        if (cursor === agent.id) return true;
        seen.add(cursor);
        cursor = agents.find((a) => a.id === cursor)?.parentAgentId ?? null;
      }
      return false;
    };
    return agents.filter((a) => a.id !== agent.id && !isDescendant(a));
  }, [agents, agent.id]);

  const [form, setForm] = useState<ConfigForm>(() => toForm(agent));
  // Les plugins ne transitent pas par le WebSocket : chargement explicite.
  const [plugins, setPlugins] = useState<PluginInstall[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listPlugins()
      .then((list) => {
        if (!cancelled) setPlugins(list);
      })
      .catch(() => {
        if (!cancelled) setPlugins([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setForm(toForm(agent));
    setError(null);
    setSaved(false);
    // Réinitialise le formulaire quand on change d'agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  const set = <K extends keyof ConfigForm>(key: K, value: ConfigForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateAgent(agent.id, {
        name: form.name.trim(),
        emoji: form.emoji.trim(),
        description: form.description.trim(),
        model: form.model.trim(),
        engine: form.engine,
        permissionMode: form.permissionMode,
        approvalPolicy: form.approvalPolicy,
        memoryEnabled: form.memoryEnabled,
        maxTurns: parseOptionalInt(form.maxTurns),
        timeoutSec: parseOptionalInt(form.timeoutSec),
        tokenBudget: parseOptionalInt(form.tokenBudget),
        color: form.color,
        cliAgent: form.cliAgent.trim() === '' ? null : form.cliAgent.trim(),
        parentAgentId: form.parentAgentId === '' ? null : form.parentAgentId,
        pluginIds: form.pluginIds,
        mcpServerIds: form.mcpServerIds,
        ragCollectionIds: form.ragCollectionIds,
        allowedTools: parseToolList(form.allowedTools),
        disallowedTools: parseToolList(form.disallowedTools),
        sandbox: toSandbox(form),
      });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="col panel-wide">
      <div className="card">
        <div className="grid cols-2">
          <Field label="Nom">
            <input
              className="input"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>
          <Field label="Emoji">
            <input
              className="input"
              value={form.emoji}
              onChange={(e) => set('emoji', e.target.value)}
            />
          </Field>
        </div>
        <Field label="Description">
          <input
            className="input"
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </Field>
        <Field
          label="Définition Claude Code native"
          hint="Nom d'un agent de ~/.claude/agents (ex. symfony-expert) : sa persona, ses outils autorisés, ses hooks et ses skills s'appliquent. Laisser vide pour utiliser le CLAUDE.md ci-contre."
        >
          <input
            className="input"
            placeholder="aucune"
            value={form.cliAgent}
            onChange={(e) => set('cliAgent', e.target.value)}
          />
        </Field>
        <Field
          label="Agent parent"
          hint="Rend cet agent subagent d'un autre : le graphe relie alors les deux au lieu de le rattacher à l'orchestrateur. Reflète la délégation réelle : Maestro, puis lead, puis experts."
        >
          <select
            className="select"
            value={form.parentAgentId}
            onChange={(e) => set('parentAgentId', e.target.value)}
          >
            <option value="">Aucun (rattaché à Maestro)</option>
            {eligibleParents.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.emoji} {candidate.name}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Serveurs MCP"
          hint="Les outils de ces serveurs deviennent appelables par cet agent, sous sa politique d'approbation. Déclare-les dans la page MCP."
        >
          {mcpServers.length === 0 ? (
            <span className="hint">Aucun serveur MCP déclaré.</span>
          ) : (
            <div className="col gap-2">
              {mcpServers.map((server) => (
                <label key={server.id} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={form.mcpServerIds.includes(server.id)}
                    onChange={(e) =>
                      set(
                        'mcpServerIds',
                        e.target.checked
                          ? [...form.mcpServerIds, server.id]
                          : form.mcpServerIds.filter((id) => id !== server.id),
                      )
                    }
                  />
                  {server.name}
                  <span className="badge mono">{server.slug}</span>
                  {server.kind === 'custom' ? (
                    <span className="badge accent">{server.tools.length} outil(s)</span>
                  ) : (
                    <span className="badge violet">{server.transport}</span>
                  )}
                  {!server.enabled && <span className="badge warn">désactivé</span>}
                </label>
              ))}
            </div>
          )}
        </Field>

        <Field
          label="Collections RAG"
          hint="Cet agent pourra les interroger avec rag_search. Il ne voit que celles cochées ici."
        >
          {ragCollections.length === 0 ? (
            <span className="hint">Aucune collection documentaire.</span>
          ) : (
            <div className="col gap-2">
              {ragCollections.map((collection) => (
                <label key={collection.id} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={form.ragCollectionIds.includes(collection.id)}
                    onChange={(e) =>
                      set(
                        'ragCollectionIds',
                        e.target.checked
                          ? [...form.ragCollectionIds, collection.id]
                          : form.ragCollectionIds.filter((id) => id !== collection.id),
                      )
                    }
                  />
                  {collection.name}
                  <span className="badge mono">{collection.slug}</span>
                  <span className="badge">{collection.chunkCount} passage(s)</span>
                </label>
              ))}
            </div>
          )}
        </Field>

        <Field
          label="Plugins chargés"
          hint="Chargés dans chaque session de cet agent : leurs skills, agents, commandes et hooks deviennent disponibles. Installe-les depuis Paramètres, onglet Plugins."
        >
          {plugins.length === 0 ? (
            <span className="hint">Aucun plugin installé.</span>
          ) : (
            <div className="col gap-2">
              {plugins.map((plugin) => (
                <label key={plugin.id} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={form.pluginIds.includes(plugin.id)}
                    onChange={(e) =>
                      set(
                        'pluginIds',
                        e.target.checked
                          ? [...form.pluginIds, plugin.id]
                          : form.pluginIds.filter((id) => id !== plugin.id),
                      )
                    }
                  />
                  {plugin.name}
                  {plugin.version && <span className="badge">v{plugin.version}</span>}
                  <span className="badge">{plugin.inventory.skills} skills</span>
                  {plugin.inventory.hooks > 0 && (
                    <span className="badge warn">{plugin.inventory.hooks} hooks</span>
                  )}
                </label>
              ))}
            </div>
          )}
        </Field>
        <div className="grid cols-2">
          <Field label="Modèle" hint="Alias (sonnet, opus, haiku) ou identifiant complet.">
            <input
              className="input"
              value={form.model}
              onChange={(e) => set('model', e.target.value)}
            />
          </Field>
          <Field label="Moteur">
            <select
              className="select"
              value={form.engine}
              onChange={(e) => set('engine', e.target.value as AgentEngine)}
            >
              <option value="sdk">SDK</option>
              <option value="tmux">tmux</option>
            </select>
          </Field>
          <Field label="Mode de permission (SDK)">
            <select
              className="select"
              value={form.permissionMode}
              onChange={(e) => set('permissionMode', e.target.value as PermissionMode)}
            >
              {(Object.keys(PERMISSION_MODE_LABELS) as PermissionMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {PERMISSION_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Politique d'approbation">
            <select
              className="select"
              value={form.approvalPolicy}
              onChange={(e) => set('approvalPolicy', e.target.value as ApprovalPolicy)}
            >
              {(Object.keys(APPROVAL_POLICY_LABELS) as ApprovalPolicy[]).map((policy) => (
                <option key={policy} value={policy}>
                  {APPROVAL_POLICY_LABELS[policy]}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="field">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.memoryEnabled}
              onChange={(e) => set('memoryEnabled', e.target.checked)}
            />
            Mémoire persistante (MEMORY.md entre les runs)
          </label>
        </div>
        <div className="grid cols-4">
          <Field label="Tours max" hint="Vide = illimité.">
            <input
              className="input"
              type="number"
              min={1}
              value={form.maxTurns}
              onChange={(e) => set('maxTurns', e.target.value)}
            />
          </Field>
          <Field label="Timeout (s)" hint="Vide = illimité.">
            <input
              className="input"
              type="number"
              min={1}
              value={form.timeoutSec}
              onChange={(e) => set('timeoutSec', e.target.value)}
            />
          </Field>
          <Field label="Budget tokens / run" hint="Vide = illimité.">
            <input
              className="input"
              type="number"
              min={1}
              value={form.tokenBudget}
              onChange={(e) => set('tokenBudget', e.target.value)}
            />
          </Field>
          <Field label="Couleur">
            <input
              className="input"
              type="color"
              value={form.color}
              onChange={(e) => set('color', e.target.value)}
            />
          </Field>
        </div>
        <div className="grid cols-2">
          <Field label="Outils autorisés" hint="Un outil par ligne. Vide = tous.">
            <textarea
              className="textarea"
              value={form.allowedTools}
              onChange={(e) => set('allowedTools', e.target.value)}
            />
          </Field>
          <Field label="Outils interdits" hint="Un outil par ligne. Vide = aucun.">
            <textarea
              className="textarea"
              value={form.disallowedTools}
              onChange={(e) => set('disallowedTools', e.target.value)}
            />
          </Field>
        </div>
        {/* Confinement.
            Replié tant qu'il est inactif : c'est une option pour un agent dont
            on doute, pas un réglage que tout le monde doit lire. */}
        <details className="mt-4" open={form.sandboxEnabled}>
          <summary className="summary-toggle">
            Bac à sable {form.sandboxEnabled ? '— actif' : '— inactif'}
          </summary>

          <p className="text-faint text-xs mt-2">
            Confine les commandes lancées par l’agent : isolation du système de fichiers, egress
            réseau filtré, seccomp. C’est le bac à sable de Claude Code, pas un conteneur — il
            distingue lecture et écriture par chemin, et la session continue de parler à l’API
            pendant que les commandes restent enfermées. Le jeton et la base de Maestro sont
            toujours illisibles depuis un agent confiné, sans quoi il lui suffirait de les lire pour
            se faire lancer un run libre.
          </p>

          <label className="checkbox-row mt-2">
            <input
              type="checkbox"
              checked={form.sandboxEnabled}
              onChange={(e) => set('sandboxEnabled', e.target.checked)}
            />
            Confiner cet agent
          </label>

          {form.sandboxEnabled && (
            <>
              {/* Le prérequis système est la première cause d'un confinement qui
                  ne confine rien : le dire ici, où l'on coche la case, et non
                  seulement dans une documentation qu'on lit après coup. */}
              <p className="text-warn text-xs">
                ⚠️ Nécessite <code>bubblewrap</code> et <code>socat</code> sur la machine (
                <code>sudo apt install bubblewrap socat</code>). Sans eux, et si le confinement
                n’est pas exigé ci-dessous, l’agent tourne <strong>sans confinement</strong> avec un
                simple avertissement au journal.
              </p>

              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={form.sandboxRequired}
                  onChange={(e) => set('sandboxRequired', e.target.checked)}
                />
                Exiger le confinement (échouer plutôt que de tourner sans)
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={form.sandboxStrict}
                  onChange={(e) => set('sandboxStrict', e.target.checked)}
                />
                Refuser les hôtes hors liste au lieu de demander
              </label>

              <div className="grid cols-3 mt-2">
                <Field
                  label="Domaines autorisés"
                  hint="Un par ligne, jokers admis. Vide = aucune sortie réseau."
                >
                  <textarea
                    className="textarea"
                    rows={4}
                    value={form.sandboxDomains}
                    onChange={(e) => set('sandboxDomains', e.target.value)}
                    placeholder={'registry.npmjs.org\n*.cneidf.net'}
                  />
                </Field>
                <Field
                  label="Écriture autorisée"
                  hint="Chemins en plus du workspace, un par ligne."
                >
                  <textarea
                    className="textarea"
                    rows={4}
                    value={form.sandboxAllowWrite}
                    onChange={(e) => set('sandboxAllowWrite', e.target.value)}
                    placeholder="/tmp/partage"
                  />
                </Field>
                <Field label="Lecture interdite" hint="Chemins à masquer, un par ligne.">
                  <textarea
                    className="textarea"
                    rows={4}
                    value={form.sandboxDenyRead}
                    onChange={(e) => set('sandboxDenyRead', e.target.value)}
                    placeholder={'~/.ssh\n~/.aws'}
                  />
                </Field>
              </div>
            </>
          )}
        </details>

        <dl className="kv">
          <dt>Workspace</dt>
          <dd className="mono">{agent.workspaceDir}</dd>
        </dl>
        <div className="row mt-4">
          <button className="btn primary" onClick={save} disabled={saving}>
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
          {saved && <span className="text-ok">Configuration enregistrée.</span>}
        </div>
        <TabError message={error} />
      </div>
    </div>
  );
}
