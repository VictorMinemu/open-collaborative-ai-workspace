import { describe, expect, it } from "vitest";
import { EnrollDeviceResponse } from "./device";
import {
  ApprovePairingRequest,
  DenyPairingRequest,
  formatUserCode,
  normalizeUserCode,
  PAIRING_INTERVAL_SECONDS,
  PAIRING_SLOW_DOWN_STEP_SECONDS,
  PAIRING_TTL_SECONDS,
  PairingErrorCode,
  PairingLookupRequest,
  PairingRequestView,
  PairingTokenRequest,
  PairingTokenResponse,
  StartPairingRequest,
  StartPairingResponse,
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
} from "./device-pairing";

const DEVICE_ID = "0199f0a0-0000-7000-8000-000000000001";
const ORG_ID = "0199f0a0-0000-7000-8000-000000000002";
const DEVICE_CODE = "x".repeat(43);

describe("user codes (07.12, D-03)", () => {
  it("are 8 Crockford base32 symbols: 32 distinct, none of I, L, O, U, exactly 40 bits", () => {
    expect(USER_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(USER_CODE_ALPHABET).size).toBe(32);
    for (const ambiguous of ["I", "L", "O", "U"]) expect(USER_CODE_ALPHABET).not.toContain(ambiguous);
    expect(Math.log2(USER_CODE_ALPHABET.length) * USER_CODE_LENGTH).toBe(40);
  });

  it.each([
    ["abcd-efgh", "ABCDEFGH"],
    ["ABCD EFGH", "ABCDEFGH"],
    [" ABCDEFGH ", "ABCDEFGH"],
    ["0OIL-1234", "00111234"],
    ["oil0 1234", "01101234"],
  ])("normalizes %j to %j", (typed, canonical) => {
    expect(normalizeUserCode(typed)).toBe(canonical);
  });

  it.each(["ABCU-EFGH", "ABC-DEF", "ABCDEFGHJ", "ABCD_EFGH!", "", "ABCD-ÉFGH"])("refuses %j", (typed) => {
    expect(normalizeUserCode(typed)).toBeNull();
  });

  it("formats a canonical code as XXXX-XXXX", () => {
    expect(formatUserCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });

  it("times pending requests: 10 minutes, poll every 5 s, slow down by 5 s", () => {
    expect([PAIRING_TTL_SECONDS, PAIRING_INTERVAL_SECONDS, PAIRING_SLOW_DOWN_STEP_SECONDS]).toEqual([
      600, 5, 5,
    ]);
  });
});

describe("pairing requests and answers (07.12, D-03, RFC 8628)", () => {
  it("StartPairingRequest takes a name, a platform and an optional runtime version, nothing else", () => {
    expect(StartPairingRequest.parse({ name: " build-01 ", platform: "linux" })).toEqual({
      name: "build-01",
      platform: "linux",
    });
    expect(
      StartPairingRequest.safeParse({ name: "build-01", platform: "linux", runtimeVersion: "0.1.0" }).success,
    ).toBe(true);
    expect(StartPairingRequest.safeParse({ name: "build-01", platform: "linux", extra: 1 }).success).toBe(
      false,
    );
    expect(StartPairingRequest.safeParse({ name: "n".repeat(81), platform: "linux" }).success).toBe(false);
    expect(StartPairingRequest.safeParse({ name: "build-01", platform: "freebsd" }).success).toBe(false);
  });

  it("StartPairingResponse carries the formatted code and both verification links", () => {
    const answer = {
      deviceCode: DEVICE_CODE,
      userCode: "ABCD-EFGH",
      verificationUri: "https://ocw.example.com/settings/devices?add=server",
      verificationUriComplete: "https://ocw.example.com/settings/devices?pair=ABCD-EFGH",
      expiresIn: 600,
      interval: 5,
    };
    expect(StartPairingResponse.parse(answer)).toEqual(answer);
    expect(StartPairingResponse.safeParse({ ...answer, userCode: "ABCDEFGH" }).success).toBe(false);
    expect(StartPairingResponse.safeParse({ ...answer, userCode: "ABCU-EFGH" }).success).toBe(false);
  });

  it("PairingTokenRequest refuses a device code under 32 characters or an extra key", () => {
    expect(PairingTokenRequest.safeParse({ deviceCode: DEVICE_CODE }).success).toBe(true);
    expect(PairingTokenRequest.safeParse({ deviceCode: "x".repeat(31) }).success).toBe(false);
    expect(PairingTokenRequest.safeParse({ deviceCode: DEVICE_CODE, userCode: "ABCD-EFGH" }).success).toBe(
      false,
    );
  });

  it("lookup, approve and deny take a typed code; a U is refused", () => {
    expect(PairingLookupRequest.safeParse({ userCode: "abcd efgh" }).success).toBe(true);
    expect(ApprovePairingRequest.safeParse({ userCode: "ABCD-EFGH", name: "build-01" }).success).toBe(true);
    expect(ApprovePairingRequest.safeParse({ userCode: "ABCU-EFGH", name: "build-01" }).success).toBe(false);
    expect(ApprovePairingRequest.safeParse({ userCode: "ABCD-EFGH", name: "" }).success).toBe(false);
    expect(DenyPairingRequest.safeParse({ userCode: "ABCD-EFGH", name: "x" }).success).toBe(false);
  });

  it("PairingErrorCode accepts the four RFC 8628 names only", () => {
    expect(PairingErrorCode.options).toEqual([
      "authorization_pending",
      "slow_down",
      "access_denied",
      "expired_token",
    ]);
    expect(PairingErrorCode.safeParse("invalid_grant").success).toBe(false);
  });

  it("PairingRequestView never needs the device code", () => {
    const view = {
      userCode: "ABCD-EFGH",
      name: "build-01",
      platform: "linux",
      runtimeVersion: "0.1.0",
      requestIp: "203.0.113.7",
      requestedAt: "2026-10-29T10:00:00.000Z",
      expiresAt: "2026-10-29T10:10:00.000Z",
    };
    expect(PairingRequestView.parse(view)).toEqual(view);
    expect(PairingRequestView.safeParse({ ...view, runtimeVersion: null, requestIp: null }).success).toBe(
      true,
    );
  });
});

describe("EnrollDeviceResponse (07.12, D-06)", () => {
  const today = { deviceId: DEVICE_ID, organizationId: ORG_ID, deviceToken: "ocwd_token" };

  it("parses the three-field answer older APIs return", () => {
    expect(EnrollDeviceResponse.parse(today)).toEqual(today);
  });

  it("parses the answer with the device name, the web URL, the organization and the owner", () => {
    const rich = {
      ...today,
      name: "build-01",
      webUrl: "https://ocw.example.com",
      organizationName: "Acme",
      ownerName: "Ada Lovelace",
    };
    expect(EnrollDeviceResponse.parse(rich)).toEqual(rich);
    expect(EnrollDeviceResponse.safeParse({ ...rich, webUrl: "not a url" }).success).toBe(false);
  });

  it("is the pairing token answer", () => {
    expect(PairingTokenResponse).toBe(EnrollDeviceResponse);
  });
});
