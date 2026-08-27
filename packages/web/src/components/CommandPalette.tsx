/**
 * Palette de commandes (Ctrl/⌘ + K).
 *
 * Une console d'exploitation se pilote au clavier : atteindre une page, ouvrir
 * un agent, retrouver un run par son identifiant ou par le début de son prompt,
 * ouvrir une skill. Avant, chaque déplacement demandait la souris et un
 * aller-retour par la barre latérale.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Lightning, MagnifyingGlass, Package } from '@phosphor-icons/react';
import type { AgentConfig, Run, SkillDef } from '@maestro/shared';

export interface PaletteEntry {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  to: string;
}

/**
 * Plafond de résultats rendus.
 *
 * Le store garde jusqu'à 300 runs : les afficher tous à l'ouverture coûterait
 * 300 sous-arbres DOM pour une liste que personne ne parcourt à la main. On
 * borne, et on dit que c'est borné.
 */
const MAX_RESULTS = 40;

/** Longueur du prompt repris comme indice de reconnaissance d'un run. */
const RUN_HINT_CHARS = 60;

/** Normalise pour une recherche insensible à la casse et aux accents. */
function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function CommandPalette(props: {
  entries: PaletteEntry[];
  agents: AgentConfig[];
  runs: Run[];
  skills: SkillDef[];
  onClose: () => void;
  onPick: (to: string) => void;
}) {
  const { entries, agents, runs, skills, onClose, onPick } = props;
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /* Le focus est donné à l'ouverture, par un effet plutôt que par `autoFocus` :
     le prop s'applique aussi au premier rendu d'une page, ce qui vole le focus
     à l'utilisateur. Ici le dialogue vient de s'ouvrir à sa demande. */
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const all = useMemo<PaletteEntry[]>(
    () => [
      ...entries,
      ...agents.map((a) => ({
        id: `agent-${a.id}`,
        group: 'Agents',
        label: a.name,
        hint: a.model,
        icon: <span aria-hidden="true">{a.emoji}</span>,
        to: `/agents/${a.id}`,
      })),
      ...runs.map((r) => ({
        id: `run-${r.id}`,
        group: 'Runs',
        label: r.id.slice(0, 8),
        hint: shorten(r.prompt, RUN_HINT_CHARS),
        icon: <Lightning />,
        to: `/runs/${r.id}`,
      })),
      ...skills.map((sk) => ({
        id: `skill-${sk.id}`,
        group: 'Skills',
        label: sk.name,
        hint: sk.slug,
        icon: <Package />,
        to: `/skills?skill=${encodeURIComponent(sk.id)}`,
      })),
    ],
    [entries, agents, runs, skills],
  );

  const { results, overflow } = useMemo(() => {
    const q = fold(query.trim());
    const matching = q
      ? all.filter((e) => fold(`${e.group} ${e.label} ${e.hint ?? ''}`).includes(q))
      : all;
    return { results: matching.slice(0, MAX_RESULTS), overflow: matching.length - MAX_RESULTS };
  }, [all, query]);

  /* Le curseur ne doit jamais désigner un élément qui vient de disparaître. */
  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      const code = ev.code;
      if (code === 'Escape') {
        ev.preventDefault();
        onClose();
        return;
      }
      if (code === 'ArrowDown') {
        ev.preventDefault();
        setCursor((c) => (results.length === 0 ? 0 : (c + 1) % results.length));
        return;
      }
      if (code === 'ArrowUp') {
        ev.preventDefault();
        setCursor((c) => (results.length === 0 ? 0 : (c - 1 + results.length) % results.length));
        return;
      }
      if (code === 'Enter' || code === 'NumpadEnter') {
        ev.preventDefault();
        const picked = results[cursor];
        if (picked) onPick(picked.to);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [results, cursor, onClose, onPick]);

  /* Garde l'élément survolé au clavier dans la zone visible. */
  useEffect(() => {
    const list = listRef.current;
    const active = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  let lastGroup = '';

  return (
    <div
      className="palette-overlay"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Palette de commandes">
        <div className="palette-input-row">
          <MagnifyingGlass size={18} />
          <input
            className="palette-input"
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Aller à une page, un agent, un run, une skill…"
            aria-label="Rechercher une page, un agent, un run ou une skill"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-results"
            aria-autocomplete="list"
            aria-activedescendant={results[cursor] ? `palette-${results[cursor].id}` : undefined}
          />
        </div>

        {results.length === 0 ? (
          <div className="palette-empty">Aucun résultat pour « {query} ».</div>
        ) : (
          <ul className="palette-list" id="palette-results" role="listbox" ref={listRef}>
            {results.map((entry, index) => {
              const header = entry.group !== lastGroup ? entry.group : null;
              lastGroup = entry.group;
              return (
                <li key={entry.id}>
                  {header && (
                    <div className="palette-group" role="presentation">
                      {header}
                    </div>
                  )}
                  <div
                    className="palette-item"
                    id={`palette-${entry.id}`}
                    role="option"
                    /* Motif combobox : le focus reste dans le champ de saisie,
                       l'option active est désignée par aria-activedescendant.
                       tabIndex -1 la rend ciblable sans l'insérer dans l'ordre
                       de tabulation. */
                    tabIndex={-1}
                    aria-selected={index === cursor}
                    onMouseEnter={() => setCursor(index)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      onPick(entry.to);
                    }}
                  >
                    {entry.icon && <span className="palette-icon">{entry.icon}</span>}
                    <span className="nowrap">{entry.label}</span>
                    {entry.hint && <span className="palette-hint ellipsis">{entry.hint}</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <div className="palette-footer">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> naviguer
          </span>
          <span>
            <kbd>Entrée</kbd> ouvrir
          </span>
          <span>
            <kbd>Échap</kbd> fermer
          </span>
          {overflow > 0 && <span className="ml-auto">{overflow} de plus, affine la recherche</span>}
        </div>
      </div>
    </div>
  );
}
