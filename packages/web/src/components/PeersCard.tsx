/**
 * Instances voisines, sur la page Fournisseurs.
 *
 * Placée là parce qu'un pair est, du point de vue de l'opérateur, un endroit de
 * plus où du travail peut s'exécuter — au même titre qu'un compte ou un moteur.
 * Le ranger dans les réglages généraux l'aurait coupé de cette question.
 *
 * 🔒 Le formulaire demande le **nom de la variable d'environnement** qui porte
 * le jeton du pair, jamais le jeton : celui-ci ouvre l'API complète de la
 * machine visée.
 */
import { useEffect, useState } from 'react';
import { ArrowsLeftRight, CheckCircle, Plus, Warning } from '@phosphor-icons/react';
import type { FederatedPeer, FederatedPeerCreate, PeerHealth } from '@maestro/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { ConfirmButton, ErrorText, Field, Spinner } from './ui';

const HEALTH_LABELS: Record<PeerHealth, string> = {
  unknown: 'jamais testé',
  ready: 'joignable',
  open: 'écarté après échecs',
  unauthorized: 'jeton refusé',
  unreachable: 'injoignable',
};

const HEALTH_TONE: Record<PeerHealth, string> = {
  unknown: 'muted',
  ready: 'ok',
  open: 'warn',
  unauthorized: 'danger',
  unreachable: 'danger',
};

function blank(): FederatedPeerCreate {
  return { name: '', baseUrl: '', tokenEnv: '', enabled: true, maxConcurrent: 2 };
}

export function PeersCard() {
  const notify = useStore((s) => s.notify);
  const [peers, setPeers] = useState<FederatedPeer[]>([]);
  const [draft, setDraft] = useState<FederatedPeerCreate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const load = () => {
    api
      .listPeers()
      .then(setPeers)
      .catch((err) => setError(err instanceof Error ? err.message : 'Lecture impossible'));
  };

  useEffect(load, []);

  const save = async () => {
    if (!draft) return;
    setError(null);
    try {
      await api.createPeer(draft);
      setDraft(null);
      load();
      notify('Pair déclaré');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enregistrement impossible');
    }
  };

  const test = async (id: string) => {
    setTesting(id);
    try {
      const peer = await api.testPeer(id);
      notify(
        peer.health === 'ready'
          ? `« ${peer.name} » est joignable`
          : `« ${peer.name} » : ${HEALTH_LABELS[peer.health]}`,
        peer.health === 'ready' ? 'ok' : 'info',
      );
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test impossible');
    } finally {
      setTesting(null);
    }
  };

  return (
    <section className="mt-4">
      <div className="row gap-2 items-center">
        <h2>Instances voisines</h2>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setDraft(draft ? null : blank())}>
          <Plus />
          Déclarer un pair
        </button>
      </div>
      <p className="hint mt-1">
        Un agent délègue à une autre machine en écrivant <span className="mono">agent@pair</span>.
        Les pairs sont déclarés explicitement : aucune découverte réseau, qui accorderait sa
        confiance à qui répond.
      </p>

      {error && <ErrorText>{error}</ErrorText>}

      {draft && (
        <div className="card mt-3">
          <div className="row gap-3">
            <Field label="Nom du pair" hint="Ni arobase ni espace : il sert dans « agent@pair ».">
              <input
                className="input"
                value={draft.name}
                placeholder="atelier"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field label="Racine de l’API">
              <input
                className="input"
                value={draft.baseUrl}
                placeholder="https://maestro.autre:4520"
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              />
            </Field>
          </div>
          <div className="row gap-3">
            <Field
              label="Variable portant le jeton"
              hint="Le nom seulement. 🔒 Un jeton de pair ouvre l’API complète de la machine visée : sa valeur reste dans l’environnement du serveur."
            >
              <input
                className="input mono"
                value={draft.tokenEnv}
                placeholder="MAESTRO_PEER_ATELIER"
                onChange={(e) => setDraft({ ...draft, tokenEnv: e.target.value.toUpperCase() })}
              />
            </Field>
            <Field
              label="Délégations simultanées"
              hint="Borne le fan-out, et le rythme d’une boucle éventuelle."
            >
              <input
                className="input"
                type="number"
                min={1}
                max={20}
                value={draft.maxConcurrent}
                onChange={(e) => setDraft({ ...draft, maxConcurrent: Number(e.target.value) })}
              />
            </Field>
          </div>
          <div className="row gap-2">
            <span className="spacer" />
            <button className="btn" onClick={() => setDraft(null)}>
              Annuler
            </button>
            <button
              className="btn primary"
              onClick={() => void save()}
              disabled={!draft.name.trim() || !draft.baseUrl.trim() || !draft.tokenEnv.trim()}
            >
              Déclarer
            </button>
          </div>
        </div>
      )}

      {peers.length === 0 && !draft ? (
        <p className="hint mt-2">
          Aucun pair. <span className="mono">send_to_agent</span> reste alors purement local.
        </p>
      ) : (
        <div className="col gap-2 mt-3">
          {peers.map((peer) => (
            <div className="card" key={peer.id}>
              <div className="row gap-2 items-center wrap">
                <ArrowsLeftRight />
                <strong>{peer.name}</strong>
                <span className={`badge ${HEALTH_TONE[peer.health]}`}>
                  {HEALTH_LABELS[peer.health]}
                </span>
                <span className="muted sm mono">{peer.baseUrl}</span>
                <span className="spacer" />
                <span className="muted sm">max {peer.maxConcurrent}</span>
                <button
                  className="btn sm"
                  onClick={() => void test(peer.id)}
                  disabled={testing === peer.id}
                >
                  {testing === peer.id ? <Spinner /> : <CheckCircle />}
                  Tester
                </button>
                <ConfirmButton
                  label="Retirer"
                  message="Les délégations déjà parties continuent sur la machine distante."
                  onConfirm={() => {
                    void api
                      .deletePeer(peer.id)
                      .then(load)
                      .catch(() => undefined);
                  }}
                />
              </div>
              <p className="hint mt-2">
                Jeton lu dans <span className="mono">{peer.tokenEnv}</span>
                {peer.detail ? ` — ${peer.detail}` : ''}
              </p>
              {peer.lastError && (
                <p className="hint warn">
                  <Warning /> {peer.lastError}
                  {peer.openUntil
                    ? ` — écarté jusqu’à ${new Date(peer.openUntil).toLocaleTimeString('fr-FR')}`
                    : ''}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
