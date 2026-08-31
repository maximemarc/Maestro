/**
 * Ce qu'un run a changé sur le disque, et comment le livrer.
 *
 * Maestro savait montrer ce qu'un agent avait *dit* — le transcript — mais pas
 * ce qu'il avait *fait*. Cette section comble ce vide : fichiers touchés, diff,
 * puis deux sorties possibles, un patch ou une branche.
 *
 * Deux choix d'affichage qui portent une intention :
 *
 * - le chargement est **à la demande**, pas au montage : lire un dépôt coûte
 *   plusieurs commandes git et la plupart des runs n'écrivent rien ;
 * - un fichier déjà modifié avant le run est **marqué**, jamais masqué. Le
 *   panneau dit alors la vérité — « voilà l'état du dépôt » — au lieu de
 *   prétendre « voilà le travail de l'agent », ce que git ne permet pas
 *   d'affirmer.
 */
import { useCallback, useState } from 'react';
import { ArrowsClockwise, Download, Files, GitBranch } from '@phosphor-icons/react';
import type { ChangedFile, WorkspaceChanges } from '@maestro/shared';
import { ApiError, api, downloadRunPatch } from '../lib/api';
import { EmptyState, ErrorText, Field, Modal, Spinner } from './ui';

const STATUS_LABELS: Record<ChangedFile['status'], string> = {
  modified: 'modifié',
  added: 'ajouté',
  deleted: 'supprimé',
  renamed: 'renommé',
  untracked: 'nouveau',
};

/** Classe de coloration d'une ligne de diff, déduite de son premier caractère. */
function diffLineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-file';
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  return '';
}

function toMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : 'Erreur inconnue';
}

