/**
 * Page Pipelines — chaînes d'agents : création/édition, exécution et suivi.
 * Données temps réel : store.pipelines et store.pipelineRuns (événements WS).
 */
import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUp, ArrowDown, FlowArrow, Play, Plus, X } from '@phosphor-icons/react';
import type {
  AgentConfig,
  Pipeline,
  PipelineRun,
  PipelineRunStatus,
  SkillDef,
} from '@maestro/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import { fmtDateTime, fmtDuration } from '../lib/format';
import {
  AgentChip,
  ConfirmButton,
  EmptyState,
  ErrorText,
  Field,
  Modal,
  Spinner,
  StatusBadge,
} from '../components/ui';

const PIPELINE_RUN_LABELS: Record<PipelineRunStatus, string> = {
  running: 'En cours',
  succeeded: 'Réussi',
  failed: 'Échoué',
  cancelled: 'Annulé',
};

const PROMPT_TEMPLATE_HINT =
  'Variables : {{input}} = entrée du pipeline, {{prev}} = sortie de l’étape précédente, {{steps.<nom>}} = sortie d’une étape nommée';

function PipelineRunBadge({ status }: { status: PipelineRunStatus }) {
  const tone =
    status === 'running'
      ? 'accent'
      : status === 'succeeded'
        ? 'ok'
        : status === 'failed'
          ? 'danger'
          : '';
  return <span className={`badge ${tone}`}>{PIPELINE_RUN_LABELS[status]}</span>;
}

// ---------------------------------------------------------------------------
// Éditeur de pipeline (création / édition)
// ---------------------------------------------------------------------------

interface StepDraft {
  /** id serveur pour une étape existante, null pour une nouvelle. */
  id: string | null;
  /** Clé React stable côté client. */
  key: string;
  name: string;
  agentId: string;
  skillId: string;
  promptTemplate: string;
}

let draftCounter = 0;
function nextDraftKey(): string {
  draftCounter += 1;
  return `draft-${draftCounter}`;
}

