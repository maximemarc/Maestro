/**
 * Catalogue de serveurs MCP prêts à déclarer.
 *
 * Maestro savait déjà déclarer n'importe quel serveur ; il fallait connaître son
 * nom de paquet et ses variables. C'est ce que ce catalogue supprime — et c'est
 * par là que le contrôle du navigateur, la recherche web et l'extraction de page
 * entrent dans Maestro, sans une ligne de code à écrire.
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowSquareOut, Package, Plus } from '@phosphor-icons/react';
import type { McpPreset } from '@maestro/shared';
import { api } from '../lib/api';
import { EmptyState, ErrorText, Field, Modal, Spinner } from './ui';

/**
 * Le runtime n'est pas un détail cosmétique : `uvx` suppose Python et uv sur la
 * machine, `npx` suppose Node. Un serveur dont le runtime manque échoue au
 * lancement, et le message d'erreur du SDK ne le dit pas clairement.
 */
const RUNTIME_HINT: Record<McpPreset['runtime'], string> = {
  npx: 'nécessite Node (npx)',
  uvx: 'nécessite Python et uv (uvx)',
};

export function McpPresetCatalog(props: { onClose: () => void; onInstalled: () => void }) {
  const { onClose, onInstalled } = props;
  const [presets, setPresets] = useState<McpPreset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<McpPreset | null>(null);
  const [env, setEnv] = useState<Record<string, string>>({});
  const [args, setArgs] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .listMcpPresets()
      .then(setPresets)
      .catch((err: unknown) => {
        setPresets([]);
        setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  const byCategory = useMemo(() => {
    const groups = new Map<string, McpPreset[]>();
    for (const preset of presets ?? []) {
      groups.set(preset.category, [...(groups.get(preset.category) ?? []), preset]);
    }
    return [...groups.entries()];
  }, [presets]);

  const open = (preset: McpPreset) => {
    setSelected(preset);
    setEnv({});
    setArgs(preset.args.join(' '));
    setError(null);
  };

  const install = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      /* Les arguments ne sont renvoyés que s'ils ont été modifiés : le serveur
         retombe alors sur ceux du preset, qui font foi. */
      const edited = args.trim().split(/\s+/).filter(Boolean);
      const changed = edited.join(' ') !== selected.args.join(' ');
      await api.installMcpPreset(selected.slug, { env, ...(changed ? { args: edited } : {}) });
      onInstalled();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Catalogue de serveurs MCP" onClose={onClose} wide>
      {error && <ErrorText>{error}</ErrorText>}

      {presets === null ? (
        <div className="row gap-2">
          <Spinner />
          Chargement du catalogue…
        </div>
      ) : selected ? (
        <div>
          <div className="section-label">{selected.name}</div>
          <p className="text-muted">{selected.description}</p>
          <p className="text-faint text-xs">
            Donne à l’agent : {selected.grants}. {RUNTIME_HINT[selected.runtime]}.
          </p>

          <Field label="Commande" hint="Modifiable — par exemple pour borner un répertoire.">
            <input className="input" value={args} onChange={(e) => setArgs(e.target.value)} />
          </Field>

          {selected.envKeys.length === 0 ? (
            <p className="text-faint text-xs">Aucune clé à renseigner.</p>
          ) : (
            selected.envKeys.map((key) => (
              <Field key={key.key} label={`${key.key}${key.required ? ' *' : ''}`} hint={key.hint}>
                {/* type password : la valeur ne doit pas rester lisible à
                    l'écran, ni être proposée en auto-complétion. */}
                <input
                  className="input"
                  type="password"
                  autoComplete="off"
                  value={env[key.key] ?? ''}
                  onChange={(e) => setEnv({ ...env, [key.key]: e.target.value })}
                />
              </Field>
            ))
          )}

          <p className="text-faint text-xs mt-2">
            🔒 La clé est enregistrée dans le registre de Maestro et masquée à la relecture. Elle
            n’est jamais renvoyée à l’interface.
          </p>

          <div className="modal-actions">
            <a className="btn ghost" href={selected.homepage} target="_blank" rel="noreferrer">
              <ArrowSquareOut />
              Source
            </a>
            <button className="btn ghost" onClick={() => setSelected(null)}>
              Retour
            </button>
            <button className="btn primary" onClick={() => void install()} disabled={busy}>
              {busy ? <Spinner /> : <Plus />}
              Déclarer
            </button>
          </div>
        </div>
      ) : byCategory.length === 0 ? (
        <EmptyState
          icon={<Package size={28} />}
          title="Catalogue vide"
          hint="Aucun preset disponible."
          compact
        />
      ) : (
        byCategory.map(([category, items]) => (
          <div key={category} className="mb-4">
            <div className="section-label">{category}</div>
            <div className="grid cols-2">
              {items.map((preset) => (
                <button key={preset.slug} className="tile-card" onClick={() => open(preset)}>
                  <div className="text-strong">{preset.name}</div>
                  <div className="text-muted text-sm">{preset.description}</div>
                  <div className="text-faint text-xs">
                    {preset.envKeys.some((k) => k.required) ? 'clé requise · ' : ''}
                    {RUNTIME_HINT[preset.runtime]}
                  </div>
                </button>
              ))}
            </div>
          </div>
        ))
      )}
    </Modal>
  );
}
