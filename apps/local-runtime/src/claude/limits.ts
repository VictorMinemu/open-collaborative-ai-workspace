// 07.18 (D-07, D-09, PD-09, PD-24, A-07): pure limit and usage detection from Claude Agent SDK messages. Detection only:
// the server decides what a limit does (cooldown, switch). Nothing here reads or carries a credential.
//
// - `rate_limit_event` (`SDKRateLimitInfo`, sdk.d.ts:5585): `status: "rejected"` is a limit by window; `utilization`
//   (a fraction) is a usage reading; `resetsAt` is epoch seconds (a value above 1e12 is read as milliseconds).
// - `SDKAssistantMessage.error` (sdk.d.ts:3683): `rate_limit`, `billing_error`, `authentication_failed`,
//   `oauth_org_not_allowed`.
// - A result or assistant text starting with one of the SDK's `USAGE_LIMIT_ERROR_PREFIXES` (@alpha, pinned by a test).

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

function windowReason(type: unknown): PoolLimitReason {
  switch (type) {
    case "five_hour":
      return "five_hour";
    case "seven_day":
    case "seven_day_overage_included":
      return "seven_day";
    case "seven_day_opus":
    case "seven_day_sonnet":
      return "weekly_model";
    case "overage":
      return "usage_limit";
    default:
      return "unknown";
  }
}

function windowKind(type: unknown): AccountUsageWindowKind {
  const reason = windowReason(type);
  return reason === "five_hour" || reason === "seven_day" || reason === "weekly_model" ? reason : "other";
}

const ASSISTANT_ERRORS: Readonly<Record<string, PoolLimitReason>> = {
  rate_limit: "rate_limit",
  billing_error: "billing",
  authentication_failed: "auth_failed",
  oauth_org_not_allowed: "auth_failed",
};

function startsWithUsagePrefix(text: string): boolean {
  const t = text.trimStart();
  return USAGE_LIMIT_ERROR_PREFIXES.some((p) => t.startsWith(p));
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

/** The account limit a message reports (PD-24), or null. */
export function claudeLimitSignal(msg: SDKMessage): ClaudeLimit | null {
  const info = rateLimitInfo(msg);
  if (info) {
    if (info.status !== "rejected") return null;
    return { reason: windowReason(info.rateLimitType), resetsAt: epochToIso(info.resetsAt) };
  }
  if (msg.type === "assistant") {
    const error = (msg as { error?: unknown }).error;
    if (typeof error === "string") {
      const reason = ASSISTANT_ERRORS[error];
      return reason ? { reason, resetsAt: null } : null;
    }
  }
  if (messageTexts(msg).some(startsWithUsagePrefix)) return { reason: "usage_limit", resetsAt: null };
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
