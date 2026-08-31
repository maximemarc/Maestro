/**
 * Carte du battement de cœur, sur la page Routines.
 *
 * Placée là à dessein : le contraste est l'essentiel de ce que l'opérateur doit
 * comprendre. Une routine **déclenche** un prompt écrit d'avance ; un battement
 * **fait délibérer** un agent, qui peut conclure qu'il n'y a rien à faire. Les
 * séparer sur deux pages laisserait croire à deux mécanismes sans rapport.
 *
 * 🔒 L'écran assume ce qu'il engage : activer, c'est accepter que
 * l'orchestrateur dépense des tokens sans qu'on lui ait rien demandé. Les
 * garde-fous sont donc montrés au même niveau que l'interrupteur, pas cachés
 * derrière un « avancé ».
 */
import { useCallback, useEffect, useState } from 'react';
import { HeartStraight, Play, Warning } from '@phosphor-icons/react';
import type { AgentConfig, Beat, HeartbeatConfig } from '@maestro/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { ErrorText, Field, Spinner } from './ui';

const OUTCOME_LABELS: Record<Beat['outcome'], string> = {
  acted: 'a agi',
  idle: 'rien à faire',
  skipped: 'sauté',
  failed: 'échec',
};

const OUTCOME_TONE: Record<Beat['outcome'], string> = {
  acted: 'ok',
  idle: 'muted',
  skipped: 'muted',
  failed: 'danger',
};

export function HeartbeatCard() {
  const agents = useStore((s) => s.agents);
  const notify = useStore((s) => s.notify);

  const [config, setConfig] = useState<HeartbeatConfig | null>(null);
  const [beats, setBeats] = useState<Beat[]>([]);
  const [nextBeatAt, setNextBeatAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const state = await api.getHeartbeat();
      setConfig(state.config);
      setBeats(state.beats);
      setNextBeatAt(state.nextBeatAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Lecture impossible');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = async (changes: Partial<HeartbeatConfig>) => {
    setError(null);
    setBusy(true);
    try {
      const next = await api.patchHeartbeat(changes);
      setConfig(next);
      await load();
    } catch (err) {
      /* Le refus d'un rythme trop rapproché arrive ici : c'est une règle, et
         son motif doit rester lisible plutôt que de disparaître en toast. */
      setError(err instanceof Error ? err.message : 'Enregistrement impossible');
    } finally {
      setBusy(false);
    }
  };

  const beatNow = async () => {
    setBusy(true);
    try {
      const beat = await api.beatNow();
      notify(
        beat.outcome === 'skipped'
          ? `Battement sauté — ${beat.reason ?? 'garde-fou'}`
          : 'Délibération lancée',
        beat.outcome === 'skipped' ? 'info' : 'ok',
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Battement impossible');
    } finally {
      setBusy(false);
    }
  };

  if (!config) return null;

  const agent: AgentConfig | undefined = agents.find((a) => a.id === config.agentId);
  /* Un agent sans budget de tokens peut consommer sans borne à chaque
     battement. C'est le seul plafond par battement — un battement *est* un run
     — donc son absence mérite un avertissement, pas un silence. */
  const missingBudget = agent && !agent.tokenBudget;

  return (
    <section className="card mt-4">
      <div className="row gap-2 items-center">
        <HeartStraight weight={config.enabled ? 'fill' : 'regular'} size={20} />
        <strong>Battement de cœur</strong>
        <span className={`badge ${config.enabled ? 'ok' : 'muted'}`}>
          {config.enabled ? 'actif' : 'inactif'}
        </span>
        {config.enabled && nextBeatAt && (
          <span className="muted sm">
            prochain à {new Date(nextBeatAt).toLocaleTimeString('fr-FR')}
          </span>
        )}
        <span className="spacer" />
        <button className="btn sm" onClick={() => void beatNow()} disabled={busy}>
          {busy ? <Spinner /> : <Play />}
          Battre maintenant
        </button>
      </div>

      <p className="hint mt-2">
        Une routine déclenche un prompt écrit d’avance. Un battement dresse un état des lieux, le
        confie à un agent avec ses consignes permanentes (<span className="mono">HEARTBEAT.md</span>{' '}
        dans son workspace), et le laisse <strong>décider s’il y a lieu d’agir</strong> — y compris
        conclure que non.
      </p>

      {error && <ErrorText>{error}</ErrorText>}

      <label className="checkbox-row mt-3">
        <input
          type="checkbox"
          checked={config.enabled}
          disabled={busy || !config.agentId}
          onChange={(e) => void patch({ enabled: e.target.checked })}
        />
        Activer la délibération périodique
      </label>
      {!config.agentId && <p className="hint">Choisis d’abord l’agent qui délibérera.</p>}

      <div className="grid cols-2 mt-3">
        <Field
          label="Agent de délibération"
          hint="Sa politique d’approbation et ses outils autorisés bornent ce que le battement peut faire."
        >
          <select
            className="input"
            value={config.agentId ?? ''}
            disabled={busy}
            onChange={(e) => void patch({ agentId: e.target.value || null })}
          >
            <option value="">— aucun —</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.emoji} {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rythme (cron)" hint="Cinq minutes au minimum entre deux battements.">
          <input
            className="input mono"
            defaultValue={config.cronExpr}
            disabled={busy}
            onBlur={(e) => {
              if (e.target.value !== config.cronExpr) void patch({ cronExpr: e.target.value });
            }}
          />
        </Field>
      </div>

      {missingBudget && (
        <p className="hint warn">
          <Warning /> L’agent « {agent?.name} » n’a pas de budget de tokens. Un battement est un run
          : sans budget, chaque délibération peut consommer sans borne. Définis-en un dans sa
          configuration.
        </p>
      )}

      <div className="grid cols-2 mt-3">
        <Field label="Plafond quotidien" hint="Nombre maximal de battements par jour.">
          <input
            className="input"
            type="number"
            min={1}
            max={288}
            defaultValue={config.dailyMax}
            disabled={busy}
            onBlur={(e) => {
              const value = Number(e.target.value);
              if (value !== config.dailyMax) void patch({ dailyMax: value });
            }}
          />
        </Field>
        <div className="col gap-2">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={config.skipWhenBusy}
              disabled={busy}
              onChange={(e) => void patch({ skipWhenBusy: e.target.checked })}
            />
            Ne pas battre pendant qu’un run tourne
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={config.skipUnderQuotaPressure}
              disabled={busy}
              onChange={(e) => void patch({ skipUnderQuotaPressure: e.target.checked })}
            />
            Céder le quota au travail demandé
          </label>
        </div>
      </div>

      {beats.length > 0 && (
        <div className="mt-4">
          <h3>Derniers battements</h3>
          <div className="col gap-1 mt-2">
            {beats.slice(0, 8).map((beat) => (
              <div className="row gap-2 items-center wrap" key={beat.id}>
                <span className="muted sm mono">
                  {new Date(beat.at).toLocaleString('fr-FR', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span className={`badge ${OUTCOME_TONE[beat.outcome]}`}>
                  {OUTCOME_LABELS[beat.outcome]}
                </span>
                <span className="hint">{beat.summary ?? beat.reason ?? ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
