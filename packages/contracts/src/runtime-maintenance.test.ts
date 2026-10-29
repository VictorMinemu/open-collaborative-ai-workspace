import { describe, expect, it } from "vitest";
import { Device } from "./device";
import {
  DeviceToServerFrame,
  RuntimeMaintenanceFrame,
  RuntimeUpdateRunFrame,
  ServerToDeviceFrame,
} from "./device-link";
import { PINNED_RUNTIME_VERSIONS } from "./runtime-controls/index";
import {
  compareRuntimeVersions,
  compatibilityOf,
  DisplayCommand,
  effectiveRuntimeUpdatesLevel,
  HomeRelativeLocation,
  newerManifest,
  parseRuntimeVersion,
  RUNTIME_COMPATIBILITY_MANIFEST,
  RuntimeCompatibilityManifest,
  RuntimeMaintenanceStatus,
  RuntimeUpdatePayload,
  RuntimeUpdateRun,
  scrubHostPaths,
} from "./runtime-maintenance";
import { EPHEMERAL_SESSION_EVENTS, SessionEvent } from "./session-events";

const RUN_ID = "0199f0a0-0000-7000-8000-000000000001";
const AT = "2026-10-28T10:00:00.000Z";

const claudeStatus: RuntimeMaintenanceStatus = {
  runtime: "claude-code",
  installedVersion: "2.1.290",
  method: "native",
  location: "~/.local/bin",
  canUpdate: true,
  reason: null,
  updateCommand: "claude update",
  channel: "latest",
  latestVersion: "2.1.300",
  advisory: "behind",
  installedCompatibility: "supported",
  candidateCompatibility: "supported",
  state: "pending",
  pendingSince: AT,
  stale: false,
  lastRun: null,
  checkedAt: AT,
};

const maintenanceFrame = {
  type: "runtime.maintenance",
  runtimes: [claudeStatus],
  runtimeInfo: [
    { id: "claude-code", installed: true, version: "2.1.290", loggedIn: true },
    { id: "codex", installed: true, version: "0.160.0", loggedIn: false },
  ],
  localLevel: "automatic",
  localLevelSource: "config",
  effectiveLevel: "automatic",
  orgLevelReceived: true,
} as const;

const startedFrame = {
  type: "runtime.update.run",
  runId: RUN_ID,
  runtime: "claude-code",
  trigger: "automatic",
  phase: "started",
  fromVersion: "2.1.290",
  toVersion: null,
  candidate: "2.1.300",
  method: "native",
  at: AT,
} as const;

const finishedFrame = {
  ...startedFrame,
  phase: "finished",
  outcome: "succeeded",
  toVersion: "2.1.300",
  output: "Successfully updated from 2.1.290 to version 2.1.300",
  at: "2026-10-28T10:01:00.000Z",
} as const;

const withStatus = (patch: Record<string, unknown>) => ({ ...claudeStatus, ...patch });

