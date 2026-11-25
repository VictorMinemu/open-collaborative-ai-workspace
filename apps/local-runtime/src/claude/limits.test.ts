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
  it("a rejected subscription window is a limit by window, with its reset", () => {
    expect(
      claudeLimitSignal(rateLimit({ status: "rejected", rateLimitType: "five_hour", resetsAt: RESET_S })),
    ).toEqual({ reason: "five_hour", resetsAt: RESET_ISO });
    const reason = (rateLimitType?: string) =>
      claudeLimitSignal(rateLimit({ status: "rejected", ...(rateLimitType ? { rateLimitType } : {}) }))
        ?.reason;
    expect(reason("seven_day")).toBe("seven_day");
    expect(reason("seven_day_opus")).toBe("weekly_model");
    expect(reason("seven_day_sonnet")).toBe("weekly_model");
    expect(reason()).toBe("unknown");
    expect(reason("a_window_this_build_does_not_know")).toBe("unknown");
  });

  it("allowed and allowed_warning are not limits", () => {
    expect(claudeLimitSignal(rateLimit({ status: "allowed", rateLimitType: "five_hour" }))).toBeNull();
    expect(claudeLimitSignal(rateLimit({ status: "allowed_warning", utilization: 0.9 }))).toBeNull();
  });

  // R1.1 (07.18-19): CLI 2.1.331 sets isUsingOverage = status === "rejected" && overageStatus in (allowed,
  // allowed_warning): the window is spent but the request is served from overage, so the account still works.
  it("a rejected window served from overage is not a limit", () => {
    const five = { status: "rejected", rateLimitType: "five_hour", resetsAt: RESET_S };
    expect(claudeLimitSignal(rateLimit({ ...five, isUsingOverage: true }))).toBeNull();
    expect(claudeLimitSignal(rateLimit({ ...five, overageStatus: "allowed" }))).toBeNull();
    expect(claudeLimitSignal(rateLimit({ ...five, overageStatus: "allowed_warning" }))).toBeNull();
    expect(claudeLimitSignal(rateLimit({ status: "rejected", isUsingOverage: true }))).toBeNull();
    expect(
      claudeLimitSignal(
        rateLimit({ status: "rejected", rateLimitType: "seven_day", overageStatus: "allowed" }),
      ),
    ).toBeNull();
    // Overage refused as well: the window really is spent.
    expect(
      claudeLimitSignal(rateLimit({ ...five, overageStatus: "rejected", isUsingOverage: false })),
    ).toEqual({ reason: "five_hour", resetsAt: RESET_ISO });
  });

  // R1.2 (07.18-19): only the shared 5h / 7d windows take an account out (CLIProxyAPI's rule).
  it("an overage-only, included-allowance or credits rejection never cools the account", () => {
    expect(claudeLimitSignal(rateLimit({ status: "rejected", rateLimitType: "overage" }))).toBeNull();
    expect(
      claudeLimitSignal(
        rateLimit({ status: "rejected", rateLimitType: "overage", overageStatus: "rejected" }),
      ),
    ).toBeNull();
    expect(
      claudeLimitSignal(rateLimit({ status: "rejected", rateLimitType: "seven_day_overage_included" })),
    ).toBeNull();
    expect(claudeLimitSignal(rateLimit({ status: "rejected", errorCode: "credits_required" }))).toBeNull();
  });

  it("a per-minute rate_limit error (no usage-limit notice) is not an account limit", () => {
    expect(claudeLimitSignal(assistant("rate_limit"))).toBeNull();
    expect(claudeLimitSignal(assistant("rate_limit", "API Error: Rate limit reached"))).toBeNull();
  });

  const apiError = (
    error: string,
    text: string,
    api_error: string,
    rate_limit_info?: Record<string, unknown>,
  ) =>
    msg({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text }] },
      error,
      is_api_error_message: true,
      api_error,
      ...(rate_limit_info ? { api_error_params: { rate_limit_info } } : {}),
    });

  it("a typed usage_limit_reached error is decided by its rate_limit_info", () => {
    const notice = "You've hit your session limit · resets 3:45pm";
    expect(
      claudeLimitSignal(
        apiError("rate_limit", notice, "usage_limit_reached", {
          status: "rejected",
          rateLimitType: "five_hour",
          resetsAt: RESET_S,
        }),
      ),
    ).toEqual({ reason: "five_hour", resetsAt: RESET_ISO });
    expect(
      claudeLimitSignal(
        apiError("rate_limit", "You're out of extra usage", "usage_limit_reached", {
          status: "rejected",
          rateLimitType: "overage",
        }),
      ),
    ).toBeNull();
    // No record: the notice decides.
    expect(claudeLimitSignal(apiError("rate_limit", notice, "usage_limit_reached"))).toMatchObject({
      reason: "usage_limit",
    });
  });

  it("a fast-mode or long-context credits error is never an account limit, whatever its text says", () => {
    const text = "You've hit your monthly spend limit. Switch to another model to continue.";
    for (const kind of ["model_requires_usage_credits", "long_context_credits_required"]) {
      expect(
        claudeLimitSignal(
          apiError("rate_limit", text, kind, { status: "rejected", rateLimitType: "five_hour" }),
        ),
        kind,
      ).toBeNull();
      expect(
        claudeLimitSignal(
          msg({ type: "result", subtype: "success", is_error: true, api_error: kind, result: text }),
        ),
        kind,
      ).toBeNull();
    }
  });

  it("assistant errors map to billing and auth_failed", () => {
    expect(claudeLimitSignal(assistant("billing_error"))).toEqual({ reason: "billing", resetsAt: null });
    expect(claudeLimitSignal(assistant("authentication_failed"))?.reason).toBe("auth_failed");
    expect(claudeLimitSignal(assistant("oauth_org_not_allowed"))?.reason).toBe("auth_failed");
    expect(claudeLimitSignal(assistant("overloaded"))).toBeNull();
    expect(claudeLimitSignal(assistant())).toBeNull();
  });

  // R1.4 (07.18-19): SDKAssistantMessageError (0.3.282) also has these two account states.
  it("an account on hold or needing verification is auth_failed", () => {
    expect(claudeLimitSignal(assistant("account_on_hold"))).toEqual({
      reason: "auth_failed",
      resetsAt: null,
    });
    expect(claudeLimitSignal(assistant("verification_required"))).toEqual({
      reason: "auth_failed",
      resetsAt: null,
    });
  });

  it("a usage-limit notice on an error result or an error assistant message is a usage limit", () => {
    const text = "You've hit your session limit · resets 3:45pm";
    expect(
      claudeLimitSignal(msg({ type: "result", subtype: "success", is_error: true, result: text })),
    ).toEqual({ reason: "usage_limit", resetsAt: null });
    expect(
      claudeLimitSignal(
        msg({ type: "result", subtype: "error_during_execution", is_error: true, errors: [text] }),
      ),
    ).toMatchObject({ reason: "usage_limit" });
    expect(claudeLimitSignal(assistant("rate_limit", text))).toMatchObject({ reason: "usage_limit" });
    expect(
      claudeLimitSignal(assistant("unknown", "You've reached your Fable limit for this week")),
    ).toMatchObject({ reason: "usage_limit" });
    expect(claudeLimitSignal(msg({ type: "result", subtype: "success", result: "All done." }))).toBeNull();
    expect(claudeLimitSignal(assistant("rate_limit", `Quoting: ${text}`))).toBeNull();
  });

  // R1.3 (07.18-19): a model reply may well start with "You've hit your…"; only an error carries the notice.
  it("normal reply text is never a limit, whatever it starts with", () => {
    const text = "You've hit your session limit · resets 3:45pm";
    expect(claudeLimitSignal(assistant(undefined, text))).toBeNull();
    expect(
      claudeLimitSignal(msg({ type: "result", subtype: "success", is_error: false, result: text })),
    ).toBeNull();
    expect(claudeLimitSignal(msg({ type: "result", subtype: "success", result: text }))).toBeNull();
  });

  it("a credits notice is not a window limit", () => {
    for (const text of [
      "You're out of usage credits · resets 3pm",
      "Fable 5 requires usage credits. Switch to another model to continue.",
      "Your seat type doesn't include usage credits",
      "You're out of extra usage",
    ]) {
      expect(claudeLimitSignal(assistant("rate_limit", text)), text).toBeNull();
      expect(
        claudeLimitSignal(msg({ type: "result", subtype: "success", is_error: true, result: text })),
        text,
      ).toBeNull();
    }
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
    expect(USAGE_LIMIT_ERROR_PREFIXES).toContain("You've reached your");
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

  it("a rejected window served from overage still gives its usage reading (R1.1)", () => {
    expect(
      claudeUsage(
        rateLimit({ status: "rejected", rateLimitType: "five_hour", isUsingOverage: true, utilization: 1 }),
        now,
      )?.windows,
    ).toEqual([{ kind: "five_hour", usedPercent: 100, resetsAt: null }]);
  });

  it("no utilization, no usage", () => {
    expect(claudeUsage(rateLimit({ status: "rejected", rateLimitType: "five_hour" }), now)).toBeNull();
    expect(claudeUsage(assistant("rate_limit"), now)).toBeNull();
  });
});
