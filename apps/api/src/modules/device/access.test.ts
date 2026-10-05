import { describe, expect, it } from "vitest";
import { authorModeCap } from "../work-session/controls";
import { deviceControllerFloor, deviceModeCap, type GrantRow, isRevokedPrincipal } from "./access";

/** Device caps (PURE, Phase 03.2, P-06, P-07). */

const DEV = "dev-1";
const OWNER = "owner";
const SAM = "sam";
const DEPT = "dept-d";
const TEAM = "team-t";
const SIBLING = "team-s";

const device = (extra: Partial<Parameters<typeof deviceModeCap>[0]> = {}) => ({
  id: DEV,
  ownerUserId: OWNER,
  shared: false,
  shareMaxMode: "acceptEdits" as const,
  ...extra,
});
const grant = (extra: Partial<GrantRow>): GrantRow => ({
  deviceId: DEV,
  principalKind: "user",
  principalId: SAM,
  maxMode: "acceptEdits",
  revokedAt: null,
  ...extra,
});
const member = (userId: string, ...paths: string[][]) => ({ userId, memberUnitPaths: paths });
const sam = member(SAM, ["root", DEPT, TEAM]);

describe("deviceModeCap (P-06)", () => {
  it("the owner's cap is fullAccess", () => {
    expect(deviceModeCap(device(), [], member(OWNER))).toBe("fullAccess");
  });

  it("a non-owner on an unshared device without grants has none", () => {
    expect(deviceModeCap(device(), [], sam)).toBeNull();
  });

  it("a shared device gives everyone its shareMaxMode", () => {
    expect(deviceModeCap(device({ shared: true, shareMaxMode: "auto" }), [], sam)).toBe("auto");
  });

  it("the highest of shareMaxMode and every matching grant wins", () => {
    const g = [grant({ maxMode: "acceptEdits" })];
    expect(deviceModeCap(device({ shared: true, shareMaxMode: "default" }), g, sam)).toBe("acceptEdits");
    expect(deviceModeCap(device({ shared: true, shareMaxMode: "auto" }), g, sam)).toBe("auto");
  });

  it("a fullAccess grant gives fullAccess", () => {
    expect(deviceModeCap(device(), [grant({ maxMode: "fullAccess" })], sam)).toBe("fullAccess");
  });

  it("a unit grant on a department applies to a member of a team under it, not to a sibling unit", () => {
    const g = [grant({ principalKind: "unit", principalId: TEAM, maxMode: "default" })];
    const deptGrant = [grant({ principalKind: "unit", principalId: DEPT, maxMode: "default" })];
    expect(deviceModeCap(device(), deptGrant, sam)).toBe("default");
    expect(deviceModeCap(device(), g, member("other", ["root", DEPT, SIBLING]))).toBeNull();
    expect(deviceModeCap(device(), deptGrant, member("other", ["root", "elsewhere"]))).toBeNull();
  });

  it("grants on another device never match", () => {
    expect(deviceModeCap(device(), [grant({ deviceId: "dev-2" })], sam)).toBeNull();
  });

  it("a revoked row never contributes", () => {
    const g = [grant({ maxMode: "fullAccess", revokedAt: "2026-10-05T00:00:00.000Z" })];
    expect(deviceModeCap(device(), g, sam)).toBeNull();
    expect(deviceModeCap(device({ shared: true, shareMaxMode: "default" }), g, sam)).toBe("default");
  });
});

describe("deviceControllerFloor (P-07)", () => {
  it("is acceptEdits with no grants and shareMaxMode acceptEdits", () => {
    expect(deviceControllerFloor(device(), [])).toBe("acceptEdits");
  });

  it("follows a lower shareMaxMode", () => {
    expect(deviceControllerFloor(device({ shareMaxMode: "default" }), [])).toBe("default");
  });

  it("is never above the lowest current grant on the device", () => {
    expect(deviceControllerFloor(device(), [grant({ maxMode: "plan" }), grant({ maxMode: "auto" })])).toBe(
      "plan",
    );
  });

  it("ignores revoked rows and other devices' grants", () => {
    expect(
      deviceControllerFloor(device(), [
        grant({ maxMode: "plan", revokedAt: "2026-10-05T00:00:00.000Z" }),
        grant({ maxMode: "plan", deviceId: "dev-2" }),
      ]),
    ).toBe("acceptEdits");
  });

  it("is never above acceptEdits even with high grants", () => {
    expect(
      deviceControllerFloor(device({ shareMaxMode: "fullAccess" }), [grant({ maxMode: "fullAccess" })]),
    ).toBe("acceptEdits");
  });
});

describe("isRevokedPrincipal", () => {
  const at = "2026-10-05T00:00:00.000Z";
  it("matches a revoked user row and a revoked unit row on the member's path", () => {
    expect(isRevokedPrincipal([grant({ revokedAt: at })], sam)).toBe(true);
    expect(
      isRevokedPrincipal([grant({ principalKind: "unit", principalId: DEPT, revokedAt: at })], sam),
    ).toBe(true);
  });

  it("does not match a current row, another member, or a unit off the member's path", () => {
    expect(isRevokedPrincipal([grant({})], sam)).toBe(false);
    expect(isRevokedPrincipal([grant({ principalId: "dana", revokedAt: at })], sam)).toBe(false);
    expect(
      isRevokedPrincipal([grant({ principalKind: "unit", principalId: SIBLING, revokedAt: at })], sam),
    ).toBe(false);
  });
});

describe("authorModeCap (P-07)", () => {
  it("a current cap is the cap", () => {
    expect(authorModeCap({ cap: "default", revoked: false, floor: "default" }, true)).toBe("default");
  });

  it("a revoked principal with no current grant gets nothing, never the floor", () => {
    expect(authorModeCap({ cap: null, revoked: true, floor: "acceptEdits" }, true)).toBeNull();
  });

  it("an unlisted controller inside a session gets the device's floor", () => {
    expect(authorModeCap({ cap: null, revoked: false, floor: "default" }, true)).toBe("default");
    expect(authorModeCap({ cap: null, revoked: false, floor: "acceptEdits" }, true)).toBe("acceptEdits");
  });

  it("an active grant wins over a revoked one (revocation only refuses principals with no active grant)", () => {
    expect(authorModeCap({ cap: "default", revoked: true, floor: "acceptEdits" }, true)).toBe("default");
  });

  it("outside a session a null cap stays null", () => {
    expect(authorModeCap({ cap: null, revoked: false, floor: "acceptEdits" }, false)).toBeNull();
  });
});