describe("round trip", () => {
  it("one automatic Claude Code update parses through the Device Link unions", () => {
    const config = ServerToDeviceFrame.parse({
      type: "runtime.config",
      policy: "automatic",
      manifest: RUNTIME_COMPATIBILITY_MANIFEST,
    });
    expect(config).toEqual({
      type: "runtime.config",
      policy: "automatic",
      manifest: RUNTIME_COMPATIBILITY_MANIFEST,
    });

    expect(DeviceToServerFrame.parse(maintenanceFrame)).toEqual(maintenanceFrame);
    expect(DeviceToServerFrame.parse(startedFrame)).toEqual(startedFrame);
    expect(DeviceToServerFrame.parse(finishedFrame)).toEqual(finishedFrame);
  });

  it("a finished run frame needs an outcome and a started one may not carry it", () => {
    const { outcome: _outcome, ...noOutcome } = finishedFrame;
    expect(RuntimeUpdateRunFrame.safeParse(noOutcome).success).toBe(false);
    expect(DeviceToServerFrame.safeParse({ ...startedFrame, outcome: "succeeded" }).success).toBe(false);
  });

  it("refuses output above 4096 characters and more than four statuses", () => {
    expect(RuntimeUpdateRunFrame.safeParse({ ...finishedFrame, output: "x".repeat(4097) }).success).toBe(
      false,
    );
    expect(RuntimeUpdateRunFrame.safeParse({ ...finishedFrame, output: "x".repeat(4096) }).success).toBe(
      true,
    );
    expect(
      RuntimeMaintenanceFrame.safeParse({ ...maintenanceFrame, runtimes: Array(5).fill(claudeStatus) })
        .success,
    ).toBe(false);
  });

  it("the update command payload carries only a runtime id (D-05)", () => {
    expect(RuntimeUpdatePayload.parse({ runtime: "codex" })).toEqual({ runtime: "codex" });
    expect(RuntimeUpdatePayload.safeParse({ runtime: "codex", version: "0.170.0" }).success).toBe(false);
    expect(RuntimeUpdatePayload.safeParse({ runtime: "codex", command: "npm i -g x" }).success).toBe(false);
    expect(RuntimeUpdatePayload.safeParse({ runtime: "opencode" }).success).toBe(false);
  });

  it("a history run parses with its nullable fields", () => {
    const run = RuntimeUpdateRun.parse({
      id: RUN_ID,
      runtime: "codex",
      trigger: "manual",
      state: "requested",
      requestedBy: { id: RUN_ID, name: "Ada" },
      fromVersion: null,
      toVersion: null,
      candidate: null,
      method: null,
      output: null,
      error: null,
      requestedAt: AT,
      startedAt: null,
      finishedAt: null,
    });
    expect(run.state).toBe("requested");
  });
});

describe("no host path", () => {
  it("location is home-relative only", () => {
    expect(RuntimeMaintenanceStatus.safeParse(withStatus({ location: "/usr/local/bin" })).success).toBe(
      false,
    );
    expect(RuntimeMaintenanceStatus.safeParse(withStatus({ location: "C:\\tools" })).success).toBe(false);
    expect(RuntimeMaintenanceStatus.safeParse(withStatus({ location: "~" })).success).toBe(true);
    expect(RuntimeMaintenanceStatus.safeParse(withStatus({ location: "~/.local/bin" })).success).toBe(true);
    expect(HomeRelativeLocation.safeParse("~/a b").success).toBe(false);
  });

  it("the display command refuses an absolute path token", () => {
    expect(
      RuntimeMaintenanceStatus.safeParse(withStatus({ updateCommand: "/opt/homebrew/bin/brew upgrade" }))
        .success,
    ).toBe(false);
    expect(DisplayCommand.safeParse("brew upgrade --cask claude-code").success).toBe(true);
    expect(DisplayCommand.safeParse("sudo npm install -g --prefix /usr @openai/codex@0.164.0").success).toBe(
      false,
    );
  });

  it("the status is strict (no stray field can carry a path)", () => {
    expect(RuntimeMaintenanceStatus.safeParse(withStatus({ realPath: "/usr/lib/x" })).success).toBe(false);
  });

  it("run output is scrubbed when parsed", () => {
    const parsed = RuntimeUpdateRunFrame.parse({ ...finishedFrame, output: "npm error path /opt/x/y" });
    expect(parsed.output).toBe("npm error path <path>");
  });

  it.each([
    ["/usr/lib/node_modules/@openai/codex", "<path>"],
    ["npm error path /opt/x/y", "npm error path <path>"],
    ["C:\\Users\\a\\b", "<path>"],
    ["C:/Users/a", "<path>"],
    ["\\\\server\\share\\x", "<path>"],
    ["file:///tmp/x", "<path>"],
    ["see /etc/hosts.", "see <path>."],
    ["at x (/usr/lib/x.js:10:5)", "at x (<path>)"],
    ["open '/usr/x'", "open '<path>'"],
    ["--prefix=/usr/local done", "--prefix=<path> done"],
    ["error:/usr/x", "error:<path>"],
    ["url=https://h/x then /var/y", "url=https://h/x then <path>"],
  ])("scrubs %s", (input, expected) => {
    expect(scrubHostPaths(input)).toBe(expected);
  });

  it.each([
    "~/.local/bin/claude",
    "~",
    "https://registry.npmjs.org/@openai%2fcodex/latest",
    "bin/claude.exe",
    "added 3 packages in 4s",
    "and / or",
    "1/2 done",
  ])("keeps %s", (input) => {
    expect(scrubHostPaths(input)).toBe(input);
  });

  it("is idempotent", () => {
    const once = scrubHostPaths("npm error path /opt/x/y and C:\\a and file:///z and \\\\srv\\s");
    expect(once).toBe("npm error path <path> and <path> and <path> and <path>");
    expect(scrubHostPaths(once)).toBe(once);
  });
});

