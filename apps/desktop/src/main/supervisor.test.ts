import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { backoffDelay, DaemonSupervisor } from "./supervisor";

class FakeChild extends EventEmitter {
  constructor(readonly pid: number | undefined) {
    super();
  }
  exit(code: number | null = 1, signal: NodeJS.Signals | null = null) {
    this.emit("exit", code, signal);
  }
}

function harness(opts: { exitOnTerm?: boolean } = {}) {
  let now = 0;
  let nextPid = 100;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let timerId = 0;
  const children: FakeChild[] = [];
  const kills: [number, string][] = [];
  const sup = new DaemonSupervisor(
    {
      spawn: () => {
        const c = new FakeChild(nextPid++);
        children.push(c);
        return c;
      },
      killGroup: (pid, sig) => {
        kills.push([pid, sig]);
        const c = children.find((x) => x.pid === pid);
        if (c && (opts.exitOnTerm ?? true)) queueMicrotask(() => c.exit(null, sig));
      },
      now: () => now,
      setTimer: (fn, ms) => {
        const id = ++timerId;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimer: (h) => {
        const i = timers.findIndex((t) => t.id === h);
        if (i >= 0) timers.splice(i, 1);
      },
    },
    { initialMs: 1000, maxMs: 8000, factor: 2, stableMs: 30_000, killTimeoutMs: 5000 },
  );
  const advance = (ms: number) => {
    now += ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > now) break;
      timers.shift();
      t.fn();
    }
  };
  return { sup, children, kills, advance, timers, setNow: (n: number) => (now = n) };
}

describe("backoffDelay", () => {
  it("grows exponentially and caps", () => {
    const o = { initialMs: 1000, maxMs: 30_000, factor: 2 };
    expect([0, 1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, o))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });
});

describe("DaemonSupervisor", () => {
  it("spawns once and reports running", () => {
    const h = harness();
    const states: string[] = [];
    h.sup.on("state", (s) => states.push(s));
    h.sup.start();
    h.sup.start();
    expect(h.children).toHaveLength(1);
    expect(h.sup.state).toBe("running");
    expect(states).toEqual(["starting", "running"]);
  });

  it("restarts crashed children with exponential backoff, capped", () => {
    const h = harness();
    const delays: number[] = [];
    h.sup.on("restart-scheduled", (d) => delays.push(d));
    h.sup.start();
    for (let i = 0; i < 5; i++) {
      h.children.at(-1)!.exit(1);
      expect(h.sup.state).toBe("restarting");
      h.advance(delays.at(-1)! - 1);
      expect(h.children).toHaveLength(i + 1); // not yet
      h.advance(1);
      expect(h.children).toHaveLength(i + 2);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(h.sup.restarts).toBe(5);
  });

  it("resets the backoff after a stable run", () => {
    const h = harness();
    const delays: number[] = [];
    h.sup.on("restart-scheduled", (d) => delays.push(d));
    h.sup.start();
    h.children[0]!.exit(1);
    h.advance(1000);
    h.children[1]!.exit(1);
    h.advance(2000);
    h.advance(31_000); // child 2 stays up > stableMs
    h.children[2]!.exit(1);
    expect(delays).toEqual([1000, 2000, 1000]);
  });

  it("stop() SIGTERMs the process group and never restarts", async () => {
    const h = harness();
    h.sup.start();
    await h.sup.stop();
    expect(h.kills).toEqual([[100, "SIGTERM"]]);
    expect(h.sup.state).toBe("stopped");
    h.advance(60_000);
    expect(h.children).toHaveLength(1);
  });

  it("stop() escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const h = harness({ exitOnTerm: false });
    h.sup.start();
    const p = h.sup.stop();
    h.advance(5000);
    h.children[0]!.exit(null, "SIGKILL");
    await p;
    expect(h.kills).toEqual([
      [100, "SIGTERM"],
      [100, "SIGKILL"],
    ]);
  });

  it("stop() during a pending restart cancels it", async () => {
    const h = harness();
    h.sup.start();
    h.children[0]!.exit(1);
    expect(h.timers).toHaveLength(1);
    await h.sup.stop();
    expect(h.timers).toHaveLength(0);
    h.advance(10_000);
    expect(h.children).toHaveLength(1);
    expect(h.sup.state).toBe("stopped");
  });

  it("restart() stops then starts a fresh child with reset backoff", async () => {
    const h = harness();
    h.sup.start();
    await h.sup.restart();
    expect(h.children).toHaveLength(2);
    expect(h.sup.state).toBe("running");
    expect(h.sup.nextDelayMs).toBe(1000);
  });

  it("treats a spawn failure (no pid + error) as a crash", () => {
    let calls = 0;
    const sup = new DaemonSupervisor(
      {
        spawn: () => {
          calls++;
          const c = new FakeChild(undefined);
          queueMicrotask(() => c.emit("error", new Error("ENOENT")));
          return c;
        },
        killGroup: () => {},
        setTimer: () => 1,
        clearTimer: () => {},
      },
      { initialMs: 1000 },
    );
    const errors: unknown[] = [];
    sup.on("spawn-error", (e) => errors.push(e));
    sup.start();
    return new Promise<void>((resolve) =>
      queueMicrotask(() => {
        expect(calls).toBe(1);
        expect(errors).toHaveLength(1);
        expect(sup.state).toBe("restarting");
        resolve();
      }),
    );
  });
});
