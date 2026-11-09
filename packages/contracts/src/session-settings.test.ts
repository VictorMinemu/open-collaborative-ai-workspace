import { describe, expect, it } from "vitest";
import {
  CapabilitiesFrame,
  ControlDenialReason,
  Device,
  DeviceHostKind,
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

describe("control denial reasons (P-08, 07.16 D-04)", () => {
  it("bot_profile comes last; the member reasons keep their order", () => {
    expect(ControlDenialReason.options).toEqual([
      "org_policy",
      "device_opt_in",
      "device_grant",
      "denied_for_you",
      "runtime",
      "not_in_catalog",
      "not_confirmed",
      "bot_profile",
    ]);
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

  it("botSessionsMax is an optional integer 0..1000 (07.16 D-15)", () => {
    const policy = { ...DEFAULT_WORK_ZONE_POLICY, updatedAt: null };
    expect(WorkZonePolicy.parse(policy).botSessionsMax).toBeUndefined();
    expect(WorkZonePolicy.parse({ ...policy, botSessionsMax: 0 }).botSessionsMax).toBe(0);
    expect(WorkZonePolicy.parse({ ...policy, botSessionsMax: 1000 }).botSessionsMax).toBe(1000);
    expect(WorkZonePolicy.safeParse({ ...policy, botSessionsMax: 1001 }).success).toBe(false);
    expect(WorkZonePolicy.safeParse({ ...policy, botSessionsMax: -1 }).success).toBe(false);
    expect(WorkZonePolicy.safeParse({ ...policy, botSessionsMax: 2.5 }).success).toBe(false);
    expect(UpdateWorkZonePolicyRequest.parse({ botSessionsMax: 5 })).toEqual({ botSessionsMax: 5 });
  });
});

describe("device host kind and isolated server (07.16 D-03, D-19, PD-18)", () => {
  const hello = {
    type: "hello",
    protocolVersion: 1,
    device: { name: "build-box", platform: "linux" },
    runtimes: [],
  };

  it("a service host's hello carries the host kind and the isolated-server mark", () => {
    const parsed = HelloFrame.parse({
      ...hello,
      device: { ...hello.device, host: "service" },
      isolatedServer: true,
    });
    expect(parsed.device.host).toBe("service");
    expect(parsed.isolatedServer).toBe(true);
    expect(DeviceHostKind.options).toEqual(["desktop", "service"]);
  });

  it("an older daemon's hello without either still parses", () => {
    const parsed = HelloFrame.parse(hello);
    expect(parsed.device.host).toBeUndefined();
    expect(parsed.isolatedServer).toBeUndefined();
  });

  it("an unknown host kind is refused", () => {
    expect(HelloFrame.safeParse({ ...hello, device: { ...hello.device, host: "laptop" } }).success).toBe(
      false,
    );
  });

  it("capabilities frames parse with and without isolatedServer", () => {
    const caps = { type: "capabilities", catalogs: [catalog(1)], fullAccessOptIn: false };
    expect(CapabilitiesFrame.parse(caps).isolatedServer).toBeUndefined();
    expect(CapabilitiesFrame.parse({ ...caps, isolatedServer: false }).isolatedServer).toBe(false);
    expect(DeviceToServerFrame.safeParse({ ...caps, isolatedServer: true }).success).toBe(true);
  });

  it("the device DTO carries the reported facts, both optional", () => {
    const device = {
      id: "00000000-0000-4000-8000-000000000001",
      ownerUserId: "00000000-0000-4000-8000-000000000002",
      ownerName: "Ana",
      name: "build-box",
      platform: "linux",
      status: "online",
      shared: false,
      fullAccessOptIn: false,
      shareMaxMode: "default",
      lastSeenAt: null,
      runtimes: [],
      daemonVersion: null,
      projectCount: 0,
      revokedAt: null,
      createdAt: "2026-11-09T10:00:00.000Z",
    };
    expect(Device.safeParse(device).success).toBe(true);
    expect(Device.parse({ ...device, hostKind: null }).hostKind).toBeNull();
    const service = Device.parse({ ...device, hostKind: "service", isolatedServer: true });
    expect(service.hostKind).toBe("service");
    expect(service.isolatedServer).toBe(true);
    expect(Device.safeParse({ ...device, hostKind: "laptop" }).success).toBe(false);
  });
});
