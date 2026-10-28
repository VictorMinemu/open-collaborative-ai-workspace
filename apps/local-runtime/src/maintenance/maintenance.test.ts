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
  ORG_LEVEL_GRACE_MS,
  REFUSED_OUTSIDE_SCRATCH_HOME,
  RuntimeMaintenance,
  type RuntimeMaintenanceOptions,
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
