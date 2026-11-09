import { describe, expect, it, vi } from "vitest";
import { eachBounded, OrgQueue, type OrgTask } from "./org-queue";

/** Phase 07.9 fan-out: the per-organization background queue of the work-session module, without a database. */

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

function quietLog() {
  return { warn: vi.fn(), error: vi.fn() };
}

/** A task that records its start and end in `trace` and finishes when `open()` is called (or at once). */
function gated(trace: string[], name: string, opts: { gate?: boolean; key?: string; ids?: string[] } = {}) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  if (!opts.gate) open();
  const task: OrgTask = {
    kind: "test",
    ...(opts.key ? { key: opts.key } : {}),
    ids: () => opts.ids ?? [name],
    async run() {
      trace.push(`start ${name}`);
      await opened;
      trace.push(`end ${name}`);
    },
  };
  return { task, open };
}

/** A tail-coalescing task over a set of ids (the shape of a session delivery). */
function batch(trace: string[], ids: string[]): OrgTask {
  const set = new Set(ids);
  return {
    kind: "batch",
    ids: () => [...set],
    async run() {
      trace.push(`batch ${[...set].join(",")}`);
    },
    absorb(next) {
      if (next.kind !== "batch") return false;
      for (const id of next.ids()) set.add(id);
      return true;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("OrgQueue", () => {
  it("runs one organization's tasks one at a time, in the order they were queued", async () => {
    const trace: string[] = [];
    const q = new OrgQueue({ log: quietLog() });
    const first = gated(trace, "1", { gate: true });
    q.push(A, first.task);
    q.push(A, gated(trace, "2").task);
    q.push(A, gated(trace, "3").task);
    await tick();
    expect(trace).toEqual(["start 1"]);
    first.open();
    await q.whenIdle(A);
    expect(trace).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
  });

  it("works on different organizations at once, at most `concurrency` of them", async () => {
    const trace: string[] = [];
    const q = new OrgQueue({ log: quietLog(), concurrency: 2 });
    const a = gated(trace, "a", { gate: true });
    const b = gated(trace, "b", { gate: true });
    q.push(A, a.task);
    q.push(B, b.task);
    q.push(C, gated(trace, "c").task);
    await tick();
    expect(trace).toEqual(["start a", "start b"]);
    b.open();
    await q.whenIdle(C);
    expect(trace).toContain("end c");
    expect(trace).not.toContain("end a");
    a.open();
    await q.whenIdle();
  });

  it("coalesces at the tail only, never into a running task nor across a task queued in between", async () => {
    const trace: string[] = [];
    const q = new OrgQueue({ log: quietLog() });
    const running = batch(trace, ["s0"]);
    const gate = gated(trace, "gate", { gate: true });
    q.push(A, gate.task);
    q.push(A, running);
    q.push(A, batch(trace, ["s1"])); // absorbed by the waiting batch at the tail
    q.push(A, gated(trace, "removed").task);
    q.push(A, batch(trace, ["s2"])); // a task waits in between: a new batch, after it
    q.push(A, batch(trace, ["s3"])); // absorbed by that one
    gate.open();
    await q.whenIdle(A);
    expect(trace).toEqual([
      "start gate",
      "end gate",
      "batch s0,s1",
      "start removed",
      "end removed",
      "batch s2,s3",
    ]);
  });

  it("drops a task whose key already waits; queues it again when that one is already running", async () => {
    const trace: string[] = [];
    const q = new OrgQueue({ log: quietLog() });
    const first = gated(trace, "sweep 1", { gate: true, key: "sweep" });
    q.push(A, first.task);
    await tick(); // running
    q.push(A, gated(trace, "sweep 2", { key: "sweep" }).task); // waits behind the running one
    q.push(A, gated(trace, "sweep 3", { key: "sweep" }).task); // the same work already waits: dropped
    first.open();
    await q.whenIdle(A);
    expect(trace).toEqual(["start sweep 1", "end sweep 1", "start sweep 2", "end sweep 2"]);
  });

  it("retries a failing task in place a bounded number of times, logging ids and an error code only", async () => {
    const log = quietLog();
    const trace: string[] = [];
    const q = new OrgQueue({ log, maxAttempts: 3, retryDelaysMs: [1] });
    let runs = 0;
    const secret = "prompt text that must never be logged";
    q.push(A, {
      kind: "deliver",
      ids: () => ["s1", "s2"],
      async run() {
        runs++;
        trace.push(`fail ${runs}`);
        throw Object.assign(new Error(secret), { code: "40001" });
      },
    });
    q.push(A, gated(trace, "next").task);
    q.push(B, gated(trace, "other org").task);
    await q.whenIdle();
    expect(runs).toBe(3);
    // In place: the organization's next task waits for the last attempt; another organization never waits.
    expect(trace.indexOf("start next")).toBeGreaterThan(trace.indexOf("fail 3"));
    expect(trace).toContain("end other org");
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[0]).toEqual({
      organizationId: A,
      kind: "deliver",
      ids: ["s1", "s2"],
      count: 2,
      attempt: 3,
      error: "40001",
    });
    expect(JSON.stringify([log.warn.mock.calls, log.error.mock.calls])).not.toContain(secret);
  });

  it("a retry that succeeds stops retrying", async () => {
    const log = quietLog();
    const q = new OrgQueue({ log, maxAttempts: 5, retryDelaysMs: [1] });
    let runs = 0;
    q.push(A, {
      kind: "deliver",
      ids: () => [],
      async run() {
        runs++;
        if (runs < 2) throw new TypeError("transient");
      },
    });
    await q.whenIdle(A);
    expect(runs).toBe(2);
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, error: "TypeError" });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs at most twenty ids of a large task, with the total", async () => {
    const log = quietLog();
    const q = new OrgQueue({ log, maxAttempts: 1 });
    const ids = Array.from({ length: 250 }, (_, i) => `s${i}`);
    q.push(A, {
      kind: "sweep",
      ids: () => ids,
      async run() {
        throw new Error("x");
      },
    });
    await q.whenIdle(A);
    expect(log.error.mock.calls[0]?.[0]).toMatchObject({ ids: ids.slice(0, 20), count: 250 });
  });

  it("close drains what is queued, including what the running tasks queue meanwhile", async () => {
    const trace: string[] = [];
    const q = new OrgQueue({ log: quietLog() });
    q.push(A, {
      kind: "sweep",
      ids: () => [],
      async run() {
        trace.push("sweep");
        q.push(A, batch(trace, ["s1"]));
      },
    });
    expect(await q.close(1_000)).toEqual({ drained: true, abandoned: 0 });
    expect(trace).toEqual(["sweep", "batch s1"]);
  });

  it("close abandons what still waits at the deadline, logs it by kind and count, and refuses new work", async () => {
    const log = quietLog();
    const trace: string[] = [];
    const q = new OrgQueue({ log });
    const stuck = gated(trace, "stuck", { gate: true });
    q.push(A, stuck.task);
    q.push(A, batch(trace, ["s1"]));
    q.push(A, gated(trace, "removed").task);
    expect(await q.close(20)).toEqual({ drained: false, abandoned: 2 });
    expect(log.warn).toHaveBeenCalledWith(
      { organizationId: A, kinds: ["batch", "test"], count: 2 },
      "background tasks abandoned at shutdown",
    );
    q.push(B, batch(trace, ["s9"]));
    stuck.open();
    await q.whenIdle();
    expect(trace).toEqual(["start stuck", "end stuck"]);
  });

  it("whenIdle resolves at once when nothing is queued", async () => {
    const q = new OrgQueue({ log: quietLog() });
    await q.whenIdle(A);
    await q.whenIdle();
  });
});

