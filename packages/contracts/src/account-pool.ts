import { z } from "zod";
import { Id, IsoDateTime } from "./common";
import type { RuntimeId } from "./session-events";

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

// ---- providers, strategies, scopes (D-01, D-04, PD-18) ----

/** One pool per organization and provider: Claude (Pro/Max/Team) and ChatGPT (Plus/Pro/Business) accounts. */
export const PoolProvider = z.enum(["claude", "chatgpt"]);
export type PoolProvider = z.infer<typeof PoolProvider>;

/** The pool a Work Zone runtime draws from. */
export const POOL_PROVIDER_OF_RUNTIME: Readonly<Record<RuntimeId, PoolProvider>> = {
  "claude-code": "claude",
  codex: "chatgpt",
};

/** The stored strategy (D-04). Sticky per session: it picks only when a session starts or must change (D-05). */
export const PoolStrategy = z.enum(["failover", "round_robin", "weighted"]);
export type PoolStrategy = z.infer<typeof PoolStrategy>;

/** What an admin may choose: `fill_first` is the same as `failover` and is stored as it. */
export const PoolStrategyChoice = z.enum(["failover", "fill_first", "round_robin", "weighted"]);
export type PoolStrategyChoice = z.infer<typeof PoolStrategyChoice>;

export function normalizeStrategy(choice: PoolStrategyChoice): PoolStrategy {
  return choice === "fill_first" ? "failover" : choice;
}

/** User-facing strategy texts (Settings › Account pool, the new-session account line). */
export const POOL_STRATEGY_TEXT: Readonly<
  Record<PoolStrategy, { readonly label: string; readonly short: string; readonly description: string }>
> = {
  failover: {
    label: "Use one until its limit, then the next",
    short: "failover",
    description: "The first ready account in your order. The next one only while it cools down.",
  },
  round_robin: {
    label: "Round-robin",
    short: "round-robin",
    description: "The ready account used least recently.",
  },
  weighted: {
    label: "Weighted",
    short: "weighted",
    description: "Ready accounts in proportion to their weight.",
  },
};

/** OpenClaw has no weighted mode (PD-13). */
export const BOTS_WEIGHTED_NOTE = "Bots don't support weighted. They use round-robin.";

/**
 * Who a Claude token account serves (PD-18): `work_zone` keeps it out of the cell, `bots` out of the Work Zone. ChatGPT
 * kinds decide their consumer themselves (`device_slot` = that device's Work Zone, `cell_profile` = bots).
 */
export const PoolScope = z.enum(["all", "work_zone", "bots"]);
export type PoolScope = z.infer<typeof PoolScope>;

/** Where the credential lives (D-02): sealed server-side, signed in on a device, or signed in inside the cell. */
export const PoolAccountKind = z.enum(["token", "device_slot", "cell_profile"]);
export type PoolAccountKind = z.infer<typeof PoolAccountKind>;

export const PoolAccountStatus = z.enum(["ready", "cooling", "needs_sign_in", "disabled"]);
export type PoolAccountStatus = z.infer<typeof PoolAccountStatus>;

/** Who added the row: an admin, a device owner's CLI (arrives disabled, PD-11), or the pre-07.18 bot sign-in (PD-12). */
export const PoolAccountOrigin = z.enum(["admin", "device_cli", "adopted"]);
export type PoolAccountOrigin = z.infer<typeof PoolAccountOrigin>;

// ---- DTOs (admins; no token, no secret id, no e-mail field: P1, P2) ----

export const PoolAccount = z.object({
  id: Id,
  provider: PoolProvider,
  kind: PoolAccountKind,
  label: z.string().max(POOL_LIMITS.labelMax),
  enabled: z.boolean(),
  priority: z.number().int().nonnegative(),
  weight: z.number().int().min(POOL_LIMITS.weightMin).max(POOL_LIMITS.weightMax),
  status: PoolAccountStatus,
  cooldownUntil: IsoDateTime.nullable(),
  limitReason: PoolLimitReason.nullable(),
  lastUsedAt: IsoDateTime.nullable(),
  usage: AccountUsageSnapshot.nullable(),
  planType: z.string().max(64).nullable(),
  origin: PoolAccountOrigin,
  /** The device a `device_slot` lives on; null for the other kinds. */
  device: z.object({ id: Id, name: z.string().max(200), online: z.boolean() }).nullable(),
  createdAt: IsoDateTime,
});
export type PoolAccount = z.infer<typeof PoolAccount>;

