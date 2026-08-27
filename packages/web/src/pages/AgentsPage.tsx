/**
 * Page Agents — grille des agents actifs + création guidée par gabarit.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, DownloadSimple, FileDashed, Plus, Robot } from '@phosphor-icons/react';
import type {
  AgentConfig,
  AgentEngine,
  AgentTemplate,
  ApprovalPolicy,
  PermissionMode,
} from '@maestro/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import {
  activable,
  AgentAvatar,
  ConfirmButton,
  EmptyState,
  ErrorText,
  Field,
  Modal,
  Spinner,
} from '../components/ui';
import { SkillImportModal } from '../components/SkillCatalog';

const MODEL_OPTIONS = ['sonnet', 'opus', 'haiku'] as const;
const CUSTOM_MODEL = '__custom__';

const APPROVAL_HINTS: Record<ApprovalPolicy, string> = {
  auto: 'Tout passe automatiquement (journalisé).',
  guarded: 'Lecture libre, écriture et exécution demandent une approbation.',
  ask: 'Chaque outil sensible attend une approbation humaine.',
};

function approvalBadgeClass(policy: ApprovalPolicy): string {
  if (policy === 'auto') return 'badge ok';
  if (policy === 'guarded') return 'badge warn';
  return 'badge violet';
}

interface AgentForm {
  name: string;
  emoji: string;
  description: string;
  modelChoice: string;
  customModel: string;
  engine: AgentEngine;
  permissionMode: PermissionMode;
  approvalPolicy: ApprovalPolicy;
  systemPrompt: string;
  memoryEnabled: boolean;
  maxTurns: string;
  timeoutSec: string;
  tokenBudget: string;
  color: string;
}

const BLANK_FORM: AgentForm = {
  name: '',
  emoji: '🤖',
  description: '',
  modelChoice: 'sonnet',
  customModel: '',
  engine: 'sdk',
  permissionMode: 'default',
  approvalPolicy: 'guarded',
  systemPrompt: '',
  memoryEnabled: true,
  maxTurns: '',
  timeoutSec: '',
  tokenBudget: '',
  color: '#22d3ee',
};

function formFromTemplate(tpl: AgentTemplate): AgentForm {
  const isKnown = (MODEL_OPTIONS as readonly string[]).includes(tpl.model);
  return {
    ...BLANK_FORM,
    name: tpl.name,
    emoji: tpl.emoji,
    description: tpl.description,
    modelChoice: isKnown ? tpl.model : CUSTOM_MODEL,
    customModel: isKnown ? '' : tpl.model,
    approvalPolicy: tpl.approvalPolicy,
    systemPrompt: tpl.systemPrompt,
    color: tpl.color,
  };
}

function parseOptionalInt(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isNaN(n) ? null : n;
}

export default function AgentsPage() {
  const navigate = useNavigate();
  const agents = useStore((s) => s.agents);
  const runs = useStore((s) => s.runs);
  const skills = useStore((s) => s.skills);
  const notify = useStore((s) => s.notify);

  const [pageError, setPageError] = useState<string | null>(null);

  // --- Modale « Lancer » ---------------------------------------------------
  const [launchAgent, setLaunchAgent] = useState<AgentConfig | null>(null);
  const [launchPrompt, setLaunchPrompt] = useState('');
  const [launchSkillId, setLaunchSkillId] = useState('');
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  // --- Modale de création ----------------------------------------------------
  const [createOpen, setCreateOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [form, setForm] = useState<AgentForm>(BLANK_FORM);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // --- Modale d'import d'un subagent distant ---------------------------------
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => {
    if (!createOpen) return;
    let cancelled = false;
    api
      .agentTemplates()
      .then((tpls) => {
        if (!cancelled) setTemplates(tpls);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setTemplatesError(
            err instanceof Error ? err.message : 'Erreur de chargement des gabarits',
          );
      });
    return () => {
      cancelled = true;
    };
  }, [createOpen]);

  const visibleAgents = agents.filter((a) => !a.archived);

  const hasActiveRun = (agentId: string) =>
    runs.some(
      (r) =>
        r.agentId === agentId &&
        (r.status === 'running' || r.status === 'queued' || r.status === 'waiting_approval'),
    );

  const openCreate = () => {
    setForm(BLANK_FORM);
    setStep(1);
    setCreateError(null);
    setTemplatesError(null);
    setCreateOpen(true);
  };

  const openLaunch = (agent: AgentConfig) => {
    setLaunchAgent(agent);
    setLaunchPrompt('');
    setLaunchSkillId('');
    setLaunchError(null);
  };

  const handleClone = async (agent: AgentConfig) => {
    setPageError(null);
    try {
      await api.cloneAgent(agent.id);
      // Le nouvel agent arrive via l'événement agent.created — pas de refetch.
      notify(`« ${agent.name} » cloné.`);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : 'Erreur lors du clonage');
    }
  };

  const handleArchive = async (agent: AgentConfig) => {
    setPageError(null);
    try {
      await api.updateAgent(agent.id, { archived: true });
      notify(`« ${agent.name} » archivé.`);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : "Erreur lors de l'archivage");
    }
  };

  const handleLaunch = async () => {
    if (!launchAgent || !launchPrompt.trim()) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      const run = await api.startRun({
        agentId: launchAgent.id,
        prompt: launchPrompt.trim(),
        skillId: launchSkillId || null,
      });
      setLaunchAgent(null);
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : 'Erreur au lancement du run');
    } finally {
      setLaunching(false);
    }
  };

  const handleCreate = async () => {
    if (!form.name.trim()) {
      setCreateError('Le nom est obligatoire.');
      return;
    }
    const model = form.modelChoice === CUSTOM_MODEL ? form.customModel.trim() : form.modelChoice;
    if (!model) {
      setCreateError('Le modèle est obligatoire.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const agent = await api.createAgent({
        name: form.name.trim(),
        emoji: form.emoji.trim() || '🤖',
        description: form.description.trim(),
        model,
        engine: form.engine,
        permissionMode: form.permissionMode,
        approvalPolicy: form.approvalPolicy,
        systemPrompt: form.systemPrompt.trim() === '' ? null : form.systemPrompt,
        memoryEnabled: form.memoryEnabled,
        maxTurns: parseOptionalInt(form.maxTurns),
        timeoutSec: parseOptionalInt(form.timeoutSec),
        tokenBudget: parseOptionalInt(form.tokenBudget),
        color: form.color,
      });
      setCreateOpen(false);
      navigate(`/agents/${agent.id}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Erreur à la création de l'agent");
    } finally {
      setCreating(false);
    }
  };

  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  return (
    <div className="page">
      <div className="page-header">
        <h1>Agents</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => setImportOpen(true)}>
          <DownloadSimple />
          Importer un agent
        </button>
        <button className="btn primary" onClick={openCreate}>
          <Plus />
          Nouvel agent
        </button>
      </div>

      {pageError && <ErrorText>{pageError}</ErrorText>}

      {visibleAgents.length === 0 ? (
        <EmptyState
          icon={<Robot size={28} />}
          title="Aucun agent"
          hint="Créez votre premier agent pour commencer à orchestrer des runs."
        >
          <button className="btn primary" onClick={openCreate}>
            <Plus />
            Nouvel agent
          </button>
        </EmptyState>
      ) : (
        <div className="grid auto">
          {visibleAgents.map((agent) => (
            <div
              key={agent.id}
              className="card clickable"
              {...activable(() => navigate(`/agents/${agent.id}`))}
            >
              <div className="row mb-2">
                <AgentAvatar agent={agent} />
                <div className="min-0">
                  <div className="row gap-2">
                    <strong>{agent.name}</strong>
                    {hasActiveRun(agent.id) && <span className="status-dot running" />}
                  </div>
                </div>
              </div>
              <div className="text-muted clamp-2 mb-3">
                {agent.description || 'Aucune description'}
              </div>
              <div className="row gap-2 wrap mb-3">
                <span className="badge">{agent.model}</span>
                <span className="badge accent">{agent.engine === 'sdk' ? 'SDK' : 'tmux'}</span>
                <span className={approvalBadgeClass(agent.approvalPolicy)}>
                  {agent.approvalPolicy}
                </span>
              </div>
              <div className="row" role="presentation" onClick={(e) => e.stopPropagation()}>
                <button className="btn ghost sm" onClick={() => openLaunch(agent)}>
                  Lancer
                </button>
                <button className="btn ghost sm" onClick={() => void handleClone(agent)}>
                  Cloner
                </button>
                <ConfirmButton
                  label="Archiver"
                  title="Archiver cet agent ?"
                  message={`« ${agent.name} » quitte la liste et le graphe. Ses runs et son workspace restent intacts.`}
                  confirmLabel="Archiver"
                  className="btn ghost sm"
                  onConfirm={() => void handleArchive(agent)}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {importOpen && (
        <SkillImportModal
          target="agent"
          onClose={() => setImportOpen(false)}
          onAgentImported={(agent) => {
            setImportOpen(false);
            navigate(`/agents/${agent.id}`);
          }}
        />
      )}

      {launchAgent && (
        <Modal
          title={`Lancer : ${launchAgent.emoji} ${launchAgent.name}`}
          onClose={() => setLaunchAgent(null)}
        >
          <Field label="Prompt">
            <textarea
              className="textarea"
              value={launchPrompt}
              onChange={(e) => setLaunchPrompt(e.target.value)}
              placeholder="Décrivez la tâche à confier à l'agent…"
              data-autofocus
            />
          </Field>
          <Field label="Skill (optionnel)">
            <select
              className="select"
              value={launchSkillId}
              onChange={(e) => setLaunchSkillId(e.target.value)}
            >
              <option value="">Aucune</option>
              {skills.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.name}
                </option>
              ))}
            </select>
          </Field>
          {launchError && <ErrorText>{launchError}</ErrorText>}
          <div className="modal-actions">
            <button className="btn ghost" onClick={() => setLaunchAgent(null)}>
              Annuler
            </button>
            <button
              className="btn primary"
              onClick={() => void handleLaunch()}
              disabled={launching || !launchPrompt.trim()}
            >
              {launching && <Spinner />}
              {launching ? 'Lancement…' : 'Lancer le run'}
            </button>
          </div>
        </Modal>
      )}

      {createOpen && (
        <Modal
          wide
          title={step === 1 ? 'Nouvel agent : choisir un gabarit' : 'Nouvel agent : configuration'}
          onClose={() => setCreateOpen(false)}
        >
          {step === 1 ? (
            <>
              {templatesError && <ErrorText>{templatesError}</ErrorText>}
              <div className="grid cols-3">
                <div
                  className="card clickable"
                  {...activable(() => {
                    setForm(BLANK_FORM);
                    setStep(2);
                  })}
                >
                  <div className="template-mark">
                    <FileDashed size={26} />
                  </div>
                  <strong>Vierge</strong>
                  <div className="text-muted text-sm mt-1">Partir de zéro, sans gabarit.</div>
                </div>
                {templates.map((tpl) => (
                  <div
                    key={tpl.slug}
                    className="card clickable"
                    {...activable(() => {
                      setForm(formFromTemplate(tpl));
                      setStep(2);
                    })}
                  >
                    <div className="template-mark" aria-hidden="true">
                      {tpl.emoji}
                    </div>
                    <strong>{tpl.name}</strong>
                    <div className="text-muted text-sm clamp-3 mt-1">{tpl.description}</div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="grid cols-2">
                <Field label="Nom">
                  <input
                    className="input"
                    value={form.name}
                    onChange={(e) => set('name', e.target.value)}
                    placeholder="Ex. Relecteur de code"
                    data-autofocus
                  />
                </Field>
                <Field label="Emoji">
                  <input
                    className="input"
                    value={form.emoji}
                    onChange={(e) => set('emoji', e.target.value)}
                    placeholder="🤖"
                  />
                </Field>
              </div>
              <Field label="Description">
                <input
                  className="input"
                  value={form.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder="Rôle de l'agent en une phrase"
                />
              </Field>
              <div className="grid cols-2">
                <Field label="Modèle">
                  <div className="col gap-2">
                    <select
                      className="select"
                      value={form.modelChoice}
                      onChange={(e) => set('modelChoice', e.target.value)}
                    >
                      {MODEL_OPTIONS.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                      <option value={CUSTOM_MODEL}>Autre (saisie libre)</option>
                    </select>
                    {form.modelChoice === CUSTOM_MODEL && (
                      <input
                        className="input"
                        value={form.customModel}
                        onChange={(e) => set('customModel', e.target.value)}
                        placeholder="Identifiant complet du modèle"
                      />
                    )}
                  </div>
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
              </div>
              <div className="grid cols-2">
                <Field label="Mode de permission (SDK)">
                  <select
                    className="select"
                    value={form.permissionMode}
                    onChange={(e) => set('permissionMode', e.target.value as PermissionMode)}
                  >
                    <option value="default">default</option>
                    <option value="acceptEdits">acceptEdits</option>
                    <option value="plan">plan</option>
                    <option value="bypassPermissions">bypassPermissions</option>
                  </select>
                </Field>
                <Field label="Politique d'approbation" hint={APPROVAL_HINTS[form.approvalPolicy]}>
                  <select
                    className="select"
                    value={form.approvalPolicy}
                    onChange={(e) => set('approvalPolicy', e.target.value as ApprovalPolicy)}
                  >
                    <option value="auto">auto : tout passe</option>
                    <option value="guarded">guarded : lecture libre, écriture approuvée</option>
                    <option value="ask">ask : tout approuvé</option>
                  </select>
                </Field>
              </div>
              <Field
                label="Prompt système (CLAUDE.md)"
                hint="Instructions permanentes de l'agent, matérialisées dans son workspace."
              >
                <textarea
                  className="textarea"
                  value={form.systemPrompt}
                  onChange={(e) => set('systemPrompt', e.target.value)}
                  placeholder="Tu es un agent spécialisé dans…"
                />
              </Field>
              <div className="checkbox-row mb-3">
                <input
                  type="checkbox"
                  id="agent-memory"
                  checked={form.memoryEnabled}
                  onChange={(e) => set('memoryEnabled', e.target.checked)}
                />
                <label htmlFor="agent-memory">Mémoire persistante (MEMORY.md) entre les runs</label>
              </div>
              <div className="grid cols-4">
                <Field label="Tours max" hint="Vide = illimité">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={form.maxTurns}
                    onChange={(e) => set('maxTurns', e.target.value)}
                  />
                </Field>
                <Field label="Timeout (s)" hint="Vide = illimité">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    value={form.timeoutSec}
                    onChange={(e) => set('timeoutSec', e.target.value)}
                  />
                </Field>
                <Field label="Budget tokens" hint="Par run ; vide = illimité">
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
              {createError && <ErrorText>{createError}</ErrorText>}
              <div className="modal-actions">
                <button className="btn ghost" onClick={() => setStep(1)}>
                  <ArrowLeft />
                  Gabarits
                </button>
                <button className="btn ghost" onClick={() => setCreateOpen(false)}>
                  Annuler
                </button>
                <button
                  className="btn primary"
                  onClick={() => void handleCreate()}
                  disabled={creating}
                >
                  {creating && <Spinner />}
                  {creating ? 'Création…' : "Créer l'agent"}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
