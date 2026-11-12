import { describe, expect, it } from "vitest";
import { DEVICE_LINK_PROTOCOL_VERSION, DeviceToServerFrame, RuntimeMaintenanceFrame } from "./device-link";
import {
  DeviceRuntimeMaintenance,
  OCW_RUNTIME_TARGET,
  RUNTIME_SELF_BLOCK_SENTENCES,
  RUNTIME_SELF_UPDATE_REFUSAL_SENTENCES,
  RUNTIME_UPDATE_TARGET_LABEL,
  RuntimeBuild,
  RuntimeSelfBlock,
  RuntimeSelfStatus,
  RuntimeSelfUpdateRefusal,
  RuntimeServedBuild,
  RuntimeUpdateHistoryQuery,
  RuntimeUpdateParams,
  RuntimeUpdatePayload,
  RuntimeUpdateRun,
  RuntimeUpdateTarget,
  runtimeBuildOf,
  scrubHostPaths,
} from "./runtime-maintenance";
import { RuntimeId, SessionEvent } from "./session-events";

/**
 * Phase 07.17.1 (runtime self-update, RSU-01…RSU-08; PD-04, PD-05, PD-25): the OCW runtime is a maintenance target
 * beside the two CLIs, never a session runtime; every addition is optional so 07.11 peers keep parsing.
 */

const RUN_ID = "0199f0a0-0000-7000-8000-000000000101";
const ID = "0199f0a0-0000-7000-8000-000000000102";
const AT = "2026-11-11T10:00:00.000Z";
const FROM_BUILD = "1a2b3c4d5e6f";
const TO_BUILD = "abcdef012345";

const self: RuntimeSelfStatus = {
  version: "0.3.1",
  build: FROM_BUILD,
  supervised: true,
  canUpdate: true,
  reason: null,
  servedVersion: "0.3.2",
  servedBuild: TO_BUILD,
  state: "idle",
  pendingSince: null,
  lastRun: {
    runId: RUN_ID,
    outcome: "succeeded",
    at: AT,
    fromVersion: "0.3.0",
    toVersion: "0.3.1",
    fromBuild: "0123456789ab",
    toBuild: FROM_BUILD,
  },
  checkedAt: AT,
};

const maintenanceFrame = {
  type: "runtime.maintenance",
  runtimes: [],
  runtimeInfo: [],
  localLevel: "automatic",
  localLevelSource: "config",
  effectiveLevel: "automatic",
  orgLevelReceived: true,
} as const;

const startedFrame = {
  type: "runtime.update.run",
  runId: RUN_ID,
  runtime: "ocw-runtime",
  trigger: "manual",
  commandId: ID,
  phase: "started",
  fromVersion: "0.3.1",
  toVersion: "0.3.2",
  candidate: "0.3.2",
  method: "ocw_bundle",
  fromBuild: FROM_BUILD,
  toBuild: TO_BUILD,
  at: AT,
} as const;

const finishedFrame = {
  ...startedFrame,
  phase: "finished",
  outcome: "succeeded",
  at: "2026-11-11T10:01:00.000Z",
} as const;

const dto07_11 = {
  runtimes: [],
  localLevel: "notify",
  localLevelSource: "config",
  effectiveLevel: "notify",
  orgLevel: "automatic",
  reportedAt: AT,
} as const;

const run07_11 = {
  id: ID,
  runtime: "codex",
  trigger: "manual",
  state: "requested",
  requestedBy: { id: ID, name: "Ada" },
  fromVersion: null,
  toVersion: null,
  candidate: null,
  method: null,
  output: null,
  error: null,
  requestedAt: AT,
  startedAt: null,
  finishedAt: null,
} as const;

