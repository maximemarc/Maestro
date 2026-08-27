/**
 * Modale de lancement d'un run depuis la fiche agent.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AgentConfig } from '@maestro/shared';
import { api } from '../../lib/api';
import { useStore } from '../../lib/store';
import { Field, Modal } from '../../components/ui';
import { TabError, errorMessage } from './shared';

export function RunModal({ agent, onClose }: { agent: AgentConfig; onClose: () => void }) {
  const navigate = useNavigate();
  const skills = useStore((s) => s.skills);
  const [prompt, setPrompt] = useState('');
  const [skillId, setSkillId] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableSkills = useMemo(
    () => skills.filter((s) => s.scope !== 'agent' || s.agentId === agent.id),
    [skills, agent.id],
  );

  const start = async () => {
    if (prompt.trim() === '') {
      setError('Le prompt est requis.');
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const run = await api.startRun({
        agentId: agent.id,
        prompt: prompt.trim(),
        skillId: skillId === '' ? null : skillId,
      });
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setStarting(false);
    }
  };

  return (
    <Modal title={`Lancer un run : ${agent.emoji} ${agent.name}`} onClose={onClose}>
      <Field label="Prompt">
        <textarea
          className="textarea"
          rows={6}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Que doit faire l'agent ?"
          data-autofocus
        />
      </Field>
      <Field label="Skill (optionnel)">
        <select className="select" value={skillId} onChange={(e) => setSkillId(e.target.value)}>
          <option value="">Aucune</option>
          {availableSkills.map((skill) => (
            <option key={skill.id} value={skill.id}>
              {skill.name}
            </option>
          ))}
        </select>
      </Field>
      <TabError message={error} />
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Annuler
        </button>
        <button className="btn primary" onClick={start} disabled={starting || prompt.trim() === ''}>
          {starting ? 'Lancement…' : 'Lancer'}
        </button>
      </div>
    </Modal>
  );
}
