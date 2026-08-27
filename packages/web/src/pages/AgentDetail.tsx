/**
 * Fiche agent : en-tête d'identité, actions, et cinq onglets.
 *
 * Chaque onglet vit dans son propre module sous `pages/agent/` : le fichier
 * unique atteignait 849 lignes, et modifier la mémoire d'un agent obligeait à
 * traverser le formulaire de configuration.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Lightning, Robot } from '@phosphor-icons/react';
import { api } from '../lib/api';
import { selectAgent, useStore } from '../lib/store';
import { AgentAvatar, ConfirmButton, EmptyState } from '../components/ui';
import { ClaudeMdTab } from './agent/ClaudeMdTab';
import { ConfigTab } from './agent/ConfigTab';
import { MemoryTab } from './agent/MemoryTab';
import { RunModal } from './agent/RunModal';
import { RunsTab } from './agent/RunsTab';
import { APPROVAL_POLICY_LABELS, TabError, errorMessage } from './agent/shared';
import { StatsTab } from './agent/StatsTab';

type TabId = 'config' | 'claudemd' | 'memory' | 'runs' | 'stats';

const TABS: { id: TabId; label: string }[] = [
  { id: 'config', label: 'Configuration' },
  { id: 'claudemd', label: 'CLAUDE.md' },
  { id: 'memory', label: 'Mémoire' },
  { id: 'runs', label: 'Runs' },
  { id: 'stats', label: 'Statistiques' },
];

export default function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const agent = useStore(selectAgent(id ?? null));
  const notify = useStore((s) => s.notify);
  const [tab, setTab] = useState<TabId>('config');
  const [runModalOpen, setRunModalOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  if (!agent) {
    return (
      <div className="page">
        <EmptyState
          icon={<Robot size={28} />}
          title="Agent introuvable"
          hint="Il a peut-être été supprimé ou archivé."
        >
          <Link to="/agents" className="btn">
            <ArrowLeft />
            Retour aux agents
          </Link>
        </EmptyState>
      </div>
    );
  }

  const clone = async () => {
    setActionError(null);
    try {
      const copy = await api.cloneAgent(agent.id);
      notify(`« ${agent.name} » cloné.`);
      navigate(`/agents/${copy.id}`);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const remove = async () => {
    setActionError(null);
    try {
      await api.deleteAgent(agent.id);
      notify(`« ${agent.name} » supprimé.`);
      navigate('/agents');
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <AgentAvatar agent={agent} size={48} />
        <div>
          <h1>{agent.name}</h1>
          <div className="text-muted text-sm">{agent.description || 'Aucune description.'}</div>
          <div className="row gap-2 mt-2">
            <span className="badge accent">{agent.model}</span>
            <span className="badge violet">{agent.engine === 'tmux' ? 'tmux' : 'SDK'}</span>
            <span className="badge">{APPROVAL_POLICY_LABELS[agent.approvalPolicy]}</span>
          </div>
        </div>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setRunModalOpen(true)}>
          <Lightning />
          Lancer un run
        </button>
        <button className="btn" onClick={() => void clone()}>
          Cloner
        </button>
        <ConfirmButton
          label="Supprimer"
          title="Supprimer cet agent ?"
          message={`« ${agent.name} », son workspace, son CLAUDE.md et sa mémoire sont supprimés définitivement. Ses runs passés restent consultables.`}
          confirmLabel="Supprimer l'agent"
          className="btn danger"
          onConfirm={() => void remove()}
        />
      </div>
      <TabError message={actionError} />

      {/* Onglets : `role=tab` demanderait de gérer les flèches et
          aria-controls. Ce sont des boutons qui changent l'état de la page, et
          ils s'annoncent comme tels via aria-pressed. */}
      <div className="tabs" role="group" aria-label="Sections de la fiche agent">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab${tab === t.id ? ' active' : ''}`}
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'config' && <ConfigTab agent={agent} />}
      {tab === 'claudemd' && <ClaudeMdTab agent={agent} />}
      {tab === 'memory' && <MemoryTab agent={agent} />}
      {tab === 'runs' && <RunsTab agentId={agent.id} />}
      {tab === 'stats' && <StatsTab agentId={agent.id} />}

      {runModalOpen && <RunModal agent={agent} onClose={() => setRunModalOpen(false)} />}
    </div>
  );
}
