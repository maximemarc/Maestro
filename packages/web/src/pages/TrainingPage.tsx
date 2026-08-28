/**
 * Entraînement : produire des jeux de données à partir du travail des agents.
 *
 * Deux métiers distincts, d'où deux onglets. Les lots fabriquent des
 * trajectoires en série ; l'export les transforme au format attendu par un
 * outil de fine-tuning. Les deux se rejoignent sur un point : ce que l'on
 * exporte, ce sont des runs — ceux d'un lot, ou ceux du travail réel.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Brain, Download, Eye, Flask, Pause, Play, Plus, Prohibit } from '@phosphor-icons/react';
import type {
  ToolCallDialect,
  ToolCallDialectInfo,
  TrainingBatch,
  TrainingBatchSpec,
  TrainingExportFormat,
  TrainingExportPreview,
  TrainingItem,
} from '@maestro/shared';
import { api, downloadTrainingExport } from '../lib/api';
import { BatchComparePanel } from '../components/BatchComparePanel';
import { fmtCost, fmtDateTime, fmtTokens } from '../lib/format';
import { useStore } from '../lib/store';
import {
  AgentChip,
  ConfirmButton,
  EmptyState,
  ErrorText,
  Field,
  Modal,
  Spinner,
} from '../components/ui';

const FORMATS: Array<{ id: TrainingExportFormat; label: string; hint: string }> = [
  {
    id: 'sharegpt',
    label: 'ShareGPT',
    hint: 'Le plus largement accepté : Axolotl, LLaMA-Factory, Unsloth.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    hint: 'messages + tool_calls natifs, pour un fine-tuning d’API.',
  },
  {
    id: 'atropos',
    label: 'Atropos (RL)',
    hint: 'Rollouts scorés. Une trajectoire sans score est écartée.',
  },
  { id: 'raw', label: 'Brut', hint: 'La forme canonique de Maestro, sans perte.' },
];

const DEFAULT_GRADER_PROMPT = `Évalue la trajectoire suivante.

Demande initiale :
{{prompt}}

Réponse produite :
{{result}}

Juge la pertinence, l'exactitude et l'usage des outils. Réponds en deux phrases
maximum, puis termine par un score entre 0 et 1 sur une ligne seule.`;

/** Saisie du formulaire : tout en texte, converti à la soumission. */
interface FormState {
  name: string;
  description: string;
  agentIds: string[];
  templates: string;
  variables: string;
  samples: string;
  workers: string;
  maxAttempts: string;
  timeoutSec: string;
  skillId: string;
  toolWeights: string;
  graderAgentId: string;
  graderPrompt: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  agentIds: [],
  templates: '',
  variables: '',
  samples: '20',
  workers: '1',
  maxAttempts: '1',
  timeoutSec: '',
  skillId: '',
  toolWeights: '',
  graderAgentId: '',
  graderPrompt: DEFAULT_GRADER_PROMPT,
};

/**
 * Lit les variables saisies en texte libre.
 *
 * Une ligne `sujet: bilan, liasse, TVA` devient `{ sujet: ['bilan', 'liasse',
 * 'TVA'] }`. Un tableau de saisie par variable aurait été plus rigoureux et
 * bien plus long à remplir : ici on décrit dix variables en dix lignes.
 */
function parseVariables(raw: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of raw.split('\n')) {
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    const values = line
      .slice(sep + 1)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (key && values.length > 0) out[key] = values;
  }
  return out;
}

function formatVariables(variables: Record<string, string[]>): string {
  return Object.entries(variables)
    .map(([key, values]) => `${key}: ${values.join(', ')}`)
    .join('\n');
}

/** `Read 70` ou `Read: 70`, une pondération par ligne. */
function parseToolWeights(raw: string): Array<{ tool: string; weight: number }> {
  const out: Array<{ tool: string; weight: number }> = [];
  for (const line of raw.split('\n')) {
    const match = /^\s*([\w:.-]+)\s*[:=\s]\s*(\d+(?:[.,]\d+)?)\s*$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    out.push({ tool: match[1], weight: Number.parseFloat(match[2].replace(',', '.')) });
  }
  return out;
}

function formatToolWeights(weights: Array<{ tool: string; weight: number }>): string {
  return weights.map((w) => `${w.tool}: ${w.weight}`).join('\n');
}