describe("versions", () => {
  it.each([
    ["2.1.307 (Claude Code)", "2.1.307"],
    ["codex-cli 0.164.0", "0.164.0"],
    ["0.159.0-alpha.12.1", "0.159.0-alpha.12.1"],
    ["1.2.3+build.5", "1.2.3"],
    ["fake", null],
    ["", null],
  ])("parses %s", (input, expected) => {
    expect(parseRuntimeVersion(input)).toBe(expected);
  });

  it("compares numerically, with a prerelease below its release", () => {
    expect(compareRuntimeVersions("2.1.10", "2.1.9")).toBe(1);
    expect(compareRuntimeVersions("2.1.9", "2.1.10")).toBe(-1);
    expect(compareRuntimeVersions("0.159.0-alpha.12", "0.159.0")).toBe(-1);
    expect(compareRuntimeVersions("0.159.0", "0.159.0-alpha.12")).toBe(1);
    expect(compareRuntimeVersions("0.159.0-alpha.2", "0.159.0-alpha.12")).toBe(-1);
    expect(compareRuntimeVersions("0.159.0-alpha", "0.159.0-beta")).toBe(-1);
    expect(compareRuntimeVersions("0.159.0-alpha", "0.159.0-alpha.1")).toBe(-1);
    expect(compareRuntimeVersions("2.1.300", "2.1.300")).toBe(0);
    expect(compareRuntimeVersions("10.0.0", "9.99.99")).toBe(1);
  });
});

