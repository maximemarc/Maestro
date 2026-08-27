/**
 * Kanban — 4 colonnes, drag & drop natif HTML5.
 * Les cartes sont poussées en temps réel par le WebSocket (task.*) : aucune
 * relecture de collection après mutation.
 */
import { useMemo, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Kanban, Play, Plus } from '@phosphor-icons/react';
import { KANBAN_COLUMNS, type KanbanColumn, type KanbanTask } from '@maestro/shared';
import { api } from '../lib/api';
import { COLUMN_LABELS } from '../lib/format';
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

type Priority = KanbanTask['priority'];

const PRIORITY_OPTIONS: { value: Priority; label: string }[] = [
  { value: 0, label: 'Haute' },
  { value: 1, label: 'Normale' },
  { value: 2, label: 'Basse' },
];

function parsePriority(raw: string): Priority {
  const n = Number(raw);
  return n === 0 || n === 2 ? n : 1;
}

function parseLabels(raw: string): string[] {
  return raw
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function PriorityBadge({ priority }: { priority: Priority }) {
  if (priority === 0) return <span className="badge danger">Haute</span>;
  if (priority === 2) return <span className="badge">Basse</span>;
  return null;
}

// ---------------------------------------------------------------------------
// Modal d'édition
// ---------------------------------------------------------------------------

function EditTaskModal({ task, onClose }: { task: KanbanTask; onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const navigate = useNavigate();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [labelsRaw, setLabelsRaw] = useState(task.labels.join(', '));
  const [agentId, setAgentId] = useState(task.agentId ?? '');
  const [column, setColumn] = useState<KanbanColumn>(task.column);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.updateTask(task.id, {
        title: title.trim(),
        description,
        priority,
        labels: parseLabels(labelsRaw),
        agentId: agentId || null,
        column,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const run = await api.runTask(task.id);
      onClose();
      navigate(`/runs/${run.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
      setBusy(false);
    }
  };

  const remove = async () => {
    setError(null);
    try {
      await api.deleteTask(task.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    }
  };

  return (
    <Modal title="Modifier la carte" onClose={onClose}>
      <Field label="Titre">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Description">
        <textarea
          className="textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className="grid cols-2">
        <Field label="Priorité">
          <select
            className="select"
            value={priority}
            onChange={(e) => setPriority(parsePriority(e.target.value))}
          >
            {PRIORITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Colonne">
          <select
            className="select"
            value={column}
            onChange={(e) => setColumn(e.target.value as KanbanColumn)}
          >
            {KANBAN_COLUMNS.map((c) => (
              <option key={c} value={c}>
                {COLUMN_LABELS[c] ?? c}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Labels" hint="Séparés par des virgules">
        <input
          className="input"
          value={labelsRaw}
          onChange={(e) => setLabelsRaw(e.target.value)}
          placeholder="bug, urgent…"
        />
      </Field>
      <Field label="Agent assigné">
        <select className="select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">Aucun</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.emoji} {a.name}
            </option>
          ))}
        </select>
      </Field>

      {error && <ErrorText>{error}</ErrorText>}

      <div className="modal-actions">
        <ConfirmButton
          label="Supprimer"
          title="Supprimer cette carte ?"
          message={`«  » sera supprimée. Les runs qu elle a déjà déclenchés restent consultables.`}
          confirmLabel="Supprimer la carte"
          onConfirm={() => void remove()}
        />
        {task.agentId && (
          <button className="btn" disabled={busy} onClick={() => void runNow()}>
            {busy ? <Spinner /> : <Play />}
            Confier à l'agent
          </button>
        )}
        <button
          className="btn primary"
          disabled={busy || !title.trim()}
          onClick={() => void save()}
        >
          Enregistrer
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Modal de création
// ---------------------------------------------------------------------------

function CreateTaskModal({ onClose }: { onClose: () => void }) {
  const agents = useStore((s) => s.agents);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [column, setColumn] = useState<KanbanColumn>('backlog');
  const [priority, setPriority] = useState<Priority>(1);
  const [agentId, setAgentId] = useState('');
  const [autoRun, setAutoRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.createTask({
        title: title.trim(),
        description,
        column,
        priority,
        agentId: agentId || null,
        autoRun: autoRun && Boolean(agentId),
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
      setBusy(false);
    }
  };

  return (
    <Modal title="Nouvelle carte" onClose={onClose}>
      <Field label="Titre">
        <input
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Que faut-il faire ?"
          data-autofocus
        />
      </Field>
      <Field label="Description">
        <textarea
          className="textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className="grid cols-2">
        <Field label="Colonne">
          <select
            className="select"
            value={column}
            onChange={(e) => setColumn(e.target.value as KanbanColumn)}
          >
            {KANBAN_COLUMNS.map((c) => (
              <option key={c} value={c}>
                {COLUMN_LABELS[c] ?? c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priorité">
          <select
            className="select"
            value={priority}
            onChange={(e) => setPriority(parsePriority(e.target.value))}
          >
            {PRIORITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Agent (optionnel)">
        <select className="select" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          <option value="">Aucun</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.emoji} {a.name}
            </option>
          ))}
        </select>
      </Field>
      {agentId && (
        <label className="checkbox-row mb-3">
          <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
          Lancer immédiatement
        </label>
      )}

      {error && <ErrorText>{error}</ErrorText>}

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Annuler
        </button>
        <button
          className="btn primary"
          disabled={busy || !title.trim()}
          onClick={() => void create()}
        >
          Créer
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function KanbanPage() {
  const tasks = useStore((s) => s.tasks);
  const notify = useStore((s) => s.notify);
  const agents = useStore((s) => s.agents);
  const runs = useStore((s) => s.runs);

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overColumn, setOverColumn] = useState<KanbanColumn | null>(null);
  const [error, setError] = useState<string | null>(null);

  const byColumn = useMemo(() => {
    const map = new Map<KanbanColumn, KanbanTask[]>();
    for (const col of KANBAN_COLUMNS) map.set(col, []);
    for (const task of tasks) map.get(task.column)?.push(task);
    for (const list of map.values()) list.sort((a, b) => a.position - b.position);
    return map;
  }, [tasks]);

  const editingTask = editingId ? (tasks.find((t) => t.id === editingId) ?? null) : null;

  const moveToColumn = async (task: KanbanTask, offset: number) => {
    const from = KANBAN_COLUMNS.indexOf(task.column);
    const to = from + offset;
    if (from === -1 || to < 0 || to >= KANBAN_COLUMNS.length) return;
    const column = KANBAN_COLUMNS[to]!;
    const maxPosition = tasks
      .filter((t) => t.column === column && t.id !== task.id)
      .reduce((max, t) => Math.max(max, t.position), 0);
    setError(null);
    try {
      await api.moveTask(task.id, { column, position: maxPosition + 10 });
      notify(`« ${task.title} » déplacée vers ${COLUMN_LABELS[column] ?? column}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    }
  };

  const onDrop = async (e: DragEvent, column: KanbanColumn) => {
    e.preventDefault();
    setOverColumn(null);
    const id = e.dataTransfer.getData('text/plain');
    setDragId(null);
    if (!id) return;
    const maxPosition = tasks
      .filter((t) => t.column === column && t.id !== id)
      .reduce((max, t) => Math.max(max, t.position), 0);
    setError(null);
    try {
      await api.moveTask(id, { column, position: maxPosition + 10 });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Kanban</h1>
        <span className="text-muted text-sm">
          Les agents avancent leurs cartes ; tu arbitres. Au clavier : <kbd>Ctrl</kbd> <kbd>←</kbd>{' '}
          <kbd>→</kbd> déplace la carte focalisée.
        </span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>
          <Plus />
          Nouvelle carte
        </button>
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      {tasks.length === 0 ? (
        <EmptyState
          icon={<Kanban size={28} />}
          title="Aucune carte"
          hint="Crée une carte et assigne-la à un agent : il la fera avancer tout seul."
        >
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Plus />
            Nouvelle carte
          </button>
        </EmptyState>
      ) : (
        <div className="kanban">
          {KANBAN_COLUMNS.map((col) => {
            const colTasks = byColumn.get(col) ?? [];
            return (
              <div
                key={col}
                className={`kanban-col${overColumn === col ? ' drag-over' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverColumn(col);
                }}
                onDragLeave={(e) => {
                  if (e.currentTarget === e.target) setOverColumn(null);
                }}
                onDrop={(e) => void onDrop(e, col)}
              >
                <div className="kanban-col-header">
                  {COLUMN_LABELS[col] ?? col}
                  <span className="count">{colTasks.length}</span>
                </div>
                {colTasks.map((task) => {
                  const agent = task.agentId
                    ? (agents.find((a) => a.id === task.agentId) ?? null)
                    : null;
                  const run = task.runId ? (runs.find((r) => r.id === task.runId) ?? null) : null;
                  return (
                    <div
                      key={task.id}
                      className={`kanban-card${dragId === task.id ? ' dragging' : ''}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', task.id);
                        e.dataTransfer.effectAllowed = 'move';
                        setDragId(task.id);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setOverColumn(null);
                      }}
                      onClick={() => setEditingId(task.id)}
                      /* Le glisser-déposer est à la souris. Le clavier passe par
                         la modale, qui contient le sélecteur de colonne : sans
                         cela, une carte est inatteignable sans souris. */
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.code === 'Enter' || e.code === 'Space') {
                          e.preventDefault();
                          setEditingId(task.id);
                          return;
                        }
                        /* Ctrl plutôt que les flèches seules : les flèches
                           doivent continuer à faire défiler la colonne. */
                        if (!e.ctrlKey && !e.metaKey) return;
                        if (e.code === 'ArrowRight') {
                          e.preventDefault();
                          void moveToColumn(task, 1);
                        } else if (e.code === 'ArrowLeft') {
                          e.preventDefault();
                          void moveToColumn(task, -1);
                        }
                      }}
                    >
                      <div className="title">{task.title}</div>
                      <div className="meta">
                        <PriorityBadge priority={task.priority} />
                        {task.labels.map((label) => (
                          <span key={label} className="badge violet">
                            {label}
                          </span>
                        ))}
                        {task.agentId && <AgentChip agent={agent} />}
                        {task.runId && (
                          <>
                            {run && <span className={`status-dot ${run.status}`} />}
                            <Link
                              to={`/runs/${task.runId}`}
                              onClick={(e) => e.stopPropagation()}
                              className="text-sm"
                            >
                              voir
                            </Link>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}

      {creating && <CreateTaskModal onClose={() => setCreating(false)} />}
      {editingTask && <EditTaskModal task={editingTask} onClose={() => setEditingId(null)} />}
    </div>
  );
}
