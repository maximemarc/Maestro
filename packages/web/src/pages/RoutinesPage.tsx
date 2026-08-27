import { useState, type FormEvent } from 'react';
import type { CreateRoutineRequest, Routine } from '@maestro/shared';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useStore } from '../lib/store';
import { Clock, Play, Plus } from '@phosphor-icons/react';
import { AgentChip, ConfirmButton, EmptyState, ErrorText, Field, Modal } from '../components/ui';

const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: 'Toutes les heures', expr: '0 * * * *' },
  { label: 'Chaque jour 9h', expr: '0 9 * * *' },
  { label: 'Lun-Ven 9h', expr: '0 9 * * 1-5' },
  { label: 'Toutes les 15 min', expr: '*/15 * * * *' },
  { label: 'Chaque nuit 2h', expr: '0 2 * * *' },
];

function cronLabel(expr: string): string {
  const preset = CRON_PRESETS.find((p) => p.expr === expr.trim());
  return preset ? preset.label : expr;
}

interface FormState {
  name: string;
  agentId: string;
  skillId: string;
  prompt: string;
  cronExpr: string;
  timeoutSec: string;
  notify: boolean;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  agentId: '',
  skillId: '',
  prompt: '',
  cronExpr: '0 9 * * *',
  timeoutSec: '',
  notify: false,
  enabled: true,
};

