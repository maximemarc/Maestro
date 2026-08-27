/**
 * Registre de skills — intégrés, globaux et par agent.
 * Les collections viennent du store (événement `skill.changed`) : pas de refetch.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { AgentConfig, SkillDef, SkillScope } from '@maestro/shared';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import {
  ArrowSquareOut,
  DownloadSimple,
  Globe,
  Package,
  Play,
  Plus,
  PuzzlePiece,
  Robot,
} from '@phosphor-icons/react';
import {
  AgentChip,
  ConfirmButton,
  EmptyState,
  ErrorText,
  Field,
  Modal,
  Spinner,
} from '../components/ui';
import { SkillImportModal } from '../components/SkillCatalog';

const SCOPE_LABELS: Record<SkillScope, string> = {
  builtin: 'Intégré',
  native: 'Claude Code',
  global: 'Global',
  agent: 'Agent',
};

const SCOPE_BADGE_CLASS: Record<SkillScope, string> = {
  builtin: 'badge',
  native: 'badge ok',
  global: 'badge accent',
  agent: 'badge violet',
};

/** Portées non modifiables depuis Maestro. */
function isReadOnly(scope: SkillScope): boolean {
  return scope === 'builtin' || scope === 'native';
}

function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function excerpt(content: string): string {
  return content
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(0, 3)
    .join('\n');
}

interface EditorState {
  /** 'view' = builtin en lecture seule. */
  mode: 'create' | 'edit' | 'view';
  /** Skill d'origine (édition / lecture seule). */
  original: SkillDef | null;
  scope: 'global' | 'agent';
  agentId: string;
  slug: string;
  /** Le slug a été saisi manuellement : on arrête l'auto-génération. */
  slugTouched: boolean;
  name: string;
  description: string;
  content: string;
}

function SkillCard(props: {
  skill: SkillDef;
  onOpen: () => void;
  onUse: () => void;
  onDelete: (() => void) | null;
}) {
  const { skill } = props;
  const preview = excerpt(skill.content);
  return (
    <div className="card col gap-2">
      <div className="row">
        <strong>{skill.name}</strong>
        <span className={SCOPE_BADGE_CLASS[skill.scope]}>{SCOPE_LABELS[skill.scope]}</span>
        <span className="badge mono">{skill.slug}</span>
      </div>
      {skill.description && <div className="text-muted">{skill.description}</div>}
      {preview && <div className="mono-preview">{preview}</div>}
      <div className="row wrap mt-2">
        <button className="btn sm" onClick={props.onOpen}>
          {isReadOnly(skill.scope) ? 'Voir' : 'Éditer'}
        </button>
        <button className="btn sm" onClick={props.onUse}>
          <Play />
          Utiliser
        </button>
        {props.onDelete && (
          <ConfirmButton
            label="Supprimer"
            title="Supprimer ce skill ?"
            message={`« ${skill.name} » sera supprimé du disque. Les runs qui s'en sont servis restent consultables.`}
            confirmLabel="Supprimer le skill"
            onConfirm={props.onDelete}
          />
        )}
        {skill.sourceUrl && (
          <a
            href={skill.sourceUrl}
            target="_blank"
            rel="noreferrer"
            title="Fichier d'origine de cette skill importée"
            className="text-sm ml-auto row gap-1"
          >
            source
            <ArrowSquareOut />
          </a>
        )}
      </div>
    </div>
  );
}