function PipelineEditor(props: {
  pipeline: Pipeline | null;
  agents: AgentConfig[];
  skills: SkillDef[];
  onClose: () => void;
}) {
  const { pipeline, agents, skills, onClose } = props;
  const [name, setName] = useState(pipeline?.name ?? '');
  const [description, setDescription] = useState(pipeline?.description ?? '');
  const [steps, setSteps] = useState<StepDraft[]>(() =>
    (pipeline?.steps ?? []).map((s) => ({
      id: s.id,
      key: nextDraftKey(),
      name: s.name,
      agentId: s.agentId,
      skillId: s.skillId ?? '',
      promptTemplate: s.promptTemplate,
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const addStep = () => {
    setSteps((prev) => [
      ...prev,
      {
        id: null,
        key: nextDraftKey(),
        name: `etape-${prev.length + 1}`,
        agentId: agents[0]?.id ?? '',
        skillId: '',
        promptTemplate: prev.length === 0 ? '{{input}}' : '{{prev}}',
      },
    ]);
  };

  const patchStep = (key: string, patch: Partial<StepDraft>) => {
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  };

  const removeStep = (key: string) => {
    setSteps((prev) => prev.filter((s) => s.key !== key));
  };

  const moveStep = (idx: number, delta: number) => {
    setSteps((prev) => {
      const j = idx + delta;
      if (j < 0 || j >= prev.length) return prev;
      const a = prev[idx];
      const b = prev[j];
      if (!a || !b) return prev;
      const next = prev.slice();
      next[idx] = b;
      next[j] = a;
      return next;
    });
  };

  const skillOptionsFor = (agentId: string): SkillDef[] =>
    skills.filter((s) => s.scope !== 'agent' || s.agentId === agentId);

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Le nom du pipeline est requis.');
      return;
    }
    if (steps.length === 0) {
      setError('Ajoutez au moins une étape.');
      return;
    }
    for (const s of steps) {
      if (!s.name.trim()) {
        setError('Chaque étape doit avoir un nom.');
        return;
      }
      if (!s.agentId) {
        setError('Chaque étape doit avoir un agent.');
        return;
      }
      if (!s.promptTemplate.trim()) {
        setError(`L’étape « ${s.name} » doit avoir un gabarit de prompt.`);
        return;
      }
    }
    const payloadSteps = steps.map((s) => ({
      ...(s.id ? { id: s.id } : {}),
      name: s.name.trim(),
      agentId: s.agentId,
      skillId: s.skillId || null,
      promptTemplate: s.promptTemplate,
    }));
    setBusy(true);
    try {
      if (pipeline) {
        await api.updatePipeline(pipeline.id, {
          name: name.trim(),
          description,
          steps: payloadSteps,
        });
      } else {
        await api.createPipeline({ name: name.trim(), description, steps: payloadSteps });
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={pipeline ? `Éditer « ${pipeline.name} »` : 'Nouveau pipeline'}
      onClose={onClose}
      wide
    >
      <Field label="Nom">
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex. : veille-et-synthese"
        />
      </Field>
      <Field label="Description">
        <input
          className="input"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="À quoi sert ce pipeline ?"
        />
      </Field>

      <h3>Étapes</h3>
      {steps.length === 0 && <div className="text-faint mb-3">Aucune étape pour l’instant.</div>}
      <div className="col">
        {steps.map((step, idx) => (
          <div className="card" key={step.key}>
            <div className="row mb-3">
              <span className="badge">{idx + 1}</span>
              <span className="spacer grow" />
              <button
                className="btn ghost sm"
                onClick={() => moveStep(idx, -1)}
                disabled={idx === 0}
                aria-label="Monter l’étape"
              >
                <ArrowUp />
              </button>
              <button
                className="btn ghost sm"
                onClick={() => moveStep(idx, 1)}
                disabled={idx === steps.length - 1}
                aria-label="Descendre l’étape"
              >
                <ArrowDown />
              </button>
              <button
                className="btn ghost sm"
                onClick={() => removeStep(step.key)}
                aria-label="Supprimer l’étape"
              >
                <X />
              </button>
            </div>
            <div className="grid cols-3">
              <Field label="Nom de l’étape">
                <input
                  className="input"
                  value={step.name}
                  onChange={(e) => patchStep(step.key, { name: e.target.value })}
                  placeholder="Ex. : analyse"
                />
              </Field>
              <Field label="Agent">
                <select
                  className="select"
                  value={step.agentId}
                  onChange={(e) => patchStep(step.key, { agentId: e.target.value })}
                >
                  <option value="">Choisir</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.emoji} {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Skill (optionnel)">
                <select
                  className="select"
                  value={step.skillId}
                  onChange={(e) => patchStep(step.key, { skillId: e.target.value })}
                >
                  <option value="">Aucun</option>
                  {skillOptionsFor(step.agentId).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Gabarit de prompt" hint={PROMPT_TEMPLATE_HINT}>
              <textarea
                className="textarea"
                value={step.promptTemplate}
                onChange={(e) => patchStep(step.key, { promptTemplate: e.target.value })}
              />
            </Field>
          </div>
        ))}
      </div>
      <div className="mt-3">
        <button className="btn sm" onClick={addStep}>
          <Plus />
          Ajouter une étape
        </button>
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={busy}>
          Annuler
        </button>
        <button className="btn primary" onClick={submit} disabled={busy}>
          {busy ? 'Enregistrement…' : pipeline ? 'Enregistrer' : 'Créer le pipeline'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Modale d'exécution (saisie de l'entrée)
// ---------------------------------------------------------------------------

function RunPipelineModal(props: { pipeline: Pipeline; onClose: () => void }) {
  const { pipeline, onClose } = props;
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.runPipeline(pipeline.id, input);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Exécuter « ${pipeline.name} »`} onClose={onClose}>
      <Field label="Entrée du pipeline" hint="Injectée via {{input}} dans les gabarits de prompt.">
        <textarea
          className="textarea"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Texte transmis à la première étape…"
          data-autofocus
        />
      </Field>
      {error && <ErrorText>{error}</ErrorText>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={busy}>
          Annuler
        </button>
        <button className="btn primary" onClick={submit} disabled={busy}>
          {busy ? <Spinner /> : <Play />}
          {busy ? 'Lancement…' : 'Exécuter'}
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Modale de détail d'une exécution
// ---------------------------------------------------------------------------

function PipelineRunDetailModal(props: {
  run: PipelineRun;
  pipeline: Pipeline | undefined;
  onClose: () => void;
}) {
  const { run, pipeline, onClose } = props;

  const stepName = (stepId: string, idx: number): string =>
    pipeline?.steps.find((s) => s.id === stepId)?.name ?? `Étape ${idx + 1}`;

  return (
    <Modal title={`Exécution : ${pipeline?.name ?? 'pipeline supprimé'}`} onClose={onClose} wide>
      <div className="row mb-3">
        <PipelineRunBadge status={run.status} />
        <span className="text-muted text-sm">
          Démarré {fmtDateTime(run.startedAt)} · Durée {fmtDuration(run.startedAt, run.endedAt)}
        </span>
      </div>

      <Field label="Entrée">
        <pre className="scroll-box short break-word">{run.input || 'aucune entrée'}</pre>
      </Field>

      <h3>Étapes</h3>
      <div className="col">
        {run.stepRuns.map((sr, idx) => (
          <div className="card" key={`${sr.stepId}-${idx}`}>
            <div className="row">
              <strong>
                {idx + 1}. {stepName(sr.stepId, idx)}
              </strong>
              {sr.status === 'pending' ? (
                <span className="badge">En attente</span>
              ) : (
                <StatusBadge status={sr.status} />
              )}
              <span className="grow" />
              {sr.runId && (
                <Link to={`/runs/${sr.runId}`} className="row gap-1">
                  Voir le run
                  <ArrowRight />
                </Link>
              )}
            </div>
            {sr.output !== null && sr.output !== '' && (
              <details className="mt-2">
                <summary className="text-muted text-sm summary-toggle">Sortie</summary>
                <pre className="scroll-box short break-word mt-2">{sr.output}</pre>
              </details>
            )}
          </div>
        ))}
      </div>

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Fermer
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function PipelinesPage() {
  const pipelines = useStore((s) => s.pipelines);
  const pipelineRuns = useStore((s) => s.pipelineRuns);
  const agents = useStore((s) => s.agents);
  const skills = useStore((s) => s.skills);

  /** null = fermé ; 'new' = création ; sinon pipeline en édition. */
  const [editorTarget, setEditorTarget] = useState<Pipeline | 'new' | null>(null);
  const [runTarget, setRunTarget] = useState<Pipeline | null>(null);
  const [detailRunId, setDetailRunId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const pipelineById = useMemo(() => new Map(pipelines.map((p) => [p.id, p])), [pipelines]);

  const sortedRuns = useMemo(
    () => [...pipelineRuns].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    [pipelineRuns],
  );

  /** Dérivé du store pour que la modale de détail se mette à jour en direct. */
  const detailRun = detailRunId ? (pipelineRuns.find((r) => r.id === detailRunId) ?? null) : null;

  const deletePipeline = async (id: string) => {
    setActionError(null);
    try {
      await api.deletePipeline(id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const cancelRun = async (id: string) => {
    setActionError(null);
    try {
      await api.cancelPipelineRun(id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Pipelines</h1>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setEditorTarget('new')}>
          <Plus />
          Nouveau pipeline
        </button>
      </div>
      <p className="page-lede">
        Une chaîne d'agents où chaque étape reçoit la sortie de la précédente.
      </p>

      {actionError && <ErrorText>{actionError}</ErrorText>}

      {pipelines.length === 0 ? (
        <EmptyState
          icon={<FlowArrow size={28} />}
          title="Aucun pipeline"
          hint="Enchaînez plusieurs agents : la sortie de chaque étape alimente la suivante."
        >
          <button className="btn primary" onClick={() => setEditorTarget('new')}>
            <Plus />
            Créer un pipeline
          </button>
        </EmptyState>
      ) : (
        <div className="col">
          {pipelines.map((p) => (
            <div className="card" key={p.id}>
              <div className="row items-start">
                <div className="grow">
                  <h2>{p.name}</h2>
                  {p.description && <div className="text-muted">{p.description}</div>}
                </div>
                <button className="btn sm" onClick={() => setRunTarget(p)}>
                  <Play />
                  Exécuter
                </button>
                <button className="btn ghost sm" onClick={() => setEditorTarget(p)}>
                  Éditer
                </button>
                <ConfirmButton
                  label="Supprimer"
                  confirmLabel={`Supprimer le pipeline « ${p.name} » ?`}
                  onConfirm={() => void deletePipeline(p.id)}
                />
              </div>

              <div className="row wrap mt-4">
                {p.steps.length === 0 && <span className="text-faint text-sm">Aucune étape.</span>}
                {p.steps.map((step, i) => (
                  <Fragment key={step.id}>
                    {i > 0 && (
                      <span className="text-faint" aria-hidden="true">
                        <ArrowRight />
                      </span>
                    )}
                    <div className="col gap-1 items-center">
                      <AgentChip agent={agentById.get(step.agentId)} />
                      <span className="text-muted text-xs">{step.name}</span>
                    </div>
                  </Fragment>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4">
        <h3>Exécutions</h3>
        {sortedRuns.length === 0 ? (
          <div className="text-faint">Aucune exécution pour l’instant.</div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Pipeline</th>
                  <th>Statut</th>
                  <th>Progression</th>
                  <th>Démarré</th>
                  <th>Durée</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sortedRuns.map((r) => {
                  const pipeline = pipelineById.get(r.pipelineId);
                  const total = r.stepRuns.length;
                  const current = total === 0 ? 0 : Math.min(r.currentStepIndex + 1, total);
                  return (
                    <tr key={r.id}>
                      <td>{pipeline?.name ?? 'pipeline supprimé'}</td>
                      <td>
                        <PipelineRunBadge status={r.status} />
                      </td>
                      <td>
                        étape {current}/{total}
                      </td>
                      <td>{fmtDateTime(r.startedAt)}</td>
                      <td>{fmtDuration(r.startedAt, r.endedAt)}</td>
                      <td>
                        <div className="row gap-2 justify-end">
                          {r.status === 'running' && (
                            <button className="btn danger sm" onClick={() => void cancelRun(r.id)}>
                              Annuler
                            </button>
                          )}
                          <button className="btn ghost sm" onClick={() => setDetailRunId(r.id)}>
                            Détail
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editorTarget !== null && (
        <PipelineEditor
          pipeline={editorTarget === 'new' ? null : editorTarget}
          agents={agents}
          skills={skills}
          onClose={() => setEditorTarget(null)}
        />
      )}

      {runTarget && <RunPipelineModal pipeline={runTarget} onClose={() => setRunTarget(null)} />}

      {detailRun && (
        <PipelineRunDetailModal
          run={detailRun}
          pipeline={pipelineById.get(detailRun.pipelineId)}
          onClose={() => setDetailRunId(null)}
        />
      )}
    </div>
  );
}
