/**
 * Éléments de présentation du catalogue : champ étiqueté, badges d'inventaire,
 * encart d'avertissement, aperçu défilant, ligne de résultat.
 */
import type { ReactNode } from 'react';
import { ArrowSquareOut, Star, Warning } from '@phosphor-icons/react';
import type { PluginInventory, RemoteSkill } from '@maestro/shared';
import { INVENTORY_ENTRIES, fmtCount, fmtStars } from './shared';

/**
 * Champ étiqueté avec association explicite `for`/`id`.
 *
 * Le `Field` partagé génère lui-même l'identifiant, mais seulement si son
 * enfant n'en porte pas déjà un. Ici les contrôles ont des identifiants
 * imposés : on associe donc à la main plutôt que de laisser un `<label>`
 * orphelin, qu'un lecteur d'écran n'annonce pas.
 */
export function LabeledField(props: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={props.id}>
        {props.label}
      </label>
      {props.children}
      {props.hint && <span className="hint">{props.hint}</span>}
    </div>
  );
}

/**
 * Inventaire d'un plugin en badges chiffrés. Exporté ici parce que la page
 * Paramètres affiche le même inventaire pour les plugins déjà installés.
 */
export function PluginInventoryBadges({ inventory }: { inventory: PluginInventory }) {
  return (
    <div className="row gap-2 wrap">
      {INVENTORY_ENTRIES.map(([key, label]) => (
        // Un serveur MCP déclaré est un signal de sécurité : il ressort visuellement.
        <span
          key={key}
          className={key === 'mcpServers' && inventory[key] > 0 ? 'badge warn' : 'badge'}
        >
          {fmtCount(inventory[key])} {label}
        </span>
      ))}
    </div>
  );
}

export function WarnBox({ children }: { children: ReactNode }) {
  return (
    <div className="warn-box" role="note">
      <span className="warn-icon" aria-hidden="true">
        <Warning size={16} />
      </span>
      <span>{children}</span>
    </div>
  );
}

/** Aperçu défilant d'un contenu distant, avant installation. */
export function ScrollPre({ children }: { children: ReactNode }) {
  return <pre className="scroll-box tall break-word">{children}</pre>;
}

export function ResultRow(props: { item: RemoteSkill; onPreview: () => void; busy: boolean }) {
  const { item } = props;
  return (
    <div className="card col gap-2 tile-card">
      <div className="row gap-2 wrap">
        <strong>{item.name}</strong>
        <span className="badge accent">{item.type}</span>
        {item.category && <span className="badge">{item.category}</span>}
        {item.featured && (
          <span className="badge warn">
            <Star size={11} weight="fill" />
            sélection
          </span>
        )}
        {item.stars !== null && (
          <span className="badge" title="Étoiles GitHub">
            <Star size={11} />
            {fmtStars(item.stars)}
          </span>
        )}
        {item.confidence && <span className="badge violet">fiabilité : {item.confidence}</span>}
        {item.origin && <span className="badge">origine : {item.origin}</span>}
      </div>
      {item.description && (
        <div className="text-muted text-sm clamp-2 break-word">{item.description}</div>
      )}
      <div className="row gap-3 wrap">
        <button className="btn sm" onClick={props.onPreview} disabled={props.busy}>
          Prévisualiser
        </button>
        <span className="badge mono">{item.slug}</span>
        {item.repo && <span className="badge mono">{item.repo}</span>}
        {item.sourceUrl && (
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noreferrer"
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
