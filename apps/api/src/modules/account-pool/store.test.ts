import { PoolAccount } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { type PoolAccountRow, poolAccountStatus, toPoolAccount } from "./store";

/**
 * The status every pool surface shows and the admin DTO (Phase 07.18-05, D-10, D-13): pure functions over a stored
 * row. Timestamps come from the database as strings (`mode: "string"`).
 */

const NOW = new Date("2026-11-24T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const row = (over: Partial<PoolAccountRow> = {}): PoolAccountRow => ({
  id: "0196f000-0000-7000-8000-000000000001",
  organizationId: "0196f000-0000-7000-8000-0000000000aa",
  provider: "claude",
  kind: "token",
  label: "ana@acme",
  enabled: true,
  priority: 0,
  weight: 1,
  secretId: "0196f000-0000-7000-8000-0000000000bb",
  deviceId: null,
  slotId: null,
  cellProfileId: null,
  origin: "admin",
  credentialState: "ok",
  planType: null,
  cooldownUntil: null,
  limitReason: null,
  lastUsedAt: null,
  wrrCurrent: 0,
  usage: null,
  usageAt: null,
  createdBy: null,
  createdAt: "2026-11-24 10:00:00.123+00",
  updatedAt: "2026-11-24 10:00:00.123+00",
  removedAt: null,
  ...over,
});

describe("poolAccountStatus", () => {
  it("is ready for an enabled account with an ok credential and no cooldown", () => {
    expect(poolAccountStatus(row(), NOW)).toBe("ready");
  });

  it("disabled wins over needs_sign_in and cooling", () => {
    expect(
      poolAccountStatus(
        row({ enabled: false, credentialState: "needs_sign_in", cooldownUntil: at(60_000) }),
        NOW,
      ),
    ).toBe("disabled");
  });

  it("needs_sign_in wins over cooling", () => {
    expect(poolAccountStatus(row({ credentialState: "needs_sign_in", cooldownUntil: at(60_000) }), NOW)).toBe(
      "needs_sign_in",
    );
  });

  it("a cooldown 1 ms in the future is cooling, one in the past (or now) is ready", () => {
    expect(poolAccountStatus(row({ cooldownUntil: at(1) }), NOW)).toBe("cooling");
    expect(poolAccountStatus(row({ cooldownUntil: at(-1) }), NOW)).toBe("ready");
    expect(poolAccountStatus(row({ cooldownUntil: at(0) }), NOW)).toBe("ready");
  });
});

describe("toPoolAccount", () => {
  const devices = new Map([["0196f000-0000-7000-8000-0000000000dd", { name: "Build box", online: true }]]);

  it("maps a token row with device null and no secret, slot or profile key", () => {
    const dto = toPoolAccount(row({ cooldownUntil: at(5_000), limitReason: "five_hour" }), devices, NOW);
    expect(PoolAccount.parse(dto)).toEqual(dto);
    expect(dto).toMatchObject({
      kind: "token",
      device: null,
      status: "cooling",
      limitReason: "five_hour",
      cooldownUntil: at(5_000),
      createdAt: "2026-11-24T10:00:00.123Z",
    });
    for (const key of ["secretId", "slotId", "cellProfileId", "token", "organizationId", "wrrCurrent"]) {
      expect(dto).not.toHaveProperty(key);
    }
  });

  it("maps a slot row with its device's name and online state", () => {
    const dto = toPoolAccount(
      row({
        provider: "chatgpt",
        kind: "device_slot",
        secretId: null,
        deviceId: "0196f000-0000-7000-8000-0000000000dd",
        slotId: "0196f000-0000-7000-8000-0000000000ee",
        planType: "pro",
        usage: { windows: [{ kind: "primary", usedPercent: 42, resetsAt: null }], at: at(-1_000) },
      }),
      devices,
      NOW,
    );
    expect(PoolAccount.parse(dto)).toEqual(dto);
    expect(dto.device).toEqual({
      id: "0196f000-0000-7000-8000-0000000000dd",
      name: "Build box",
      online: true,
    });
    expect(dto.planType).toBe("pro");
    expect(dto.usage?.windows[0]?.usedPercent).toBe(42);
    for (const key of ["secretId", "slotId", "cellProfileId"]) expect(dto).not.toHaveProperty(key);
  });

  it("a slot whose device is not in the map reads as an offline unknown device; bad usage reads as null", () => {
    const dto = toPoolAccount(
      row({
        provider: "chatgpt",
        kind: "device_slot",
        deviceId: "0196f000-0000-7000-8000-0000000000ff",
        usage: { windows: [{ kind: "nope", usedPercent: 500, resetsAt: null }], at: "later" },
      }),
      devices,
      NOW,
    );
    expect(dto.device).toEqual({
      id: "0196f000-0000-7000-8000-0000000000ff",
      name: "Unknown device",
      online: false,
    });
    expect(dto.usage).toBeNull();
  });

  it("maps a cell profile with device null and no profile id", () => {
    const dto = toPoolAccount(
      row({ provider: "chatgpt", kind: "cell_profile", secretId: null, cellProfileId: "openai:pool-x" }),
      devices,
      NOW,
    );
    expect(dto.device).toBeNull();
    expect(JSON.stringify(dto)).not.toContain("openai:pool-x");
  });
});