describe("target vocabulary (PD-04)", () => {
  it("the maintenance target adds the OCW runtime; the session runtime id never grows", () => {
    expect(RuntimeUpdateTarget.options).toEqual(["claude-code", "codex", "ocw-runtime"]);
    expect(OCW_RUNTIME_TARGET).toBe("ocw-runtime");
    expect(RuntimeId.options).toEqual(["claude-code", "codex"]);
    expect(RuntimeId.safeParse("ocw-runtime").success).toBe(false);
    expect(DEVICE_LINK_PROTOCOL_VERSION).toBe(1);
  });

  it("labels every target", () => {
    expect(RUNTIME_UPDATE_TARGET_LABEL).toEqual({
      "claude-code": "Claude Code",
      codex: "Codex",
      "ocw-runtime": "OCW runtime",
    });
  });

  it("the command payload carries only the target, strict (P1)", () => {
    expect(RuntimeUpdatePayload.parse({ runtime: "ocw-runtime" })).toEqual({ runtime: "ocw-runtime" });
    expect(RuntimeUpdatePayload.parse({ runtime: "codex" })).toEqual({ runtime: "codex" });
    expect(RuntimeUpdatePayload.safeParse({ runtime: "ocw-runtime", url: "https://x" }).success).toBe(false);
    expect(RuntimeUpdatePayload.safeParse({ runtime: "ocw-runtime", version: "0.3.1" }).success).toBe(false);
    expect(RuntimeUpdatePayload.safeParse({ runtime: "ocw" }).success).toBe(false);
  });
});

describe("builds (PD-05)", () => {
  it("a build is the first 12 hex of the bundle's sha256", () => {
    expect(runtimeBuildOf("a".repeat(64))).toBe("a".repeat(12));
    expect(RuntimeBuild.safeParse(FROM_BUILD).success).toBe(true);
    expect(RuntimeBuild.safeParse("ABCDEF012345").success).toBe(false);
    expect(RuntimeBuild.safeParse("abcdef01234").success).toBe(false);
    expect(RuntimeBuild.safeParse("abcdef0123456").success).toBe(false);
  });

  it("a served build is a version and a build", () => {
    expect(RuntimeServedBuild.parse({ version: "0.3.2", build: TO_BUILD })).toEqual({
      version: "0.3.2",
      build: TO_BUILD,
    });
    expect(RuntimeServedBuild.safeParse({ version: "0.3.2", build: "xyz" }).success).toBe(false);
  });
});

describe("run frames on the Device Link (PD-04)", () => {
  it("an OCW runtime run parses started and finished with its builds", () => {
    expect(DeviceToServerFrame.parse(startedFrame)).toEqual(startedFrame);
    expect(DeviceToServerFrame.parse(finishedFrame)).toEqual(finishedFrame);
  });

  it("refuses an upper-case or short build", () => {
    expect(DeviceToServerFrame.safeParse({ ...startedFrame, toBuild: "ABCDEF012345" }).success).toBe(false);
    expect(DeviceToServerFrame.safeParse({ ...startedFrame, toBuild: "abcdef01234" }).success).toBe(false);
  });

  it("a 07.11 run frame without builds still parses", () => {
    const { fromBuild: _f, toBuild: _t, ...old } = startedFrame;
    const cli = { ...old, runtime: "codex", method: "npm" } as const;
    expect(DeviceToServerFrame.parse(cli)).toEqual(cli);
  });
});

describe("the device's own status (D-08, PD-25)", () => {
  it("a maintenance snapshot parses with and without self", () => {
    expect(DeviceToServerFrame.parse({ ...maintenanceFrame, self })).toEqual({ ...maintenanceFrame, self });
    expect(DeviceToServerFrame.parse(maintenanceFrame)).toEqual(maintenanceFrame);
  });

  it("refuses an extra key inside self, so no path can ride on it", () => {
    expect(
      RuntimeMaintenanceFrame.safeParse({ ...maintenanceFrame, self: { ...self, path: "/home/x" } }).success,
    ).toBe(false);
  });

  it("refuses a non-version and accepts a checkout's dev version without a build", () => {
    expect(RuntimeSelfStatus.safeParse({ ...self, version: "dev" }).success).toBe(false);
    const checkout = {
      ...self,
      version: "0.0.0-dev",
      build: null,
      supervised: false,
      canUpdate: false,
      reason: "not_installed",
      servedVersion: null,
      servedBuild: null,
      lastRun: null,
      checkedAt: null,
    } as const;
    expect(RuntimeSelfStatus.parse(checkout)).toEqual(checkout);
  });

  it("refuses an unknown state or reason", () => {
    expect(RuntimeSelfStatus.safeParse({ ...self, state: "draining" }).success).toBe(false);
    expect(RuntimeSelfStatus.safeParse({ ...self, reason: "manual" }).success).toBe(false);
  });
});

