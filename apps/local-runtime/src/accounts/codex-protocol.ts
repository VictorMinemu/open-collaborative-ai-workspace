// Narrow schemas of the `codex app-server` v2 account messages the daemon uses (07.18, D-02, PD-09, PD-10).
//
// They follow the types `codex app-server generate-ts` prints for codex-cli 0.172.0: `LoginAccountParams` /
// `LoginAccountResponse` (`account/login/start`, variant `chatgptDeviceCode`), `AccountLoginCompletedNotification`
// (`account/login/completed`), `CancelLoginAccountParams` (`account/login/cancel`), `GetAccountResponse` / `Account`
// (`account/read`), `LogoutAccountResponse` (`account/logout`), and `GetAccountRateLimitsResponse` /
// `AccountRateLimitsUpdatedNotification` / `RateLimitSnapshot` / `RateLimitWindow` (`account/rateLimits/*`).
//
// Why not the generated closure in `codex/generated/`: those files pin one CLI version for the session protocol. Devices
// run whatever Codex their owner installed, and the account methods keep growing variants and fields. So each schema
// checks only the fields read here and lets every other key through (`z.looseObject`): a newer Codex still parses, an
// older one without the device-code variant fails visibly (A-08). Nothing here keeps an e-mail: `account/read` is
// parsed for the account type and plan only (P2).

import { z } from "zod";

/** `account/login/start` params for Codex's own device-code sign-in. */
export const CODEX_DEVICE_CODE_LOGIN = { type: "chatgptDeviceCode" } as const;

/** `account/login/start` answer, device-code variant: the URL to open and the code to type there. */
export const CodexDeviceCodeLoginStart = z.looseObject({
  type: z.literal("chatgptDeviceCode"),
  loginId: z.string().min(1).max(200),
  verificationUrl: z
    .url()
    .max(500)
    .refine((u) => u.startsWith("https://"), "the verification URL is not https"),
  userCode: z.string().min(4).max(32),
});
export type CodexDeviceCodeLoginStart = z.infer<typeof CodexDeviceCodeLoginStart>;

/** Any `account/login/start` answer: only its `type` is read before the variant is checked. */
export const CodexLoginStartAnswer = z.looseObject({ type: z.string() });

/** `account/login/completed` notification. */
export const CodexLoginCompleted = z.looseObject({
  loginId: z.string().nullable().optional(),
  success: z.boolean(),
  error: z.string().nullable().optional(),
});
export type CodexLoginCompleted = z.infer<typeof CodexLoginCompleted>;

/** `account/login/cancel` params. */
export type CodexLoginCancelParams = { loginId: string };

/** `account/read` answer: the account type and plan only (the e-mail and workspace name are never read). */
export const CodexAccountRead = z.looseObject({
  account: z
    .looseObject({
      type: z.string(),
      planType: z.string().max(64).nullable().optional(),
    })
    .nullable(),
  requiresOpenaiAuth: z.boolean().optional(),
});
export type CodexAccountRead = z.infer<typeof CodexAccountRead>;

/** One rate-limit window (`resetsAt` in epoch seconds, A-07; `usedPercent` 0-100). */
export const CodexRateLimitWindow = z.looseObject({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullable().optional(),
  resetsAt: z.number().nullable().optional(),
});
export type CodexRateLimitWindow = z.infer<typeof CodexRateLimitWindow>;

/** A rate-limit snapshot; a rolling update may leave any window out. */
export const CodexRateLimitSnapshot = z.looseObject({
  primary: CodexRateLimitWindow.nullable().optional(),
  secondary: CodexRateLimitWindow.nullable().optional(),
  planType: z.string().max(64).nullable().optional(),
  rateLimitReachedType: z.string().nullable().optional(),
});
export type CodexRateLimitSnapshot = z.infer<typeof CodexRateLimitSnapshot>;

/** `account/rateLimits/read` answer and the `account/rateLimits/updated` notification share this shape. */
export const CodexRateLimits = z.looseObject({ rateLimits: CodexRateLimitSnapshot });
export type CodexRateLimits = z.infer<typeof CodexRateLimits>;
