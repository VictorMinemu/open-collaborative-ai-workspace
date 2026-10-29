// Phase 07.11 (D-02, D-04, D-10, PD-07, PD-08, PD-19): the RuntimeMaintenance orchestrator with fakes for the install
// resolution, the version probe, the registry and the runner. No process is spawned and no network is used here; the
// daemon tests run the same orchestrator against the fake CLI in a scratch home.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNTIME_COMPATIBILITY_MANIFEST,
  type RuntimeCompatibilityManifest,
  type RuntimeMaintenanceFrame,
  type RuntimeUpdateRunFrame,
  type RuntimeUpdatesLevel,
} from "@ocw/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeGate } from "./gate.js";
import type { InstallResolution } from "./install-method.js";
import {
  CHECK_EVERY_MS,
  DRAIN_AFTER_MS,
  ORG_LEVEL_GRACE_MS,
  PENDING_POLL_MS,
  REFUSED_OUTSIDE_SCRATCH_HOME,
  RuntimeMaintenance,
  type RuntimeMaintenanceOptions,
  STALE_AFTER_MS,
  UNCHANGED_BACKOFF_MS,
} from "./maintenance.js";
import type { RunResult, RunUpdateOptions } from "./runner.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A native Claude Code install as the resolver reports it (paths are never read in these tests). */
function nativeResolution(over: Partial<InstallResolution> = {}): InstallResolution {
  return {
    runtime: "claude-code",
    method: "native",
    binPath: "/scratch/home/.local/bin/claude",
    realPath: "/scratch/home/.local/share/claude/versions/2.1.290",
    installRoot: "/scratch/home/.local/share/claude",
    location: "~/.local/bin",
    canUpdate: true,
    reason: null,
    display: "claude update",
    note: null,
    channel: "latest",
    ...over,
  };
}

/** The bundled manifest plus a broken range for 2.1.300 (newer, so it wins). */
const BROKEN_2_1_300: RuntimeCompatibilityManifest = {
  ...RUNTIME_COMPATIBILITY_MANIFEST,
  updatedAt: "2026-11-01T00:00:00.000Z",
  runtimes: {
    ...RUNTIME_COMPATIBILITY_MANIFEST.runtimes,
    "claude-code": {
      ...RUNTIME_COMPATIBILITY_MANIFEST.runtimes["claude-code"],
      ranges: [
        { bounds: { min: "2.1.300", maxExclusive: "2.1.301" }, status: "broken" },
        ...RUNTIME_COMPATIBILITY_MANIFEST.runtimes["claude-code"].ranges,
      ],
    },
  },
};

interface Harness {
  m: RuntimeMaintenance;
  gate: RuntimeGate;
  adapter: {
    id: "claude-code";
    turns: number;
    retired: number;
    refreshed: number;
    interrupts: number;
    activeTurns(): number;
    retireIdle(): Promise<number>;
    refreshInstall(): void;
  };
  registryCalls: string[];
  freshCalls: string[];
  runs: RunUpdateOptions[];
  snapshots: RuntimeMaintenanceFrame[];
  runFrames: RuntimeUpdateRunFrame[];
  notified: Array<[string, string, string | undefined]>;
  afterRuns: string[];
  state: { installed: string | null; latest: string | null; clock: number };
  setRunResult(fn: (opts: RunUpdateOptions) => RunResult | Promise<RunResult>): void;
  advance(ms: number): Promise<void>;
}

/** Lets every pending promise chain run (the orchestrator starts runs without awaiting them). */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r));
}

