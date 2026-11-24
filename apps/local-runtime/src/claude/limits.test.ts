import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { claudeLimitSignal, claudeResetsAt, claudeUsage } from "./limits.js";

const msg = (m: Record<string, unknown>) => m as unknown as SDKMessage;
const rateLimit = (info: Record<string, unknown>) => msg({ type: "rate_limit_event", rate_limit_info: info });
const assistant = (error?: string, text = "") =>
  msg({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: text ? [{ type: "text", text }] : [] },
    ...(error ? { error } : {}),
  });
const RESET_S = 1_795_000_000;
const RESET_ISO = new Date(RESET_S * 1000).toISOString();

describe("claudeLimitSignal (07.18 PD-24, A-07)", () => {
  it("a rejected rate_limit_event is a limit by window, with its reset", () => {
    expect(
      claudeLimitSignal(rateLimit({ status: "rejected", rateLimitType: "five_hour", resetsAt: RESET_S })),
    ).toEqual({ reason: "five_hour", resetsAt: RESET_ISO });
    const reason = (rateLimitType?: string) =>
      claudeLimitSignal(rateLimit({ status: "rejected", ...(rateLimitType ? { rateLimitType } : {}) }))
        ?.reason;
    expect(reason("seven_day")).toBe("seven_day");
    expect(reason("seven_day_overage_included")).toBe("seven_day");
    expect(reason("seven_day_opus")).toBe("weekly_model");
    expect(reason("seven_day_sonnet")).toBe("weekly_model");
    expect(reason("overage")).toBe("usage_limit");
    expect(reason()).toBe("unknown");
  });

  it("allowed and allowed_warning are not limits", () => {
    expect(claudeLimitSignal(rateLimit({ status: "allowed", rateLimitType: "five_hour" }))).toBeNull();
    expect(claudeLimitSignal(rateLimit({ status: "allowed_warning", utilization: 0.9 }))).toBeNull();
  });

  it("assistant errors map to rate_limit, billing and auth_failed", () => {
    expect(claudeLimitSignal(assistant("rate_limit"))).toEqual({ reason: "rate_limit", resetsAt: null });
    expect(claudeLimitSignal(assistant("billing_error"))).toEqual({ reason: "billing", resetsAt: null });
    expect(claudeLimitSignal(assistant("authentication_failed"))?.reason).toBe("auth_failed");
    expect(claudeLimitSignal(assistant("oauth_org_not_allowed"))?.reason).toBe("auth_failed");
    expect(claudeLimitSignal(assistant("overloaded"))).toBeNull();
    expect(claudeLimitSignal(assistant())).toBeNull();
  });

  it("a result or assistant text starting with an SDK usage-limit prefix is a usage limit", () => {
    const text = "You've hit your session limit · resets 3:45pm";
    expect(
      claudeLimitSignal(msg({ type: "result", subtype: "success", is_error: true, result: text })),
    ).toEqual({
      reason: "usage_limit",
      resetsAt: null,
    });
    expect(
      claudeLimitSignal(
        msg({ type: "result", subtype: "error_during_execution", is_error: true, errors: [text] }),
      ),
    ).toMatchObject({ reason: "usage_limit" });
    expect(claudeLimitSignal(assistant(undefined, text))).toMatchObject({ reason: "usage_limit" });
    expect(claudeLimitSignal(msg({ type: "result", subtype: "success", result: "All done." }))).toBeNull();
    expect(claudeLimitSignal(assistant(undefined, `Quoting: ${text}`))).toBeNull();
  });

  it("any other message is not a limit", () => {
    expect(claudeLimitSignal(msg({ type: "system", subtype: "init" }))).toBeNull();
    expect(claudeLimitSignal(msg({ type: "stream_event" }))).toBeNull();
  });

  it("reads resetsAt as epoch seconds, or milliseconds above 1e12", () => {
    expect(claudeResetsAt(rateLimit({ status: "allowed", resetsAt: RESET_S }))).toBe(RESET_ISO);
    expect(claudeResetsAt(rateLimit({ status: "allowed", resetsAt: RESET_S * 1000 }))).toBe(RESET_ISO);
    expect(claudeResetsAt(rateLimit({ status: "allowed" }))).toBeNull();
    expect(claudeResetsAt(rateLimit({ status: "allowed", resetsAt: "soon" }))).toBeNull();
    expect(claudeResetsAt(assistant("rate_limit"))).toBeNull();
  });

  it("pins the SDK prefixes it relies on (@alpha export)", () => {
    expect(USAGE_LIMIT_ERROR_PREFIXES).toContain("You've hit your");
  });
});

describe("claudeUsage (07.18 PD-09, A-07)", () => {
  const now = new Date("2026-11-24T12:00:00.000Z");
  it("a utilization fraction becomes one window in percent", () => {
    expect(
      claudeUsage(
        rateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: 0.42, resetsAt: RESET_S }),
        now,
      ),
    ).toEqual({
      windows: [{ kind: "five_hour", usedPercent: 42, resetsAt: RESET_ISO }],
      at: now.toISOString(),
    });
    expect(
      claudeUsage(rateLimit({ status: "allowed", rateLimitType: "seven_day_opus", utilization: 1.2 }), now),
    ).toEqual({
      windows: [{ kind: "weekly_model", usedPercent: 100, resetsAt: null }],
      at: now.toISOString(),
    });
    expect(claudeUsage(rateLimit({ status: "allowed", utilization: 0.291 }), now)?.windows[0]).toEqual({
      kind: "other",
      usedPercent: 29.1,
      resetsAt: null,
    });
  });

  it("no utilization, no usage", () => {
    expect(claudeUsage(rateLimit({ status: "rejected", rateLimitType: "five_hour" }), now)).toBeNull();
    expect(claudeUsage(assistant("rate_limit"), now)).toBeNull();
  });
});