describe("DTOs stay compatible (D-07)", () => {
  it("DeviceRuntimeMaintenance parses a 07.11 DTO, one with self and served, and one with served null", () => {
    expect(DeviceRuntimeMaintenance.parse(dto07_11)).toEqual(dto07_11);
    const full = { ...dto07_11, self, served: { version: "0.3.2", build: TO_BUILD } };
    expect(DeviceRuntimeMaintenance.parse(full)).toEqual(full);
    const none = { ...dto07_11, served: null };
    expect(DeviceRuntimeMaintenance.parse(none)).toEqual(none);
  });

  it("RuntimeUpdateRun parses a 07.11 row, an OCW runtime row with both builds, and with fromBuild null", () => {
    expect(RuntimeUpdateRun.parse(run07_11)).toEqual(run07_11);
    const ocw = {
      ...run07_11,
      runtime: "ocw-runtime",
      method: "ocw_bundle",
      candidate: "0.3.2",
      toVersion: "0.3.2",
      fromBuild: FROM_BUILD,
      toBuild: TO_BUILD,
    } as const;
    expect(RuntimeUpdateRun.parse(ocw)).toEqual(ocw);
    expect(RuntimeUpdateRun.parse({ ...ocw, fromBuild: null })).toEqual({ ...ocw, fromBuild: null });
    expect(RuntimeUpdateRun.safeParse({ ...ocw, toBuild: "nope" }).success).toBe(false);
  });

  it("route params and the history query accept the OCW runtime", () => {
    expect(RuntimeUpdateParams.parse({ id: ID, runtime: "ocw-runtime" })).toEqual({
      id: ID,
      runtime: "ocw-runtime",
    });
    expect(RuntimeUpdateHistoryQuery.parse({ runtime: "ocw-runtime" })).toEqual({ runtime: "ocw-runtime" });
    expect(RuntimeUpdateHistoryQuery.parse({})).toEqual({});
    expect(RuntimeUpdateParams.safeParse({ id: ID, runtime: "ocw" }).success).toBe(false);
  });
});

describe("refusals and their sentences (D-05, PD-13)", () => {
  it("names the three blocks; not_supervised is D-05 verbatim", () => {
    expect(Object.keys(RUNTIME_SELF_BLOCK_SENTENCES).sort()).toEqual([...RuntimeSelfBlock.options].sort());
    expect(RUNTIME_SELF_BLOCK_SENTENCES.not_supervised).toBe(
      "Run as a service to update from the browser; or re-run the install command",
    );
  });

  it("names the seven refusals; the three block codes reuse the block sentences", () => {
    expect(Object.keys(RUNTIME_SELF_UPDATE_REFUSAL_SENTENCES).sort()).toEqual(
      [...RuntimeSelfUpdateRefusal.options].sort(),
    );
    expect(RuntimeSelfUpdateRefusal.options).toHaveLength(7);
    for (const block of RuntimeSelfBlock.options) {
      expect(RUNTIME_SELF_UPDATE_REFUSAL_SENTENCES[block]).toBe(RUNTIME_SELF_BLOCK_SENTENCES[block]);
    }
  });

  it("every sentence is short, has no placeholder, no URL and no host path", () => {
    const all = [
      ...Object.values(RUNTIME_SELF_BLOCK_SENTENCES),
      ...Object.values(RUNTIME_SELF_UPDATE_REFUSAL_SENTENCES),
    ];
    for (const s of all) {
      expect(s.length).toBeLessThanOrEqual(200);
      expect(s).not.toContain("{");
      expect(s).not.toContain("http");
      expect(scrubHostPaths(s)).toBe(s);
    }
  });
});

describe("held-session subject (PD-18)", () => {
  it("a runtime.update event may name the OCW runtime as what it waits for", () => {
    const held = {
      type: "runtime.update",
      runtime: "codex",
      phase: "waiting",
      subject: "ocw-runtime",
    } as const;
    expect(SessionEvent.parse(held)).toEqual(held);
    const plain = { type: "runtime.update", runtime: "codex", phase: "waiting" } as const;
    expect(SessionEvent.parse(plain)).toEqual(plain);
    expect(SessionEvent.safeParse({ ...held, subject: "codex" }).success).toBe(false);
  });
});