function harness(over: Partial<RuntimeMaintenanceOptions> & { local?: RuntimeUpdatesLevel } = {}): Harness {
  const state = { installed: "2.1.290" as string | null, latest: "2.1.300" as string | null, clock: 0 };
  state.clock = Date.parse("2026-10-28T12:00:00.000Z");
  const timers: Array<{ fn: () => void; at: number } | null> = [];
  const adapter: Harness["adapter"] = {
    id: "claude-code",
    turns: 0,
    retired: 0,
    refreshed: 0,
    interrupts: 0,
    activeTurns() {
      return this.turns;
    },
    async retireIdle() {
      this.retired++;
      return 0;
    },
    refreshInstall() {
      this.refreshed++;
    },
  };
  const gate = new RuntimeGate();
  const h = {
    gate,
    adapter,
    registryCalls: [] as string[],
    freshCalls: [] as string[],
    runs: [] as RunUpdateOptions[],
    snapshots: [] as RuntimeMaintenanceFrame[],
    runFrames: [] as RuntimeUpdateRunFrame[],
    notified: [] as Array<[string, string, string | undefined]>,
    afterRuns: [] as string[],
    state,
  } as Harness;
  let runResult = (opts: RunUpdateOptions): RunResult | Promise<RunResult> => {
    const from = state.installed;
    state.installed = opts.candidate;
    return {
      outcome: "succeeded",
      fromVersion: from,
      toVersion: opts.candidate,
      output: "Successfully updated",
    };
  };
  h.setRunResult = (fn) => {
    runResult = fn;
  };
  h.advance = async (ms: number) => {
    const until = state.clock + ms;
    for (;;) {
      await flush();
      let next: number | null = null;
      for (let i = 0; i < timers.length; i++) {
        const t = timers[i];
        if (t && t.at <= until && (next === null || t.at < (timers[next]?.at ?? Infinity))) next = i;
      }
      if (next === null) break;
      const t = timers[next];
      timers[next] = null;
      if (!t) break;
      state.clock = Math.max(state.clock, t.at);
      t.fn();
    }
    state.clock = until;
    await flush();
  };
  const { local, ...rest } = over;
  h.m = new RuntimeMaintenance({
    runtimes: [adapter],
    gates: new Map([["claude-code", gate]]),
    userHome: "/scratch/home",
    env: {},
    resolve: () => nativeResolution(),
    probe: async () => state.installed,
    registry: {
      latest: async (rt, tag) => {
        h.registryCalls.push(`${rt}@${tag}`);
        return state.latest;
      },
    },
    freshRegistry: {
      latest: async (rt, tag) => {
        h.freshCalls.push(`${rt}@${tag}`);
        return state.latest;
      },
    },
    run: async (opts) => {
      h.runs.push(opts);
      return runResult(opts);
    },
    now: () => state.clock,
    random: () => 0.5,
    setTimer: (fn, ms) => {
      timers.push({ fn, at: state.clock + ms });
      return timers.length - 1;
    },
    clearTimer: (handle) => {
      timers[handle as number] = null;
    },
    sendSnapshot: (f) => h.snapshots.push(f),
    sendRun: (f) => h.runFrames.push(f),
    notifySession: (rt, phase, version) => h.notified.push([rt, phase, version]),
    afterRun: (rt) => {
      h.afterRuns.push(rt);
    },
    localLevel: local ?? "automatic",
    localLevelSource: "config",
    ...rest,
  });
  return h;
}

const lastSnapshot = (h: Harness) => {
  const s = h.snapshots.at(-1);
  if (!s) throw new Error("no snapshot sent");
  return s;
};
const claudeStatus = (h: Harness) => {
  const s = lastSnapshot(h).runtimes.find((r) => r.runtime === "claude-code");
  if (!s) throw new Error("no Claude status");
  return s;
};