describe("manifest", () => {
  it("the bundled manifest parses with its own schema and has no broken range", () => {
    expect(RuntimeCompatibilityManifest.parse(RUNTIME_COMPATIBILITY_MANIFEST)).toEqual(
      RUNTIME_COMPATIBILITY_MANIFEST,
    );
    for (const entry of Object.values(RUNTIME_COMPATIBILITY_MANIFEST.runtimes)) {
      expect(entry.ranges.some((r) => r.status === "broken")).toBe(false);
      expect(entry.ranges.some((r) => r.bounds.maxExclusive !== undefined && r.status === "supported")).toBe(
        false,
      );
    }
  });

  it("recommends the pinned fixture versions", () => {
    expect(RUNTIME_COMPATIBILITY_MANIFEST.runtimes["claude-code"].recommended.min).toBe(
      PINNED_RUNTIME_VERSIONS["claude-code"].cli,
    );
    expect(RUNTIME_COMPATIBILITY_MANIFEST.runtimes.codex.recommended.min).toBe(
      PINNED_RUNTIME_VERSIONS.codex.cli,
    );
  });

  it("evaluates the bundled floors", () => {
    const m = RUNTIME_COMPATIBILITY_MANIFEST;
    expect(compatibilityOf(m, "claude-code", "2.1.286")).toBe("unsupported");
    expect(compatibilityOf(m, "claude-code", "2.1.287")).toBe("supported");
    expect(compatibilityOf(m, "claude-code", "2.1.312")).toBe("supported");
    expect(compatibilityOf(m, "claude-code", "2.1.287-beta.1")).toBe("unsupported");
    expect(compatibilityOf(m, "codex", "0.159.9")).toBe("unsupported");
    expect(compatibilityOf(m, "codex", "0.160.0")).toBe("supported");
    expect(compatibilityOf(m, "codex", "fake")).toBe("unknown");
    expect(compatibilityOf(m, "codex", null)).toBe("unknown");
  });

  it("the first matching range wins (a broken release)", () => {
    const claude = RUNTIME_COMPATIBILITY_MANIFEST.runtimes["claude-code"];
    const m = RuntimeCompatibilityManifest.parse({
      ...RUNTIME_COMPATIBILITY_MANIFEST,
      runtimes: {
        ...RUNTIME_COMPATIBILITY_MANIFEST.runtimes,
        "claude-code": {
          ...claude,
          ranges: [
            {
              bounds: { min: "2.1.300", maxExclusive: "2.1.301" },
              status: "broken",
              note: "drops tool results",
            },
            ...claude.ranges,
          ],
        },
      },
    });
    expect(compatibilityOf(m, "claude-code", "2.1.300")).toBe("broken");
    expect(compatibilityOf(m, "claude-code", "2.1.301")).toBe("supported");
    expect(compatibilityOf(m, "claude-code", "2.1.299")).toBe("supported");
  });

  it("with no matching range, at or above the highest min is supported", () => {
    const m = RuntimeCompatibilityManifest.parse({
      ...RUNTIME_COMPATIBILITY_MANIFEST,
      runtimes: {
        ...RUNTIME_COMPATIBILITY_MANIFEST.runtimes,
        codex: {
          recommended: {},
          ranges: [{ bounds: { min: "0.150.0", maxExclusive: "0.155.0" }, status: "graceful" }],
        },
      },
    });
    expect(compatibilityOf(m, "codex", "0.152.0")).toBe("graceful");
    expect(compatibilityOf(m, "codex", "0.149.0")).toBe("unsupported");
    expect(compatibilityOf(m, "codex", "0.160.0")).toBe("supported");
  });

  it("refuses unknown bound keys and invalid versions", () => {
    const ok = (bounds: unknown) =>
      RuntimeCompatibilityManifest.safeParse({
        ...RUNTIME_COMPATIBILITY_MANIFEST,
        runtimes: { ...RUNTIME_COMPATIBILITY_MANIFEST.runtimes, codex: { recommended: bounds, ranges: [] } },
      }).success;
    expect(ok({ max: "1.0.0" })).toBe(false);
    expect(ok({ min: "latest" })).toBe(false);
    expect(ok({ min: "1.0.0" })).toBe(true);
  });

  it("newerManifest keeps the later updatedAt (a tie keeps the first)", () => {
    const older = { ...RUNTIME_COMPATIBILITY_MANIFEST, updatedAt: "2026-01-01T00:00:00.000Z" };
    const newer = { ...RUNTIME_COMPATIBILITY_MANIFEST, updatedAt: "2026-12-01T00:00:00.000Z" };
    expect(newerManifest(older, newer)).toBe(newer);
    expect(newerManifest(newer, older)).toBe(newer);
    const twin = { ...newer };
    expect(newerManifest(newer, twin)).toBe(newer);
  });

  it("newerManifest never lifts a broken range of the older copy: broken wins (07.11 review LO-01)", () => {
    const claude = RUNTIME_COMPATIBILITY_MANIFEST.runtimes["claude-code"];
    const bundled = {
      ...RUNTIME_COMPATIBILITY_MANIFEST,
      updatedAt: "2026-11-01T00:00:00.000Z",
      runtimes: {
        ...RUNTIME_COMPATIBILITY_MANIFEST.runtimes,
        "claude-code": {
          ...claude,
          ranges: [
            { bounds: { min: "2.1.300", maxExclusive: "2.1.301" }, status: "broken" as const },
            ...claude.ranges,
          ],
        },
      },
    };
    const server = { ...RUNTIME_COMPATIBILITY_MANIFEST, updatedAt: "2026-12-01T00:00:00.000Z" };
    for (const merged of [newerManifest(bundled, server), newerManifest(server, bundled)]) {
      expect(merged.updatedAt).toBe("2026-12-01T00:00:00.000Z");
      expect(compatibilityOf(merged, "claude-code", "2.1.300")).toBe("broken");
      expect(compatibilityOf(merged, "claude-code", "2.1.301")).toBe("supported");
      expect(RuntimeCompatibilityManifest.safeParse(merged).success).toBe(true);
    }
  });
});

