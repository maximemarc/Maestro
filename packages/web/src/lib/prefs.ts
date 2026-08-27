/**
 * Préférences locales de poste de travail.
 *
 * Elles ne concernent que le navigateur courant : repli de la navigation,
 * alertes système. Rien ici ne doit voyager vers le serveur, et rien ici n'est
 * une donnée métier.
 */

const NOTIFY_APPROVALS = 'maestro:notify-approvals';

export function notifyApprovalsEnabled(): boolean {
  return localStorage.getItem(NOTIFY_APPROVALS) === '1';
}

export function setNotifyApprovals(enabled: boolean): void {
  localStorage.setItem(NOTIFY_APPROVALS, enabled ? '1' : '0');
}

/**
 * Demande la permission de notifier, et ne l'active qu'en cas d'accord.
 *
 * La permission n'est jamais demandée au chargement : un navigateur qui
 * réclame ce droit sans que l'utilisateur ait rien demandé se fait refuser une
 * fois pour toutes, et le refus est difficile à annuler. On ne la demande donc
 * qu'au moment où l'utilisateur coche la case.
 */
export async function requestApprovalNotifications(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

export function canNotify(): boolean {
  return 'Notification' in window && Notification.permission === 'granted';
}

const KANBAN_FOCUS = 'maestro:kanban-focus';

/**
 * Mode focus du Kanban.
 *
 * Persisté parce que c'est une habitude de travail, pas un état de session :
 * qui arbitre son tableau en plein écran veut le retrouver ainsi demain. La
 * préférence reste locale au navigateur, comme le reste de ce module.
 */
export function kanbanFocusEnabled(): boolean {
  return localStorage.getItem(KANBAN_FOCUS) === '1';
}

export function setKanbanFocus(enabled: boolean): void {
  localStorage.setItem(KANBAN_FOCUS, enabled ? '1' : '0');
}
