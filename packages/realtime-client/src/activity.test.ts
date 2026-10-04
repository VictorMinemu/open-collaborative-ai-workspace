import { AWAY_AFTER_IDLE_MS } from "@ocw/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActivityMonitor } from "./activity";

afterEach(() => {
  vi.useRealTimers();
});

function monitor(idleMs?: number) {
  const changes: Array<"online" | "away"> = [];
  const m = createActivityMonitor({ onChange: (s) => changes.push(s), ...(idleMs ? { idleMs } : {}) });
  return { m, changes };
}

describe("createActivityMonitor (RT-04 away, D-04)", () => {
  it("starts online without announcing it", () => {
    vi.useFakeTimers();
    const { m, changes } = monitor();
    expect(m.state).toBe("online");
    expect(changes).toEqual([]);
  });

  it("a hidden tab is away at once; visible again is online", () => {
    vi.useFakeTimers();
    const { m, changes } = monitor();
    m.visibility(true);
    expect(m.state).toBe("away");
    expect(changes).toEqual(["away"]);
    m.visibility(false);
    expect(m.state).toBe("online");
    expect(changes).toEqual(["away", "online"]);
  });

  it("five minutes without input in a visible tab is away; input brings it back and restarts the idle timer", () => {
    vi.useFakeTimers();
    const { m, changes } = monitor();
    vi.advanceTimersByTime(AWAY_AFTER_IDLE_MS);
    expect(changes).toEqual(["away"]);
    m.activity();
    expect(m.state).toBe("online");
    expect(changes).toEqual(["away", "online"]);
    vi.advanceTimersByTime(AWAY_AFTER_IDLE_MS - 1000);
    m.activity(); // restarts the timer: no away at the old deadline
    vi.advanceTimersByTime(2000);
    expect(m.state).toBe("online");
    vi.advanceTimersByTime(AWAY_AFTER_IDLE_MS);
    expect(changes).toEqual(["away", "online", "away"]);
  });

  it("repeated identical inputs fire onChange once", () => {
    vi.useFakeTimers();
    const { m, changes } = monitor();
    m.visibility(true);
    m.visibility(true);
    m.activity(); // input cannot reach a hidden tab: ignored
    expect(changes).toEqual(["away"]);
    m.visibility(false);
    m.visibility(false);
    m.activity();
    m.activity();
    expect(changes).toEqual(["away", "online"]);
  });

  it("a hidden tab cancels the idle timer", () => {
    vi.useFakeTimers();
    const { m, changes } = monitor();
    m.visibility(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2 * AWAY_AFTER_IDLE_MS);
    expect(changes).toEqual(["away"]);
  });

  it("dispose() cancels the timer and ignores later input", () => {
    vi.useFakeTimers();
    const { m, changes } = monitor();
    m.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2 * AWAY_AFTER_IDLE_MS);
    m.visibility(true);
    expect(changes).toEqual([]);
  });

  it("idle for 4 min 59 s stays online; at 5 min it is away", () => {
    vi.useFakeTimers();
    const { m, changes } = monitor();
    vi.advanceTimersByTime(4 * 60_000 + 59_000);
    expect(m.state).toBe("online");
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(m.state).toBe("away");
    expect(changes).toEqual(["away"]);
  });

  it("hiding a tab that is already idle-away fires nothing; showing it again is online", () => {
    vi.useFakeTimers();
    const { m, changes } = monitor();
    vi.advanceTimersByTime(5 * 60_000);
    expect(changes).toEqual(["away"]);
    m.visibility(true);
    expect(changes).toEqual(["away"]);
    m.visibility(false);
    expect(m.state).toBe("online");
    expect(changes).toEqual(["away", "online"]);
    // Showing the tab restarted the idle timer.
    vi.advanceTimersByTime(5 * 60_000);
    expect(changes).toEqual(["away", "online", "away"]);
  });

  it("timers are injectable", () => {
    const pending: Array<{ fn: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    const changes: string[] = [];
    const m = createActivityMonitor({
      onChange: (s) => changes.push(s),
      idleMs: 1234,
      setTimer: (fn, ms) => {
        pending.push({ fn, ms });
        return pending.length;
      },
      clearTimer: (t) => cleared.push(t),
    });
    expect(pending.map((p) => p.ms)).toEqual([1234]);
    pending[0]?.fn();
    expect(m.state).toBe("away");
    expect(changes).toEqual(["away"]);
    m.activity(); // re-arms: timer #2
    expect(m.state).toBe("online");
    m.dispose();
    expect(cleared).toEqual([2]);
  });
});
