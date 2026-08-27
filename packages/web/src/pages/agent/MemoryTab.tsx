/**
 * Onglet Mémoire : MEMORY.md, persistant entre les runs.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AgentConfig } from '@maestro/shared';
import { api } from '../../lib/api';
import { Field } from '../../components/ui';
import { TabError, errorMessage } from './shared';

export function MemoryTab({ agent }: { agent: AgentConfig }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const { content: memory } = await api.getMemory(agent.id);
      setContent(memory);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [agent.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await api.saveMemory(agent.id, content);
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card panel-wide">
      {!agent.memoryEnabled && (
        <div className="text-warn text-sm mb-3">
          La mémoire persistante est désactivée pour cet agent (onglet Configuration).
        </div>
      )}
      <Field label="MEMORY.md" hint="Mémoire persistante maintenue par l'agent entre les runs.">
        <textarea
          className="textarea"
          rows={14}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          disabled={loading}
          placeholder={loading ? 'Chargement…' : 'Mémoire vide.'}
        />
      </Field>
      <div className="row">
        <button className="btn primary" onClick={save} disabled={saving || loading}>
          {saving ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        <button className="btn" onClick={() => void load()} disabled={loading}>
          Recharger
        </button>
        {saved && <span className="text-ok">Mémoire enregistrée.</span>}
      </div>
      <TabError message={error} />
    </div>
  );
}
