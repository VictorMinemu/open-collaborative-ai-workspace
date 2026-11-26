import type { RuntimeId } from "@ocw/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  APP_UPDATE_AUTO_RELEASE_MS,
  APP_UPDATE_MAX_HOLD_MS,
  APP_UPDATE_POLL_MS,
  AppRestartHold,
} from "./app-restart-hold.js";
import { RuntimeGate } from "./gate.js";
import { SELF_UPDATE_MAX_HOLD_MS } from "./self-update-job.js";

/** Lets every queued microtask (and the ones they queue) run. */
async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** A clock that fires only what a test advances to; `pending` counts the live timers. */
function fakeClock() {
  let clock = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let next = 0;
  return {
    setTimer(fn: () => void, ms: number): number {
      const id = next++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer(handle: unknown) {
      timers.delete(handle as number);
    },
    get pending() {
      return timers.size;
    },
    /** Fires every timer due within `ms`, in order, moving the clock. */
    advance(ms: number) {
      const until = clock + ms;
      for (;;) {
        let due: [number, { fn: () => void; at: number }] | null = null;
        for (const entry of timers)
          if (entry[1].at <= until && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        timers.delete(due[0]);
        clock = Math.max(clock, due[1].at);
        due[1].fn();
      }
      clock = until;
    },
  };
}

function setup(o: { busy?: boolean } = {}) {
  const gates = new Map<RuntimeId, RuntimeGate>([
    ["claude-code", new RuntimeGate()],
    ["codex", new RuntimeGate()],
  ]);
  const turns: Partial<Record<RuntimeId, number>> = {};
  const state = { busy: o.busy ?? false };
  const clock = fakeClock();
  const onChange = vi.fn();
  const hold = new AppRestartHold({
    gates,
    activeTurns: (id) => turns[id] ?? 0,
    runtimeUpdateBusy: () => state.busy,
    onChange,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const allClosed = () => [...gates.values()].every((g) => !g.isOpen);
  const allOpen = () => [...gates.values()].every((g) => g.isOpen);
  return { gates, turns, state, clock, onChange, hold, allClosed, allOpen };
}

describe("AppRestartHold (07.13.1 D-07)", () => {
  it("bounds: 30 min like the self-update, 2 min auto-release, 1 s poll", () => {
    expect(APP_UPDATE_MAX_HOLD_MS).toBe(SELF_UPDATE_MAX_HOLD_MS);
    expect(APP_UPDATE_MAX_HOLD_MS).toBe(30 * 60_000);
    expect(APP_UPDATE_AUTO_RELEASE_MS).toBe(2 * 60_000);
    expect(APP_UPDATE_POLL_MS).toBe(1_000);
  });

  it("idle gates: hold without drain closes every gate in one step and answers held", () => {
    const { hold, allClosed, onChange } = setup();
    expect(hold.status()).toEqual({ state: "idle", running: 0 });
    expect(hold.active).toBe(false);
    expect(hold.hold({ drain: false })).toEqual({ held: true, state: "held", running: 0 });
    expect(allClosed()).toBe(true);
    expect(hold.active).toBe(true);
    expect(hold.status()).toEqual({ state: "held", running: 0 });
    expect(onChange).toHaveBeenCalled();
  });

  it("a turn in flight: hold without drain closes nothing and answers idle with the count", () => {
    const { hold, turns, allOpen, onChange } = setup();
    turns.codex = 1;
    expect(hold.hold({ drain: false })).toEqual({ held: false, state: "idle", running: 1 });
    expect(allOpen()).toBe(true);
    expect(hold.active).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("release reopens every gate and lets a held caller run; a second release answers false", async () => {
    const { hold, gates, allOpen } = setup();
    hold.hold({ drain: false });
    const ran = vi.fn(async () => undefined);
    const call = gates.get("claude-code")?.admit(ran);
    await flush();
    expect(ran).not.toHaveBeenCalled();
    expect(hold.release()).toEqual({ released: true });
    await call;
    expect(ran).toHaveBeenCalledTimes(1);
    expect(allOpen()).toBe(true);
    expect(hold.active).toBe(false);
    expect(hold.status()).toEqual({ state: "idle", running: 0, lastEnd: "released" });
    expect(hold.release()).toEqual({ released: false });
  });
});