/** Nombre d'échantillons parvenus à un état terminal. */
function doneCount(batch: TrainingBatch): number {
  const { succeeded, failed, skipped, cancelled } = batch.counts;
  return succeeded + failed + skipped + cancelled;
}

function statusTone(status: TrainingBatch['status']): string {
  if (status === 'running') return 'running';
  if (status === 'succeeded') return 'succeeded';
  /* « partial » n'est pas un succès : un lot avec des échecs se signale. */
  if (status === 'partial') return 'waiting_approval';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'paused') return 'waiting_approval';
  return 'queued';
}

export default function TrainingPage() {
  const batches = useStore((s) => s.trainingBatches);
  const agents = useStore((s) => s.agents);
  const skills = useStore((s) => s.skills);
  const trainingItems = useStore((s) => s.trainingItems);
  const truncatedByBatch = useStore((s) => s.trainingItemsTruncated);
  const loadTrainingItems = useStore((s) => s.loadTrainingItems);
  const notify = useStore((s) => s.notify);

  const [tab, setTab] = useState<'batches' | 'export' | 'compare'>('batches');
  const [pageError, setPageError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [openBatchId, setOpenBatchId] = useState<string | null>(null);

  const sortedItems = useMemo(() => {
    const list = openBatchId ? (trainingItems[openBatchId] ?? []) : [];
    return [...list].sort((a, b) => a.index - b.index);
  }, [openBatchId, trainingItems]);

  const openDetail = useCallback(
    (id: string) => {
      setOpenBatchId(id);
      loadTrainingItems(id).catch((err: unknown) =>
        setPageError(err instanceof Error ? err.message : String(err)),
      );
    },
    [loadTrainingItems],
  );

  const guard = async (fn: () => Promise<unknown>, done?: string) => {
    setPageError(null);
    try {
      await fn();
      if (done) notify(done);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    }
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, agentIds: agents[0] ? [agents[0].id] : [] });
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (batch: TrainingBatch) => {
    setEditingId(batch.id);
    setForm({
      name: batch.name,
      description: batch.description,
      agentIds: batch.spec.agentIds,
      templates: batch.spec.promptTemplates.join('\n---\n'),
      variables: formatVariables(batch.spec.variables),
      samples: String(batch.spec.samples),
      workers: String(batch.spec.workers),
      maxAttempts: String(batch.spec.maxAttempts),
      timeoutSec: batch.spec.timeoutSec != null ? String(batch.spec.timeoutSec) : '',
      skillId: batch.spec.skillId ?? '',
      toolWeights: formatToolWeights(batch.spec.toolWeights),
      graderAgentId: batch.spec.grader?.agentId ?? '',
      graderPrompt: batch.spec.grader?.promptTemplate ?? DEFAULT_GRADER_PROMPT,
    });
    setFormError(null);
    setModalOpen(true);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const templates = form.templates
      .split('\n---\n')
      .map((t) => t.trim())
      .filter(Boolean);
    if (!form.name.trim()) return setFormError('Le nom est requis.');
    if (form.agentIds.length === 0) return setFormError('Au moins un agent est requis.');
    if (templates.length === 0) return setFormError('Au moins un gabarit de prompt est requis.');
    const samples = Number.parseInt(form.samples, 10);
    if (!Number.isFinite(samples) || samples < 1) {
      return setFormError('Le nombre d’échantillons doit être un entier positif.');
    }

    const spec: TrainingBatchSpec = {
      agentIds: form.agentIds,
      promptTemplates: templates,
      variables: parseVariables(form.variables),
      samples,
      workers: Math.max(1, Number.parseInt(form.workers, 10) || 1),
      maxAttempts: Math.max(1, Number.parseInt(form.maxAttempts, 10) || 1),
      toolWeights: parseToolWeights(form.toolWeights),
      timeoutSec: form.timeoutSec ? Number.parseInt(form.timeoutSec, 10) : null,
      skillId: form.skillId || null,
      grader: form.graderAgentId
        ? { agentId: form.graderAgentId, promptTemplate: form.graderPrompt }
        : null,
    };

    setSaving(true);
    try {
      const payload = { name: form.name.trim(), description: form.description.trim(), spec };
      if (editingId) await api.updateTrainingBatch(editingId, payload);
      else await api.createTrainingBatch(payload);
      setModalOpen(false);
      notify(editingId ? 'Lot mis à jour' : 'Lot créé');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleAgent = (id: string) => {
    setForm((f) => ({
      ...f,
      agentIds: f.agentIds.includes(id) ? f.agentIds.filter((a) => a !== id) : [...f.agentIds, id],
    }));
  };

  /* Le parallélisme réel est borné par le pool : l'annoncer dans le formulaire
     évite de découvrir après coup qu'un lot s'exécute en série. */
  const effectiveWorkers = Math.max(
    1,
    Math.min(Number.parseInt(form.workers, 10) || 1, form.agentIds.length || 1),
  );

  return (
    <div className="page">
      <div className="page-header">
        <h1>Entraînement</h1>
        <span className="spacer" />
        {tab === 'batches' && (
          <button className="btn primary" onClick={openCreate}>
            <Plus />
            Nouveau lot
          </button>
        )}
      </div>
      <p className="page-lede">
        Fabriquer des trajectoires en série, les noter, et les exporter au format d’un outil de
        fine-tuning.
      </p>

      {pageError && <ErrorText>{pageError}</ErrorText>}

      <div className="tabs" role="group" aria-label="Sections de l’entraînement">
        <button
          className={`tab${tab === 'batches' ? ' active' : ''}`}
          onClick={() => setTab('batches')}
        >
          Lots de génération
        </button>
        <button
          className={`tab${tab === 'export' ? ' active' : ''}`}
          onClick={() => setTab('export')}
        >
          Export
        </button>
        <button
          className={`tab${tab === 'compare' ? ' active' : ''}`}
          onClick={() => setTab('compare')}
        >
          Non-régression
        </button>
      </div>

      {tab === 'batches' ? (
        batches.length === 0 ? (
          <EmptyState
            icon={<Flask size={28} />}
            title="Aucun lot de génération"
            hint="Un lot décrit des gabarits de prompt, des variables et un nombre d’échantillons ; plusieurs agents les produisent de front."
          >
            <button className="btn primary" onClick={openCreate}>
              <Plus />
              Nouveau lot
            </button>
          </EmptyState>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Lot</th>
                    <th>Agents</th>
                    <th>Avancement</th>
                    <th>Échecs</th>
                    <th>Notation</th>
                    <th>Démarré</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((batch) => {
                    const done = doneCount(batch);
                    const total = batch.checkpointIndex || batch.spec.samples;
                    return (
                      <tr key={batch.id}>
                        <td>
                          <div className="col gap-1">
                            <button
                              className="btn ghost sm"
                              onClick={() => openDetail(batch.id)}
                              title="Voir les échantillons"
                            >
                              {batch.name}
                            </button>
                            <span className={`badge ${statusTone(batch.status)}`}>
                              {batch.status}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="row gap-1 wrap">
                            {batch.spec.agentIds.map((id) => (
                              <AgentChip key={id} agent={agents.find((a) => a.id === id)} />
                            ))}
                          </div>
                        </td>
                        <td className="num">
                          {done} / {total}
                          {batch.counts.running > 0 && (
                            <span className="text-muted text-xs">
                              {' '}
                              · {batch.counts.running} en cours
                            </span>
                          )}
                        </td>
                        <td className="num">
                          {batch.counts.failed > 0 ? (
                            <span className="text-warn">{batch.counts.failed}</span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{batch.spec.grader ? 'juge automatique' : 'manuelle'}</td>
                        <td>{fmtDateTime(batch.startedAt)}</td>
                        <td>
                          <div className="row gap-2">
                            {batch.status === 'running' ? (
                              <button
                                className="btn sm"
                                onClick={() =>
                                  void guard(
                                    () => api.pauseTrainingBatch(batch.id),
                                    'Pause demandée',
                                  )
                                }
                              >
                                <Pause />
                                Pause
                              </button>
                            ) : (
                              <button
                                className="btn sm"
                                onClick={() =>
                                  void guard(() => api.startTrainingBatch(batch.id), 'Lot lancé')
                                }
                              >
                                <Play />
                                {done > 0 ? 'Reprendre' : 'Lancer'}
                              </button>
                            )}
                            {(batch.status === 'running' || batch.status === 'paused') && (
                              <button
                                className="btn ghost sm"
                                onClick={() =>
                                  void guard(() => api.cancelTrainingBatch(batch.id), 'Lot annulé')
                                }
                              >
                                <Prohibit />
                                Annuler
                              </button>
                            )}
                            <button
                              className="btn ghost sm"
                              onClick={() => openEdit(batch)}
                              disabled={batch.status === 'running'}
                            >
                              Éditer
                            </button>
                            <ConfirmButton
                              label="Supprimer"
                              confirmLabel={`Supprimer le lot « ${batch.name} » et ses échantillons ?`}
                              onConfirm={() => void guard(() => api.deleteTrainingBatch(batch.id))}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {openBatchId && (
              <BatchDetail
                batch={batches.find((b) => b.id === openBatchId) ?? null}
                items={sortedItems}
                truncated={Boolean(truncatedByBatch[openBatchId])}
                onClose={() => setOpenBatchId(null)}
                onError={setPageError}
              />
            )}
          </>
        )
      ) : tab === 'export' ? (
        <ExportPanel batches={batches} onError={setPageError} notify={notify} />
      ) : (
        <BatchComparePanel batches={batches} />
      )}

      {modalOpen && (
        <Modal
          title={editingId ? 'Modifier le lot' : 'Nouveau lot de génération'}
          onClose={() => setModalOpen(false)}
          wide
        >
          <form onSubmit={(e) => void submit(e)}>
            <Field label="Nom">
              <input
                className="input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Trajectoires d’audit comptable"
              />
            </Field>

            <Field label="Description" hint="Facultatif : à quoi servira ce jeu de données.">
              <input
                className="input"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </Field>

            <Field
              label="Agents du lot"
              hint={`Le parallélisme vient d’ici : un agent n’exécute qu’un run à la fois. ${effectiveWorkers} génération(s) de front.`}
            >
              <div className="row gap-2 wrap">
                {agents.map((agent) => (
                  <label key={agent.id} className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={form.agentIds.includes(agent.id)}
                      onChange={() => toggleAgent(agent.id)}
                    />
                    {agent.emoji} {agent.name}
                  </label>
                ))}
              </div>
            </Field>

            <Field
              label="Gabarits de prompt"
              hint="Un gabarit par bloc, séparés par une ligne « --- ». {{variable}} est substitué."
            >
              <textarea
                className="textarea"
                rows={6}
                value={form.templates}
                onChange={(e) => setForm({ ...form, templates: e.target.value })}
                placeholder={
                  'Analyse {{sujet}} et propose une correction.\n---\nRédige une note sur {{sujet}}.'
                }
              />
            </Field>

            <Field
              label="Variables"
              hint="Une par ligne : « nom: valeur1, valeur2 ». Tirage reproductible par lot."
            >
              <textarea
                className="textarea"
                rows={3}
                value={form.variables}
                onChange={(e) => setForm({ ...form, variables: e.target.value })}
                placeholder={'sujet: le bilan, la liasse fiscale, la TVA'}
              />
            </Field>

            <Field
              label="Distribution d’outils"
              hint="Une par ligne : « outil: poids ». Un outil est tiré par échantillon et mis en avant dans le prompt."
            >
              <textarea
                className="textarea"
                rows={3}
                value={form.toolWeights}
                onChange={(e) => setForm({ ...form, toolWeights: e.target.value })}
                placeholder={'Read: 70\nWrite: 30'}
              />
            </Field>

            <div className="grid cols-4">
              <Field label="Échantillons">
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={form.samples}
                  onChange={(e) => setForm({ ...form, samples: e.target.value })}
                />
              </Field>
              <Field label="Workers">
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={form.workers}
                  onChange={(e) => setForm({ ...form, workers: e.target.value })}
                />
              </Field>
              <Field label="Tentatives">
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={5}
                  value={form.maxAttempts}
                  onChange={(e) => setForm({ ...form, maxAttempts: e.target.value })}
                />
              </Field>
              <Field label="Délai (s)">
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={form.timeoutSec}
                  onChange={(e) => setForm({ ...form, timeoutSec: e.target.value })}
                  placeholder="illimité"
                />
              </Field>
            </div>

            <Field label="Skill jointe" hint="Facultatif : chargée dans chaque run du lot.">
              <select
                className="select"
                value={form.skillId}
                onChange={(e) => setForm({ ...form, skillId: e.target.value })}
              >
                <option value="">aucune</option>
                {skills.map((skill) => (
                  <option key={skill.id} value={skill.id}>
                    {skill.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Agent juge"
              hint="Sans juge, pas de score — et un export Atropos n’a alors aucun signal d’apprentissage."
            >
              <select
                className="select"
                value={form.graderAgentId}
                onChange={(e) => setForm({ ...form, graderAgentId: e.target.value })}
              >
                <option value="">aucun (notation manuelle)</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.emoji} {agent.name}
                  </option>
                ))}
              </select>
            </Field>

            {form.graderAgentId && (
              <Field
                label="Consigne du juge"
                hint="{{prompt}} et {{result}} sont substitués. Le juge doit terminer par un nombre entre 0 et 1."
              >
                <textarea
                  className="textarea"
                  rows={6}
                  value={form.graderPrompt}
                  onChange={(e) => setForm({ ...form, graderPrompt: e.target.value })}
                />
              </Field>
            )}

            {formError && <ErrorText>{formError}</ErrorText>}

            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setModalOpen(false)}>
                Annuler
              </button>
              <button type="submit" className="btn primary" disabled={saving}>
                {saving && <Spinner />}
                {editingId ? 'Enregistrer' : 'Créer'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

/** Détail d'un lot : ses échantillons, leur score, leur run. */
function BatchDetail(props: {
  batch: TrainingBatch | null;
  items: TrainingItem[];
  truncated: boolean;
  onClose: () => void;
  onError: (message: string | null) => void;
}) {
  const { batch, items, truncated, onClose, onError } = props;
  if (!batch) return null;

  const score = async (item: TrainingItem, value: number) => {
    onError(null);
    try {
      await api.scoreTrainingItem(item.id, value);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  const scored = items.filter((i) => i.score !== null);
  const meanScore =
    scored.length > 0 ? scored.reduce((sum, i) => sum + (i.score ?? 0), 0) / scored.length : null;

  return (
    <Modal title={`Échantillons — ${batch.name}`} onClose={onClose} wide>
      <div className="row gap-3 mb-3 wrap">
        <span className="stat-chip">
          Réussis <b>{batch.counts.succeeded}</b>
        </span>
        <span className="stat-chip">
          Échoués <b>{batch.counts.failed}</b>
        </span>
        <span className="stat-chip">
          En attente <b>{batch.counts.pending}</b>
        </span>
        <span className="stat-chip ctx">
          Notés <b>{scored.length}</b>
        </span>
        {meanScore !== null && (
          <span className="stat-chip ctx">
            Score moyen <b>{meanScore.toFixed(2)}</b>
          </span>
        )}
        <span className="stat-chip ctx">
          Coût <b>{fmtCost(items.reduce((sum, i) => sum + i.costUsd, 0))}</b>
        </span>
      </div>

      {/* Une liste tronquee qui ne le dit pas fait croire a un lot plus petit
          qu'il n'est, et rend inexplicable l'impossibilite de noter le reste. */}
      {truncated && (
        <p className="text-warn text-xs mb-2">
          Seuls les {items.length} premiers echantillons sur {batch.checkpointIndex} sont affiches.
          L’export, lui, porte sur la totalite du lot.
        </p>
      )}

      {items.length === 0 ? (
        <EmptyState
          title="Aucun échantillon"
          hint="Les échantillons sont engendrés au premier lancement du lot."
          compact
        />
      ) : (
        <div className="table-wrap scroll-y">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Prompt</th>
                <th>Statut</th>
                <th>Outils</th>
                <th>Tokens</th>
                <th>Score</th>
                <th>Run</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="num">{item.index}</td>
                  <td className="cell-clip clamp-2" title={item.prompt}>
                    {item.prompt}
                  </td>
                  <td>
                    <span
                      className={`badge ${item.status === 'succeeded' ? 'succeeded' : item.status === 'failed' ? 'failed' : 'queued'}`}
                    >
                      {item.status}
                    </span>
                    {item.error && (
                      <div className="text-muted text-xs clamp-2" title={item.error}>
                        {item.error}
                      </div>
                    )}
                  </td>
                  <td className="num">{item.toolCallCount}</td>
                  <td className="num">{fmtTokens(item.totalTokens)}</td>
                  <td>
                    {/* La notation manuelle reste ouverte même avec un juge :
                        corriger un score aberrant est le geste le plus utile
                        qu'un humain puisse faire sur un jeu de données. */}
                    <div className="row gap-1 items-baseline">
                      {/* Enregistrement à la sortie du champ, pas à la frappe :
                          saisir « 0.75 » persistait 0, puis 0.7, puis 0.75, et
                          diffusait trois événements — des scores faux le temps
                          de la frappe, dans les données mêmes qu'on exporte. */}
                      <input
                        className="input w-sm"
                        type="number"
                        min={0}
                        max={1}
                        step={0.1}
                        defaultValue={item.score ?? ''}
                        key={`${item.id}-${item.score ?? 'vide'}`}
                        onBlur={(e) => {
                          const value = Number.parseFloat(e.target.value);
                          if (Number.isFinite(value) && value !== item.score) {
                            void score(item, value);
                          }
                        }}
                        aria-label={`Score de l’échantillon ${item.index}`}
                      />
                      {item.scoreSource && (
                        <span className="text-muted text-xs">{item.scoreSource}</span>
                      )}
                    </div>
                  </td>
                  <td>
                    {item.runId ? (
                      <Link className="btn ghost sm" to={`/runs/${item.runId}`}>
                        Voir
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

/** Panneau d'export : source, format, dialecte, budget, aperçu. */
function ExportPanel(props: {
  batches: TrainingBatch[];
  onError: (message: string | null) => void;
  notify: (message: string) => void;
}) {
  const { batches, onError, notify } = props;

  const [dialects, setDialects] = useState<ToolCallDialectInfo[]>([]);
  const [format, setFormat] = useState<TrainingExportFormat>('sharegpt');
  const [dialect, setDialect] = useState<ToolCallDialect>('hermes');
  const [batchId, setBatchId] = useState<string>('');
  const [tokenBudget, setTokenBudget] = useState('');
  const [onlySucceeded, setOnlySucceeded] = useState(true);
  const [includeThinking, setIncludeThinking] = useState(false);
  const [requireToolCalls, setRequireToolCalls] = useState(false);
  const [preview, setPreview] = useState<TrainingExportPreview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .listToolCallDialects()
      .then(setDialects)
      .catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)));
  }, [onError]);

  const request = useMemo(
    () => ({
      format,
      dialect,
      batchId: batchId || null,
      tokenBudget: tokenBudget ? Number.parseInt(tokenBudget, 10) : null,
      onlySucceeded,
      includeThinking,
      requireToolCalls,
    }),
    [format, dialect, batchId, tokenBudget, onlySucceeded, includeThinking, requireToolCalls],
  );

  const run = async (mode: 'preview' | 'download') => {
    onError(null);
    setBusy(true);
    try {
      if (mode === 'preview') {
        setPreview(await api.previewTrainingExport(request));
      } else {
        const count = await downloadTrainingExport(request);
        notify(`${count} trajectoire(s) exportée(s)`);
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const selectedDialect = dialects.find((d) => d.id === dialect);
  const selectedFormat = FORMATS.find((f) => f.id === format);

  return (
    <div className="grid cols-2">
      <div className="card">
        <div className="section-label">Ce qu’on exporte</div>

        <Field
          label="Source"
          hint="Sans lot, les runs récents de l’instance — le travail réel fait souvent les meilleures trajectoires."
        >
          <select className="select" value={batchId} onChange={(e) => setBatchId(e.target.value)}>
            <option value="">runs récents (500 max)</option>
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>
                {batch.name} — {batch.counts.succeeded} réussi(s)
              </option>
            ))}
          </select>
        </Field>

        <Field label="Format" hint={selectedFormat?.hint}>
          <select
            className="select"
            value={format}
            onChange={(e) => setFormat(e.target.value as TrainingExportFormat)}
          >
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Dialecte d’appels d’outils"
          hint={
            selectedDialect
              ? `${selectedDialect.families}. Un dialecte inadapté apprend au modèle une syntaxe qu’il n’émettra jamais.`
              : undefined
          }
        >
          <select
            className="select"
            value={dialect}
            onChange={(e) => setDialect(e.target.value as ToolCallDialect)}
          >
            {dialects.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </Field>

        {selectedDialect && (
          <pre className="mono-preview" aria-label="Exemple de rendu du dialecte">
            {selectedDialect.sample}
          </pre>
        )}

        <Field
          label="Budget de tokens par trajectoire"
          hint="Au-delà, compression : la réflexion part d’abord, puis les retours d’outils les plus longs."
        >
          <input
            className="input"
            type="number"
            min={100}
            value={tokenBudget}
            onChange={(e) => setTokenBudget(e.target.value)}
            placeholder="illimité"
          />
        </Field>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={onlySucceeded}
            onChange={(e) => setOnlySucceeded(e.target.checked)}
          />
          Runs réussis seulement
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={requireToolCalls}
            onChange={(e) => setRequireToolCalls(e.target.checked)}
          />
          Exiger au moins un appel d’outil
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={includeThinking}
            onChange={(e) => setIncludeThinking(e.target.checked)}
          />
          Conserver la réflexion
        </label>

        <div className="row gap-2 mt-3">
          <button className="btn" onClick={() => void run('preview')} disabled={busy}>
            {busy ? <Spinner /> : <Eye />}
            Aperçu
          </button>
          <button className="btn primary" onClick={() => void run('download')} disabled={busy}>
            <Download />
            Télécharger le JSONL
          </button>
        </div>

        {/* Un jeu de données exporté sort de Maestro et part généralement
            ailleurs — dépôt de fine-tuning, service d'entraînement tiers. Il
            contient les prompts et les retours d'outils tels quels, donc
            potentiellement des données personnelles issues du travail réel. Le
            dire ici, au moment du geste, et non dans une documentation que
            personne ne relit avant de cliquer. */}
        <p className="text-faint text-xs mt-3">
          ⚠️ Le fichier contient les prompts et les retours d’outils intégraux des runs retenus —
          donc, s’ils portent sur des dossiers réels, des données personnelles en clair (noms,
          SIRET, montants nominatifs). Vérifie-le avant de le transmettre à un service
          d’entraînement tiers.
        </p>
      </div>

      <div className="card">
        <div className="section-label">Aperçu</div>
        {!preview ? (
          <EmptyState
            icon={<Brain size={28} />}
            title="Aucun aperçu"
            hint="L’aperçu dit combien de trajectoires seront retenues, lesquelles sont écartées et pourquoi, avant d’écrire un fichier."
            compact
          />
        ) : (
          <>
            <div className="row gap-3 mb-3 wrap">
              <span className="stat-chip">
                Retenues <b>{preview.count}</b>
              </span>
              <span className="stat-chip">
                Écartées <b>{preview.skipped.length}</b>
              </span>
              <span className="stat-chip ctx">
                Tokens <b>{fmtTokens(preview.totalEstimatedTokens)}</b>
              </span>
            </div>

            {preview.compression.applied && (
              <div className="kv mb-3">
                <span>Compression</span>
                <span>
                  {fmtTokens(preview.compression.tokensBefore)} →{' '}
                  {fmtTokens(preview.compression.tokensAfter)} tokens
                </span>
                <span>Réflexions retirées</span>
                <span className="num">{preview.compression.droppedThinkingTurns}</span>
                <span>Retours d’outils raccourcis</span>
                <span className="num">{preview.compression.truncatedToolResults}</span>
                <span>Tours retirés</span>
                <span className="num">{preview.compression.droppedTurns}</span>
              </div>
            )}

            {preview.skipped.length > 0 && (
              <details className="mb-3">
                <summary className="summary-toggle">
                  {preview.skipped.length} trajectoire(s) écartée(s)
                </summary>
                <ul className="home-list">
                  {preview.skipped.slice(0, 40).map((s) => (
                    <li key={s.runId}>
                      <code>{s.runId.slice(0, 12)}</code> — {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            {preview.sample.length === 0 ? (
              <EmptyState title="Aucune ligne à montrer" compact />
            ) : (
              preview.sample.map((line, i) => (
                <pre key={i} className="mono-preview scroll-box">
                  {line}
                </pre>
              ))
            )}
          </>
        )}
      </div>
    </div>
  );
}