describe("RuntimeMaintenance: levels (D-02, D-10, PD-08)", () => {
  it("without a runtime.config the device checks and reports behind, but never installs (D-10)", async () => {
    const h = harness();
    h.m.start({ paired: false });
    await flush();
    expect(h.registryCalls).toEqual(["claude-code@latest"]);
    expect(h.runs).toEqual([]);
    expect(lastSnapshot(h)).toMatchObject({
      orgLevelReceived: false,
      effectiveLevel: "notify",
      localLevel: "automatic",
    });
    expect(claudeStatus(h)).toMatchObject({
      installedVersion: "2.1.290",
      latestVersion: "2.1.300",
      advisory: "behind",
      state: "idle",
      method: "native",
      location: "~/.local/bin",
      updateCommand: "claude update",
    });
  });

  it.each<[RuntimeUpdatesLevel, RuntimeUpdatesLevel, boolean, boolean]>([
    ["automatic", "automatic", true, true],
    ["automatic", "notify", true, false],
    ["notify", "automatic", true, false],
    ["off", "automatic", false, false],
    ["automatic", "off", false, false],
    ["notify", "off", false, false],
  ])("org %s ∩ device %s: registry asked %s, installed %s", async (org, local, asks, installs) => {
    const h = harness({ local });
    h.m.setOrgPolicy(org, RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    expect(h.registryCalls.length > 0).toBe(asks);
    expect(h.runs.length > 0).toBe(installs);
  });

  it("off: no registry request at all; the snapshot still says what is installed and how", async () => {
    const h = harness();
    h.m.setOrgPolicy("off", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    await h.m.check();
    await h.advance(CHECK_EVERY_MS * 2);
    expect(h.registryCalls).toEqual([]);
    expect(claudeStatus(h)).toMatchObject({
      installedVersion: "2.1.290",
      method: "native",
      latestVersion: null,
      advisory: "unknown",
      checkedAt: null,
    });
    expect(lastSnapshot(h).effectiveLevel).toBe("off");
  });

  it("a paired daemon waits for runtime.config before its first registry request (then the grace period ends it)", async () => {
    const h = harness();
    h.m.start({ paired: true });
    await flush();
    expect(h.registryCalls).toEqual([]);
    expect(claudeStatus(h)).toMatchObject({ installedVersion: "2.1.290", latestVersion: null });
    await h.advance(ORG_LEVEL_GRACE_MS);
    expect(h.registryCalls).toEqual(["claude-code@latest"]);
    expect(h.runs).toEqual([]); // still notify: no org level
  });

  it("checks again every 6 h (jitter centred)", async () => {
    const h = harness({ local: "notify" });
    h.m.start({ paired: false });
    await flush();
    expect(h.registryCalls).toHaveLength(1);
    await h.advance(CHECK_EVERY_MS - 1);
    expect(h.registryCalls).toHaveLength(1);
    await h.advance(1);
    expect(h.registryCalls).toHaveLength(2);
    h.m.stop();
    await h.advance(CHECK_EVERY_MS * 2);
    expect(h.registryCalls).toHaveLength(2);
  });
});

describe("RuntimeMaintenance: automatic updates on an idle runtime (D-03, D-07)", () => {
  it("behind + automatic: gate closed, idle processes retired, update run, install re-read, gate opened, reported", async () => {
    const h = harness();
    h.m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    expect(h.runs).toHaveLength(1);
    expect(h.runs[0]).toMatchObject({ candidate: "2.1.300", home: "/scratch/home" });
    expect(h.runs[0]?.lockDir).toBe(join("/scratch/home", ".cache", "ocw", "runtime-updates"));
    expect(h.adapter.retired).toBe(1);
    expect(h.adapter.refreshed).toBe(1);
    expect(h.adapter.interrupts).toBe(0);
    expect(h.gate.isOpen).toBe(true);
    expect(h.runFrames.map((f) => [f.phase, f.outcome])).toEqual([
      ["started", undefined],
      ["finished", "succeeded"],
    ]);
    const [started, finished] = h.runFrames;
    expect(started).toMatchObject({
      trigger: "automatic",
      fromVersion: "2.1.290",
      toVersion: null,
      candidate: "2.1.300",
      method: "native",
    });
    expect(finished).toMatchObject({ runId: started?.runId, fromVersion: "2.1.290", toVersion: "2.1.300" });
    expect(claudeStatus(h)).toMatchObject({
      installedVersion: "2.1.300",
      advisory: "current",
      state: "idle",
      lastRun: { outcome: "succeeded", fromVersion: "2.1.290", toVersion: "2.1.300" },
    });
    expect(h.afterRuns).toEqual(["claude-code"]);
    expect(h.notified).toEqual([["claude-code", "done", "2.1.300"]]);
  });

  it("a broken candidate is never installed: one skipped_broken run frame per candidate (D-04)", async () => {
    const h = harness();
    h.m.setOrgPolicy("automatic", BROKEN_2_1_300);
    h.m.start({ paired: true });
    await flush();
    await h.m.check();
    await h.m.check();
    expect(h.runs).toEqual([]);
    expect(h.runFrames).toHaveLength(1);
    expect(h.runFrames[0]).toMatchObject({
      phase: "finished",
      outcome: "skipped_broken",
      candidate: "2.1.300",
      fromVersion: "2.1.290",
      trigger: "automatic",
    });
    expect(claudeStatus(h)).toMatchObject({ candidateCompatibility: "broken", advisory: "behind" });
    // A newer, fixed candidate is installed.
    h.state.latest = "2.1.301";
    await h.m.check();
    await flush();
    expect(h.runs.map((r) => r.candidate)).toEqual(["2.1.301"]);
  });

  it("a pending update whose candidate a newer manifest marks broken is dropped and reported skipped_broken (07.11 review HI-02)", async () => {
    const h = harness();
    h.adapter.turns = 1;
    h.m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    expect(claudeStatus(h)).toMatchObject({ state: "pending" });
    h.m.setOrgPolicy("automatic", BROKEN_2_1_300);
    await flush();
    expect(claudeStatus(h)).toMatchObject({ state: "idle", pendingSince: null });
    expect(h.runFrames).toEqual([
      expect.objectContaining({ phase: "finished", outcome: "skipped_broken", candidate: "2.1.300" }),
    ]);
    h.adapter.turns = 0;
    h.m.onRuntimeActivity("claude-code");
    await h.advance(PENDING_POLL_MS);
    expect(h.runs).toEqual([]);
  });

  it("a draining update whose candidate turns broken reopens the gate, releases the held sessions and never runs (07.11 review HI-02)", async () => {
    const h = harness({ pollMs: 10 * 60 * 1000, drainPollMs: 5 });
    h.adapter.turns = 1;
    h.m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    await h.advance(DRAIN_AFTER_MS);
    expect(claudeStatus(h).state).toBe("draining");
    expect(h.gate.isOpen).toBe(false);
    h.m.setOrgPolicy("automatic", BROKEN_2_1_300);
    expect(h.gate.isOpen).toBe(true); // at once, not after the next check's registry request
    h.adapter.turns = 0;
    await new Promise((r) => setTimeout(r, 30));
    await flush();
    expect(h.runs).toEqual([]);
    expect(h.runFrames.map((f) => f.outcome)).toEqual(["skipped_broken"]);
  });

  it("a self-updating installer is not run when the latest moved to a broken release since the check (07.11 review HI-02)", async () => {
    const h = harness();
    h.state.latest = "2.1.299";
    h.adapter.turns = 1;
    h.m.setOrgPolicy("automatic", BROKEN_2_1_300);
    h.m.start({ paired: true });
    await flush();
    expect(claudeStatus(h)).toMatchObject({ state: "pending" });
    // `claude update` installs whatever is latest when it runs, not the checked candidate.
    h.state.latest = "2.1.300";
    h.adapter.turns = 0;
    h.m.onRuntimeActivity("claude-code");
    await flush();
    expect(h.runs).toEqual([]);
    expect(h.gate.isOpen).toBe(true);
    expect(h.runFrames.at(-1)).toMatchObject({
      phase: "finished",
      outcome: "skipped_broken",
      candidate: "2.1.300",
    });
    expect(claudeStatus(h)).toMatchObject({ state: "idle", installedVersion: "2.1.290" });
  });

  it("an update that ends on a version marked broken is failed, never succeeded (07.11 review HI-02)", async () => {
    const h = harness();
    h.state.latest = "2.1.299";
    h.setRunResult(() => {
      h.state.installed = "2.1.300";
      return { outcome: "succeeded", fromVersion: "2.1.290", toVersion: "2.1.300", output: "Updated" };
    });
    h.m.setOrgPolicy("automatic", BROKEN_2_1_300);
    h.m.start({ paired: true });
    await flush();
    expect(h.runs).toHaveLength(1);
    const finished = h.runFrames.find((f) => f.phase === "finished");
    expect(finished).toMatchObject({ outcome: "failed", toVersion: "2.1.300" });
    expect(finished?.output).toContain("installed a version marked broken");
    expect(h.notified).toEqual([["claude-code", "failed", "2.1.300"]]);
    expect(claudeStatus(h)).toMatchObject({
      installedVersion: "2.1.300",
      installedCompatibility: "broken",
      lastRun: { outcome: "failed" },
    });
  });

  it("after an unchanged run the same candidate is not retried automatically for 24 h", async () => {
    const h = harness();
    h.setRunResult(() => ({
      outcome: "unchanged",
      fromVersion: "2.1.290",
      toVersion: "2.1.290",
      output: "",
    }));
    h.m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    expect(h.runs).toHaveLength(1);
    expect(claudeStatus(h).lastRun?.outcome).toBe("unchanged");
    await h.m.check();
    await flush();
    expect(h.runs).toHaveLength(1);
    await h.advance(UNCHANGED_BACKOFF_MS);
    await h.m.check();
    await flush();
    expect(h.runs).toHaveLength(2);
  });

  it("an install that cannot be updated here (manual) is reported, never run", async () => {
    const h = harness({
      resolve: () =>
        nativeResolution({ method: "system_package", canUpdate: false, reason: "manual", display: null }),
    });
    h.m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    expect(h.runs).toEqual([]);
    expect(claudeStatus(h)).toMatchObject({ advisory: "behind", canUpdate: false, reason: "manual" });
  });

  it("PD-19: in scratch mode an install outside the scratch home is refused (failed), never run", async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "ocw-maint-")));
    dirs.push(scratch);
    const h = harness({
      userHome: scratch,
      requireScratchHome: true,
      resolve: () =>
        nativeResolution({
          binPath: "/usr/local/bin/claude",
          realPath: "/usr/local/lib/claude/versions/2.1.290",
          installRoot: "/usr/local/lib/claude",
        }),
    });
    h.m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    expect(h.runs).toEqual([]);
    expect(h.adapter.retired).toBe(0);
    const finished = h.runFrames.find((f) => f.phase === "finished");
    expect(finished).toMatchObject({ outcome: "failed" });
    expect(finished?.output).toContain(REFUSED_OUTSIDE_SCRATCH_HOME);
    expect(h.gate.isOpen).toBe(true);
  });
});