describe("eachBounded: one task's work items at bounded concurrency (07.9 fan-out, WINDOWS #311)", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("runs every item, never more than the limit at once, in order of start", async () => {
    const opens: Array<() => void> = [];
    const gates = Array.from(
      { length: 7 },
      (_, i) =>
        new Promise<void>((resolve) => {
          opens[i] = resolve;
        }),
    );
    const started: number[] = [];
    let running = 0;
    let most = 0;
    const done = eachBounded([0, 1, 2, 3, 4, 5, 6], 3, async (i) => {
      started.push(i);
      running++;
      most = Math.max(most, running);
      await gates[i];
      running--;
    });
    await tick();
    expect(started).toEqual([0, 1, 2]);
    for (let i = 0; i < 7; i++) {
      opens[i]?.();
      await tick();
    }
    await done;
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(most).toBe(3);
  });

  it("a limit above the item count starts each item once; nothing runs for an empty list", async () => {
    const seen: number[] = [];
    await eachBounded([1, 2], 8, async (i) => {
      seen.push(i);
    });
    expect(seen).toEqual([1, 2]);
    await eachBounded([], 3, async () => {
      throw new Error("never");
    });
  });

  it("a failure starts nothing new, waits for the items already running, then rethrows the first error", async () => {
    const started: number[] = [];
    let slowDone = false;
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = eachBounded([0, 1, 2, 3, 4], 2, async (i) => {
      started.push(i);
      if (i === 0) {
        await slow;
        slowDone = true;
        return;
      }
      throw new Error(`item ${i}`);
    });
    let settled = false;
    done.catch(() => {
      settled = true;
    });
    await tick();
    expect(settled, "still waiting for the item in flight").toBe(false);
    release();
    await expect(done).rejects.toThrow("item 1");
    expect(slowDone).toBe(true);
    expect(started).toEqual([0, 1]);
  });
});
