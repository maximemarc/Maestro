/**
 * Composants UI partagés — à réutiliser dans toutes les pages.
 */
import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { CircleNotch, X } from '@phosphor-icons/react';
import type { AgentConfig, RunStatus } from '@maestro/shared';
import { RUN_STATUS_LABELS } from '../lib/format';

/** Sélecteur des éléments qu'un utilisateur peut atteindre au clavier. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Un élément atteignable au clavier doit être effectivement visible.
 *
 * `offsetParent !== null` est le raccourci habituel, mais il est faux deux fois :
 * il vaut null pour tout élément en `position: fixed`, qu'on écarterait donc à
 * tort, et il dépend d'une mise en page que jsdom ne calcule pas, ce qui rendait
 * le comportement intestable. On interroge le style calculé, qui répond dans les
 * deux environnements.
 */
function isVisible(el: HTMLElement): boolean {
  if (el.hasAttribute('hidden')) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/**
 * Piège le focus dans un conteneur, puis le rend à l'élément qui l'avait.
 *
 * Sans cela, une modale n'en est pas une : la tabulation continue dans la page
 * derrière le voile, on remplit un formulaire qu'on ne voit plus, et à la
 * fermeture le focus repart en haut du document. C'est le comportement attendu
 * de tout dialogue (WAI-ARIA « modal dialog »).
 */
function useFocusTrap(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    const restoreTo = document.activeElement as HTMLElement | null;

    /* Ordre de préférence pour le focus initial :
       1. le contrôle marqué `data-autofocus` par l'appelant, quand un champ
          précis est le point de départ attendu (le prompt d'un run, pas le
          sélecteur d'agent qui le précède) ;
       2. sinon le premier contrôle de contenu ;
       3. jamais le bouton de fermeture, qui n'est pas ce qu'on vient faire.
       Cela remplace `autoFocus`, qui vole le focus au chargement d'une page et
       n'a de sens que dans un dialogue. */
    const candidates = Array.from(container?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    const first =
      candidates.find((el) => el.hasAttribute('data-autofocus')) ??
      candidates.find((el) => !el.hasAttribute('data-modal-close')) ??
      candidates[0];
    (first ?? container)?.focus();

    const onKeyDown = (ev: KeyboardEvent) => {
      const { shiftKey } = ev;
      if (ev.code !== 'Tab') return;
      if (!container) return;
      const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        isVisible,
      );
      if (items.length === 0) return;
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      const current = document.activeElement;
      if (shiftKey && (current === firstItem || !container.contains(current))) {
        ev.preventDefault();
        lastItem.focus();
      } else if (!shiftKey && current === lastItem) {
        ev.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    /* Le fond ne défile plus derrière le dialogue. */
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreTo?.focus?.();
    };
  }, [active]);

  return ref;
}

