// Phase 07.17.1 (ADR-0040, D-03, D-04, D-05, D-06, D-09, D-11; hub PD-08, PD-09, PD-10, PD-12, PD-19, PD-25): the
// SelfUpdate job decides when the device updates its own runtime and how it waits. Every case runs the real
// `prepareVersion` and `switchToVersion` on a scratch OCW_HOME (`scratchOcwHome`) against a loopback stub of the
// workspace's runtime routes (`startDistStub`), with the fake npm, real `RuntimeGate`s, fake timers through the class's
// seams and an `exit` spy. The install lock lives in a directory inside the scratch home (`locks` injected), and after
// every case no lock file exists under the OS user's real home (PD-19, E30).

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import { join, relative } from "node:path";
import {
  RUNTIME_ROUTES,
  type RuntimeId,
  RuntimeSelfStatus,
  type RuntimeUpdateRunFrame,
  type RuntimeUpdatesLevel,
} from "@ocw/contracts";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { RUNTIME_VERSION } from "../version.js";
import { RuntimeGate } from "./gate.js";
import { CANCELLED_OFF, CANCELLED_STOPPED, CHECK_EVERY_MS, CHECK_JITTER_MS } from "./maintenance.js";
import { InstallLock } from "./runner.js";
import {
  type PrepareVersionOptions,
  prepareVersion,
  readSelfUpdateMarker,
  SELF_UPDATE_FAILURE_SENTENCES,
  SelfUpdateError,
  selfUpdateMarkerPath,
  switchToVersion,
} from "./self-update.js";
import {
  type DistStub,
  fakeNpm,
  HOST_PATH_TOKEN_RE,
  type ScratchHome,
  scratchOcwHome,
  startDistStub,
  testBundle,
} from "./self-update-harness.js";
import { SELF_UPDATE_REFUSALS, SelfUpdate, type SelfUpdateOptions } from "./self-update-job.js";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const COMMAND_ID = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";
const RUNTIMES: readonly RuntimeId[] = ["claude-code", "codex"];

/** Lets every pending promise chain run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r));
}

interface FakeClock {
  now(): number;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(handle: unknown): void;
  /** Fires every timer due within `ms`, in order, moving the clock; then lets promise chains run. */
  advance(ms: number): Promise<void>;
}

function fakeClock(start = Date.parse("2026-11-11T12:00:00.000Z")): FakeClock {
  let clock = start;
  const timers: Array<{ fn: () => void; at: number } | null> = [];
  return {
    now: () => clock,
    setTimer(fn, ms) {
      timers.push({ fn, at: clock + ms });
      return timers.length - 1;
    },
    clearTimer(handle) {
      timers[handle as number] = null;
    },
    async advance(ms) {
      const until = clock + ms;
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
        clock = Math.max(clock, t.at);
        t.fn();
      }
      clock = until;
      await flush();
    },
  };
}

interface Rig {
  home: ScratchHome;
  stub: DistStub;
  npmPath: string;
  env: NodeJS.ProcessEnv;
  lockDir: string;
  gates: Map<RuntimeId, RuntimeGate>;
  turns: Record<RuntimeId, number>;
  cli: { busy: boolean };
  level: { value: RuntimeUpdatesLevel };
  frames: RuntimeUpdateRunFrame[];
  /** `status()` at each `publish()`, parsed strictly. */
  published: RuntimeSelfStatus[];
  exit: Mock<(code: number) => Promise<void>>;
  clock: FakeClock;
  /** Gate `close()` calls per runtime (the opportunistic and the drain path both end in `close`). */
  closes: Record<RuntimeId, number>;
  su: SelfUpdate;
}

const rigs: Rig[] = [];

/** The lock file this rig's job takes, if it were in the OS user's real lock directory (PD-19). */
function realHomeLockFile(r: Rig): string {
  const name = `${sha256(join(r.home.ocwHome, "runtime"))}.lock`;
  return join(userInfo().homedir, ".cache", "ocw", "runtime-updates", name);
}