export function RunChanges({ runId }: { runId: string }) {
  const [state, setState] = useState<WorkspaceChanges | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [branchOpen, setBranchOpen] = useState(false);
  const [branch, setBranch] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [branchBusy, setBranchBusy] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [delivered, setDelivered] = useState<string | null>(null);
  /* Branche livrée localement : c'est elle qu'on proposera de publier. */
  const [deliveredBranch, setDeliveredBranch] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushed, setPushed] = useState<{ branch: string; url: string | null } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setState(await api.runChanges(runId));
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setLoading(false);
    }
  }, [runId]);

  const openBranch = useCallback(async () => {
    setBranchError(null);
    setBranchOpen(true);
    try {
      // Nom proposé par le serveur : il dérive du prompt, que l'humain reconnaît.
      const { branch: suggested } = await api.runBranchName(runId);
      setBranch(suggested);
    } catch {
      setBranch('');
    }
  }, [runId]);

  const submitBranch = useCallback(async () => {
    setBranchBusy(true);
    setBranchError(null);
    try {
      const result = await api.createRunBranch(runId, {
        branch: branch.trim(),
        ...(commitMessage.trim() ? { message: commitMessage.trim() } : {}),
      });
      setDelivered(
        `Branche ${result.branch} créée — ${result.files} fichier(s), ${result.sha.slice(0, 8)}`,
      );
      setDeliveredBranch(result.branch);
      setPushed(null);
      setBranchOpen(false);
      await load();
    } catch (err) {
      setBranchError(toMessage(err));
    } finally {
      setBranchBusy(false);
    }
  }, [branch, commitMessage, load, runId]);

  /*
   * Publication.
   *
   * Le push emprunte les identifiants git de la machine ; Maestro ne stocke
   * aucun jeton de forge. Le lien de merge request vient de la forge elle-même,
   * dans la sortie du push — le fabriquer aurait demandé de connaître son
   * domaine et sa convention d'URL.
   */
  const publish = useCallback(async () => {
    if (!deliveredBranch) return;
    setPushBusy(true);
    setError(null);
    try {
      const result = await api.pushRunBranch(runId, { branch: deliveredBranch });
      setPushed({ branch: result.branch, url: result.mergeRequestUrl });
    } catch (err) {
      setError(toMessage(err));
    } finally {
      setPushBusy(false);
    }
  }, [deliveredBranch, runId]);

  const download = useCallback(async () => {
    setError(null);
    try {
      await downloadRunPatch(runId);
    } catch (err) {
      setError(toMessage(err));
    }
  }, [runId]);

  const files = state?.files ?? [];
  const fromRun = files.filter((f) => !f.preexisting);
  const before = files.filter((f) => f.preexisting);

  return (
    <section aria-label="Modifications du répertoire de l'agent">
      <div className="row justify-between wrap">
        <h3>Modifications</h3>
        <div className="row gap-2">
          {state && (
            <button className="btn sm ghost" onClick={load} disabled={loading}>
              {loading ? <Spinner /> : <ArrowsClockwise />}
              Actualiser
            </button>
          )}
          {state?.available && files.length > 0 && (
            <>
              <button className="btn sm ghost" onClick={download}>
                <Download />
                Patch
              </button>
              <button className="btn sm primary" onClick={openBranch}>
                <GitBranch />
                Créer une branche
              </button>
            </>
          )}
        </div>
      </div>

      {delivered && (
        <div className="card card-ok" role="status">
          {delivered}
          {deliveredBranch && !pushed && (
            <div className="row gap-2 mt-2">
              <button className="btn sm" onClick={publish} disabled={pushBusy}>
                {pushBusy && <Spinner />}
                {pushBusy ? 'Publication…' : 'Publier sur le dépôt distant'}
              </button>
              <span className="text-faint text-xs">
                Pousse la branche avec les identifiants git de la machine. Jamais en force.
              </span>
            </div>
          )}
          {pushed && (
            <div className="mt-2">
              <div>Branche {pushed.branch} publiée.</div>
              {pushed.url ? (
                <a className="btn sm mt-2" href={pushed.url} target="_blank" rel="noreferrer">
                  Ouvrir la merge request
                </a>
              ) : (
                <span className="text-faint text-xs">
                  Le dépôt distant n’a proposé aucun lien de merge request.
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {error && <ErrorText>{error}</ErrorText>}

      {!state && (
        <EmptyState
          icon={<Files size={28} />}
          title="Modifications non chargées"
          hint="Lire l'état du dépôt demande quelques commandes git : Maestro attend que tu le demandes."
        >
          <button className="btn sm" onClick={load} disabled={loading}>
            {loading && <Spinner />}
            {loading ? 'Lecture…' : 'Voir les modifications'}
          </button>
        </EmptyState>
      )}

      {state && !state.available && (
        <div className="card card-off">
          <p className="text-faint">{state.reason}</p>
          <p className="text-xs text-faint">
            Pour suivre les modifications, pointe le répertoire de cet agent sur un dépôt git
            (Configuration → Répertoire de travail).
          </p>
        </div>
      )}

      {state?.available && files.length === 0 && (
        <div className="card card-off">
          <p className="text-faint">
            Aucune modification en attente
            {state.branch ? ` sur la branche ${state.branch}` : ''}.
          </p>
        </div>
      )}

      {state?.available && files.length > 0 && (
        <>
          <div className="row gap-2 wrap text-xs text-faint">
            {state.branch && (
              <span>
                branche <span className="mono">{state.branch}</span>
              </span>
            )}
            {state.baseSha && (
              <span>
                depuis <span className="mono">{state.baseSha.slice(0, 8)}</span>
              </span>
            )}
            <span className="num">
              {fromRun.length} fichier(s) depuis le démarrage du run
              {before.length > 0 ? `, ${before.length} déjà modifié(s) avant` : ''}
            </span>
          </div>

          <ul className="change-list">
            {files.map((file) => (
              <li key={file.path} className="row gap-2 wrap">
                <span className={`badge${file.preexisting ? '' : ' warn'}`}>
                  {STATUS_LABELS[file.status]}
                </span>
                <span className="mono">{file.path}</span>
                {(file.additions > 0 || file.deletions > 0) && (
                  <span className="text-xs num">
                    <span className="diff-add">+{file.additions}</span>{' '}
                    <span className="diff-del">−{file.deletions}</span>
                  </span>
                )}
                {file.preexisting && (
                  <span className="text-xs text-faint">déjà modifié avant le run</span>
                )}
              </li>
            ))}
          </ul>

          {state.diff && (
            <pre className="scroll-box mono diff-view" aria-label="Diff des modifications">
              {state.diff.split('\n').map((line, index) => (
                <div key={index} className={diffLineClass(line)}>
                  {line || ' '}
                </div>
              ))}
            </pre>
          )}
          {state.diffTruncated && (
            <p className="text-xs text-faint">
              Diff tronqué pour l'affichage — télécharge le patch pour le contenu complet.
            </p>
          )}
        </>
      )}

      {branchOpen && (
        <Modal title="Livrer sur une branche" onClose={() => setBranchOpen(false)}>
          <p className="text-xs text-faint">
            Maestro crée une branche neuve depuis l'état courant et y commite les modifications. Une
            branche existante n'est jamais réécrite, et rien n'est poussé sur un remote.
          </p>
          <Field label="Nom de la branche">
            <input
              className="input mono"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              data-autofocus
            />
          </Field>
          <Field
            label="Message de commit"
            hint="Vide : Maestro reprend la première ligne du prompt et cite l'agent."
          >
            <textarea
              className="textarea"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="(par défaut)"
            />
          </Field>
          {branchError && <ErrorText>{branchError}</ErrorText>}
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setBranchOpen(false)}>
              Annuler
            </button>
            <button
              className="btn primary"
              disabled={branchBusy || branch.trim() === ''}
              onClick={submitBranch}
            >
              {branchBusy && <Spinner />}
              {branchBusy ? 'Livraison…' : 'Créer la branche'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
