import {
  type AccountUsageSnapshot,
  type AccountUsageWindowKind,
  POOL_LIMITS,
  POOL_STRATEGY_TEXT,
  type PoolAccount,
  type PoolStrategy,
} from "@ocw/contracts";
import { relativeTime } from "./utils";

/**
 * Settings › Account pool texts (Phase 07.18, D-09, D-10): pure functions over what the API sent, so the page and its
 * tests read the same words.
 */

const DAY_KEY: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };

/**
 * A reset time: "15:40" today, "Tue 15:40" on another day (a cooldown is at most 7 days, so the weekday is enough).
 * The viewer's locale and time zone unless given.
 */
export function poolTime(
  iso: string,
  opts: { now?: number; timeZone?: string; locale?: string } = {},
): string {
  const at = new Date(iso);
  const now = new Date(opts.now ?? Date.now());
  const zone = opts.timeZone ? { timeZone: opts.timeZone } : {};
  const time = at.toLocaleTimeString(opts.locale ?? [], {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...zone,
  });
  const day = (d: Date) => d.toLocaleDateString("en-CA", { ...DAY_KEY, ...zone });
  if (day(at) === day(now)) return time;
  const weekday = at.toLocaleDateString(opts.locale ?? [], { weekday: "short", ...zone });
  return `${weekday} ${time}`;
}

/** The status chip: Ready, Cooling until 15:40, Needs sign-in (a token: Paste a new token), Off. */
export function accountStatusText(
  a: Pick<PoolAccount, "status" | "kind" | "cooldownUntil">,
  formatTime: (iso: string) => string = (iso) => poolTime(iso),
): string {
  switch (a.status) {
    case "ready":
      return "Ready";
    case "cooling":
      return a.cooldownUntil ? `Cooling until ${formatTime(a.cooldownUntil)}` : "Cooling";
    case "needs_sign_in":
      return a.kind === "token" ? "Paste a new token" : "Needs sign-in";
    case "disabled":
      return "Off";
  }
}

/** Where the credential lives (D-02). */
export function accountLocationText(a: Pick<PoolAccount, "kind" | "device">): string {
  switch (a.kind) {
    case "token":
      return "Sealed on the server";
    case "device_slot":
      if (!a.device) return "On a device";
      return a.device.online ? `On ${a.device.name}` : `On ${a.device.name} · offline`;
    case "cell_profile":
      return "Bots runtime";
  }
}

const WINDOW_LABELS: Record<AccountUsageWindowKind, string> = {
  five_hour: "5 hours",
  seven_day: "7 days",
  weekly_model: "Weekly model",
  primary: "Primary",
  secondary: "Secondary",
  other: "Other",
};

export interface UsageBar {
  kind: AccountUsageWindowKind;
  label: string;
  /** Whole percent used, 0–100. */
  percent: number;
  resetsAt: string | null;
}

/** One bar per window the runtime reported with a number (D-09); none → []. */
export function usageBars(usage: AccountUsageSnapshot | null): UsageBar[] {
  if (!usage) return [];
  return usage.windows.flatMap((w) =>
    w.usedPercent === null
      ? []
      : [
          {
            kind: w.kind,
            label: WINDOW_LABELS[w.kind],
            percent: Math.min(100, Math.max(0, Math.round(w.usedPercent))),
            resetsAt: w.resetsAt,
          },
        ],
  );
}

export interface StrategyOption {
  value: PoolStrategy;
  label: string;
  description: string;
}

/** The strategy picker's options, in the contract's words (D-04): failover first, the default. */
export function strategyOptions(): StrategyOption[] {
  return (["failover", "round_robin", "weighted"] as const).map((value) => ({
    value,
    label: POOL_STRATEGY_TEXT[value].label,
    description: POOL_STRATEGY_TEXT[value].description,
  }));
}

/** "Used 5 minutes ago" / "Not used yet". */
export function lastUsedText(lastUsedAt: string | null, now: number = Date.now()): string {
  return lastUsedAt ? `Used ${relativeTime(lastUsedAt, now)}` : "Not used yet";
}

/** The provider's new order after moving one account up (-1) or down (1); null when it cannot move. */
export function moveInOrder(ids: readonly string[], id: string, by: -1 | 1): string[] | null {
  const at = ids.indexOf(id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  next[at] = ids[to] as string;
  next[to] = id;
  return next;
}

const WEIGHT_INVALID = `Enter a whole number from ${POOL_LIMITS.weightMin} to ${POOL_LIMITS.weightMax}`;

/** What the API would refuse for a weight, refused before sending; null when fine. */
export function weightError(value: string): string | null {
  const v = value.trim();
  if (!/^\d+$/.test(v)) return WEIGHT_INVALID;
  const n = Number(v);
  return n >= POOL_LIMITS.weightMin && n <= POOL_LIMITS.weightMax ? null : WEIGHT_INVALID;
}