export function Modal(props: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  narrow?: boolean;
}) {
  const { onClose } = props;
  const titleId = useId();
  const trapRef = useFocusTrap(true);

  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.code === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const size = props.wide ? ' wide' : props.narrow ? ' narrow' : '';

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`modal${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={trapRef}
        tabIndex={-1}
      >
        <div className="modal-title">
          <h2 id={titleId}>{props.title}</h2>
          <button
            className="btn ghost sm icon"
            onClick={onClose}
            aria-label="Fermer"
            data-modal-close
          >
            <X />
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

/**
 * Dialogue de confirmation.
 *
 * Remplace `window.confirm` : la boîte native ne se style pas, ne nomme pas ce
 * qui va disparaître, et son bouton par défaut est le bouton destructeur. Une
 * suppression d'agent mérite de dire quel agent.
 */
export function ConfirmDialog(props: {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={props.title} onClose={props.onCancel} narrow>
      <div className="text-muted prose">{props.message}</div>
      <div className="modal-actions">
        <button className="btn" onClick={props.onCancel} disabled={props.busy}>
          Annuler
        </button>
        <button
          className={props.destructive ? 'btn danger' : 'btn primary'}
          onClick={props.onConfirm}
          disabled={props.busy}
        >
          {props.busy && <Spinner />}
          {props.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/** Bouton dont l'action passe par une confirmation en dialogue. */
export function ConfirmButton(props: {
  label: string;
  title?: string;
  message?: ReactNode;
  confirmLabel?: string;
  className?: string;
  icon?: ReactNode;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { onConfirm } = props;
  const confirm = useCallback(() => {
    setOpen(false);
    onConfirm();
  }, [onConfirm]);

  return (
    <>
      <button className={props.className ?? 'btn danger sm'} onClick={() => setOpen(true)}>
        {props.icon}
        {props.label}
      </button>
      {open && (
        <ConfirmDialog
          title={props.title ?? props.label}
          message={props.message ?? 'Cette action est définitive.'}
          confirmLabel={props.confirmLabel ?? props.label}
          destructive
          onConfirm={confirm}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  );
}

/**
 * État vide : il dit ce qui manque et comment le remplir. Un état vide muet
 * laisse croire à une panne.
 */
export function EmptyState(props: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  compact?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`empty-state${props.compact ? ' compact' : ''}`}>
      {props.icon && (
        <div className="icon" aria-hidden="true">
          {props.icon}
        </div>
      )}
      <div className="empty-title">{props.title}</div>
      {props.hint && <div className="empty-hint">{props.hint}</div>}
      {props.children && <div className="empty-action">{props.children}</div>}
    </div>
  );
}

/** Indicateur d'attente. Le libellé accessible est porté par le bouton hôte. */
export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span className="spinner" aria-hidden="true">
      <CircleNotch size={size} />
    </span>
  );
}

/**
 * Squelette de chargement, à la forme du contenu attendu : la page ne saute pas
 * quand les données arrivent.
 */
export function SkeletonRows({ rows = 3, height = 12 }: { rows?: number; height?: number }) {
  return (
    <div className="stack gap-2" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height, width: `${100 - (i % 3) * 12}%` }} />
      ))}
    </div>
  );
}

/** Bloc de chargement annoncé aux lecteurs d'écran. */
export function LoadingBlock({
  label = 'Chargement…',
  rows = 3,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <SkeletonRows rows={rows} />
    </div>
  );
}

/** Message d'erreur annoncé dès son apparition. */
export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <div className="error-text" role="alert">
      {children}
    </div>
  );
}

/**
 * Rend un conteneur activable au clavier comme au clic.
 *
 * Les cartes cliquables étaient des `<div onClick>` : la souris fonctionnait,
 * le clavier non, et aucun lecteur d'écran n'annonçait qu'il y avait quelque
 * chose à activer. Ce helper pose le rôle, l'entrée dans l'ordre de tabulation
 * et les touches attendues d'un bouton.
 */
export function activable(onActivate: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      if (e.code !== 'Enter' && e.code !== 'Space') return;
      e.preventDefault();
      onActivate();
    },
  };
}

export function StatusBadge({ status }: { status: RunStatus }) {
  const tone =
    status === 'succeeded'
      ? 'ok'
      : status === 'running'
        ? 'accent'
        : status === 'failed' || status === 'timeout'
          ? 'danger'
          : status === 'waiting_approval' || status === 'queued'
            ? 'warn'
            : '';
  return (
    <span className={`badge ${tone}`}>
      <span className={`status-dot ${status}`} />
      {RUN_STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function AgentChip({ agent }: { agent: AgentConfig | null | undefined }) {
  if (!agent) return <span className="badge">agent supprimé</span>;
  return (
    <span className="badge" style={{ borderColor: agent.color }}>
      <span aria-hidden="true">{agent.emoji}</span>
      {agent.name}
    </span>
  );
}

/**
 * Avatar d'agent. L'emoji vient de la configuration de l'agent : c'est une
 * donnée saisie par l'utilisateur, pas l'iconographie de l'application.
 */
export function AgentAvatar({ agent, size = 34 }: { agent: AgentConfig; size?: number }) {
  return (
    <span
      className="agent-avatar"
      style={{ width: size, height: size, fontSize: size * 0.5, borderColor: agent.color }}
      aria-hidden="true"
    >
      {agent.emoji}
    </span>
  );
}

/**
 * Champ de formulaire étiqueté.
 *
 * Le libellé est réellement associé à son contrôle : un `<label>` sans
 * `htmlFor` n'est rattaché à rien — un lecteur d'écran annonce le champ sans
 * son intitulé, et cliquer le texte ne donne pas le focus. On génère donc un
 * identifiant et on l'injecte dans l'unique enfant élément, s'il n'en porte pas
 * déjà un. L'indice est rattaché par `aria-describedby` : sans cela il est
 * affiché mais jamais annoncé. Enfant multiple ou non-élément : on retombe sur
 * l'ancien comportement plutôt que de deviner lequel étiqueter.
 */
export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const single = Children.count(props.children) === 1 ? props.children : null;
  const associable = isValidElement(single) && (single.props as { id?: string }).id === undefined;
  const control = associable
    ? cloneElement(single as ReactElement<{ id?: string; 'aria-describedby'?: string }>, {
        id,
        ...(props.hint ? { 'aria-describedby': hintId } : {}),
      })
    : props.children;

  return (
    <div className="field">
      <label className="field-label" htmlFor={associable ? id : undefined}>
        {props.label}
      </label>
      {control}
      {props.hint && (
        <span className="hint" id={hintId}>
          {props.hint}
        </span>
      )}
    </div>
  );
}
