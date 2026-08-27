/**
 * Page Plugins : dépôts clonés localement, chargés dans les sessions des agents
 * qui les activent.
 *
 * Les plugins ne transitent pas par le WebSocket (contrairement aux agents,
 * skills, runs…) : chaque mutation est suivie d'un rechargement explicite.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PluginInstall } from '@maestro/shared';
import { PluginInventoryBadges, SkillImportModal } from '../components/SkillCatalog';
import { ArrowSquareOut, DownloadSimple, PuzzlePiece } from '@phosphor-icons/react';
import { ConfirmButton, EmptyState, ErrorText, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useStore } from '../lib/store';

export default function PluginsPage() {
  const agents = useStore((s) => s.agents);

  const [plugins, setPlugins] = useState<PluginInstall[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Plugin en cours de mutation, pour ne désactiver que sa propre ligne. */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPlugins(await api.listPlugins());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de chargement des plugins');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Quels agents chargent quel plugin — l'information qui manque ailleurs. */
  const consumersByPlugin = useMemo(() => {
    const map = new Map<string, typeof agents>();
    for (const agent of agents) {
      for (const pluginId of agent.pluginIds ?? []) {
        map.set(pluginId, [...(map.get(pluginId) ?? []), agent]);
      }
    }
    return map;
  }, [agents]);

  const update = async (plugin: PluginInstall) => {
    setBusyId(plugin.id);
    setError(null);
    try {
      await api.updatePlugin(plugin.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Erreur de mise à jour de « ${plugin.name} »`);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (plugin: PluginInstall) => {
    setBusyId(plugin.id);
    setError(null);
    try {
      await api.deletePlugin(plugin.id);
      await refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : `Erreur de désinstallation de « ${plugin.name} »`,
      );
    } finally {
      setBusyId(null);
    }
  };

  const totals = useMemo(
    () =>
      plugins.reduce(
        (acc, p) => ({
          skills: acc.skills + p.inventory.skills,
          agents: acc.agents + p.inventory.agents,
          commands: acc.commands + p.inventory.commands,
          hooks: acc.hooks + p.inventory.hooks,
          mcpServers: acc.mcpServers + p.inventory.mcpServers,
        }),
        { skills: 0, agents: 0, commands: 0, hooks: 0, mcpServers: 0 },
      ),
    [plugins],
  );

  return (
    <div className="page">
      <div className="page-header">
        <h1>Plugins</h1>
        {plugins.length > 0 && (
          <span className="badge">
            {plugins.length} installé{plugins.length > 1 ? 's' : ''}
          </span>
        )}
        <span className="spacer" />
        <button className="btn" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Actualisation…' : 'Actualiser'}
        </button>
        <button className="btn primary" onClick={() => setImportOpen(true)}>
          <DownloadSimple />
          Installer un plugin
        </button>
      </div>

      <p className="page-lede">
        Un plugin est un dépôt cloné localement. Ses skills, agents, commandes et hooks sont chargés
        dans les sessions des agents qui l'activent. L'activation se fait agent par agent, depuis la
        fiche d'un agent, onglet Configuration, section Plugins chargés.
      </p>

      {error && <ErrorText>{error}</ErrorText>}

      {plugins.length === 0 && !error ? (
        <EmptyState
          icon={<PuzzlePiece size={28} />}
          title="Aucun plugin installé"
          hint="Installe un plugin depuis un catalogue distant pour l'activer sur un agent."
        >
          <button className="btn primary" onClick={() => setImportOpen(true)}>
            <DownloadSimple />
            Installer un plugin
          </button>
        </EmptyState>
      ) : (
        <>
          {plugins.length > 1 && (
            <div className="row mb-4">
              <span className="text-faint text-sm">Total chargeable :</span>
              <PluginInventoryBadges inventory={totals} />
            </div>
          )}
          <div className="col gap-4">
            {plugins.map((plugin) => {
              const consumers = consumersByPlugin.get(plugin.id) ?? [];
              return (
                <div className="card" key={plugin.id}>
                  <div className="row wrap">
                    <strong className="text-md">{plugin.name}</strong>
                    {plugin.version && <span className="badge accent">v{plugin.version}</span>}
                    {plugin.repo && <span className="badge mono">{plugin.repo}</span>}
                    {plugin.revision && (
                      <span className="badge mono" title="Révision clonée">
                        {plugin.revision}
                      </span>
                    )}
                    <span className="spacer" />
                    <button
                      className="btn sm"
                      onClick={() => void update(plugin)}
                      disabled={busyId === plugin.id}
                    >
                      {busyId === plugin.id && <Spinner />}
                      {busyId === plugin.id ? 'Mise à jour…' : 'Mettre à jour'}
                    </button>
                    <ConfirmButton
                      label="Désinstaller"
                      title="Désinstaller ce plugin ?"
                      message={`« ${plugin.name} » sera retiré du disque et des agents qui le chargent.`}
                      confirmLabel="Désinstaller"
                      onConfirm={() => void remove(plugin)}
                    />
                  </div>

                  {plugin.description && (
                    <div className="text-muted mt-2">{plugin.description}</div>
                  )}

                  <div className="mt-3">
                    <PluginInventoryBadges inventory={plugin.inventory} />
                  </div>

                  <div className="row gap-2 wrap mt-3">
                    <span className="text-faint text-sm">Chargé par :</span>
                    {consumers.length === 0 ? (
                      <span className="text-faint text-sm">
                        aucun agent. Active-le depuis la configuration d'un agent.
                      </span>
                    ) : (
                      consumers.map((agent) => (
                        <Link
                          key={agent.id}
                          to={`/agents/${agent.id}`}
                          className="badge"
                          style={{ borderColor: agent.color }}
                        >
                          {agent.emoji} {agent.name}
                        </Link>
                      ))
                    )}
                  </div>

                  <div className="row gap-3 wrap mt-3">
                    <code className="break-all text-xs">{plugin.path}</code>
                    <span className="text-faint text-xs">
                      installé le {fmtDateTime(plugin.installedAt)}
                      {plugin.updatedAt !== plugin.installedAt &&
                        ` · à jour le ${fmtDateTime(plugin.updatedAt)}`}
                    </span>
                    {plugin.sourceUrl && (
                      <a
                        href={plugin.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-sm row gap-1"
                      >
                        manifeste
                        <ArrowSquareOut />
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {importOpen && (
        <SkillImportModal
          target="plugin"
          onClose={() => setImportOpen(false)}
          onPluginImported={() => {
            setImportOpen(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
