/**
 * Onglet CLAUDE.md : instructions permanentes de l'agent.
 */
import { useEffect, useState } from 'react';
import type { AgentConfig } from '@maestro/shared';
import { api } from '../../lib/api';
import { Field } from '../../components/ui';
import { TabError, errorMessage } from './shared';

export function ClaudeMdTab({ agent }: { agent: AgentConfig }) {
  const [content, setContent] = useState(agent.systemPrompt ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setContent(agent.systemPrompt ?? '');
    setError(null);
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.updateAgent(agent.id, { systemPrompt: content === '' ? null : content });
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card panel-wide">
      <Field
        label="CLAUDE.md"
        hint="Matérialisé dans le workspace de l'agent ; le contexte Maestro (outils MCP, mémoire) y est ajouté automatiquement."
      >
        <textarea
          className="textarea"
          rows={18}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="# Instructions de l'agent…"
        />
      </Field>
      <div className="row">
        <button className="btn primary" onClick={save} disabled={saving}>
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        {saved && <span className="text-ok">CLAUDE.md enregistré.</span>}
      </div>
      <TabError message={error} />
    </div>
  );
}