export const PoolPolicy = z.object({
  provider: PoolProvider,
  strategy: PoolStrategy,
  scope: PoolScope,
  /** D-06: no usable account → the device's own login (default on), else the start is refused. */
  fallbackToDeviceLogin: z.boolean(),
  /** Null until an admin changed the default policy. */
  updatedAt: IsoDateTime.nullable(),
});
export type PoolPolicy = z.infer<typeof PoolPolicy>;

const ProviderPool = z.object({
  policy: PoolPolicy,
  accounts: z.array(PoolAccount).max(POOL_LIMITS.accountsPerProvider),
});

/** Settings › Account pool (D-10). */
export const AccountPoolView = z.object({ claude: ProviderPool, chatgpt: ProviderPool });
export type AccountPoolView = z.infer<typeof AccountPoolView>;

// ---- admin requests (strict; `provider.manage` only, PD-19) ----

const PoolWeight = z.number().int().min(POOL_LIMITS.weightMin).max(POOL_LIMITS.weightMax);
const atLeastOneKey = (v: Record<string, unknown>) => Object.values(v).some((x) => x !== undefined);

export const AddClaudeTokenRequest = z.strictObject({ label: PoolLabel, token: ClaudeSetupToken });
export type AddClaudeTokenRequest = z.infer<typeof AddClaudeTokenRequest>;

export const UpdatePoolAccountRequest = z
  .strictObject({
    label: PoolLabel.optional(),
    enabled: z.boolean().optional(),
    weight: PoolWeight.optional(),
    /** Replace a token account's setup-token (sealed again; never echoed back). */
    token: ClaudeSetupToken.optional(),
  })
  .refine(atLeastOneKey, { message: "change at least one field" });
export type UpdatePoolAccountRequest = z.infer<typeof UpdatePoolAccountRequest>;

/** The full new order of one provider's accounts (priority = index). */
export const ReorderPoolRequest = z.strictObject({
  accountIds: z
    .array(Id)
    .min(1)
    .max(POOL_LIMITS.accountsPerProvider)
    .refine((ids) => new Set(ids).size === ids.length, { message: "each account once" }),
});
export type ReorderPoolRequest = z.infer<typeof ReorderPoolRequest>;

export const UpdatePoolPolicyRequest = z
  .strictObject({
    strategy: PoolStrategyChoice.optional(),
    scope: PoolScope.optional(),
    fallbackToDeviceLogin: z.boolean().optional(),
  })
  .refine(atLeastOneKey, { message: "change at least one field" });
export type UpdatePoolPolicyRequest = z.infer<typeof UpdatePoolPolicyRequest>;

/** Sign a ChatGPT account in on a service device (a new Codex slot there). */
export const StartDeviceSignInRequest = z.strictObject({ deviceId: Id, label: PoolLabel });
export type StartDeviceSignInRequest = z.infer<typeof StartDeviceSignInRequest>;

/** Sign a ChatGPT account in inside the cell, for bots. */
export const BotPoolSignIn = z.strictObject({ label: PoolLabel });
export type BotPoolSignIn = z.infer<typeof BotPoolSignIn>;

// ---- device sign-ins (D-10) ----

export const DeviceSignInState = z.enum(["starting", "pending", "connected", "error"]);
export type DeviceSignInState = z.infer<typeof DeviceSignInState>;

