import { describe, expect, it } from "vitest";
import { codexLimitSignal, codexUsage, mergeCodexWindows } from "./limits.js";

// 07.18 (D-07, D-09, PD-09, PD-23, A-07): Codex limit and usage detection, pure.

const RESET_PRIMARY = 1_795_000_000; // epoch seconds (A-07)
const RESET_SECONDARY = 1_795_400_000;
const iso = (sec: number) => new Date(sec * 1000).toISOString();

const turnCompleted = (codexErrorInfo: unknown) => ({
  method: "turn/completed",
  params: {
    threadId: "t1",
    turn: {
      id: "turn-1",
      status: "failed",
      items: [],
      error: { message: "You've hit your usage limit.", codexErrorInfo, additionalDetails: null },
    },
  },
});
const errorNote = (codexErrorInfo: unknown, willRetry: boolean) => ({
  method: "error",
  params: {
    threadId: "t1",
    turnId: "turn-1",
    willRetry,
    error: { message: "limit", codexErrorInfo, additionalDetails: null },
  },
});

describe("codexLimitSignal (PD-23)", () => {
  const exhausted = {
    primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: RESET_PRIMARY },
    secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: RESET_SECONDARY },
  };

  it("a turn that ends with usageLimitExceeded is usage_limit, resetting when the exhausted window resets", () => {
    expect(codexLimitSignal(turnCompleted("usageLimitExceeded"), exhausted)).toEqual({
      reason: "usage_limit",
      resetsAt: iso(RESET_PRIMARY),
    });
  });

  it("the latest reset among the windows at 100 % or more wins", () => {
    const both = {
      primary: { usedPercent: 100, resetsAt: RESET_PRIMARY },
      secondary: { usedPercent: 100.5, resetsAt: RESET_SECONDARY },
    };
    expect(codexLimitSignal(turnCompleted("usageLimitExceeded"), both)?.resetsAt).toBe(iso(RESET_SECONDARY));
  });

  it("no exhausted window or no reading: the reset is unknown (null)", () => {
    const half = { primary: { usedPercent: 50, resetsAt: RESET_PRIMARY }, secondary: null };
    expect(codexLimitSignal(turnCompleted("usageLimitExceeded"), half)).toEqual({
      reason: "usage_limit",
      resetsAt: null,
    });
    expect(codexLimitSignal(turnCompleted("usageLimitExceeded"), null)?.resetsAt).toBeNull();
  });

  it("a final error notification with it is the same; one Codex retries is not a limit", () => {
    expect(codexLimitSignal(errorNote("usageLimitExceeded", false), exhausted)).toEqual({
      reason: "usage_limit",
      resetsAt: iso(RESET_PRIMARY),
    });
    expect(codexLimitSignal(errorNote("usageLimitExceeded", true), exhausted)).toBeNull();
  });

  it("unauthorized is auth_failed (no reset); rateLimitExceeded and other errors are not account limits", () => {
    expect(codexLimitSignal(turnCompleted("unauthorized"), exhausted)).toEqual({
      reason: "auth_failed",
      resetsAt: null,
    });
    expect(codexLimitSignal(errorNote("unauthorized", false), null)?.reason).toBe("auth_failed");
    expect(codexLimitSignal(turnCompleted("rateLimitExceeded"), exhausted)).toBeNull();
    expect(codexLimitSignal(turnCompleted("contextWindowExceeded"), exhausted)).toBeNull();
    expect(
      codexLimitSignal(turnCompleted({ httpConnectionFailed: { httpStatusCode: 429 } }), null),
    ).toBeNull();
    expect(codexLimitSignal(turnCompleted(null), exhausted)).toBeNull();
  });

  // 07.18-19 R1.6: codex-cli 0.172.0 `CodexErrorInfo` (`APISpendLimitExceeded(SpendLimitScope)` in codex-rs).
  it("a spend limit of the key, project or organization is billing (no reset)", () => {
    for (const info of [
      "apiKeySpendLimitExceeded",
      "projectSpendLimitExceeded",
      "organizationSpendLimitExceeded",
    ]) {
      expect(codexLimitSignal(turnCompleted(info), exhausted), info).toEqual({
        reason: "billing",
        resetsAt: null,
      });
      expect(codexLimitSignal(errorNote(info, false), null)?.reason, info).toBe("billing");
      expect(codexLimitSignal(errorNote(info, true), null), info).toBeNull();
    }
  });

  it("a completed turn and any other notification are not limits", () => {
    const ok = {
      method: "turn/completed",
      params: { threadId: "t1", turn: { id: "turn-1", status: "completed", items: [], error: null } },
    };
    expect(codexLimitSignal(ok, exhausted)).toBeNull();
    expect(codexLimitSignal({ method: "item/started", params: {} }, exhausted)).toBeNull();
    expect(codexLimitSignal({ method: "turn/completed" }, exhausted)).toBeNull();
  });

  it("a reset above 1e12 is read as milliseconds (A-07)", () => {
    const ms = { primary: { usedPercent: 100, resetsAt: RESET_PRIMARY * 1000 } };
    expect(codexLimitSignal(turnCompleted("usageLimitExceeded"), ms)?.resetsAt).toBe(iso(RESET_PRIMARY));
  });
});

describe("codexUsage (PD-09)", () => {
  const at = new Date("2026-11-24T10:00:00.000Z");

  it("primary and secondary become windows of the same names with their percent and reset", () => {
    expect(
      codexUsage(
        {
          primary: { usedPercent: 42.25, windowDurationMins: 300, resetsAt: RESET_PRIMARY },
          secondary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: null },
          planType: "plus",
        },
        at,
      ),
    ).toEqual({
      windows: [
        { kind: "primary", usedPercent: 42.3, resetsAt: iso(RESET_PRIMARY) },
        { kind: "secondary", usedPercent: 7, resetsAt: null },
      ],
      at: at.toISOString(),
    });
  });

  it("null windows are skipped; a snapshot with none is no reading; percentages are clamped to 0-100", () => {
    expect(codexUsage({ primary: null, secondary: { usedPercent: 130, resetsAt: null } }, at)).toEqual({
      windows: [{ kind: "secondary", usedPercent: 100, resetsAt: null }],
      at: at.toISOString(),
    });
    expect(codexUsage({ primary: null, secondary: null }, at)).toBeNull();
    expect(codexUsage({}, at)).toBeNull();
  });
});

describe("mergeCodexWindows", () => {
  it("a rolling update keeps the windows it leaves out; null clears one", () => {
    const prev = { primary: { usedPercent: 10, resetsAt: 1 }, secondary: { usedPercent: 20, resetsAt: 2 } };
    expect(mergeCodexWindows(prev, { primary: { usedPercent: 30, resetsAt: 3 } })).toEqual({
      primary: { usedPercent: 30, resetsAt: 3 },
      secondary: { usedPercent: 20, resetsAt: 2 },
    });
    expect(mergeCodexWindows(prev, { secondary: null })).toEqual({
      primary: { usedPercent: 10, resetsAt: 1 },
      secondary: null,
    });
    expect(mergeCodexWindows(null, { primary: { usedPercent: 5 } })).toEqual({
      primary: { usedPercent: 5 },
      secondary: null,
    });
  });
});
