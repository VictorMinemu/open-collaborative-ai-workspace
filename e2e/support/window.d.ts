/**
 * Globals that the specs' init scripts install in the page, declared once for every spec (a `declare global` per spec
 * file conflicts as soon as two specs record the same thing). `__notes`: the OS pop-ups recorded by a `Notification`
 * stand-in (notification-prefs, agent-cards); `__permissionRequests` and `__badge`: notification-prefs' counters.
 */
interface Window {
  __notes: Array<{ title: string; body: string; tag: string; onclick?: (() => void) | null }>;
  __permissionRequests: number;
  __badge: number[];
}