/** One device sign-in as the admin who started it sees it; the user code is never audited (PD-20). */
export const DeviceSignIn = z.object({
  id: Id,
  deviceId: Id,
  label: z.string().max(POOL_LIMITS.labelMax),
  state: DeviceSignInState,
  verificationUrl: z.url().max(500).nullable(),
  userCode: z.string().max(32).nullable(),
  expiresAt: IsoDateTime.nullable(),
  error: z.object({ code: PoolSignInErrorCode, message: z.string().max(300) }).nullable(),
  accountId: Id.nullable(),
  startedAt: IsoDateTime,
});
export type DeviceSignIn = z.infer<typeof DeviceSignIn>;

export const AccountPoolErrorCode = z.enum([
  "api_key_not_allowed",
  "too_many_accounts",
  "not_a_service_device",
  /** 07.18-19 R3.2: a desktop device the admin may not use (`ocw-runtime account add codex` on it instead). */
  "device_not_allowed",
  "device_offline",
  "account_not_found",
  "sign_in_in_progress",
  "wrong_kind",
  "no_account",
]);
export type AccountPoolErrorCode = z.infer<typeof AccountPoolErrorCode>;

// ---- members: previews and the session's account (labels only, D-11, PD-19) ----

/** Where a new session on a device would get its account. */
export const AccountSourcePreview = z.discriminatedUnion("source", [
  z.object({ source: z.literal("pool"), strategy: PoolStrategy, ready: z.number().int().nonnegative() }),
  z.object({ source: z.literal("device_login") }),
  z.object({ source: z.literal("none"), resetsAt: IsoDateTime.nullable() }),
]);
export type AccountSourcePreview = z.infer<typeof AccountSourcePreview>;

export const AccountPoolPreview = z.object({
  "claude-code": AccountSourcePreview,
  codex: AccountSourcePreview,
});
export type AccountPoolPreview = z.infer<typeof AccountPoolPreview>;

/** The new-session dialog's account line. */
export function accountSourceLabel(preview: AccountSourcePreview): string {
  switch (preview.source) {
    case "pool":
      return `Account: pool (${POOL_STRATEGY_TEXT[preview.strategy].short})`;
    case "device_login":
      return "This device's login";
    case "none":
      return "No pool account is ready";
  }
}

/** The pool account a session runs on, as every viewer of the session sees it (label only). */
export const SessionPoolAccountRef = z.object({
  id: Id,
  label: z.string().max(POOL_LIMITS.labelMax),
  provider: PoolProvider,
});
export type SessionPoolAccountRef = z.infer<typeof SessionPoolAccountRef>;

/**
 * Whether bots get Claude setup-tokens through the cell (A-05). When the probe in 07.18-07 fails, plan 14 sets it to
 * false: the API then sends no Claude tokens to the cell and Settings says "Bots use the Anthropic API key".
 */
export const CELL_CLAUDE_TOKENS: boolean = true;

// ---- the switch line (D-08, PD-14) ----

export const AccountSwitchReason = z.enum(["limit", "unavailable"]);
export type AccountSwitchReason = z.infer<typeof AccountSwitchReason>;

const DEVICE_LOGIN = "this device's login";
const cutLabel = (label: string) => label.trim().slice(0, POOL_LIMITS.labelMax);

/**
 * The session timeline's switch line: "Switched to account B: A reached its limit until 15:40". A null label is the
 * device's own login; `formatTime` renders the ISO reset time in the viewer's locale.
 */
export function accountSwitchedSentence(
  e: { fromLabel: string | null; toLabel: string | null; reason: AccountSwitchReason; until: string | null },
  formatTime: (iso: string) => string,
): string {
  const to =
    e.toLabel === null ? `Switched to ${DEVICE_LOGIN}` : `Switched to account ${cutLabel(e.toLabel)}`;
  const from = e.fromLabel === null ? DEVICE_LOGIN : cutLabel(e.fromLabel);
  if (e.reason === "unavailable") return `${to}: ${from} is no longer available`;
  const until = e.until === null ? "" : ` until ${formatTime(e.until)}`;
  return `${to}: ${from} reached its limit${until}`;
}