function insideDir(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/** Every SelfUpdate here is built through this helper: `lockDir` and `locks` inside the scratch home (PD-19). */
function selfUpdateOptions(r: Rig, over: Partial<SelfUpdateOptions> = {}): SelfUpdateOptions {
  return {
    ocwHome: r.home.ocwHome,
    serverUrl: r.stub.url,
    env: r.env,
    running: { version: "0.3.1", sha256: r.home.oldSha256 },
    supervision: { supervised: true, reason: null },
    gates: r.gates,
    activeTurns: (id) => r.turns[id],
    cliBusy: () => r.cli.busy,
    level: () => r.level.value,
    sendRun: (f) => r.frames.push(f),
    publish: () => {
      r.published.push(RuntimeSelfStatus.parse(r.su.status()));
    },
    exit: r.exit,
    requireScratchHome: true,
    lockDir: r.lockDir,
    locks: new InstallLock(r.lockDir),
    execPath: process.execPath,
    nodeVersion: process.versions.node,
    pollMs: 1_000,
    now: r.clock.now,
    random: () => 0.5,
    setTimer: r.clock.setTimer,
    clearTimer: r.clock.clearTimer,
    prepare: (p: PrepareVersionOptions) => prepareVersion({ ...p, npmPath: r.npmPath }),
    ...over,
  };
}

async function makeRig(
  over: Partial<SelfUpdateOptions> = {},
  setup: { level?: RuntimeUpdatesLevel; served?: string } = {},
): Promise<Rig> {
  const stub = await startDistStub({ version: setup.served ?? "0.3.2" });
  const home = await scratchOcwHome();
  const scratchRoot = join(home.ocwHome, "..");
  const npmPath = await fakeNpm(join(scratchRoot, "fake-bin"));
  const lockDir = join(scratchRoot, "locks");
  mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const base: Omit<Rig, "su"> = {
    home,
    stub,
    npmPath,
    env: { PATH: ["/usr/bin", "/bin"].join(":"), HOME: scratchRoot },
    lockDir,
    gates: new Map(RUNTIMES.map((id) => [id, new RuntimeGate()])),
    turns: { "claude-code": 0, codex: 0 },
    cli: { busy: false },
    level: { value: setup.level ?? "notify" },
    frames: [],
    published: [],
    exit: vi.fn(async (_code: number) => undefined),
    clock: fakeClock(),
    closes: { "claude-code": 0, codex: 0 },
  };
  for (const id of RUNTIMES) {
    const gate = base.gates.get(id) as RuntimeGate;
    const close = gate.close.bind(gate);
    gate.close = () => {
      base.closes[id]++;
      close();
    };
  }
  const built = base as Rig;
  built.su = new SelfUpdate(selfUpdateOptions(built, over));
  rigs.push(built);
  return built;
}

beforeEach(() => {
  rigs.length = 0;
});

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.su.stop();
    // PD-19, E30: the job's lock is in the scratch home, never in the OS user's lock directory.
    expect(existsSync(realHomeLockFile(r))).toBe(false);
    const home = userInfo().homedir;
    const realHome = (() => {
      try {
        return realpathSync(home);
      } catch {
        return home;
      }
    })();
    const lockReal = realpathSync(r.lockDir);
    expect(insideDir(lockReal, home) || insideDir(lockReal, realHome)).toBe(false);
    await r.stub.close();
    r.home.cleanup();
  }
});

const runtimeDirOf = (r: Rig) => join(r.home.ocwHome, "runtime");
const lockFileOf = (r: Rig) => join(r.lockDir, `${sha256(runtimeDirOf(r))}.lock`);
const gatesOpen = (r: Rig) => RUNTIMES.every((id) => r.gates.get(id)?.isOpen);
const gatesClosed = (r: Rig) => RUNTIMES.every((id) => r.gates.get(id)?.isOpen === false);
const stagingLeft = (r: Rig) =>
  readdirSync(join(runtimeDirOf(r), "versions")).filter((n) => n.startsWith(".staging-"));
const newSha12 = (r: Rig) => r.stub.manifest.sha256.slice(0, 12);
const oldSha12 = (r: Rig) => r.home.oldSha12;

function expectNoHostPath(r: Rig): void {
  for (const f of r.frames) expect(JSON.stringify(f)).not.toMatch(HOST_PATH_TOKEN_RE);
  for (const s of r.published) expect(JSON.stringify(s)).not.toMatch(HOST_PATH_TOKEN_RE);
  expect(JSON.stringify(r.su.status())).not.toMatch(HOST_PATH_TOKEN_RE);
}

async function untilExit(r: Rig): Promise<void> {
  await vi.waitFor(() => expect(r.exit).toHaveBeenCalled(), { timeout: 10_000, interval: 20 });
}

async function untilIdleWith(r: Rig, n: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(r.frames.length).toBeGreaterThanOrEqual(n);
      expect(r.su.status().state).toBe("idle");
      expect(r.su.busy).toBe(false);
    },
    { timeout: 10_000, interval: 20 },
  );
}

