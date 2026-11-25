// 07.18 (D-07, D-09, PD-09, PD-24, A-07): pure limit and usage detection from Claude Agent SDK messages. Detection only:
// the server decides what a limit does (cooldown, switch). Nothing here reads or carries a credential.
//
// - `rate_limit_event` (`SDKRateLimitInfo`, sdk.d.ts:5585): `utilization` (a fraction) is a usage reading; `resetsAt`
//   is epoch seconds (a value above 1e12 is read as milliseconds). `status: "rejected"` is an account limit only for a
//   shared subscription window (07.18-19 R1.1, R1.2; CLIProxyAPI's rule: only the 5h / 7d unified windows take an
//   account out):
//   - served from overage is not a limit: CLI 2.1.331 computes `isUsingOverage = status === "rejected" &&
//     (overageStatus === "allowed" || overageStatus === "allowed_warning")`, the request still runs;
//   - `five_hour`, `seven_day`, `seven_day_opus|sonnet` are limits; a type this build does not know is `unknown`;
//   - `overage` (the overage pot), `seven_day_overage_included` (a model's included allowance, CLIProxyAPI's "7d_oi"
//     Fable-only claim) and `errorCode: "credits_required"` are model or credit refusals, never an account limit.
// - `SDKAssistantMessage.error` (sdk.d.ts:3683): `billing_error` → billing; `authentication_failed`,
//   `oauth_org_not_allowed`, `account_on_hold`, `verification_required` → auth_failed. `rate_limit` alone is any 429
//   (a per-minute limit too) and is not an account limit; its notice text or typed record decides (below).
// - The CLI's typed error kind (`api_error`, an @internal wire field of 2.1.331 on assistant and result messages):
//   `usage_limit_reached` carries the refusal's `api_error_params.rate_limit_info`, judged like a `rate_limit_event`;
//   `model_requires_usage_credits` and `long_context_credits_required` (fast mode, 1M context) are never limits.
// - Fallback: an error message (assistant with `error`, result with `is_error`) whose text starts with a window-limit
//   notice of the SDK's `USAGE_LIMIT_ERROR_PREFIXES` (@alpha, pinned by a test). Normal reply text never counts
//   (R1.3), and the credit notices of that list ("You're out of usage credits", "… requires usage credits", …) do not
//   either (R1.2).