export default function RoutinesPage() {
  const routines = useStore((s) => s.routines);
  const agents = useStore((s) => s.agents);
  const skills = useStore((s) => s.skills);

  const [pageError, setPageError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const skillName = (skillId: string | null): string => {
    if (!skillId) return 'aucune';
    const skill = skills.find((s) => s.id === skillId);
    return skill ? skill.name : skillId;
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, agentId: agents[0]?.id ?? '' });
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (routine: Routine) => {
    setEditingId(routine.id);
    setForm({
      name: routine.name,
      agentId: routine.agentId,
      skillId: routine.skillId ?? '',
      prompt: routine.prompt,
      cronExpr: routine.cronExpr,
      timeoutSec: routine.timeoutSec != null ? String(routine.timeoutSec) : '',
      notify: routine.notify,
      enabled: routine.enabled,
    });
    setFormError(null);
    setModalOpen(true);
  };

  const toggleEnabled = async (routine: Routine, enabled: boolean) => {
    setPageError(null);
    try {
      await api.updateRoutine(routine.id, { enabled });
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    }
  };

  const runNow = async (id: string) => {
    setPageError(null);
    try {
      await api.runRoutineNow(id);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (id: string) => {
    setPageError(null);
    try {
      await api.deleteRoutine(id);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!form.name.trim()) {
      setFormError('Le nom est requis.');
      return;
    }
    if (!form.agentId) {
      setFormError('Un agent est requis.');
      return;
    }
    if (!form.cronExpr.trim()) {
      setFormError("L'expression cron est requise.");
      return;
    }
    const timeoutSec = form.timeoutSec.trim() === '' ? null : Number(form.timeoutSec);
    if (timeoutSec !== null && (!Number.isFinite(timeoutSec) || timeoutSec <= 0)) {
      setFormError('Le timeout doit être un nombre de secondes positif.');
      return;
    }
    const body: CreateRoutineRequest = {
      name: form.name.trim(),
      agentId: form.agentId,
      skillId: form.skillId === '' ? null : form.skillId,
      prompt: form.prompt,
      cronExpr: form.cronExpr.trim(),
      enabled: form.enabled,
      timeoutSec,
      notify: form.notify,
    };
    setSaving(true);
    try {
      if (editingId) {
        await api.updateRoutine(editingId, body);
      } else {
        await api.createRoutine(body);
      }
      setModalOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Routines</h1>
        <span className="spacer" />
        <button className="btn primary" onClick={openCreate}>
          <Plus />
          Nouvelle routine
        </button>
      </div>

      {pageError && <ErrorText>{pageError}</ErrorText>}

      {routines.length === 0 ? (
        <EmptyState
          icon={<Clock size={28} />}
          title="Aucune routine planifiée"
          hint="Créez une routine pour déclencher un agent selon une planification cron."
        >
          <button className="btn primary" onClick={openCreate}>
            <Plus />
            Nouvelle routine
          </button>
        </EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Agent</th>
                <th>Planification</th>
                <th>Skill</th>
                <th>Actif</th>
                <th>Dernier déclenchement</th>
                <th>Prochain</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {routines.map((routine) => {
                const agent = agents.find((a) => a.id === routine.agentId);
                return (
                  <tr key={routine.id}>
                    <td className="text-strong">{routine.name}</td>
                    <td>
                      <AgentChip agent={agent} />
                    </td>
                    <td>
                      <div className="col gap-1">
                        <code>{routine.cronExpr}</code>
                        {cronLabel(routine.cronExpr) !== routine.cronExpr && (
                          <span className="text-muted text-xs">{cronLabel(routine.cronExpr)}</span>
                        )}
                      </div>
                    </td>
                    <td>{skillName(routine.skillId)}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={routine.enabled}
                        onChange={(e) => void toggleEnabled(routine, e.target.checked)}
                        aria-label={`Activer ${routine.name}`}
                      />
                    </td>
                    <td>{fmtDateTime(routine.lastFiredAt)}</td>
                    <td>{fmtDateTime(routine.nextFireAt)}</td>
                    <td>
                      <div className="row gap-2">
                        <button className="btn sm" onClick={() => void runNow(routine.id)}>
                          <Play />
                          Lancer
                        </button>
                        <button className="btn ghost sm" onClick={() => openEdit(routine)}>
                          Éditer
                        </button>
                        <ConfirmButton
                          label="Supprimer"
                          confirmLabel={`Supprimer la routine « ${routine.name} » ?`}
                          onConfirm={() => void remove(routine.id)}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modalOpen && (
        <Modal
          title={editingId ? 'Éditer la routine' : 'Nouvelle routine'}
          onClose={() => setModalOpen(false)}
        >
          <form onSubmit={(e) => void submit(e)}>
            <Field label="Nom">
              <input
                className="input"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Veille quotidienne"
                data-autofocus
              />
            </Field>

            <Field label="Agent">
              <select
                className="select"
                value={form.agentId}
                onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value }))}
              >
                <option value="">Choisir un agent</option>
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
                value={form.skillId}
                onChange={(e) => setForm((f) => ({ ...f, skillId: e.target.value }))}
              >
                <option value="">Aucune</option>
                {skills.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Prompt">
              <textarea
                className="textarea"
                value={form.prompt}
                onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
                placeholder="Instructions envoyées à l'agent à chaque déclenchement…"
              />
            </Field>

            <Field
              label="Planification (cron)"
              hint="Format cron à 5 champs : minute heure jour-du-mois mois jour-de-semaine"
            >
              <div className="row gap-2 wrap mb-2">
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.expr}
                    type="button"
                    className={`badge${form.cronExpr.trim() === p.expr ? ' accent' : ''}`}

                    onClick={() => setForm((f) => ({ ...f, cronExpr: p.expr }))}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <input
                className="input mono"
                value={form.cronExpr}
                onChange={(e) => setForm((f) => ({ ...f, cronExpr: e.target.value }))}
                placeholder="0 9 * * *"
              />
            </Field>

            <Field label="Timeout (secondes, optionnel)">
              <input
                className="input"
                type="number"
                min={1}
                value={form.timeoutSec}
                onChange={(e) => setForm((f) => ({ ...f, timeoutSec: e.target.value }))}
                placeholder="Illimité"
              />
            </Field>

            <label className="checkbox-row mb-3">
              <input
                type="checkbox"
                checked={form.notify}
                onChange={(e) => setForm((f) => ({ ...f, notify: e.target.checked }))}
              />
              Notifier à la fin (Telegram)
            </label>

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
              />
              Routine active
            </label>

            {formError && <ErrorText>{formError}</ErrorText>}

            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setModalOpen(false)}>
                Annuler
              </button>
              <button type="submit" className="btn primary" disabled={saving}>
                {saving ? 'Enregistrement…' : editingId ? 'Enregistrer' : 'Créer la routine'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
