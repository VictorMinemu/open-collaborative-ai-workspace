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

/** The n-th hold id the fake mints (a UUID, as the daemon's own). */
const holdIdN = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ID1 = holdIdN(1);
const ID2 = holdIdN(2);

function setup(o: { busy?: boolean } = {}) {
  const gates = new Map<RuntimeId, RuntimeGate>([
    ["claude-code", new RuntimeGate()],
    ["codex", new RuntimeGate()],
  ]);
  const turns: Partial<Record<RuntimeId, number>> = {};
  const state = { busy: o.busy ?? false };
  const clock = fakeClock();
  const onChange = vi.fn();
  let minted = 0;
  const hold = new AppRestartHold({
    gates,
    activeTurns: (id) => turns[id] ?? 0,
    runtimeUpdateBusy: () => state.busy,
    onChange,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    newHoldId: () => holdIdN(++minted),
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
    expect(hold.hold({ drain: false })).toEqual({ held: true, state: "held", running: 0, holdId: ID1 });
    expect(allClosed()).toBe(true);
    expect(hold.active).toBe(true);
    expect(hold.status()).toEqual({ state: "held", running: 0, holdId: ID1 });
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
    expect(hold.release({ holdId: ID1 })).toEqual({ released: true });
    await call;
    expect(ran).toHaveBeenCalledTimes(1);
    expect(allOpen()).toBe(true);
    expect(hold.active).toBe(false);
    expect(hold.status()).toEqual({ state: "idle", running: 0, lastEnd: "released" });
    expect(hold.release({ holdId: ID1 })).toEqual({ released: false });
  });

  // Review CR-01: a hold has an owner. Only the request that started it gets its id, and only that id releases it, so
  // a late release (from a cancelled wait) never reopens a newer hold, and a repeat hold never looks like its owner.
  it("only the request that starts a hold gets its id; a stale or missing id releases nothing", async () => {
    const { hold, gates, allClosed, allOpen } = setup();
    expect(hold.hold({ drain: false }).holdId).toBe(ID1);
    expect(hold.hold({ drain: true })).toEqual({ held: true, state: "held", running: 0 });
    expect(hold.release({ holdId: ID1 })).toEqual({ released: true });
    expect(hold.status()).not.toHaveProperty("holdId");
    // A new hold gets a new id; the first one's (late) release changes nothing.
    expect(hold.hold({ drain: true }).holdId).toBe(ID2);
    const ran = vi.fn(async () => undefined);
    const call = gates.get("codex")?.admit(ran);
    expect(hold.release({ holdId: ID1 })).toEqual({ released: false });
    expect(hold.release({ holdId: "" })).toEqual({ released: false });
    await flush();
    expect(ran).not.toHaveBeenCalled();
    expect(allClosed()).toBe(true);
    expect(hold.status()).toEqual({ state: "held", running: 0, holdId: ID2, lastEnd: "released" });
    expect(hold.release({ holdId: ID2 })).toEqual({ released: true });
    await call;
    expect(ran).toHaveBeenCalledTimes(1);
    expect(allOpen()).toBe(true);
  });

  // ---- drain, bounds, the runtime-update exclusion, stop ----

  it("drain with a turn in flight closes every gate at once; the next poll after the turn ends moves to held", () => {
    const { hold, turns, clock, onChange, allClosed } = setup();
    turns.codex = 1;
    expect(hold.hold({ drain: true })).toEqual({ held: false, state: "draining", running: 1, holdId: ID1 });
    expect(allClosed()).toBe(true);
    expect(hold.active).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    clock.advance(APP_UPDATE_POLL_MS * 5);
    expect(hold.status()).toEqual({ state: "draining", running: 1, holdId: ID1 });
    turns.codex = 0;
    clock.advance(APP_UPDATE_POLL_MS);
    expect(hold.status()).toEqual({ state: "held", running: 0, holdId: ID1 });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(allClosed()).toBe(true);
  });

  it("drain on an idle daemon is held at once", () => {
    const { hold, allClosed } = setup();
    expect(hold.hold({ drain: true })).toEqual({ held: true, state: "held", running: 0, holdId: ID1 });
    expect(allClosed()).toBe(true);
  });

  it("a second hold while draining or held returns the current state and starts no second timer", () => {
    const { hold, turns, clock, onChange } = setup();
    turns["claude-code"] = 1;
    hold.hold({ drain: true });
    const timers = clock.pending;
    expect(hold.hold({ drain: true })).toEqual({ held: false, state: "draining", running: 1 });
    expect(hold.hold({ drain: false })).toEqual({ held: false, state: "draining", running: 1 });
    expect(clock.pending).toBe(timers);
    turns["claude-code"] = 0;
    clock.advance(APP_UPDATE_POLL_MS);
    const heldTimers = clock.pending;
    expect(hold.hold({ drain: true })).toEqual({ held: true, state: "held", running: 0 });
    expect(hold.hold({ drain: false })).toEqual({ held: true, state: "held", running: 0 });
    expect(clock.pending).toBe(heldTimers);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("a drain still running after the max hold reopens every gate, cuts nothing and ends timed_out", async () => {
    const { hold, turns, clock, gates, allOpen, onChange } = setup();
    turns.codex = 1;
    hold.hold({ drain: true });
    const ran = vi.fn(async () => undefined);
    const call = gates.get("claude-code")?.admit(ran);
    clock.advance(APP_UPDATE_MAX_HOLD_MS - 1);
    await flush();
    expect(hold.status().state).toBe("draining");
    expect(ran).not.toHaveBeenCalled();
    clock.advance(1);
    await call;
    expect(ran).toHaveBeenCalledTimes(1);
    expect(allOpen()).toBe(true);
    // The fake turn was never stopped: it still runs and is counted.
    expect(hold.status()).toEqual({ state: "idle", running: 1, lastEnd: "timed_out" });
    expect(clock.pending).toBe(0);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("held and not followed by a stop: the gates reopen by themselves after the auto-release (auto_released)", () => {
    const { hold, turns, clock, allOpen, allClosed } = setup();
    turns.codex = 1;
    hold.hold({ drain: true });
    clock.advance(APP_UPDATE_POLL_MS * 3);
    turns.codex = 0;
    clock.advance(APP_UPDATE_POLL_MS);
    expect(hold.status().state).toBe("held");
    // The auto-release counts from `held`, not from the drain's start; the max-hold timer is gone.
    expect(clock.pending).toBe(1);
    clock.advance(APP_UPDATE_AUTO_RELEASE_MS - 1);
    expect(allClosed()).toBe(true);
    clock.advance(1);
    expect(allOpen()).toBe(true);
    expect(hold.status()).toEqual({ state: "idle", running: 0, lastEnd: "auto_released" });
    expect(clock.pending).toBe(0);
  });

  it("held without drain also auto-releases; a release before it clears the timer (released)", () => {
    const a = setup();
    a.hold.hold({ drain: false });
    a.clock.advance(APP_UPDATE_AUTO_RELEASE_MS);
    expect(a.hold.status()).toEqual({ state: "idle", running: 0, lastEnd: "auto_released" });
    const b = setup();
    b.hold.hold({ drain: false });
    expect(b.clock.pending).toBe(1);
    expect(b.hold.release({ holdId: ID1 })).toEqual({ released: true });
    expect(b.clock.pending).toBe(0);
    expect(b.hold.status()).toEqual({ state: "idle", running: 0, lastEnd: "released" });
  });

  it("a release while draining reopens at once and clears every timer", () => {
    const { hold, turns, clock, allOpen } = setup();
    turns.codex = 1;
    hold.hold({ drain: true });
    expect(clock.pending).toBeGreaterThan(0);
    expect(hold.release({ holdId: ID1 })).toEqual({ released: true });
    expect(allOpen()).toBe(true);
    expect(clock.pending).toBe(0);
    expect(hold.status()).toEqual({ state: "idle", running: 1, lastEnd: "released" });
  });

  it("a 07.11 CLI job or the self-update busy: both holds answer blocked and leave every gate open", () => {
    const { hold, turns, state, allOpen, clock, onChange } = setup({ busy: true });
    expect(hold.hold({ drain: false })).toEqual({
      held: false,
      state: "idle",
      running: 0,
      blocked: "runtime_update",
    });
    turns.codex = 1;
    expect(hold.hold({ drain: true })).toEqual({
      held: false,
      state: "idle",
      running: 1,
      blocked: "runtime_update",
    });
    expect(allOpen()).toBe(true);
    expect(hold.active).toBe(false);
    expect(clock.pending).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
    state.busy = false;
    expect(hold.hold({ drain: true })).toEqual({ held: false, state: "draining", running: 1, holdId: ID1 });
  });

  it("stop clears every timer, reopens nothing and calls no onChange; a later release changes nothing", () => {
    const { hold, turns, clock, onChange, allClosed } = setup();
    turns.codex = 1;
    hold.hold({ drain: true });
    onChange.mockClear();
    hold.stop();
    expect(clock.pending).toBe(0);
    clock.advance(APP_UPDATE_MAX_HOLD_MS * 2);
    expect(allClosed()).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(hold.release({ holdId: ID1 })).toEqual({ released: false });
    expect(allClosed()).toBe(true);
    const held = setup();
    held.hold.hold({ drain: false });
    held.hold.stop();
    expect(held.clock.pending).toBe(0);
    held.clock.advance(APP_UPDATE_AUTO_RELEASE_MS * 2);
    expect(held.allClosed()).toBe(true);
  });
});
