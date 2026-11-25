import { z } from "zod";
import { Id } from "./common";

/**
 * The Work Zone browser (Phase 07.13, D-07 … D-35, ADR-0035): a Claude Code or Codex session drives a browser the Local
 * Runtime runs on the session's own device, its audience watches it live and the asker can take control to sign in.
 * One vocabulary for the device, the API and the web: the tools and their bodies, refusal codes and their sentences,
 * origins, the per-turn grant, audit actions, live frames, sign-in DTOs and the binary frame codec.
 *
 * What this file never carries (07.13-01 P1, P3): a cookie value, a storage state, typed text, page or snapshot text or
 * an absolute path in any device → server or server-side DTO. The only schema holding a storage state is
 * `WorkBrowserStorageState`, which rides the `browser.signin.state` reply (server → device) and the device-JWT sign-in
 * upload, nothing else (P7). Audit and events name a page by `BrowserOrigin` (`scheme://host:port`), never a path or
 * a query.
 *
 * Imports only `zod`, `common` and `browser` (the bots' schemas are reused, never copied), so `device-link`,
 * `work-session` and `session-events` can import it without a cycle; nothing here uses `node:*`, so the web imports it.
 */

/** The MCP server name both runtimes see (`mcp__ocw_browser__open` in Claude Code, PD-06). */
export const WORK_BROWSER_MCP_SERVER = "ocw_browser";

/** The tools' short names inside the MCP server (PD-06). */
export const WorkBrowserTool = z.enum(["open", "snapshot", "act", "screenshot", "wait", "close", "signin"]);
export type WorkBrowserTool = z.infer<typeof WorkBrowserTool>;

/** Every accepted default of D-15, D-20 … D-22 and PD-12 as one named constant. */
export const WORK_BROWSER_LIMITS = {
  /** Live frames per second at most, only while someone watches (D-15). */
  fps: 4,
  frameWidth: 960,
  frameHeight: 600,
  jpegQuality: 55,
  /** A page with no tool call and no input for this long is closed (PD-24). */
  idleMinutes: 10,
  /** A non-loopback host approval waits this long (PD-10). */
  hostApprovalMinutes: 10,
  /** A `signed_in_host` or `signin` approval waits this long (PD-10). */
  memberApprovalMinutes: 15,
  /** `ocw_browser_signin` waits for the asker this long (D-21). */
  signinWaitMinutes: 15,
  /** An API instance with viewers re-sends `browser.frames { on: true }` this often (PD-12). */
  watchPingMs: 10_000,
  /** The device stops streaming when no ping arrived for this long (PD-12). */
  watchLapseMs: 25_000,
  /** A sign-in's storage state as JSON, at most. */
  storageStateMaxBytes: 2 * 1024 * 1024,
} as const;

/**
 * A page's origin as audit, events and approvals keep it: `scheme://host:port`, the port always explicit
 * (`https://github.com:443`), never a path, a query or user info (P3).
 */
export const BrowserOrigin = z
  .string()
  .min(1)
  .max(300)
  .regex(/^https?:\/\/[a-z0-9.\-[\]:]+:\d{1,5}$/, { message: "must be scheme://host:port" });
export type BrowserOrigin = z.infer<typeof BrowserOrigin>;

/** Why the device refused a browser tool call (each has a fixed sentence for the model). */
export const WorkBrowserRefusal = z.enum([
  "not_allowed",
  "policy_changed",
  "paused",
  "approval_denied",
  "approval_expired",
  "navigation_refused",
  "metadata_refused",
  "timeout",
  "no_context",
  "element_gone",
  "screenshot_unavailable",
  "image_model_required",
  "signin_not_allowed",
  "signin_denied",
  "signin_expired",
  "browser_unavailable",
  "busy",
  "too_large",
]);
export type WorkBrowserRefusal = z.infer<typeof WorkBrowserRefusal>;

/** Why the device could not start its browser (installer, launch, D-05, PD-18). */
export const WorkBrowserLaunchFailure = z.enum([
  "unsupported_platform",
  "download_failed",
  "checksum_mismatch",
  "missing_library",
  "no_usable_sandbox",
  "launch_failed",
]);
export type WorkBrowserLaunchFailure = z.infer<typeof WorkBrowserLaunchFailure>;

/** What happened to a session's page, as the device reports it in `browser.event` (D-14). */
export const WorkBrowserEventKind = z.enum([
  "opened",
  "navigated",
  "acted",
  "closed",
  "refused",
  "crashed",
  "signin_loaded",
  "signin_unloaded",
  "takeover_abandoned",
]);
export type WorkBrowserEventKind = z.infer<typeof WorkBrowserEventKind>;

/** The action a browser event names (never its target, value or text). */
export const WorkBrowserAction = z.enum([
  "open",
  "navigate",
  "click",
  "type",
  "select",
  "press",
  "scroll",
  "wait",
  "snapshot",
  "screenshot",
  "close",
  "signin",
]);
export type WorkBrowserAction = z.infer<typeof WorkBrowserAction>;

/**
 * The browser a turn may use (D-10, PD-09, PD-26, D-32), decided by the API per turn and sent with `session.start` and
 * every `prompt`; the device re-checks it per call with its own live opt-in. Absent on a frame = not allowed.
 *
 * - `reason`: `ok` when allowed; otherwise why not (policy off, device opted out, device too old, asker lost access).
 * - `askerId`: the person (or bot) whose turn this is; a loaded sign-in is unloaded before any other asker's call.
 * - `alwaysAsk` / `whenTainted`: the admins' per-tool rules, mode only (D-34).
 * - `signinAllowed`: a human asker in a session whose audience is the asker plus at most the device owner (D-32).
 */