describe("SelfUpdate: one click on an idle service device (07.17.1, D-03, D-05, PD-08)", () => {
  it("builds the served runtime, switches `current` to it and exits 75; the next daemon reports the run", async () => {
    const r = await makeRig();
    expect(await r.su.request("manual", COMMAND_ID)).toEqual({ accepted: true });
    await untilExit(r);

    expect(r.exit).toHaveBeenCalledTimes(1);
    expect(r.exit).toHaveBeenCalledWith(75);
    expect(r.frames).toHaveLength(1);
    expect(r.frames[0]).toMatchObject({
      type: "runtime.update.run",
      runtime: "ocw-runtime",
      phase: "started",
      trigger: "manual",
      commandId: COMMAND_ID,
      fromVersion: "0.3.1",
      toVersion: "0.3.2",
      fromBuild: oldSha12(r),
      toBuild: newSha12(r),
      method: "ocw_bundle",
    });
    // No `finished` frame from this daemon for a switched run: the next one reports it from the marker (07).
    expect(r.frames.some((f) => f.phase === "finished")).toBe(false);

    expect(r.published.map((s) => s.state)).toEqual(["downloading", "installing", "restarting"]);
    expect(r.su.status().state).toBe("restarting");
    expect(readlinkSync(join(runtimeDirOf(r), "current"))).toBe(`versions/${newSha12(r)}`);

    const marker = await readSelfUpdateMarker(r.home.ocwHome);
    expect(marker).toMatchObject({
      runId: r.frames[0]?.runId,
      commandId: COMMAND_ID,
      trigger: "manual",
      from: { version: "0.3.1", sha256: r.home.oldSha256 },
      to: { version: "0.3.2", sha256: r.stub.manifest.sha256 },
    });

    // Only the paired server's three fixed routes (PD-06); the gates stay closed into the exit.
    expect(r.stub.requests).toEqual([
      RUNTIME_ROUTES.version,
      RUNTIME_ROUTES.bundle,
      RUNTIME_ROUTES.externalLock,
    ]);
    expect(gatesClosed(r)).toBe(true);
    expect(r.su.holding).toBe(true);
    expectNoHostPath(r);
  });

  it("a click when the workspace serves the running build ends `unchanged`: no restart, the gates never close", async () => {
    const r = await makeRig();
    r.stub.serve("0.3.1", testBundle("0.3.1"));
    expect(r.stub.manifest.sha256).toBe(r.home.oldSha256);
    expect(await r.su.request("manual", COMMAND_ID)).toEqual({ accepted: true });
    await untilIdleWith(r, 2);

    expect(r.frames.map((f) => [f.phase, f.outcome, f.commandId])).toEqual([
      ["started", undefined, COMMAND_ID],
      ["finished", "unchanged", COMMAND_ID],
    ]);
    expect(r.frames[1]).toMatchObject({ fromBuild: oldSha12(r), toBuild: oldSha12(r), method: "ocw_bundle" });
    expect(r.exit).not.toHaveBeenCalled();
    expect(r.closes).toEqual({ "claude-code": 0, codex: 0 });
    expect(gatesOpen(r)).toBe(true);
    expect(r.stub.requests).toEqual([RUNTIME_ROUTES.version]);
    expect(r.su.status().lastRun).toMatchObject({ outcome: "unchanged", fromBuild: oldSha12(r) });
    expect(existsSync(lockFileOf(r))).toBe(false);
    expectNoHostPath(r);
  });

  it("a download that does not match the manifest fails before the switch: its sentence, lock released, gates open", async () => {
    const r = await makeRig();
    r.stub.set("extra_byte");
    expect(await r.su.request("manual", COMMAND_ID)).toEqual({ accepted: true });
    await untilIdleWith(r, 2);

    expect(r.frames.map((f) => [f.phase, f.outcome])).toEqual([
      ["started", undefined],
      ["finished", "failed"],
    ]);
    expect(r.frames[1]?.output).toBe("checksum mismatch");
    expect(r.frames[1]).toMatchObject({
      commandId: COMMAND_ID,
      fromBuild: oldSha12(r),
      toBuild: newSha12(r),
    });
    expect(r.exit).not.toHaveBeenCalled();
    expect(gatesOpen(r)).toBe(true);
    expect(existsSync(lockFileOf(r))).toBe(false);
    expect(readlinkSync(join(runtimeDirOf(r), "current"))).toBe(`versions/${oldSha12(r)}`);
    expect(stagingLeft(r)).toEqual([]);
    expect(r.su.status()).toMatchObject({ state: "idle", lastRun: { outcome: "failed" } });
    expectNoHostPath(r);
  });

  it("another daemon of the same OCW_HOME holding the install lock: finished failed with the busy sentence, nothing fetched past the manifest", async () => {
    const r = await makeRig();
    const other = await new InstallLock(r.lockDir).acquire(runtimeDirOf(r));
    expect(other).not.toBe("busy");
    expect(await r.su.request("manual", COMMAND_ID)).toEqual({ accepted: true });
    await untilIdleWith(r, 1);

    expect(r.frames).toEqual([
      expect.objectContaining({ phase: "finished", outcome: "failed", commandId: COMMAND_ID }),
    ]);
    expect(r.frames[0]?.output).toBe(SELF_UPDATE_REFUSALS.busy);
    expect(r.stub.requests).toEqual([RUNTIME_ROUTES.version]);
    expect(gatesOpen(r)).toBe(true);
    expect(r.exit).not.toHaveBeenCalled();
    if (other !== "busy") await other.release();
  });

  it("status() is strict and path-free before anything ran", async () => {
    const r = await makeRig();
    const s = RuntimeSelfStatus.parse(r.su.status());
    expect(s).toEqual({
      version: "0.3.1",
      build: oldSha12(r),
      supervised: true,
      canUpdate: true,
      reason: null,
      servedVersion: null,
      servedBuild: null,
      state: "idle",
      pendingSince: null,
      lastRun: null,
      checkedAt: null,
    });
  });
});