describe("RuntimeMaintenance: never cut a turn (D-03, D-03a, D-03b, PD-07)", () => {
  const realWait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("a busy runtime: the update waits with the gate open and runs at the first idle moment (activity)", async () => {
    const h = harness();
    h.adapter.turns = 1;
    h.m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    expect(h.runs).toEqual([]);
    expect(h.gate.isOpen).toBe(true);
    expect(claudeStatus(h)).toMatchObject({ state: "pending", pendingSince: "2026-10-28T12:00:00.000Z" });
    h.m.onRuntimeActivity("claude-code"); // still busy: nothing
    await flush();
    expect(h.runs).toEqual([]);
    h.adapter.turns = 0;
    h.m.onRuntimeActivity("claude-code");
    expect(h.gate.isOpen).toBe(false); // closed in the same tick as the idle check
    await flush();
    expect(h.runs).toHaveLength(1);
    expect(h.gate.isOpen).toBe(true);
    expect(h.adapter.interrupts).toBe(0);
  });

  it("without any activity the 5 s poll finds the idle moment", async () => {
    const h = harness();
    h.adapter.turns = 1;
    h.m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    h.adapter.turns = 0;
    await h.advance(PENDING_POLL_MS - 1);
    expect(h.runs).toEqual([]);
    await h.advance(1);
    expect(h.runs).toHaveLength(1);
  });

  it("after DRAIN_AFTER_MS it drains: gate closed, the in-flight turn finishes, then the update runs; nothing interrupted", async () => {
    const h = harness({ pollMs: 10 * 60 * 1000, drainPollMs: 5 });
    h.adapter.turns = 1;
    h.m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    await h.advance(DRAIN_AFTER_MS - 1);
    expect(claudeStatus(h).state).toBe("pending");
    expect(h.gate.isOpen).toBe(true);
    await h.advance(1);
    expect(claudeStatus(h).state).toBe("draining");
    expect(h.gate.isOpen).toBe(false);
    await realWait(30);
    expect(h.runs).toEqual([]);
    h.adapter.turns = 0;
    await realWait(30);
    await flush();
    expect(h.runs).toHaveLength(1);
    expect(h.gate.isOpen).toBe(true);
    expect(h.adapter.interrupts).toBe(0);
    expect(claudeStatus(h)).toMatchObject({ state: "idle", stale: false, pendingSince: null });
  });

  it("still busy after STALE_AFTER_MS: reported stale with pendingSince (snapshot re-sent)", async () => {
    const h = harness({ pollMs: 60 * 60 * 1000, drainPollMs: 5 });
    h.adapter.turns = 1;
    h.m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    await h.advance(STALE_AFTER_MS - 1);
    expect(claudeStatus(h).stale).toBe(false);
    const before = h.snapshots.length;
    await h.advance(1);
    expect(h.snapshots.length).toBeGreaterThan(before);
    expect(claudeStatus(h)).toMatchObject({
      stale: true,
      state: "draining",
      pendingSince: "2026-10-28T12:00:00.000Z",
    });
    h.adapter.turns = 0;
    await realWait(30);
    await flush();
    expect(h.runs).toHaveLength(1);
    expect(claudeStatus(h).stale).toBe(false);
  });

  it("a pending update whose candidate the install already reached is dropped, never run (07.11 review HI-01)", async () => {
    const h = harness();
    h.adapter.turns = 1;
    h.m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    expect(claudeStatus(h)).toMatchObject({ state: "pending" });
    // The owner updated by hand past the candidate while the session was busy.
    h.state.installed = "2.1.305";
    h.state.latest = "2.1.305";
    await h.m.check();
    await flush();
    expect(claudeStatus(h)).toMatchObject({ state: "idle", pendingSince: null, advisory: "current" });
    h.adapter.turns = 0;
    h.m.onRuntimeActivity("claude-code");
    await h.advance(PENDING_POLL_MS);
    expect(h.runs).toEqual([]);
  });

  it("a pending update follows a newer latest and keeps its pendingSince (07.11 review HI-01)", async () => {
    const h = harness();
    h.adapter.turns = 1;
    h.m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    const since = claudeStatus(h).pendingSince;
    h.state.latest = "2.1.310";
    await h.advance(60_000);
    await h.m.check();
    await flush();
    expect(claudeStatus(h)).toMatchObject({
      state: "pending",
      pendingSince: since,
      latestVersion: "2.1.310",
    });
    h.adapter.turns = 0;
    h.m.onRuntimeActivity("claude-code");
    await flush();
    expect(h.runs.map((r) => r.candidate)).toEqual(["2.1.310"]);
  });

  it("a failed run reopens the gate, tells the held sessions it failed and reports lastRun failed", async () => {
    const h = harness();
    h.setRunResult(() => ({
      outcome: "failed",
      fromVersion: "2.1.290",
      toVersion: null,
      output: "Error: fake update failed with code 1 (<path>)",
      error: "the update command exited with code 1",
    }));
    h.m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    expect(h.gate.isOpen).toBe(true);
    expect(h.notified).toEqual([["claude-code", "failed", "2.1.290"]]);
    expect(claudeStatus(h)).toMatchObject({ lastRun: { outcome: "failed" }, installedVersion: "2.1.290" });
    const finished = h.runFrames.find((f) => f.phase === "finished");
    expect(finished?.output).toContain("the update command exited with code 1");
    // Not retried at once (no hot loop on a failing installer).
    await h.m.check();
    await flush();
    expect(h.runs).toHaveLength(1);
  });

  it("a lowered level drops a pending automatic update before it drains", async () => {
    const h = harness();
    h.adapter.turns = 1;
    h.m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    expect(claudeStatus(h).state).toBe("pending");
    h.m.setLocalLevel("notify", "env");
    await flush();
    expect(claudeStatus(h)).toMatchObject({ state: "idle", pendingSince: null });
    expect(lastSnapshot(h)).toMatchObject({
      localLevel: "notify",
      localLevelSource: "env",
      effectiveLevel: "notify",
    });
    h.adapter.turns = 0;
    h.m.onRuntimeActivity("claude-code");
    await flush();
    expect(h.runs).toEqual([]);
  });

  it("a lowered level also drops an automatic update that is draining: the gate reopens, held sessions are released, nothing runs", async () => {
    const h = harness({ pollMs: 10 * 60 * 1000, drainPollMs: 5 });
    h.adapter.turns = 1;
    h.m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    await h.advance(DRAIN_AFTER_MS);
    expect(claudeStatus(h).state).toBe("draining");
    expect(h.gate.isOpen).toBe(false);
    h.m.setLocalLevel("notify", "config");
    await flush();
    expect(h.gate.isOpen).toBe(true);
    expect(claudeStatus(h)).toMatchObject({ state: "idle", pendingSince: null, stale: false });
    expect(h.notified).toEqual([["claude-code", "done", "2.1.290"]]);
    h.adapter.turns = 0;
    await realWait(30);
    await flush();
    expect(h.runs).toEqual([]);
    expect(h.adapter.interrupts).toBe(0);
  });
});