import { type SDKMessage, USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk";
import type { AccountUsageSnapshot, AccountUsageWindowKind, PoolLimitReason } from "@ocw/contracts";

export interface ClaudeLimit {
  reason: PoolLimitReason;
  /** ISO time the limit resets, when the message says so. */
  resetsAt: string | null;
}

type RateLimitInfo = {
  status?: unknown;
  rateLimitType?: unknown;
  resetsAt?: unknown;
  utilization?: unknown;
  overageStatus?: unknown;
  isUsingOverage?: unknown;
  errorCode?: unknown;
};

function rateLimitInfo(msg: SDKMessage): RateLimitInfo | null {
  if (msg.type !== "rate_limit_event") return null;
  const info = (msg as { rate_limit_info?: unknown }).rate_limit_info;
  return info && typeof info === "object" ? (info as RateLimitInfo) : null;
}

/** Epoch seconds (or milliseconds above 1e12) → ISO; anything else → null. */
function epochToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const ms = value > 1e12 ? value : value * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The account limit a window type names (null: a model or credit refusal, never an account limit). */
function windowReason(type: unknown): PoolLimitReason | null {
  switch (type) {
    case "five_hour":
      return "five_hour";
    case "seven_day":
      return "seven_day";
    case "seven_day_opus":
    case "seven_day_sonnet":
      return "weekly_model";
    case "overage":
    case "seven_day_overage_included":
      return null;
    default:
      return "unknown";
  }
}

function windowKind(type: unknown): AccountUsageWindowKind {
  switch (type) {
    case "five_hour":
      return "five_hour";
    case "seven_day":
    case "seven_day_overage_included":
      return "seven_day";
    case "seven_day_opus":
    case "seven_day_sonnet":
      return "weekly_model";
    default:
      return "other";
  }
}

/** R1.1: the window is spent but the request is served from overage, so the account still works. */
function servedFromOverage(info: RateLimitInfo): boolean {
  return (
    info.isUsingOverage === true ||
    info.overageStatus === "allowed" ||
    info.overageStatus === "allowed_warning"
  );
}

/** A rate-limit record (an event, or a typed refusal's) as an account limit (R1.1, R1.2), or null. */
function limitOfInfo(info: RateLimitInfo): ClaudeLimit | null {
  if (info.status !== "rejected" || servedFromOverage(info) || info.errorCode === "credits_required")
    return null;
  const reason = windowReason(info.rateLimitType);
  return reason ? { reason, resetsAt: epochToIso(info.resetsAt) } : null;
}

const ASSISTANT_ERRORS: Readonly<Record<string, PoolLimitReason>> = {
  billing_error: "billing",
  authentication_failed: "auth_failed",
  oauth_org_not_allowed: "auth_failed",
  account_on_hold: "auth_failed",
  verification_required: "auth_failed",
};

/** The CLI's typed error kinds (2.1.331 `api_error`) that are credit refusals, never an account limit (R1.2). */
const CREDIT_API_ERRORS: ReadonlySet<string> = new Set([
  "model_requires_usage_credits",
  "long_context_credits_required",
]);

/** The window-limit notices of the SDK's list ("You've hit your session limit", "You've reached your … limit"). */
const WINDOW_LIMIT_PREFIXES: readonly string[] = USAGE_LIMIT_ERROR_PREFIXES.filter(
  (p) => p.startsWith("You've hit your") || p.startsWith("You've reached your"),
);

function startsWithWindowNotice(text: string): boolean {
  const t = text.trimStart();
  return WINDOW_LIMIT_PREFIXES.some((p) => t.startsWith(p));
}

/** Whether the message is an error (R1.3): only an error can carry a usage-limit notice. */
function isErrorMessage(msg: SDKMessage): boolean {
  if (msg.type === "result") return (msg as { is_error?: unknown }).is_error === true;
  if (msg.type === "assistant") return typeof (msg as { error?: unknown }).error === "string";
  return false;
}

/** The CLI's typed error kind and its rate-limit record, when the message has them (lenient: @internal fields). */
function typedApiError(msg: SDKMessage): { kind: string | null; info: RateLimitInfo | null } {
  const m = msg as { api_error?: unknown; api_error_params?: { rate_limit_info?: unknown } | null };
  const kind = typeof m.api_error === "string" ? m.api_error : null;
  const info = m.api_error_params?.rate_limit_info;
  return { kind, info: info && typeof info === "object" ? (info as RateLimitInfo) : null };
}

/** The texts a message carries that a usage-limit notice can be: a result's text and errors, an assistant's text. */
function messageTexts(msg: SDKMessage): string[] {
  if (msg.type === "result") {
    const m = msg as { result?: unknown; errors?: unknown };
    const out = typeof m.result === "string" ? [m.result] : [];
    if (Array.isArray(m.errors)) for (const e of m.errors) if (typeof e === "string") out.push(e);
    return out;
  }
  if (msg.type === "assistant") {
    const content = (msg as { message?: { content?: unknown } }).message?.content;
    if (typeof content === "string") return [content];
    if (!Array.isArray(content)) return [];
    return content
      .filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text);
  }
  return [];
}

/** The account limit a message reports (PD-24, 07.18-19 R1.1-R1.4), or null. */
export function claudeLimitSignal(msg: SDKMessage): ClaudeLimit | null {
  const info = rateLimitInfo(msg);
  if (info) return limitOfInfo(info);
  if (!isErrorMessage(msg)) return null;
  if (msg.type === "assistant") {
    const reason = ASSISTANT_ERRORS[(msg as { error: string }).error];
    if (reason) return { reason, resetsAt: null };
  }
  const typed = typedApiError(msg);
  if (typed.kind && CREDIT_API_ERRORS.has(typed.kind)) return null;
  if (typed.kind === "usage_limit_reached" && typed.info) return limitOfInfo(typed.info);
  if (messageTexts(msg).some(startsWithWindowNotice)) return { reason: "usage_limit", resetsAt: null };
  return null;
}

/** The reset time a `rate_limit_event` names (any status), or null. */
export function claudeResetsAt(msg: SDKMessage): string | null {
  return epochToIso(rateLimitInfo(msg)?.resetsAt);
}

/** A usage reading (PD-09): `utilization` as one window in percent, or null when the message has none. */
export function claudeUsage(msg: SDKMessage, now: Date = new Date()): AccountUsageSnapshot | null {
  const info = rateLimitInfo(msg);
  if (!info || typeof info.utilization !== "number" || !Number.isFinite(info.utilization)) return null;
  const percent = Math.min(100, Math.max(0, Math.round(info.utilization * 1000) / 10));
  return {
    windows: [
      { kind: windowKind(info.rateLimitType), usedPercent: percent, resetsAt: epochToIso(info.resetsAt) },
    ],
    at: now.toISOString(),
  };
}
