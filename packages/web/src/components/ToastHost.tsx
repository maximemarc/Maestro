/**
 * Hôte des notifications transitoires.
 *
 * Un seul point d'affichage, monté par la coque : les pages appellent
 * `notify()` sur le store et n'ont pas à porter de zone de message. La région
 * est annoncée en `polite` — une confirmation d'action ne doit pas couper la
 * lecture en cours, seulement s'y insérer.
 */
import { useEffect } from 'react';
import { CheckCircle, Info, X } from '@phosphor-icons/react';
import { useStore, type Toast } from '../lib/store';

/** Durée d'affichage : assez pour être lu, assez court pour ne pas gêner. */
const TOAST_MS = 4000;

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast.id, onDismiss]);

  return (
    <div className={`toast ${toast.tone}`}>
      <span className="toast-icon" aria-hidden="true">
        {toast.tone === 'ok' ? <CheckCircle size={16} /> : <Info size={16} />}
      </span>
      <span className="grow">{toast.message}</span>
      <button
        className="btn ghost sm icon"
        onClick={() => onDismiss(toast.id)}
        aria-label="Masquer cette notification"
      >
        <X size={12} />
      </button>
    </div>
  );
}

export function ToastHost() {
  const toasts = useStore((s) => s.toasts);
  const dismissToast = useStore((s) => s.dismissToast);

  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={dismissToast} />
      ))}
    </div>
  );
}
