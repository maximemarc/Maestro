/**
 * Page Paramètres : réglages de l'orchestrateur, infos serveur,
 * sessions tmux et gestion de l'accès (jeton).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Settings, TmuxSessionInfo } from '@maestro/shared';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useStore } from '../lib/store';
import { Desktop, PuzzlePiece } from '@phosphor-icons/react';
import {
  canNotify,
  notifyApprovalsEnabled,
  requestApprovalNotifications,
  setNotifyApprovals,
} from '../lib/prefs';
import { ConfirmButton, EmptyState, Field, LoadingBlock } from '../components/ui';

export default function SettingsPage() {
  const server = useStore((s) => s.server);

  // --- Orchestrateur -------------------------------------------------------
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.getSettings();
        if (!cancelled) setSettings(s);
      } catch (e) {
        if (!cancelled)
          setSettingsError(e instanceof Error ? e.message : 'Erreur de chargement des paramètres');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveSettings = async () => {
    if (!settings) return;
    setSaving(true);
    setSaved(false);
    setSettingsError(null);
    try {
      const next = await api.patchSettings(settings);
      setSettings(next);
      setSaved(true);
    } catch (e) {
      setSettingsError(e instanceof Error ? e.message : "Erreur lors de l'enregistrement");
    } finally {
      setSaving(false);
    }
  };

  // --- Sessions tmux -------------------------------------------------------
  const [sessions, setSessions] = useState<TmuxSessionInfo[]>([]);
  const [tmuxError, setTmuxError] = useState<string | null>(null);
  const [tmuxLoading, setTmuxLoading] = useState(false);
  const [copiedName, setCopiedName] = useState<string | null>(null);

  const refreshSessions = useCallback(async () => {
    setTmuxLoading(true);
    setTmuxError(null);
    try {
      setSessions(await api.listTmuxSessions());
    } catch (e) {
      setTmuxError(e instanceof Error ? e.message : 'Erreur de chargement des sessions tmux');
    } finally {
      setTmuxLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const copyAttach = async (name: string) => {
    try {
      await navigator.clipboard.writeText(`tmux attach -t ${name}`);
      setCopiedName(name);
      setTimeout(() => setCopiedName((n) => (n === name ? null : n)), 2000);
    } catch {
      setTmuxError('Impossible de copier dans le presse-papiers');
    }
  };

  const notify = useStore((s) => s.notify);
  const policies = useStore((s) => s.policies);
  const [notifyApprovals, setNotifyApprovalsState] = useState(() => notifyApprovalsEnabled());
  const [notifyDenied, setNotifyDenied] = useState(false);

  /* Si le navigateur a révoqué la permission entre deux visites, la case doit
     retomber : une case cochée qui ne notifie rien est un mensonge. */
  useEffect(() => {
    if (notifyApprovals && !canNotify()) {
      setNotifyApprovals(false);
      setNotifyApprovalsState(false);
      setNotifyDenied(true);
    }
  }, [notifyApprovals]);

  const toggleApprovalAlerts = async (enabled: boolean) => {
    if (!enabled) {
      setNotifyApprovals(false);
      setNotifyApprovalsState(false);
      setNotifyDenied(false);
      return;
    }
    const granted = await requestApprovalNotifications();
    setNotifyApprovals(granted);
    setNotifyApprovalsState(granted);
    setNotifyDenied(!granted);
    if (granted) notify('Alertes système activées.');
  };

  const killSession = async (name: string) => {
    setTmuxError(null);
    try {
      await api.killTmuxSession(name);
      await refreshSessions();
      notify(`Session tmux ${name} fermée.`);
    } catch (e) {
      setTmuxError(e instanceof Error ? e.message : 'Erreur lors de la fermeture de la session');
    }
  };

  const logout = () => {
    localStorage.removeItem('maestro_token');
    window.location.reload();
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Paramètres</h1>
      </div>
      <p className="page-lede">
        Concurrence des runs, délai d'expiration des approbations, profondeur de délégation,
        notifications.
      </p>

      <div className="col panel-wide">
        {/* --- Orchestrateur ------------------------------------------------ */}
        <div className="card">
          <h2>Orchestrateur</h2>
          {settingsError && (
            <p className="error-text" role="alert">
              {settingsError}
            </p>
          )}
          {!settings && !settingsError && <LoadingBlock rows={5} />}
          {settings && (
            <>
              <Field label="Nom de l'instance">
                <input
                  className="input"
                  value={settings.instanceName}
                  onChange={(e) => setSettings({ ...settings, instanceName: e.target.value })}
                />
              </Field>
              <div className="grid cols-3">
                <Field label="Runs simultanés max">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={32}
                    value={settings.maxConcurrentRuns}
                    onChange={(e) =>
                      setSettings({ ...settings, maxConcurrentRuns: Number(e.target.value) })
                    }
                  />
                </Field>
                <Field
                  label="Timeout d'approbation (s)"
                  hint="délai avant expiration d'une approbation"
                >
                  <input
                    className="input"
                    type="number"
                    min={0}
                    value={settings.approvalTimeoutSec}
                    onChange={(e) =>
                      setSettings({ ...settings, approvalTimeoutSec: Number(e.target.value) })
                    }
                  />
                </Field>
                <Field
                  label="Profondeur de délégation"
                  hint="profondeur max de délégation d'un agent vers un autre"
                >
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={5}
                    value={settings.maxAgentDepth}
                    onChange={(e) =>
                      setSettings({ ...settings, maxAgentDepth: Number(e.target.value) })
                    }
                  />
                </Field>
              </div>
              <Field
                label="Politique de résilience par défaut"
                hint="Appliquée aux agents qui n'en déclarent pas. Sans elle, un run s'exécute sur l'environnement du serveur et s'arrête à la première limite d'usage."
              >
                <select
                  className="input"
                  value={settings.defaultResiliencePolicyId ?? ''}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      defaultResiliencePolicyId: e.target.value === '' ? null : e.target.value,
                    })
                  }
                >
                  <option value="">Aucune — environnement du serveur</option>
                  {policies.map((policy) => (
                    <option key={policy.id} value={policy.id}>
                      {policy.name}
                    </option>
                  ))}
                </select>
              </Field>
              <label className="checkbox-row mb-3">
                <input
                  type="checkbox"
                  checked={settings.telegramNotifyAllRuns}
                  onChange={(e) =>
                    setSettings({ ...settings, telegramNotifyAllRuns: e.target.checked })
                  }
                />
                {/* Le réglage porte sur tous les canaux configurés, pas seulement
                    Telegram ; la clé garde son nom pour ne pas casser les
                    instances déjà enregistrées. */}
                Notifier chaque fin de run sur les canaux configurés
              </label>

              <label className="checkbox-row mb-2">
                <input
                  type="checkbox"
                  checked={notifyApprovals}
                  onChange={(e) => void toggleApprovalAlerts(e.target.checked)}
                />
                Alerte système quand une approbation attend
              </label>
              <p className="text-faint text-xs mb-3">
                Une approbation en attente bloque le run qui l'a demandée. Cette alerte ne concerne
                que ce navigateur, et n'est pas transmise au serveur.
                {notifyDenied && ' Le navigateur a refusé les notifications pour ce site.'}
              </p>
              <div className="row">
                <button className="btn primary" onClick={saveSettings} disabled={saving}>
                  {saving ? 'Enregistrement…' : 'Enregistrer'}
                </button>
                {saved && <span className="text-ok">Paramètres enregistrés.</span>}
              </div>
            </>
          )}
        </div>

        {/* --- Serveur ------------------------------------------------------ */}
        <div className="card">
          <h2>Serveur</h2>
          {server ? (
            <dl className="kv">
              <dt>Version</dt>
              <dd>{server.version}</dd>
              <dt>Démarré le</dt>
              <dd>{fmtDateTime(server.startedAt)}</dd>
              <dt>Répertoire de données</dt>
              <dd className="mono">{server.dataDir}</dd>
              <dt>Telegram</dt>
              <dd>
                <span className={`badge ${server.telegramEnabled ? 'ok' : ''}`}>
                  {server.telegramEnabled ? 'actif' : 'inactif'}
                </span>
                <div className="text-faint text-xs mt-1">
                  configurer TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_IDS dans l'environnement
                </div>
              </dd>
              <dt>tmux</dt>
              <dd>
                <span className={`badge ${server.tmuxAvailable ? 'ok' : 'warn'}`}>
                  {server.tmuxAvailable ? 'disponible' : 'indisponible'}
                </span>
              </dd>
            </dl>
          ) : (
            <p className="text-muted">Informations serveur indisponibles.</p>
          )}
        </div>

        {/* --- Sessions tmux ------------------------------------------------ */}
        <div className="card">
          <div className="row mb-3">
            <h2 className="grow">Sessions tmux</h2>
            <button
              className="btn sm"
              onClick={() => void refreshSessions()}
              disabled={tmuxLoading}
            >
              {tmuxLoading ? 'Actualisation…' : 'Actualiser'}
            </button>
          </div>
          {tmuxError && (
            <p className="error-text" role="alert">
              {tmuxError}
            </p>
          )}
          {sessions.length === 0 && !tmuxError ? (
            <EmptyState
              icon={<Desktop size={28} />}
              title="Aucune session tmux"
              hint="Les sessions apparaissent quand un agent en mode tmux est lancé."
            />
          ) : (
            <div className="col">
              {sessions.map((session) => (
                <div key={session.name} className="tile">
                  <div className="row wrap">
                    <code>{session.name}</code>
                    <span className={`badge ${session.attached ? 'accent' : ''}`}>
                      {session.attached ? 'attaché' : 'détaché'}
                    </span>
                    {session.runId && <Link to={`/runs/${session.runId}`}>voir le run</Link>}
                    <span className="grow" />
                    <ConfirmButton
                      label="Tuer"
                      title="Tuer cette session tmux ?"
                      message={`La session ${session.name} sera fermée. Un run en cours dedans est interrompu.`}
                      confirmLabel="Tuer la session"
                      onConfirm={() => void killSession(session.name)}
                    />
                  </div>
                  <div className="row mt-2">
                    <code className="mono text-muted">tmux attach -t {session.name}</code>
                    <button className="btn ghost sm" onClick={() => void copyAttach(session.name)}>
                      {copiedName === session.name ? 'Copié' : 'Copier'}
                    </button>
                  </div>
                  {session.preview && (
                    <pre className="scroll-box short break-word mt-2 mb-0">{session.preview}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* --- Plugins ------------------------------------------------------ */}
        <div className="card">
          <div className="row">
            <h2 className="grow">Plugins</h2>
            <Link to="/plugins" className="btn sm">
              <PuzzlePiece />
              Gérer les plugins
            </Link>
          </div>
          <p className="text-faint text-sm mb-0">
            Installation, mise à jour et désinstallation se font sur la page Plugins ; l'activation
            par agent dans sa configuration.
          </p>
        </div>

        {/* --- Accès -------------------------------------------------------- */}
        <div className="card">
          <h2>Accès</h2>
          <div className="row">
            <button className="btn danger" onClick={logout}>
              Se déconnecter
            </button>
          </div>
          <p className="text-faint text-xs mb-0">
            Le jeton est défini par MAESTRO_TOKEN ou &lt;dataDir&gt;/token.
          </p>
        </div>
      </div>
    </div>
  );
}