export const SessionBrowserGrant = z.strictObject({
  allowed: z.boolean(),
  reason: z.enum(["ok", "off_policy", "off_device", "update_device", "no_access"]),
  askerId: Id.nullable(),
  askerIsBot: z.boolean(),
  alwaysAsk: z.array(WorkBrowserTool).max(7),
  whenTainted: z.array(WorkBrowserTool).max(7),
  signinAllowed: z.boolean(),
});
export type SessionBrowserGrant = z.infer<typeof SessionBrowserGrant>;

// ---------------------------------------------------------------- sign-in state (device ↔ API only, P7)

const SameSite = z.enum(["Strict", "Lax", "None"]);

/** One cookie as Playwright's `storageState()` reports it (bounded; RFC 6265 limits are far below these). */
const StorageCookie = z.strictObject({
  name: z.string().max(4096),
  value: z.string().max(8192),
  domain: z.string().min(1).max(260),
  path: z.string().max(2048),
  /** Seconds since the epoch; -1 = a session cookie. */
  expires: z.number().finite(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: SameSite,
  /** CHIPS partition key, when Playwright reports one. */
  partitionKey: z.string().max(512).optional(),
});

const StorageOrigin = z.strictObject({
  /** The page origin as Playwright reports it (`https://github.com`, default port implied). */
  origin: z.string().min(1).max(300),
  localStorage: z
    .array(z.strictObject({ name: z.string().max(4096), value: z.string().max(1_000_000) }))
    .max(1000),
});

/**
 * A member's sign-in for one site (D-22, D-24): cookies and origin storage, already filtered to the site on the device
 * and again at the API. Rides only `browser.signin.state` and the device-JWT upload; never Redis, `device_commands`,
 * events, audit, logs or a column (P7). At most `WORK_BROWSER_LIMITS.storageStateMaxBytes` as JSON.
 */
export const WorkBrowserStorageState = z
  .strictObject({
    cookies: z.array(StorageCookie).max(500),
    origins: z.array(StorageOrigin).max(100),
  })
  .refine(
    (s) => new TextEncoder().encode(JSON.stringify(s)).length <= WORK_BROWSER_LIMITS.storageStateMaxBytes,
    {
      message: "storage state too large",
    },
  );
export type WorkBrowserStorageState = z.infer<typeof WorkBrowserStorageState>;

// ---------------------------------------------------------------- binary live frames (D-15, PD-12)

/** The first byte of a Work Zone browser frame on the Device Link (binary WebSocket message). */
export const WORK_BROWSER_FRAME_KIND = 1;
/** `[u8 kind][16 bytes session uuid][u16 BE width][u16 BE height]`, then the JPEG. */
export const WORK_BROWSER_FRAME_HEADER_BYTES = 21;
/**
 * The largest frame, header included: equal to `DEVICE_LINK_MAX_DEVICE_FRAME_BYTES` (the API's inbound `maxPayload`;
 * pinned by `work-browser-link.test.ts`). Declared here, not imported, so `device-link` can import this file.
 */
export const WORK_BROWSER_FRAME_MAX_BYTES = 256 * 1024;

const UUID_HEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const U16_MAX = 0xffff;

export interface WorkBrowserFrame {
  sessionId: string;
  width: number;
  height: number;
  jpeg: Uint8Array;
}

function validSize(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= U16_MAX;
}

/**
 * One live frame as Device Link bytes. Null when the session id is not a UUID, a size is outside 1 … 65535, the JPEG is
 * empty, or the whole frame would exceed `WORK_BROWSER_FRAME_MAX_BYTES` (the caller drops it; a frame is never split).
 */
export function encodeWorkBrowserFrame(frame: WorkBrowserFrame): Uint8Array | null {
  const { sessionId, width, height, jpeg } = frame;
  if (!UUID_HEX.test(sessionId) || !validSize(width) || !validSize(height) || jpeg.length === 0) return null;
  const total = WORK_BROWSER_FRAME_HEADER_BYTES + jpeg.length;
  if (total > WORK_BROWSER_FRAME_MAX_BYTES) return null;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  out[0] = WORK_BROWSER_FRAME_KIND;
  const hex = sessionId.replace(/-/g, "");
  for (let i = 0; i < 16; i++) out[1 + i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  view.setUint16(17, width, false);
  view.setUint16(19, height, false);
  out.set(jpeg, WORK_BROWSER_FRAME_HEADER_BYTES);
  return out;
}

/** The inverse of `encodeWorkBrowserFrame`; null for another kind, a short or oversize buffer, or an empty image. */
export function decodeWorkBrowserFrame(bytes: Uint8Array): WorkBrowserFrame | null {
  if (bytes.length <= WORK_BROWSER_FRAME_HEADER_BYTES || bytes.length > WORK_BROWSER_FRAME_MAX_BYTES)
    return null;
  if (bytes[0] !== WORK_BROWSER_FRAME_KIND) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let hex = "";
  for (let i = 0; i < 16; i++) hex += (bytes[1 + i] ?? 0).toString(16).padStart(2, "0");
  const sessionId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const width = view.getUint16(17, false);
  const height = view.getUint16(19, false);
  if (!validSize(width) || !validSize(height)) return null;
  return { sessionId, width, height, jpeg: bytes.subarray(WORK_BROWSER_FRAME_HEADER_BYTES) };
}
