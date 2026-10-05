import { describe, expect, it } from "vitest";
import {
  CapabilitiesFrame,
  DEFAULT_WORK_ZONE_POLICY,
  DeviceToServerFrame,
  EFFORT_LABELS,
  effortRank,
  HelloFrame,
  isFullAccessReport,
  KNOWN_EFFORTS,
  minMode,
  modeWithin,
  PERMISSION_MODE_RANK,
  PermissionMode,
  PromptPayload,
  RUNTIME_BYPASS_LITERALS,
  RuntimeCatalog,
  type RuntimeModel,
  SessionConfigurePayload,
  SessionEvent,
  SessionStartPayload,
  UpdateWorkSessionSettingsRequest,
  UpdateWorkZonePolicyRequest,
  WorkZonePolicy,
} from "./index";

const model = (id: string): RuntimeModel => ({
  id,
  displayName: id,
  description: null,
  legacy: false,
  isDefault: false,
  badge: null,
  efforts: [],
  defaultEffort: null,
  contextWindows: [],
  defaultContextWindow: null,
  fastMode: { supported: false, reason: null },
  supportsAutoMode: false,
});

const catalog = (n: number) => ({
  runtime: "claude-code",
  runtimeVersion: "fake",
  models: Array.from({ length: n }, (_, i) => model(`m${i}`)),
  permissionModes: ["default", "acceptEdits", "plan"],
  fastModeCost: null,
  collectedAt: new Date().toISOString(),
});

describe("permission modes (P-03, D-03)", () => {
  it("accepts the five platform modes and rejects every runtime bypass literal", () => {
    for (const m of ["plan", "default", "acceptEdits", "auto", "fullAccess"]) {
      expect(PermissionMode.safeParse(m).success, m).toBe(true);
    }
    expect(RUNTIME_BYPASS_LITERALS).toEqual(
      expect.arrayContaining(["bypassPermissions", "dontAsk", "danger-full-access", "dangerFullAccess"]),
    );
    for (const literal of RUNTIME_BYPASS_LITERALS) {
      expect(PermissionMode.safeParse(literal).success, literal).toBe(false);
    }
  });

  it("payloads that carry a mode reject bypassPermissions at the contract edge", () => {
    const bad = { permissionMode: "bypassPermissions" };
    expect(SessionStartPayload.safeParse({ projectLocalId: "lp1", ...bad }).success).toBe(false);
    expect(SessionConfigurePayload.safeParse({ settings: bad, reason: "user" }).success).toBe(false);
    expect(PromptPayload.safeParse({ promptId: "p1", text: "hi", ...bad }).success).toBe(false);
    expect(PromptPayload.safeParse({ promptId: "p1", text: "hi", permissionMode: "auto" }).success).toBe(
      true,
    );
  });

  it("ranks the ladder plan < default < acceptEdits < auto < fullAccess", () => {
    expect(PermissionMode.options.map((m) => PERMISSION_MODE_RANK[m]).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(PERMISSION_MODE_RANK.plan).toBe(0);
    expect(PERMISSION_MODE_RANK.fullAccess).toBe(4);
    expect(minMode("fullAccess", "acceptEdits")).toBe("acceptEdits");
    expect(minMode("plan", "auto")).toBe("plan");
    expect(modeWithin("auto", null)).toBe(false);
    expect(modeWithin("auto", "auto")).toBe(true);
    expect(modeWithin("fullAccess", "auto")).toBe(false);
  });

  it("recognises a full-access report from the runtime", () => {
    expect(isFullAccessReport("fullAccess")).toBe(true);
    expect(isFullAccessReport("bypassPermissions")).toBe(true);
    expect(isFullAccessReport("danger-full-access")).toBe(true);
    expect(isFullAccessReport("acceptEdits")).toBe(false);
    expect(isFullAccessReport(null)).toBe(false);
    expect(isFullAccessReport(undefined)).toBe(false);
  });
});

describe("session settings (D-07, D-09)", () => {
  it("orders efforts and labels them", () => {
    expect(KNOWN_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortRank("xhigh")).toBeGreaterThan(effortRank("high"));
    expect(effortRank("ultra")).toBeGreaterThan(effortRank("max"));
    expect(EFFORT_LABELS.xhigh).toBe("Extra High");
  });

  it("a settings change must change something", () => {
    expect(UpdateWorkSessionSettingsRequest.safeParse({}).success).toBe(false);
    expect(UpdateWorkSessionSettingsRequest.safeParse({ model: "sonnet" }).success).toBe(true);
    expect(UpdateWorkSessionSettingsRequest.safeParse({ effort: null }).success).toBe(true);
  });

  it("session.settings round-trips", () => {
    const ev = {
      type: "session.settings",
      model: "claude-sonnet-5-5",
      permissionMode: "acceptEdits",
      effort: "high",
      contextWindow: 1_000_000,
      fastMode: false,
      fastModeState: "off",
      fastModeReason: "extra_usage_disabled",
      serviceTier: null,
    };
    expect(SessionEvent.parse(ev)).toEqual(ev);
  });
});

describe("Device Link additions (P-05)", () => {
  it("a hello without fullAccessOptIn still parses (protocol v1 stays compatible)", () => {
    const hello = {
      type: "hello",
      protocolVersion: 1,
      device: { name: "mac", platform: "darwin" },
      runtimes: [],
    };
    expect(HelloFrame.safeParse(hello).success).toBe(true);
    expect(HelloFrame.parse({ ...hello, fullAccessOptIn: true }).fullAccessOptIn).toBe(true);
  });

  it("capabilities frames are bounded", () => {
    const ok = { type: "capabilities", catalogs: [catalog(3)], fullAccessOptIn: false };
    expect(CapabilitiesFrame.safeParse(ok).success).toBe(true);
    expect(DeviceToServerFrame.safeParse(ok).success).toBe(true);
    expect(RuntimeCatalog.safeParse(catalog(100)).success).toBe(true);
    expect(
      DeviceToServerFrame.safeParse({
        type: "capabilities",
        catalogs: [catalog(101)],
        fullAccessOptIn: false,
      }).success,
    ).toBe(false);
  });
});

describe("Work Zone policy (D-02, D-11)", () => {
  it("defaults keep full access and fast mode off", () => {
    expect(DEFAULT_WORK_ZONE_POLICY.allowFullAccess).toBe(false);
    expect(DEFAULT_WORK_ZONE_POLICY.allowFastMode).toBe(false);
    expect(DEFAULT_WORK_ZONE_POLICY.allowedPermissionModes).toEqual([
      "plan",
      "default",
      "acceptEdits",
      "auto",
    ]);
    expect(WorkZonePolicy.safeParse({ ...DEFAULT_WORK_ZONE_POLICY, updatedAt: null }).success).toBe(true);
  });

  it("fullAccess is never an allowed mode; it has its own switch", () => {
    expect(UpdateWorkZonePolicyRequest.safeParse({ allowedPermissionModes: ["fullAccess"] }).success).toBe(
      false,
    );
    expect(UpdateWorkZonePolicyRequest.safeParse({ allowFullAccess: true }).success).toBe(true);
  });
});
