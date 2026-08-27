/**
 * Page Runs — liste filtrable des exécutions + lancement d'un nouveau run.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CaretDown, CaretUp, CaretUpDown, Lightning, Plus } from '@phosphor-icons/react';
import type { Run } from '@maestro/shared';
import { ACTIVE_RUN_STATUSES } from '@maestro/shared';
import { api } from '../lib/api';
import {
  fmtCost,
  fmtDateTime,
  fmtDuration,
  fmtTokens,
  ORIGIN_LABELS,
  RUN_STATUS_LABELS,
} from '../lib/format';
import { useStore } from '../lib/store';
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

const PROMPT_MAX = 80;

/**
 * Tri de la table.
 *
 * Par défaut, les runs actifs remontent, puis l'ordre est chronologique
 * inverse : c'est ce qu'on veut voir en arrivant. Dès qu'une colonne est
 * choisie, ce groupement disparaît, parce qu'un tri par coût qui garderait les
 * runs actifs en tête ne serait pas un tri par coût.
 */
type SortColumn = 'turns' | 'tokens' | 'cost' | 'duration' | 'created';

interface SortState {
  column: SortColumn;
  dir: 'asc' | 'desc';
}

/** Durée écoulée, run en cours compris : sinon il trierait comme un run nul. */
function durationMs(run: Run): number {
  if (!run.startedAt) return 0;
  const end = run.endedAt ? new Date(run.endedAt).getTime() : Date.now();
  return Math.max(0, end - new Date(run.startedAt).getTime());
}

const SORT_VALUES: Record<SortColumn, (run: Run) => number> = {
  turns: (r) => r.numTurns,
  tokens: (r) => r.inputTokens + r.outputTokens,
  cost: (r) => r.costUsd,
  duration: (r) => durationMs(r),
  created: (r) => new Date(r.createdAt).getTime(),
};

/** Coupe un texte trop long en conservant son début. */
function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isActive(run: Run): boolean {
  return ACTIVE_RUN_STATUSES.includes(run.status);
}

const SCOPE_LABELS: Record<string, string> = {
  builtin: 'intégré',
  global: 'global',
  agent: 'agent',
};

function NewRunModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const agents = useStore((s) => s.agents);
  const skills = useStore((s) => s.skills);
  const runs = useStore((s) => s.runs);

  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [skillId, setSkillId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [resumeRunId, setResumeRunId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableSkills = useMemo(
    () => skills.filter((sk) => sk.scope !== 'agent' || sk.agentId === agentId),
    [skills, agentId],
  );

  const resumableRuns = useMemo(
    () => runs.filter((r) => r.agentId === agentId && r.status === 'succeeded'),
    [runs, agentId],
  );

  const changeAgent = (id: string) => {
    setAgentId(id);
    setSkillId('');
    setResumeRunId('');
  };

  const submit = async () => {
    if (!agentId || !prompt.trim()) {
      setError('Agent et prompt sont obligatoires.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const run = await api.startRun({
        agentId,
        prompt: prompt.trim(),
        skillId: skillId || null,
        resumeRunId: resumeRunId || null,
      });
      navigate(`/runs/${run.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Nouveau run" onClose={onClose}>
      <Field label="Agent">
        <select className="select" value={agentId} onChange={(e) => changeAgent(e.target.value)}>
          {agents.length === 0 && <option value="">Aucun agent disponible</option>}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.emoji} {a.name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Skill (optionnel)">
        <select className="select" value={skillId} onChange={(e) => setSkillId(e.target.value)}>
          <option value="">Aucune</option>
          {availableSkills.map((sk) => (
            <option key={sk.id} value={sk.id}>
              {sk.name} · {SCOPE_LABELS[sk.scope] ?? sk.scope}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Prompt">
        <textarea
          className="textarea"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Instructions pour l'agent…"
          data-autofocus
        />
      </Field>

      <Field
        label="Reprendre la session d'un run (optionnel)"
        hint="Reprend la session Claude Code d'un run réussi du même agent."
      >
        <select
          className="select"
          value={resumeRunId}
          onChange={(e) => setResumeRunId(e.target.value)}
          disabled={resumableRuns.length === 0}
        >
          <option value="">Nouvelle session</option>
          {resumableRuns.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id} · {shorten(r.prompt, 60)}
            </option>
          ))}
        </select>
      </Field>

      {error && <ErrorText>{error}</ErrorText>}

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={submitting}>
          Annuler
        </button>
        <button
          className="btn primary"
          onClick={submit}
          disabled={submitting || !agentId || !prompt.trim()}
        >
          {submitting && <Spinner />}
          {submitting ? 'Lancement…' : 'Lancer le run'}
        </button>
      </div>
    </Modal>
  );
}

export default function RunsPage() {
  const navigate = useNavigate();
  const runs = useStore((s) => s.runs);
  const agents = useStore((s) => s.agents);

  const [agentFilter, setAgentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [originFilter, setOriginFilter] = useState('');
  const [sort, setSort] = useState<SortState | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const matching = runs.filter(
      (r) =>
        (!agentFilter || r.agentId === agentFilter) &&
        (!statusFilter || r.status === statusFilter) &&
        (!originFilter || r.origin === originFilter),
    );
    if (sort) {
      const value = SORT_VALUES[sort.column];
      const sign = sort.dir === 'asc' ? 1 : -1;
      return matching.slice().sort((a, b) => (value(a) - value(b)) * sign);
    }
    const byCreatedDesc = (a: Run, b: Run) => b.createdAt.localeCompare(a.createdAt);
    const active = matching.filter(isActive).sort(byCreatedDesc);
    const finished = matching.filter((r) => !isActive(r)).sort(byCreatedDesc);
    return [...active, ...finished];
  }, [runs, agentFilter, statusFilter, originFilter, sort]);

  /* Premier clic : décroissant, parce qu'on cherche le run le plus coûteux ou
     le plus long avant le plus petit. Troisième clic : retour au tri par
     défaut, pour ne pas enfermer l'utilisateur dans un ordre. */
  const toggleSort = (column: SortColumn) => {
    setSort((current) => {
      if (!current || current.column !== column) return { column, dir: 'desc' };
      if (current.dir === 'desc') return { column, dir: 'asc' };
      return null;
    });
  };

  const sortProps = (column: SortColumn, label: string) => {
    const active = sort?.column === column ? sort.dir : null;
    return {
      'aria-sort': (active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none') as
        'ascending' | 'descending' | 'none',
      children: (
        <button className="th-sort" onClick={() => toggleSort(column)}>
          {label}
          {active === 'asc' ? (
            <CaretUp size={10} />
          ) : active === 'desc' ? (
            <CaretDown size={10} />
          ) : (
            <CaretUpDown size={10} className="th-sort-idle" />
          )}
        </button>
      ),
    };
  };

  const cancelRun = async (id: string) => {
    setError(null);
    try {
      await api.cancelRun(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur lors de l'annulation");
    }
  };

  const filtering = Boolean(agentFilter || statusFilter || originFilter);

  return (
    /* Page à défilement interne : les filtres et le compte restent visibles,
       seul le tableau défile, et son en-tête reste lisible. */
    <div className="page fixed">
      <div className="page-header">
        <h1>Runs</h1>
        <span className="text-faint text-sm num">
          {filtered.length} sur {runs.length}
        </span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setShowModal(true)}>
          <Plus />
          Nouveau run
        </button>
      </div>

      <div className="filter-bar mb-3">
        <select
          className="select w-md"
          value={agentFilter}
          onChange={(e) => setAgentFilter(e.target.value)}
          aria-label="Filtrer par agent"
        >
          <option value="">Tous les agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.emoji} {a.name}
            </option>
          ))}
        </select>
        <select
          className="select w-md"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filtrer par statut"
        >
          <option value="">Tous les statuts</option>
          {Object.entries(RUN_STATUS_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          className="select w-sm"
          value={originFilter}
          onChange={(e) => setOriginFilter(e.target.value)}
          aria-label="Filtrer par origine"
        >
          <option value="">Toutes origines</option>
          {Object.entries(ORIGIN_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {(filtering || sort) && (
          <button
            className="btn ghost sm"
            onClick={() => {
              setAgentFilter('');
              setStatusFilter('');
              setOriginFilter('');
              setSort(null);
            }}
          >
            Réinitialiser
          </button>
        )}
      </div>

      {error && <ErrorText>{error}</ErrorText>}

      {filtered.length === 0 ? (
        <EmptyState
          icon={<Lightning size={28} />}
          title={filtering ? 'Aucun run pour ces filtres' : 'Aucun run'}
          hint={
            filtering
              ? 'Élargis les filtres pour retrouver des exécutions.'
              : 'Lance un run manuellement, ou laisse une routine, un pipeline ou le Kanban le faire.'
          }
        >
          {filtering ? (
            <button
              className="btn"
              onClick={() => {
                setAgentFilter('');
                setStatusFilter('');
                setOriginFilter('');
              }}
            >
              Réinitialiser les filtres
            </button>
          ) : (
            <button className="btn primary" onClick={() => setShowModal(true)}>
              <Plus />
              Nouveau run
            </button>
          )}
        </EmptyState>
      ) : (
        <div className="table-wrap fill">
          <table className="table">
            <thead>
              <tr>
                <th>Statut</th>
                <th>Agent</th>
                <th>Prompt</th>
                <th>Origine</th>
                <th>Modèle</th>
                <th className="num" {...sortProps('turns', 'Tours')} />
                <th className="num" {...sortProps('tokens', 'Tokens')} />
                <th className="num" {...sortProps('cost', 'Coût')} />
                <th {...sortProps('duration', 'Durée')} />
                <th {...sortProps('created', 'Créé')} />
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((run) => {
                const agent = agents.find((a) => a.id === run.agentId);
                return (
                  <tr
                    key={run.id}
                    className="clickable"
                    onClick={() => navigate(`/runs/${run.id}`)}
                  >
                    <td>
                      <StatusBadge status={run.status} />
                    </td>
                    <td>
                      <AgentChip agent={agent} />
                    </td>
                    <td title={run.prompt}>{shorten(run.prompt, PROMPT_MAX)}</td>
                    <td>
                      <span className="badge">{ORIGIN_LABELS[run.origin] ?? run.origin}</span>
                    </td>
                    <td className="mono">{run.model}</td>
                    <td className="num">{run.numTurns}</td>
                    <td className="num">{fmtTokens(run.inputTokens + run.outputTokens)}</td>
                    <td className="num">{fmtCost(run.costUsd)}</td>
                    <td>{fmtDuration(run.startedAt, run.endedAt)}</td>
                    <td>{fmtDateTime(run.createdAt)}</td>
                    <td>
                      {isActive(run) && (
                        /* Le clic sur la ligne ouvre le run : l'annulation ne
                           doit pas le déclencher au passage. */
                        <span role="presentation" onClick={(e) => e.stopPropagation()}>
                          <ConfirmButton
                            label="Annuler"
                            title="Annuler ce run ?"
                            message={
                              <>
                                Le run <span className="mono">{run.id.slice(0, 8)}</span> et les
                                runs qu'il a délégués seront interrompus. Le travail déjà effectué
                                reste dans le transcript.
                              </>
                            }
                            confirmLabel="Annuler le run"
                            onConfirm={() => void cancelRun(run.id)}
                          />
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showModal && <NewRunModal onClose={() => setShowModal(false)} />}
    </div>
  );
}
