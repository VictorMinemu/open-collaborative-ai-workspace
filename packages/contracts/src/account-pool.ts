import { z } from "zod";
import { IsoDateTime } from "./common";

/**
 * Phase 07.18 (D-02, D-13, ADR-0044): the organization's pool of Claude and ChatGPT subscription accounts.
 *
 * Imports only `zod`, `common` and `session-events`; nothing it imports may import it back.
 *
 * This file defines no schema that carries a token toward a browser, the audit log or a log line. The token schema
 * (`ClaudeSetupToken`) is reused only by the payloads that go to the device that runs a session (`SessionAccount` in
 * `device-link.ts`) and to the cell (`CellAccountPool` in `agent-channel.ts`), plus the admin's own add/replace request.
 */

/** Bounds shared by the API, the daemon, the plugin and the web. */
export const POOL_LIMITS = {
  labelMax: 120,
  weightMin: 1,
  weightMax: 100,
  accountsPerProvider: 20,
  slotsPerDevice: 10,
  switchesPerTurn: 3,
  defaultCooldownMs: 300_000,
  maxCooldownMs: 604_800_000,
  tokenMin: 20,
  tokenMax: 512,
  signInCodeTtlMs: 900_000,
} as const;

/** A label an admin types (e.g. the account's e-mail); never read from a device or a provider. */
export const PoolLabel = z.string().trim().min(1).max(POOL_LIMITS.labelMax);
export type PoolLabel = z.infer<typeof PoolLabel>;

const API_KEY_PREFIX = "sk-ant-api";

/**
 * A long-lived token made with `claude setup-token` (PD-22). An Anthropic API key (`sk-ant-api…`) is refused: org API
 * keys already live in Settings › Models.
 */
export const ClaudeSetupToken = z
  .string()
  .trim()
  .min(POOL_LIMITS.tokenMin)
  .max(POOL_LIMITS.tokenMax)
  .regex(/^sk-ant-[A-Za-z0-9_-]+$/, "A Claude setup-token starts with sk-ant-")
  .refine((t) => !t.startsWith(API_KEY_PREFIX), {
    message: "This is an API key. Add it in Settings › Models.",
  });
export type ClaudeSetupToken = z.infer<typeof ClaudeSetupToken>;

/** Why an account stopped serving (PD-23, PD-24). `auth_failed` means it needs a new sign-in, not a cooldown. */
export const PoolLimitReason = z.enum([
  "five_hour",
  "seven_day",
  "weekly_model",
  "usage_limit",
  "rate_limit",
  "billing",
  "auth_failed",
  "unknown",
]);
export type PoolLimitReason = z.infer<typeof PoolLimitReason>;

/** Why a device or cell sign-in ended without an account. */
export const PoolSignInErrorCode = z.enum([
  "expired",
  "denied",
  "cancelled",
  "device_offline",
  "runtime_too_old",
  "cell_offline",
  "unsupported",
  "failed",
]);
export type PoolSignInErrorCode = z.infer<typeof PoolSignInErrorCode>;

/** Usage windows as runtimes report them (Claude five-hour / seven-day / weekly model; Codex primary / secondary). */
export const AccountUsageWindowKind = z.enum([
  "five_hour",
  "seven_day",
  "weekly_model",
  "primary",
  "secondary",
  "other",
]);
export type AccountUsageWindowKind = z.infer<typeof AccountUsageWindowKind>;

export const AccountUsageWindow = z.object({
  kind: AccountUsageWindowKind,
  usedPercent: z.number().min(0).max(100).nullable(),
  resetsAt: IsoDateTime.nullable(),
});
export type AccountUsageWindow = z.infer<typeof AccountUsageWindow>;

/** The last usage a runtime reported for one account (D-09); never polled. */
export const AccountUsageSnapshot = z.object({
  windows: z.array(AccountUsageWindow).max(6),
  at: IsoDateTime,
});
export type AccountUsageSnapshot = z.infer<typeof AccountUsageSnapshot>;
