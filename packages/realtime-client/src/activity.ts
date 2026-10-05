import { AWAY_AFTER_IDLE_MS, type PresenceState } from "@ocw/contracts";

export interface ActivityMonitor {
  /** Input in a visible tab (pointer, key, wheel, touch, focus): online, and the idle timer restarts. */
  activity(): void;
  /** Tab visibility changed: hidden is away at once; visible counts as activity. */
  visibility(hidden: boolean): void;
  readonly state: PresenceState;
  /** Cancels the idle timer; later calls are ignored. */
  dispose(): void;
}

/**
 * Pure away/active state machine (RT-04, 03-02 D-04). No DOM access: the caller forwards visibility and input.
 * Starts online (a new connection is online) with the idle timer running; `onChange` fires only on a real change.
 */
export function createActivityMonitor(o: {
  onChange: (s: PresenceState) => void;
  idleMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}): ActivityMonitor {
  const idleMs = o.idleMs ?? AWAY_AFTER_IDLE_MS;
  // Resolved at call time so fake timers installed after import still apply.
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));

  let state: PresenceState = "online";
  let hidden = false;
  let disposed = false;
  let timer: unknown = null;

  const set = (next: PresenceState) => {
    if (next === state) return;
    state = next;
    o.onChange(next);
  };
  const cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const arm = () => {
    cancel();
    timer = setTimer(() => {
      timer = null;
      if (!disposed) set("away");
    }, idleMs);
  };

  const activity = () => {
    // Input cannot reach a hidden tab; a stray event while hidden must not flip it back.
    if (disposed || hidden) return;
    arm();
    set("online");
  };

  arm();

  return {
    activity,
    visibility(isHidden) {
      if (disposed) return;
      hidden = isHidden;
      if (isHidden) {
        cancel();
        set("away");
      } else {
        activity();
      }
    },
    get state() {
      return state;
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
