// 07.18 (D-07, D-09, PD-09, PD-23, A-07): pure limit and usage detection from `codex app-server` v2 notifications.
// Detection only: the server decides what a limit does (cooldown, switch). Nothing here reads or carries a credential.
//
// - A turn that ends with `turn.error.codexErrorInfo === "usageLimitExceeded"` (`turn/completed`), or an `error`
//   notification with it and `willRetry: false`, is a `usage_limit`; `unauthorized` is `auth_failed`; a spend limit of
//   the API key, project or organization (`apiKeySpendLimitExceeded`, `projectSpendLimitExceeded`,
//   `organizationSpendLimitExceeded`, codex-cli 0.172.0; 07.18-19 R1.6) is `billing`. Everything else
//   (`rateLimitExceeded`, which Codex retries, connection failures, …) is not an account limit.
// - The reset is the latest `resetsAt` among the last reported windows at 100 % or more (epoch seconds, a value above
//   1e12 read as milliseconds), else unknown. Codex's own protocol comment says clients "must not infer recovery from
//   percentages", so the server treats an unknown reset with its default cooldown (PD-08).
// - `account/rateLimits/updated` and `account/rateLimits/read` (`RateLimitSnapshot`, codex-cli 0.172.0) carry
//   `primary` / `secondary` windows `{ usedPercent, windowDurationMins, resetsAt }`; a rolling update may leave one out.

import type { AccountUsageSnapshot, AccountUsageWindow, PoolLimitReason } from "@ocw/contracts";
import type { CodexRateLimitWindow } from "../accounts/codex-protocol.js";

export interface CodexLimit {
  reason: PoolLimitReason;
  /** ISO time the exhausted window resets, when the last reading says so. */
  resetsAt: string | null;
}

/** The windows remembered for a session: the last value of each, null when Codex cleared or never sent it. */
export type CodexWindows = {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
};

type WindowInput = CodexRateLimitWindow | null | undefined;
/** A `RateLimitSnapshot` (or the remembered windows): only `primary` and `secondary` are read; other keys pass. */
type RateLimitWindows = { primary?: WindowInput; secondary?: WindowInput; [key: string]: unknown };
type WindowsInput = RateLimitWindows | null | undefined;

/** Epoch seconds (or milliseconds above 1e12) → ISO; anything else → null. */
function epochToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const d = new Date(value > 1e12 ? value : value * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The `codexErrorInfo` a notification ends its turn with, or null (an error Codex retries ends nothing). */
function finalErrorInfo(n: { method: string; params?: unknown }): unknown {
  const p = n.params as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return null;
  if (n.method === "turn/completed") {
    const turn = p.turn as { error?: { codexErrorInfo?: unknown } | null } | undefined;
    return turn?.error?.codexErrorInfo ?? null;
  }
  if (n.method === "error") {
    if (p.willRetry === true) return null;
    return (p.error as { codexErrorInfo?: unknown } | undefined)?.codexErrorInfo ?? null;
  }
  return null;
}

/** The latest reset among the windows at 100 % or more, or null. */
function exhaustedResetsAt(windows: WindowsInput): string | null {
  let latest: number | null = null;
  for (const w of [windows?.primary, windows?.secondary]) {
    if (!w || typeof w.usedPercent !== "number" || w.usedPercent < 100) continue;
    const iso = epochToIso(w.resetsAt);
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (latest === null || ms > latest) latest = ms;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

/** Codex's spend-limit errors (codex-rs `APISpendLimitExceeded(SpendLimitScope)`): the account's billing refuses. */
const SPEND_LIMIT_ERRORS: ReadonlySet<string> = new Set([
  "apiKeySpendLimitExceeded",
  "projectSpendLimitExceeded",
  "organizationSpendLimitExceeded",
]);

/** The account limit a notification reports (PD-23), or null. */
export function codexLimitSignal(
  n: { method: string; params?: unknown },
  lastWindows: WindowsInput,
): CodexLimit | null {
  const info = finalErrorInfo(n);
  if (info === "usageLimitExceeded")
    return { reason: "usage_limit", resetsAt: exhaustedResetsAt(lastWindows) };
  if (info === "unauthorized") return { reason: "auth_failed", resetsAt: null };
  if (typeof info === "string" && SPEND_LIMIT_ERRORS.has(info)) return { reason: "billing", resetsAt: null };
  return null;
}

function usageWindow(kind: "primary" | "secondary", w: WindowInput): AccountUsageWindow | null {
  if (!w) return null;
  const used =
    typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent)
      ? Math.min(100, Math.max(0, Math.round(w.usedPercent * 10) / 10))
      : null;
  return { kind, usedPercent: used, resetsAt: epochToIso(w.resetsAt) };
}

/** A usage reading (PD-09): the primary and secondary windows that are present, or null when none is. */
export function codexUsage(snapshot: RateLimitWindows, now: Date = new Date()): AccountUsageSnapshot | null {
  const windows = [
    usageWindow("primary", snapshot.primary),
    usageWindow("secondary", snapshot.secondary),
  ].filter((w): w is AccountUsageWindow => w !== null);
  return windows.length ? { windows, at: now.toISOString() } : null;
}

/** A rolling update over the remembered windows: a window left out keeps its last value, an explicit null clears it. */
export function mergeCodexWindows(prev: CodexWindows | null, next: RateLimitWindows): CodexWindows {
  return {
    primary: next.primary !== undefined ? next.primary : (prev?.primary ?? null),
    secondary: next.secondary !== undefined ? next.secondary : (prev?.secondary ?? null),
  };
}