describe('RuntimeMaintenance: "Update now" (D-05, PD-08)', () => {
  const realWait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("accepted: a fresh registry check, then it drains at once (no opportunistic hour), trigger and command id on the run", async () => {
    const h = harness({ drainPollMs: 5 });
    h.m.setOrgPolicy("notify", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    h.adapter.turns = 1;
    const commandId = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";
    expect(await h.m.requestUpdate("claude-code", "manual", commandId)).toEqual({ accepted: true });
    expect(h.freshCalls).toEqual(["claude-code@latest"]);
    await flush();
    expect(claudeStatus(h).state).toBe("draining");
    expect(h.gate.isOpen).toBe(false);
    h.adapter.turns = 0;
    await realWait(30);
    await flush();
    expect(h.runs).toHaveLength(1);
    expect(h.runFrames.map((f) => [f.phase, f.trigger, f.commandId])).toEqual([
      ["started", "manual", commandId],
      ["finished", "manual", commandId],
    ]);
  });

  it("a local request carries trigger local and no command id", async () => {
    const h = harness();
    h.m.start({ paired: false });
    await flush();
    expect(await h.m.requestUpdate("claude-code", "local")).toEqual({ accepted: true });
    await flush();
    expect(h.runFrames.map((f) => [f.phase, f.trigger, f.commandId])).toEqual([
      ["started", "local", undefined],
      ["finished", "local", undefined],
    ]);
  });

  it.each<[string, Partial<RuntimeMaintenanceOptions> & { local?: RuntimeUpdatesLevel }, string]>([
    ["the device's level is off", { local: "off" }, "updates are off on this device"],
    [
      "a manual install",
      { resolve: () => nativeResolution({ method: "system_package", canUpdate: false, reason: "manual" }) },
      "update it with the tool that installed it",
    ],
    [
      "an install that needs admin",
      {
        resolve: () =>
          nativeResolution({ canUpdate: false, reason: "needs_admin", display: "sudo npm i -g x" }),
      },
      "needs admin on this machine",
    ],
  ])("refused when %s", async (_name, over, reason) => {
    const h = harness(over);
    h.m.start({ paired: false });
    await flush();
    expect(await h.m.requestUpdate("claude-code", "manual")).toEqual({ accepted: false, reason });
    await flush();
    expect(h.runs).toEqual([]);
    expect(h.runFrames).toEqual([]);
  });

  it("refused when a fresh registry check says it is current (the cached answer is not trusted)", async () => {
    const h = harness();
    h.m.start({ paired: false });
    await flush();
    h.state.installed = "2.1.300"; // updated by hand since the last check
    expect(await h.m.requestUpdate("claude-code", "manual")).toEqual({
      accepted: false,
      reason: "already up to date",
    });
    expect(h.freshCalls).toHaveLength(1);
    expect(h.runs).toEqual([]);
  });

  it("refused while an update of the same runtime is pending or running", async () => {
    const h = harness({ drainPollMs: 5 });
    h.adapter.turns = 1;
    h.m.setOrgPolicy("automatic", RUNTIME_COMPATIBILITY_MANIFEST);
    h.m.start({ paired: true });
    await flush();
    expect(claudeStatus(h).state).toBe("pending");
    expect(await h.m.requestUpdate("claude-code", "manual")).toEqual({
      accepted: false,
      reason: "already updating",
    });
    h.adapter.turns = 0;
    await h.advance(PENDING_POLL_MS);
    expect(h.runs).toHaveLength(1);
  });

  it("an unknown runtime on this device is refused, nothing runs", async () => {
    const h = harness();
    h.m.start({ paired: false });
    await flush();
    expect(await h.m.requestUpdate("codex", "manual")).toEqual({
      accepted: false,
      reason: "this runtime is not available on this device",
    });
  });

  it("check({ fresh: true }) bypasses the registry cache", async () => {
    const h = harness();
    h.m.start({ paired: false });
    await flush();
    expect(h.freshCalls).toEqual([]);
    await h.m.check({ fresh: true });
    expect(h.freshCalls).toEqual(["claude-code@latest"]);
    expect(h.registryCalls).toHaveLength(1);
  });
});