async function untilState(r: Rig, state: RuntimeSelfStatus["state"]): Promise<void> {
  await vi.waitFor(() => expect(r.su.status().state).toBe(state), { timeout: 10_000, interval: 20 });
}

describe("SelfUpdate: never cut a turn (07.17.1, D-04, PD-09, E12)", () => {
  it("a click while Codex runs a turn closes every gate at once, holds new turns, and switches once Codex is idle", async () => {
    const r = await makeRig();
    r.turns.codex = 1;
    expect(await r.su.request("manual", COMMAND_ID)).toEqual({ accepted: true });
    await untilState(r, "waiting");

    expect(gatesClosed(r)).toBe(true);
    expect(r.su.holding).toBe(true);
    expect(r.su.status().pendingSince).toBe("2026-11-11T12:00:00.000Z");
    expect(r.exit).not.toHaveBeenCalled();
    // A new Claude Code turn is held, not run.
    const ran: string[] = [];
    void r.gates.get("claude-code")?.admit(async () => {
      ran.push("claude-code");
    });
    expect(r.gates.get("claude-code")?.heldCount).toBe(1);
    await r.clock.advance(5_000);
    expect(r.exit).not.toHaveBeenCalled();
    expect(ran).toEqual([]);

    r.turns.codex = 0;
    await r.clock.advance(1_000);
    await untilExit(r);
    expect(r.exit).toHaveBeenCalledWith(75);
    expect(ran).toEqual([]);
    expect(readlinkSync(join(runtimeDirOf(r), "current"))).toBe(`versions/${newSha12(r)}`);
    expect(r.published.map((s) => s.state)).toEqual(["downloading", "installing", "waiting", "restarting"]);
  });

  it("automatic with a turn running keeps every gate open until drainAfterMs, then drains and switches when idle", async () => {
    const r = await makeRig({ drainAfterMs: 60_000 }, { level: "automatic" });
    r.turns["claude-code"] = 1;
    expect(await r.su.request("automatic")).toEqual({ accepted: true });
    await untilState(r, "waiting");
    expect(gatesOpen(r)).toBe(true);
    expect(r.su.holding).toBe(false);

    await r.clock.advance(59_000);
    expect(gatesOpen(r)).toBe(true);
    expect(r.exit).not.toHaveBeenCalled();
    await r.clock.advance(1_000);
    expect(gatesClosed(r)).toBe(true);
    expect(r.su.status().state).toBe("waiting");
    expect(r.exit).not.toHaveBeenCalled();

    r.turns["claude-code"] = 0;
    await r.clock.advance(1_000);
    await untilExit(r);
    expect(r.frames[0]).toMatchObject({ phase: "started", trigger: "automatic" });
    expect(r.frames[0]?.commandId).toBeUndefined();
  });

  it("automatic: a turn that ends before drainAfterMs lets the next idle moment close every gate and switch", async () => {
    const r = await makeRig({ drainAfterMs: 60_000 }, { level: "automatic" });
    r.turns.codex = 1;
    expect(await r.su.request("automatic")).toEqual({ accepted: true });
    await untilState(r, "waiting");
    await r.clock.advance(10_000);
    expect(gatesOpen(r)).toBe(true);
    r.turns.codex = 0;
    await r.clock.advance(1_000);
    await untilExit(r);
    expect(gatesClosed(r)).toBe(true);
  });

  it("automatic with nothing running closes every gate and switches at once", async () => {
    const r = await makeRig({ drainAfterMs: 60_000 }, { level: "automatic" });
    expect(await r.su.request("automatic")).toEqual({ accepted: true });
    await untilExit(r);
    expect(r.published.map((s) => s.state)).toEqual(["downloading", "installing", "restarting"]);
  });

  it("a command admitted but not yet at its adapter counts as running: no switch until it is through", async () => {
    const r = await makeRig();
    let done: () => void = () => undefined;
    const inFlight = r.gates.get("claude-code")?.admit(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    expect(r.gates.get("claude-code")?.admitted).toBe(1);
    expect(await r.su.request("manual", COMMAND_ID)).toEqual({ accepted: true });
    await untilState(r, "waiting");
    expect(gatesClosed(r)).toBe(true);
    await r.clock.advance(3_000);
    expect(r.exit).not.toHaveBeenCalled();
    done();
    await inFlight;
    await r.clock.advance(1_000);
    await untilExit(r);
  });
});

describe("SelfUpdate: exclusion with 07.11 and every gate reopened (07.17.1, PD-09, E13)", () => {
  it("a 07.11 CLI job active: no gate closes and the state is waiting; when it ends the decision runs", async () => {
    const r = await makeRig();
    r.cli.busy = true;
    expect(await r.su.request("manual", COMMAND_ID)).toEqual({ accepted: true });
    await untilState(r, "waiting");
    await r.clock.advance(5_000);
    expect(r.closes).toEqual({ "claude-code": 0, codex: 0 });
    expect(gatesOpen(r)).toBe(true);
    expect(r.su.holding).toBe(false);
    expect(r.exit).not.toHaveBeenCalled();

    r.cli.busy = false;
    await r.clock.advance(1_000);
    await untilExit(r);
    expect(gatesClosed(r)).toBe(true);
  });

  it("a switch that fails after the gates closed reopens every gate, releases the lock and reports the switch sentence", async () => {
    let closedAtSwitch = false;
    const r = await makeRig({
      switchTo: async () => {
        closedAtSwitch = gatesClosed(rigs[0] as Rig);
        throw new SelfUpdateError("switch_failed");
      },
    });
    expect(await r.su.request("manual", COMMAND_ID)).toEqual({ accepted: true });
    await untilIdleWith(r, 2);

    expect(closedAtSwitch).toBe(true);
    expect(gatesOpen(r)).toBe(true);
    expect(r.su.holding).toBe(false);
    expect(r.exit).not.toHaveBeenCalled();
    expect(r.frames.map((f) => [f.phase, f.outcome])).toEqual([
      ["started", undefined],
      ["finished", "failed"],
    ]);
    expect(r.frames[1]?.output).toBe(SELF_UPDATE_FAILURE_SENTENCES.switch_failed);
    await vi.waitFor(() => expect(existsSync(lockFileOf(r))).toBe(false), { timeout: 5_000, interval: 20 });
    expect(r.su.status()).toMatchObject({
      state: "idle",
      pendingSince: null,
      lastRun: { outcome: "failed" },
    });
    expectNoHostPath(r);
  });

  it("an unexpected error while switching is reported with the fixed switch sentence, never its message", async () => {
    const r = await makeRig({
      switchTo: async () => {
        throw new Error("EACCES: permission denied, rename '/Users/someone/.ocw/runtime/current.tmp-1'");
      },
    });
    expect(await r.su.request("manual", COMMAND_ID)).toEqual({ accepted: true });
    await untilIdleWith(r, 2);
    expect(r.frames[1]?.output).toBe(SELF_UPDATE_FAILURE_SENTENCES.switch_failed);
    expect(gatesOpen(r)).toBe(true);
    expectNoHostPath(r);
  });
});

describe("SelfUpdate: requests the device refuses (07.17.1, D-05, PD-11)", () => {
  it("a second request while a job runs answers the busy sentence", async () => {
    const r = await makeRig();
    r.turns.codex = 1;
    expect(await r.su.request("manual", COMMAND_ID)).toEqual({ accepted: true });
    expect(await r.su.request("manual", "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e60")).toEqual({
      accepted: false,
      reason: SELF_UPDATE_REFUSALS.busy,
    });
    expect(await r.su.request("automatic")).toEqual({ accepted: false, reason: SELF_UPDATE_REFUSALS.busy });
    expect(SELF_UPDATE_REFUSALS.busy).toBe("an update of the OCW runtime is already running");
  });

  it.each([
    ["not_supervised", { supervised: false, reason: "not_supervised" as const }],
    ["not_installed", { supervised: false, reason: "not_installed" as const }],
  ])(
    "a daemon whose supervision says %s refuses with its sentence; nothing is fetched",
    async (reason, supervision) => {
      const r = await makeRig({ supervision });
      expect(await r.su.request("manual", COMMAND_ID)).toEqual({
        accepted: false,
        reason: SELF_UPDATE_REFUSALS[reason as "not_supervised" | "not_installed"],
      });
      await flush();
      expect(r.stub.requests).toEqual([]);
      expect(r.frames).toEqual([]);
      expect(r.su.busy).toBe(false);
    },
  );

  it("no running build (a checkout, the desktop app): refused not_installed, nothing fetched", async () => {
    const r = await makeRig({ running: null, supervision: { supervised: false, reason: null } });
    expect(await r.su.request("manual", COMMAND_ID)).toEqual({
      accepted: false,
      reason: SELF_UPDATE_REFUSALS.not_installed,
    });
    await flush();
    expect(r.stub.requests).toEqual([]);
    // The daemon's own version (`0.0.0-dev` under tsx), no build.
    expect(r.su.status()).toMatchObject({ version: RUNTIME_VERSION, build: null, canUpdate: false });
  });

  it("the sentences are the contract's (RUNTIME_SELF_BLOCK_SENTENCES)", () => {
    expect(SELF_UPDATE_REFUSALS.not_supervised).toBe(
      "Run as a service to update from the browser; or re-run the install command",
    );
  });
});

describe("SelfUpdate: stop() before and after the switch (07.17.1, E29)", () => {
  it("stop() while waiting: gates open, lock released, no staging, finished failed cancelled, no exit", async () => {
    const r = await makeRig();
    r.turns.codex = 1;
    expect(await r.su.request("manual", COMMAND_ID)).toEqual({ accepted: true });
    await untilState(r, "waiting");
    expect(gatesClosed(r)).toBe(true);
    expect(existsSync(lockFileOf(r))).toBe(true);

    await r.su.stop();
    expect(gatesOpen(r)).toBe(true);
    expect(existsSync(lockFileOf(r))).toBe(false);
    expect(stagingLeft(r)).toEqual([]);
    expect(r.frames.map((f) => [f.phase, f.outcome, f.commandId])).toEqual([
      ["started", undefined, COMMAND_ID],
      ["finished", "failed", COMMAND_ID],
    ]);
    expect(r.frames[1]?.output).toBe(CANCELLED_STOPPED);
    expect(r.su.status().state).toBe("idle");

    r.turns.codex = 0;
    await r.clock.advance(5_000);
    await flush();
    expect(r.exit).not.toHaveBeenCalled();
    expect(r.frames).toHaveLength(2);
    expect(readlinkSync(join(runtimeDirOf(r), "current"))).toBe(`versions/${oldSha12(r)}`);
  });

  it("stop() after the switch (restarting, exit pending): no frame, every gate stays closed, the lock and the marker stay", async () => {
    // The daemon's stop runs while the exit hand-over is still pending (10).
    const exit = vi.fn((_code: number) => new Promise<void>(() => undefined));
    const r = await makeRig({ exit });
    expect(await r.su.request("manual", COMMAND_ID)).toEqual({ accepted: true });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(75), { timeout: 10_000, interval: 20 });
    expect(r.su.status().state).toBe("restarting");
    const markerBefore = readFileSync(selfUpdateMarkerPath(r.home.ocwHome), "utf8");
    const framesBefore = r.frames.length;

    await r.su.stop();
    await flush();
    expect(r.frames).toHaveLength(framesBefore);
    expect(r.frames.some((f) => f.phase === "finished")).toBe(false);
    expect(gatesClosed(r)).toBe(true);
    expect(r.su.holding).toBe(true);
    expect(existsSync(lockFileOf(r))).toBe(true);
    expect(readFileSync(selfUpdateMarkerPath(r.home.ocwHome), "utf8")).toBe(markerBefore);
    expect(r.su.status().state).toBe("restarting");
  });

  it("stop() while the switch itself runs: nothing is sent and no exit follows; the next start reports the run", async () => {
    let release: () => void = () => undefined;
    const r = await makeRig({
      switchTo: async (p) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await switchToVersion(p);
      },
    });
    expect(await r.su.request("manual", COMMAND_ID)).toEqual({ accepted: true });
    await untilState(r, "restarting");
    const stopped = r.su.stop();
    release();
    await stopped;
    await vi.waitFor(() =>
      expect(readlinkSync(join(runtimeDirOf(r), "current"))).toBe(`versions/${newSha12(r)}`),
    );
    await flush();
    expect(r.exit).not.toHaveBeenCalled();
    expect(r.frames.some((f) => f.phase === "finished")).toBe(false);
    expect(await readSelfUpdateMarker(r.home.ocwHome)).toMatchObject({ commandId: COMMAND_ID });
  });
});

