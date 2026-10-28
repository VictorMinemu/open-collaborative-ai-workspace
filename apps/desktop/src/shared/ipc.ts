// IPC surface between the preloads and the main process. Every channel is listed here, every
// argument is validated with Zod in the main process, and nothing returned to web content
// contains an absolute host path (AGENTS principle 7) or a credential.

import { z } from "zod";
import { redactRemote } from "./urls";

export { Channels } from "./channels";

// ---- arguments ---------------------------------------------------------------------------------

/** `addProject()` takes no arguments or an optional display name. */
export const AddProjectArgs = z
  .object({ name: z.string().trim().min(1).max(80).optional() })
  .strict()
  .optional();

export const NoArgs = z.undefined();

export const CheckServerArgs = z
  .object({
    webUrl: z.string().min(1).max(2048),
    apiUrl: z.string().max(2048).optional(),
  })
  .strict();

export const EnrollArgs = z
  .object({
    webUrl: z.string().min(1).max(2048),
    apiUrl: z.string().min(1).max(2048),
    code: z
      .string()
      .trim()
      .min(4)
      .max(32)
      .regex(/^[A-Za-z0-9-]+$/, "Pairing codes contain letters, digits and dashes only."),
    deviceName: z.string().trim().min(1).max(80),
  })
  .strict();
export type EnrollArgs = z.infer<typeof EnrollArgs>;

export const FinishArgs = z.object({ skipPairing: z.boolean() }).strict();

/** `setBadgeCount(n)`: the unread mention count for the dock/taskbar badge, a whole number 0–9999 (0 clears). */
export const SetBadgeCountArgs = z.number().int().min(0).max(9999);

/** A ChatGPT loopback flow token: 32 random bytes, base64url (43 characters). */
export const ChatgptFlowToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

/** `chatgptLoopbackAwait(flowToken, authorizeUrl)`; the main process also requires https (or loopback in dev). */
export const ChatgptLoopbackAwaitArgs = z
  .object({ flowToken: ChatgptFlowToken, authorizeUrl: z.string().min(1).max(2048) })
  .strict();

export const ChatgptLoopbackCancelArgs = z.object({ flowToken: ChatgptFlowToken }).strict();

/** Parse IPC args, turning Zod errors into a short message (never echo the payload back). */
export function parseArgs<T>(schema: z.ZodType<T>, value: unknown): T {
  const res = schema.safeParse(value);
  if (!res.success) {
    const first = res.error.issues[0];
    throw new Error(first?.message && first.code === "invalid_format" ? first.message : "invalid arguments");
  }
  return res.data;
}

// ---- results -----------------------------------------------------------------------------------

export const RuntimeInfo = z.object({
  id: z.string(),
  installed: z.boolean(),
  version: z.string().nullable(),
  loggedIn: z.boolean(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfo>;

/**
 * 07.11 (D-02): the device's runtime updates level. A local copy of the contracts enum: the desktop package does not
 * depend on `@ocw/contracts`.
 */
export const DesktopRuntimeUpdatesLevel = z.enum(["automatic", "notify", "off"]);
export type DesktopRuntimeUpdatesLevel = z.infer<typeof DesktopRuntimeUpdatesLevel>;

/**
 * 07.11 (D-09): the subset of the daemon's `status().runtimeUpdates` the menu shows (the daemon sends every status
 * field; unknown keys are dropped). Every field is optional and the free-text ones are plain strings, so a newer daemon
 * that adds a state or a reason never breaks the parse.
 */
export const DaemonRuntimeUpdates = z.object({
  localLevel: DesktopRuntimeUpdatesLevel.optional(),
  /** `env` (OCW_RUNTIME_UPDATES, not switchable from the menu) or `config` (runtime.json). */
  localLevelSource: z.enum(["env", "config"]).optional(),
  effectiveLevel: DesktopRuntimeUpdatesLevel.optional(),
  orgLevelReceived: z.boolean().optional(),
  runtimes: z
    .array(
      z.object({
        runtime: z.string(),
        installedVersion: z.string().nullable().optional(),
        latestVersion: z.string().nullable().optional(),
        advisory: z.string().optional(),
        state: z.string().optional(),
        lastRun: z.object({ outcome: z.string().optional() }).nullable().optional(),
        reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
});
export type DaemonRuntimeUpdates = z.infer<typeof DaemonRuntimeUpdates>;

/** What the daemon returns over the control socket for `status` (subset we rely on). */
export const DaemonStatusPayload = z.object({
  paired: z.boolean(),
  connected: z.boolean(),
  deviceName: z.string().optional(),
  projects: z.number().optional(),
  runtimes: z.array(RuntimeInfo).optional(),
  sessions: z.array(z.unknown()).optional(),
  /** ADR-0012: the device's own Full access opt-in, as the daemon enforces it (absent on older daemons). */
  fullAccessOptIn: z.boolean().optional(),
  /** Where it comes from: `env` (OCW_ALLOW_FULL_ACCESS, not switchable from the menu) or `config` (runtime.json). */
  fullAccessSource: z.enum(["env", "config"]).optional(),
  /**
   * 07.11: the runtime CLIs' update status and the device's level (absent on older daemons and where maintenance does
   * not run). Main process only: never part of `DesktopStatus`. A block this app cannot read is dropped, never fatal.
   */
  runtimeUpdates: DaemonRuntimeUpdates.optional().catch(undefined),
});
export type DaemonStatusPayload = z.infer<typeof DaemonStatusPayload>;

/** Daemon `listProjects` entries (contain the absolute path; main process only). */
export const LocalProject = z.object({
  localId: z.string(),
  path: z.string(),
  name: z.string(),
  gitRemote: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  addedAt: z.string(),
});
export type LocalProject = z.infer<typeof LocalProject>;

/** What web content may see about a project: no path, no credentials. */
export interface PublicProject {
  localId: string;
  name: string;
  gitRemote: string | null;
  defaultBranch: string | null;
  addedAt: string;
}

export function toPublicProject(p: LocalProject): PublicProject {
  return {
    localId: p.localId,
    name: p.name,
    gitRemote: redactRemote(p.gitRemote),
    defaultBranch: p.defaultBranch,
    addedAt: p.addedAt,
  };
}

export type RuntimeState = "online" | "connecting" | "offline" | "needs_pairing" | "paused";

export interface DesktopStatus {
  state: RuntimeState;
  /** Human label for tray and UI ("Runtime online", "Needs pairing"…). */
  label: string;
  paired: boolean;
  daemon: "running" | "starting" | "stopped" | "restarting" | "external";
  deviceName: string | null;
  projects: number;
  activeSessions: number;
  runtimes: RuntimeInfo[];
  /** Read-only for web content: Full access is switched only from the desktop Runtime menu or the CLI. */
  fullAccessOptIn: boolean;
}

export interface ChatgptLoopbackPrepared {
  flowToken: string;
  port: number;
}

export type ChatgptLoopbackResult =
  | { ok: true; redirectUrl: string }
  | { ok: false; reason: "timeout" | "cancelled" | "invalid_url" };

export type AddProjectResult =
  | { ok: true; project: PublicProject }
  | { ok: false; canceled: true }
  | { ok: false; canceled: false; error: string };