describe("levels", () => {
  it("the effective level is the lower of org and device; no org level counts as notify (D-10)", () => {
    expect(effectiveRuntimeUpdatesLevel("automatic", "notify")).toBe("notify");
    expect(effectiveRuntimeUpdatesLevel("notify", "automatic")).toBe("notify");
    expect(effectiveRuntimeUpdatesLevel("off", "automatic")).toBe("off");
    expect(effectiveRuntimeUpdatesLevel("automatic", "automatic")).toBe("automatic");
    expect(effectiveRuntimeUpdatesLevel(null, "automatic")).toBe("notify");
    expect(effectiveRuntimeUpdatesLevel(null, "off")).toBe("off");
  });
});

describe("DTO and event", () => {
  const device = {
    id: RUN_ID,
    ownerUserId: RUN_ID,
    ownerName: "Ada",
    name: "build-box",
    platform: "linux",
    status: "online",
    shared: true,
    fullAccessOptIn: false,
    shareMaxMode: "default",
    lastSeenAt: AT,
    runtimes: [{ id: "claude-code", installed: true, version: "2.1.286", loggedIn: true }],
    daemonVersion: "0.1.0",
    projectCount: 2,
    revokedAt: null,
    createdAt: AT,
  };
  const codexStatus: RuntimeMaintenanceStatus = {
    ...claudeStatus,
    runtime: "codex",
    installedVersion: "0.160.0",
    method: "npm",
    location: null,
    canUpdate: false,
    reason: "needs_admin",
    updateCommand: "sudo npm install -g @openai/codex@0.164.0",
    latestVersion: "0.164.0",
    state: "idle",
    pendingSince: null,
  };

  it("an older Device payload without the new fields still parses", () => {
    expect(Device.parse(device)).toEqual(device);
  });

  it("a Device carries maintenance and compatibility", () => {
    const withBoth = {
      ...device,
      runtimeMaintenance: {
        runtimes: [claudeStatus, codexStatus],
        localLevel: "automatic",
        localLevelSource: "env",
        effectiveLevel: "notify",
        orgLevel: "notify",
        reportedAt: AT,
      },
      runtimeCompatibility: { "claude-code": "unsupported" },
    };
    expect(Device.parse(withBoth)).toEqual(withBoth);
    expect(Device.safeParse({ ...device, runtimeCompatibility: { "claude-code": "fine" } }).success).toBe(
      false,
    );
  });

  it("a session can be told its turn waits for a runtime update", () => {
    expect(SessionEvent.parse({ type: "runtime.update", runtime: "claude-code", phase: "waiting" })).toEqual({
      type: "runtime.update",
      runtime: "claude-code",
      phase: "waiting",
    });
    const done = { type: "runtime.update", runtime: "claude-code", phase: "done", version: "2.1.300" };
    expect(SessionEvent.parse(done)).toEqual(done);
    expect(
      SessionEvent.safeParse({ type: "runtime.update", runtime: "codex", phase: "started" }).success,
    ).toBe(false);
    expect(
      SessionEvent.safeParse({ type: "runtime.update", runtime: "opencode", phase: "done" }).success,
    ).toBe(false);
  });

  it("runtime.update is persisted (not ephemeral) so the timeline shows it after a reload", () => {
    expect(EPHEMERAL_SESSION_EVENTS.has("runtime.update" as never)).toBe(false);
  });
});