describe("SelfUpdate: when the device checks its workspace and updates by itself (07.17.1, D-06, D-09, D-11, PD-10, E14)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const versionRequests = (r: Rig) => r.stub.requests.filter((p) => p === RUNTIME_ROUTES.version).length;
  /** The fake npm's control file for `npm ci` (in the staging directory's parent). */
  const npmControl = (r: Rig) => join(runtimeDirOf(r), "versions", "fake-update.json");

  it("off: start(), onConfig() and a day of timers make zero requests; a click still updates (D-09)", async () => {
    const r = await makeRig({}, { level: "off" });
    r.su.start();
    await r.su.onConfig();
    await r.clock.advance(DAY_MS);
    expect(r.stub.requests).toEqual([]);
    expect(r.frames).toEqual([]);
    expect(r.su.status()).toMatchObject({ servedVersion: null, servedBuild: null, checkedAt: null });

    expect(await r.su.request("manual", COMMAND_ID)).toEqual({ accepted: true });
    await untilExit(r);
    expect(r.exit).toHaveBeenCalledWith(75);
  });

  it("notify: onConfig() checks once and reports what the workspace serves; it never runs by itself", async () => {
    const r = await makeRig({}, { level: "notify" });
    r.su.start();
    await r.su.onConfig();
    expect(r.stub.requests).toEqual([RUNTIME_ROUTES.version]);
    expect(r.su.status()).toMatchObject({
      servedVersion: "0.3.2",
      servedBuild: newSha12(r),
      checkedAt: "2026-11-11T12:00:00.000Z",
      canUpdate: true,
      state: "idle",
    });
    expect(r.published.at(-1)).toMatchObject({ servedBuild: newSha12(r) });
    await flush();
    expect(r.frames).toEqual([]);
    expect(r.su.busy).toBe(false);
    expect(r.exit).not.toHaveBeenCalled();
  });

  it("notify: the timer checks again every checkEveryMs ± jitter", async () => {
    const r = await makeRig({ random: () => 1 }, { level: "notify" });
    r.su.start();
    expect(versionRequests(r)).toBe(0);
    await r.clock.advance(CHECK_EVERY_MS + CHECK_JITTER_MS - 1);
    expect(versionRequests(r)).toBe(0);
    await r.clock.advance(1);
    await vi.waitFor(() => expect(versionRequests(r)).toBe(1));
    await r.clock.advance(CHECK_EVERY_MS + CHECK_JITTER_MS);
    await vi.waitFor(() => expect(versionRequests(r)).toBe(2));
    expect(r.frames).toEqual([]);
  });

  it("automatic: a newer served build runs by itself (trigger automatic, no command id)", async () => {
    const r = await makeRig({}, { level: "automatic" });
    r.su.start();
    await r.su.onConfig();
    await untilExit(r);
    expect(r.frames[0]).toMatchObject({
      phase: "started",
      trigger: "automatic",
      fromVersion: "0.3.1",
      toVersion: "0.3.2",
    });
    expect(r.frames[0]?.commandId).toBeUndefined();
    // The check's manifest is the run's: one /version request.
    expect(versionRequests(r)).toBe(1);
    expect(readlinkSync(join(runtimeDirOf(r), "current"))).toBe(`versions/${newSha12(r)}`);
  });

  it("automatic: an OLDER served build (a server rollback) is followed too (D-11)", async () => {
    const r = await makeRig({}, { level: "automatic", served: "0.3.0" });
    await r.su.onConfig();
    await untilExit(r);
    expect(r.frames[0]).toMatchObject({ trigger: "automatic", fromVersion: "0.3.1", toVersion: "0.3.0" });
    expect(readlinkSync(join(runtimeDirOf(r), "current"))).toBe(`versions/${newSha12(r)}`);
  });

  it("automatic: the running build served → nothing runs, no lock is taken", async () => {
    const r = await makeRig({}, { level: "automatic" });
    r.stub.serve("0.3.1", testBundle("0.3.1"));
    await r.su.onConfig();
    await flush();
    expect(r.stub.requests).toEqual([RUNTIME_ROUTES.version]);
    expect(r.frames).toEqual([]);
    expect(r.su.status()).toMatchObject({ servedBuild: oldSha12(r), state: "idle" });
    expect(existsSync(lockFileOf(r))).toBe(false);
  });

  it("a failed automatic run of a build is not retried before failedBackoffMs; a check after it retries", async () => {
    const r = await makeRig({ failedBackoffMs: 2 * CHECK_EVERY_MS }, { level: "automatic" });
    writeFileSync(npmControl(r), JSON.stringify({ exitCode: 1 }));
    r.su.start();
    await r.su.onConfig();
    await untilIdleWith(r, 2);
    expect(r.frames.map((f) => [f.phase, f.outcome, f.trigger])).toEqual([
      ["started", undefined, "automatic"],
      ["finished", "failed", "automatic"],
    ]);
    expect(r.frames[1]?.output).toBe(SELF_UPDATE_FAILURE_SENTENCES.npm_failed);
    rmSync(npmControl(r));

    // The next scheduled check (6 h) is inside the backoff: it reports, it does not run.
    await r.clock.advance(CHECK_EVERY_MS);
    await vi.waitFor(() => expect(versionRequests(r)).toBe(2));
    await flush();
    expect(r.frames).toHaveLength(2);
    expect(r.su.busy).toBe(false);

    // The one after it (12 h) is past it: the run starts again.
    await r.clock.advance(CHECK_EVERY_MS);
    await untilExit(r);
    expect(r.frames.filter((f) => f.phase === "started")).toHaveLength(2);
  });

  it("a click within the backoff of a failed automatic run still runs", async () => {
    const r = await makeRig({}, { level: "automatic" });
    writeFileSync(npmControl(r), JSON.stringify({ exitCode: 1 }));
    await r.su.onConfig();
    await untilIdleWith(r, 2);
    rmSync(npmControl(r));
    expect(await r.su.request("manual", COMMAND_ID)).toEqual({ accepted: true });
    await untilExit(r);
    expect(r.frames.at(-1)).toMatchObject({ phase: "started", trigger: "manual", commandId: COMMAND_ID });
  });

  it.each<RuntimeUpdatesLevel>(["automatic", "notify", "off"])(
    "level %s: no running build or not_installed → zero requests; status says why it cannot update",
    async (level) => {
      for (const over of [
        { running: null, supervision: { supervised: false, reason: null } },
        { supervision: { supervised: false, reason: "not_installed" as const } },
      ] satisfies Partial<SelfUpdateOptions>[]) {
        const r = await makeRig(over, { level });
        r.su.start();
        await r.su.onConfig();
        await r.clock.advance(DAY_MS);
        expect(r.stub.requests).toEqual([]);
        expect(r.su.status()).toMatchObject({ canUpdate: false, reason: "not_installed" });
      }
    },
  );

  it("the level is read at each decision: automatic → off stops the checks at the next tick", async () => {
    const r = await makeRig({}, { level: "automatic" });
    r.stub.serve("0.3.1", testBundle("0.3.1"));
    r.su.start();
    await r.su.onConfig();
    expect(versionRequests(r)).toBe(1);
    r.level.value = "off";
    await r.clock.advance(DAY_MS);
    expect(versionRequests(r)).toBe(1);
    r.level.value = "notify";
    await r.clock.advance(CHECK_EVERY_MS + CHECK_JITTER_MS);
    await vi.waitFor(() => expect(versionRequests(r)).toBe(2));
  });

  it("an automatic update still waiting for an idle moment ends when the level leaves automatic: gates open, no exit", async () => {
    const r = await makeRig({ drainAfterMs: 60_000 }, { level: "automatic" });
    r.turns.codex = 1;
    await r.su.onConfig();
    await untilState(r, "waiting");
    r.level.value = "notify";
    await r.clock.advance(1_000);
    await untilIdleWith(r, 2);
    expect(r.frames[1]).toMatchObject({ phase: "finished", outcome: "failed", trigger: "automatic" });
    expect(r.frames[1]?.output).toBe(CANCELLED_OFF);
    expect(gatesOpen(r)).toBe(true);
    await r.clock.advance(120_000);
    expect(r.exit).not.toHaveBeenCalled();
  });
});