export default function SkillsPage() {
  const navigate = useNavigate();
  const skills = useStore((s) => s.skills);
  const agents = useStore((s) => s.agents);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [useSkill, setUseSkill] = useState<SkillDef | null>(null);
  const [useAgentId, setUseAgentId] = useState('');
  const [usePrompt, setUsePrompt] = useState('');
  const [useError, setUseError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  const [pageError, setPageError] = useState<string | null>(null);

  const [importOpen, setImportOpen] = useState(false);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  // La confirmation d'import est éphémère : la liste elle-même arrive par WebSocket.
  useEffect(() => {
    if (!importNotice) return;
    const timer = window.setTimeout(() => setImportNotice(null), 8000);
    return () => window.clearTimeout(timer);
  }, [importNotice]);

  const builtinSkills = useMemo(() => skills.filter((s) => s.scope === 'builtin'), [skills]);
  const nativeSkills = useMemo(() => skills.filter((s) => s.scope === 'native'), [skills]);
  const globalSkills = useMemo(() => skills.filter((s) => s.scope === 'global'), [skills]);
  const agentGroups = useMemo(() => {
    const groups = new Map<string, SkillDef[]>();
    for (const skill of skills) {
      if (skill.scope !== 'agent') continue;
      const key = skill.agentId ?? '?';
      const list = groups.get(key);
      if (list) list.push(skill);
      else groups.set(key, [skill]);
    }
    return groups;
  }, [skills]);

  const agentById = (id: string): AgentConfig | undefined => agents.find((a) => a.id === id);

  /* Ouverture directe depuis la palette de commandes. */
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const wanted = searchParams.get('skill');
    if (!wanted) return;
    const skill = skills.find((sk) => sk.id === wanted);
    if (!skill) return;
    openSkill(skill);
    const next = new URLSearchParams(searchParams);
    next.delete('skill');
    setSearchParams(next, { replace: true });
    // openSkill est stable au sein d'un rendu et ne dépend que de setEditor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, skills]);

  const openCreate = () => {
    setEditorError(null);
    setEditor({
      mode: 'create',
      original: null,
      scope: 'global',
      agentId: agents[0]?.id ?? '',
      slug: '',
      slugTouched: false,
      name: '',
      description: '',
      content: '',
    });
  };

  const openSkill = (skill: SkillDef) => {
    setEditorError(null);
    setEditor({
      mode: isReadOnly(skill.scope) ? 'view' : 'edit',
      original: skill,
      scope: skill.scope === 'agent' ? 'agent' : 'global',
      agentId: skill.agentId ?? agents[0]?.id ?? '',
      slug: skill.slug,
      slugTouched: true,
      name: skill.name,
      description: skill.description,
      content: skill.content,
    });
  };

  const duplicateAsGlobal = (skill: SkillDef) => {
    setEditorError(null);
    setEditor({
      mode: 'create',
      original: null,
      scope: 'global',
      agentId: agents[0]?.id ?? '',
      slug: `${skill.slug}-copie`,
      slugTouched: true,
      name: `${skill.name} (copie)`,
      description: skill.description,
      content: skill.content,
    });
  };

  const openUse = (skill: SkillDef) => {
    setUseError(null);
    setUsePrompt('');
    setUseAgentId(skill.agentId ?? agents[0]?.id ?? '');
    setUseSkill(skill);
  };

  const submitEditor = async (e: FormEvent) => {
    e.preventDefault();
    if (!editor || editor.mode === 'view') return;
    const name = editor.name.trim();
    const slug = editor.slug.trim();
    if (!name || !slug) {
      setEditorError('Le nom et le slug sont obligatoires.');
      return;
    }
    if (editor.scope === 'agent' && !editor.agentId) {
      setEditorError('Choisis un agent pour un skill de portée « agent ».');
      return;
    }
    setSaving(true);
    setEditorError(null);
    try {
      await api.upsertSkill({
        scope: editor.scope,
        agentId: editor.scope === 'agent' ? editor.agentId : null,
        slug,
        name,
        description: editor.description.trim(),
        content: editor.content,
      });
      setEditor(null);
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const submitUse = async (e: FormEvent) => {
    e.preventDefault();
    if (!useSkill) return;
    if (!useAgentId) {
      setUseError('Choisis un agent.');
      return;
    }
    if (!usePrompt.trim()) {
      setUseError('Décris la demande à exécuter avec ce skill.');
      return;
    }
    setLaunching(true);
    setUseError(null);
    try {
      const run = await api.startRun({
        agentId: useAgentId,
        prompt: usePrompt.trim(),
        skillId: useSkill.id,
      });
      setUseSkill(null);
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setUseError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunching(false);
    }
  };

  const deleteSkill = async (skill: SkillDef) => {
    setPageError(null);
    try {
      await api.deleteSkill(skill.id);
    } catch (err) {
      setPageError(err instanceof Error ? err.message : String(err));
    }
  };

  const renderCards = (list: SkillDef[]) => (
    <div className="grid cols-3">
      {list.map((skill) => (
        <SkillCard
          key={skill.id}
          skill={skill}
          onOpen={() => openSkill(skill)}
          onUse={() => openUse(skill)}
          onDelete={isReadOnly(skill.scope) ? null : () => void deleteSkill(skill)}
        />
      ))}
    </div>
  );

  const isView = editor?.mode === 'view';

  return (
    <div className="page">
      <div className="page-header">
        <h1>Skills</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => setImportOpen(true)}>
          <DownloadSimple />
          Importer une skill
        </button>
        <button className="btn primary" onClick={openCreate}>
          <Plus />
          Nouveau skill
        </button>
      </div>
      <p className="page-lede">
        Des consignes réutilisables, en quatre portées : intégrées, Claude Code, globales, par
        agent.
      </p>

      {pageError && <ErrorText>{pageError}</ErrorText>}

      {importNotice && (
        <div className="row text-ok mb-4">
          <span>{importNotice}</span>
          <button className="btn ghost sm" onClick={() => setImportNotice(null)}>
            Masquer
          </button>
        </div>
      )}

      <div className="col gap-4">
        <section>
          <h3>Intégrés</h3>
          {builtinSkills.length > 0 ? (
            renderCards(builtinSkills)
          ) : (
            <EmptyState icon={<Package size={28} />} title="Aucun skill intégré" />
          )}
        </section>

        <section>
          <h3>Claude Code ({nativeSkills.length})</h3>
          <div className="text-faint text-sm mb-3">
            Skills de <code>~/.claude/skills</code>, lues en place. Le CLI les charge lui-même :
            Maestro n'en recopie rien, un <code>git pull</code> les met à jour.
          </div>
          {nativeSkills.length > 0 ? (
            renderCards(nativeSkills)
          ) : (
            <EmptyState
              icon={<PuzzlePiece size={28} />}
              title="Aucune skill Claude Code détectée"
              hint="Attendu dans ~/.claude/skills"
            />
          )}
        </section>

        <section>
          <h3>Globaux</h3>
          {globalSkills.length > 0 ? (
            renderCards(globalSkills)
          ) : (
            <EmptyState
              icon={<Globe size={28} />}
              title="Aucun skill global"
              hint="Les skills globaux sont partagés par tous les agents."
            >
              <button className="btn sm" onClick={openCreate}>
                <Plus />
                Créer un skill
              </button>
            </EmptyState>
          )}
        </section>

        <section>
          <h3>Par agent</h3>
          {agentGroups.size > 0 ? (
            <div className="col gap-4">
              {[...agentGroups.entries()].map(([agentId, list]) => (
                <div key={agentId} className="col gap-3">
                  <div className="row">
                    <AgentChip agent={agentById(agentId)} />
                    <span className="text-faint text-sm">
                      {list.length} skill{list.length > 1 ? 's' : ''}
                    </span>
                  </div>
                  {renderCards(list)}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<Robot size={28} />}
              title="Aucun skill par agent"
              hint="Un skill de portée « agent » vit dans le workspace d'un agent précis."
            />
          )}
        </section>
      </div>

      {importOpen && (
        <SkillImportModal
          onClose={() => setImportOpen(false)}
          onImported={(skill) => {
            setImportOpen(false);
            setImportNotice(`Skill « ${skill.name} » importée (${skill.slug}).`);
          }}
        />
      )}

      {editor && (
        <Modal
          wide
          title={
            editor.mode === 'create'
              ? 'Nouveau skill'
              : editor.mode === 'edit'
                ? `Éditer « ${editor.original?.name ?? editor.name} »`
                : `Skill intégré « ${editor.original?.name ?? editor.name} »`
          }
          onClose={() => setEditor(null)}
        >
          <form onSubmit={submitEditor}>
            {isView && (
              <div className="text-muted text-sm mb-3">
                Skill intégré, en lecture seule. Duplique-le en global pour l'adapter.
              </div>
            )}
            <div className="grid cols-2">
              <Field label="Portée">
                <select
                  className="select"
                  value={editor.scope}
                  disabled={editor.mode !== 'create'}
                  onChange={(e) =>
                    setEditor({ ...editor, scope: e.target.value === 'agent' ? 'agent' : 'global' })
                  }
                >
                  <option value="global">Global : partagé par tous les agents</option>
                  <option value="agent">Agent : propre à un agent</option>
                </select>
              </Field>
              {editor.scope === 'agent' && (
                <Field label="Agent">
                  <select
                    className="select"
                    value={editor.agentId}
                    disabled={editor.mode !== 'create'}
                    onChange={(e) => setEditor({ ...editor, agentId: e.target.value })}
                  >
                    <option value="">Choisir un agent</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.emoji} {a.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            <div className="grid cols-2">
              <Field label="Nom">
                <input
                  className="input"
                  value={editor.name}
                  disabled={isView}
                  placeholder="Revue de code"
                  onChange={(e) =>
                    setEditor({
                      ...editor,
                      name: e.target.value,
                      slug:
                        editor.mode === 'create' && !editor.slugTouched
                          ? slugify(e.target.value)
                          : editor.slug,
                    })
                  }
                />
              </Field>
              <Field
                label="Slug"
                hint={
                  editor.mode === 'create'
                    ? 'Généré depuis le nom, en minuscules et tirets.'
                    : undefined
                }
              >
                <input
                  className="input mono"
                  value={editor.slug}
                  readOnly={editor.mode !== 'create'}
                  disabled={isView}
                  onChange={(e) =>
                    setEditor({ ...editor, slug: slugify(e.target.value), slugTouched: true })
                  }
                />
              </Field>
            </div>
            <Field label="Description">
              <input
                className="input"
                value={editor.description}
                disabled={isView}
                placeholder="Quand et comment utiliser ce skill"
                onChange={(e) => setEditor({ ...editor, description: e.target.value })}
              />
            </Field>
            <Field label="Contenu (markdown)">
              <textarea
                className="textarea"
                rows={16}
                value={editor.content}
                disabled={isView}
                onChange={(e) => setEditor({ ...editor, content: e.target.value })}
              />
            </Field>
            {editorError && <ErrorText>{editorError}</ErrorText>}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setEditor(null)}>
                Fermer
              </button>
              {isView ? (
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => editor.original && duplicateAsGlobal(editor.original)}
                >
                  Dupliquer en global
                </button>
              ) : (
                <button type="submit" className="btn primary" disabled={saving}>
                  {saving
                    ? 'Enregistrement…'
                    : editor.mode === 'create'
                      ? 'Créer le skill'
                      : 'Enregistrer'}
                </button>
              )}
            </div>
          </form>
        </Modal>
      )}

      {useSkill && (
        <Modal title={`Utiliser « ${useSkill.name} »`} onClose={() => setUseSkill(null)}>
          <form onSubmit={submitUse}>
            <Field label="Agent">
              <select
                className="select"
                value={useAgentId}
                onChange={(e) => setUseAgentId(e.target.value)}
              >
                <option value="">Choisir un agent</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.emoji} {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Demande" hint="Le skill sera injecté dans le contexte du run.">
              <textarea
                className="textarea"
                value={usePrompt}
                placeholder="Décris la tâche à exécuter avec ce skill…"
                onChange={(e) => setUsePrompt(e.target.value)}
              />
            </Field>
            {useError && <ErrorText>{useError}</ErrorText>}
            <div className="modal-actions">
              <button type="button" className="btn ghost" onClick={() => setUseSkill(null)}>
                Annuler
              </button>
              <button type="submit" className="btn primary" disabled={launching}>
                {launching ? <Spinner /> : <Play />}
                {launching ? 'Lancement…' : 'Lancer le run'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