describe("SelfUpdate: the run the restart carried over (07.17.1, PD-12)", () => {
  it("adoptBoot() reports the boot's last run and remembers its command, so a redelivered click does not run twice", async () => {
    const r = await makeRig();
    const runId = "5b0f6a52-3c1e-4c55-9f0d-0f8f3f6c2a11";
    const lastRun = {
      runId,
      outcome: "succeeded" as const,
      at: "2026-11-11T11:59:00.000Z",
      fromVersion: "0.3.0",
      toVersion: "0.3.1",
      fromBuild: "aaaaaaaaaaaa",
      toBuild: oldSha12(r),
    };
    const marker = {
      runId,
      commandId: COMMAND_ID,
      trigger: "manual" as const,
      from: { version: "0.3.0", sha256: "a".repeat(64) },
      to: { version: "0.3.1", sha256: r.home.oldSha256 },
      startedAt: "2026-11-11T11:58:00.000Z",
    };
    expect(r.su.isKnownCommand(COMMAND_ID)).toBe(false);
    const base = {
      type: "runtime.update.run" as const,
      runId,
      runtime: "ocw-runtime" as const,
      trigger: "manual" as const,
      commandId: COMMAND_ID,
      fromVersion: "0.3.0",
      toVersion: "0.3.1",
      candidate: "0.3.1",
      method: "ocw_bundle" as const,
      fromBuild: lastRun.fromBuild,
      toBuild: lastRun.toBuild,
      at: lastRun.at,
    };
    r.su.adoptBoot({
      marker,
      outcome: "succeeded",
      frames: [
        { ...base, phase: "started" },
        { ...base, phase: "finished", outcome: "succeeded" },
      ],
      lastRun,
    });
    expect(r.su.isKnownCommand(COMMAND_ID)).toBe(true);
    expect(r.su.status().lastRun).toEqual(lastRun);
    r.su.adoptBoot(null);
    expect(r.su.status().lastRun).toEqual(lastRun);
  });

  it("a click's command id is known from the moment it is accepted", async () => {
    const r = await makeRig();
    r.turns.codex = 1;
    expect(await r.su.request("manual", COMMAND_ID)).toEqual({ accepted: true });
    expect(r.su.isKnownCommand(COMMAND_ID)).toBe(true);
  });
});
