import { z } from "zod";
import {
  BROWSER_ACT_FIELDS,
  BROWSER_LIMITS,
  BROWSER_SNAPSHOT_TEXT_MAX,
  BROWSER_TIMEOUTS_MS,
  BROWSER_WAIT_FIELDS,
  BrowserHost,
  BrowserUrl,
  LiveInputFrame,
  refineBrowserAct,
  refineBrowserWait,
} from "./browser";
import { Id, IsoDateTime } from "./common";

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
  /** The redacted snapshot text the model gets, at most (the bots' bound). */
  snapshotTextMax: BROWSER_SNAPSHOT_TEXT_MAX,
} as const;

/**
 * The time budgets of one Work Zone browser call on the device. Navigation, op and launch are the bots' (one engine,
 * D-04); `coldOpen` covers the first use (the pinned browser's download, then its launch); `signin` waits past the
 * 15-minute sign-in wait so the device answers `signin_expired` itself.
 */
export const WORK_BROWSER_TIMEOUTS_MS = {
  navigation: BROWSER_TIMEOUTS_MS.navigation,
  op: BROWSER_TIMEOUTS_MS.agentOp,
  launch: BROWSER_TIMEOUTS_MS.launch,
  coldOpen: 600_000,
  signin: 16 * 60_000,
} as const;

// ---------------------------------------------------------------- tool names (PD-06)

/** The name audit, approvals and admin per-tool rules use (`ocw_browser_open`). */
export const CanonicalBrowserTool = z.enum([
  "ocw_browser_open",
  "ocw_browser_snapshot",
  "ocw_browser_act",
  "ocw_browser_screenshot",
  "ocw_browser_wait",
  "ocw_browser_close",
  "ocw_browser_signin",
]);
export type CanonicalBrowserTool = z.infer<typeof CanonicalBrowserTool>;

export function canonicalBrowserTool(t: WorkBrowserTool): CanonicalBrowserTool {
  return `ocw_browser_${t}`;
}

/** The name Claude Code shows for an in-process SDK MCP tool (`mcp__ocw_browser__open`). */
export function claudeBrowserToolName(t: WorkBrowserTool): `mcp__ocw_browser__${WorkBrowserTool}` {
  return `mcp__${WORK_BROWSER_MCP_SERVER}__${t}`;
}

/** The short tool from a Claude name, a canonical name or a short name; null for anything else. */
export function browserToolFromName(name: string): WorkBrowserTool | null {
  let short = name;
  if (name.startsWith(`mcp__${WORK_BROWSER_MCP_SERVER}__`))
    short = name.slice(`mcp__${WORK_BROWSER_MCP_SERVER}__`.length);
  else if (name.startsWith(`${WORK_BROWSER_MCP_SERVER}_`))
    short = name.slice(`${WORK_BROWSER_MCP_SERVER}_`.length);
  const parsed = WorkBrowserTool.safeParse(short);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------- tool bodies (model-written, untrusted; D-07)

/** `open`: load a page in the session's one page (navigates it when already open, PD-24). */
export const WorkBrowserOpenInput = z.strictObject({ url: BrowserUrl });
export type WorkBrowserOpenInput = z.infer<typeof WorkBrowserOpenInput>;

/** `snapshot`: the redacted accessibility text with refs (untrusted page content for the model). */
export const WorkBrowserSnapshotInput = z.strictObject({});
export type WorkBrowserSnapshotInput = z.infer<typeof WorkBrowserSnapshotInput>;

/** `act`: one action on a snapshot ref; the bots' fields and refinement (one engine, one contract). */
export const WorkBrowserActInput = z.strictObject(BROWSER_ACT_FIELDS).superRefine(refineBrowserAct);
export type WorkBrowserActInput = z.infer<typeof WorkBrowserActInput>;

/** `screenshot`: a masked JPEG, only for a model that accepts images (D-09, PD-23). */
export const WorkBrowserScreenshotInput = z.strictObject({});
export type WorkBrowserScreenshotInput = z.infer<typeof WorkBrowserScreenshotInput>;

/** `wait`: for the load, a text or a time; the bots' fields and refinement. */
export const WorkBrowserWaitInput = z.strictObject(BROWSER_WAIT_FIELDS).superRefine(refineBrowserWait);
export type WorkBrowserWaitInput = z.infer<typeof WorkBrowserWaitInput>;

/** `close`: end the session's page and its browser. */
export const WorkBrowserCloseInput = z.strictObject({});
export type WorkBrowserCloseInput = z.infer<typeof WorkBrowserCloseInput>;

/** `signin`: ask the turn's asker to sign in to `host` (D-21); the device checks the host against the page. */
export const WorkBrowserSignInInput = z.strictObject({
  host: BrowserHost,
  reason: z.string().trim().min(1).max(BROWSER_LIMITS.reasonMaxChars),
});
export type WorkBrowserSignInInput = z.infer<typeof WorkBrowserSignInInput>;

/** Every tool's body, by short name (the device's MCP servers and its tool table read it). */
export const WORK_BROWSER_INPUTS: Readonly<Record<WorkBrowserTool, z.ZodType>> = {
  open: WorkBrowserOpenInput,
  snapshot: WorkBrowserSnapshotInput,
  act: WorkBrowserActInput,
  screenshot: WorkBrowserScreenshotInput,
  wait: WorkBrowserWaitInput,
  close: WorkBrowserCloseInput,
  signin: WorkBrowserSignInInput,
};

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

/**
 * `scheme://host:port` of an `http(s)` URL (default port written out), or null for any other scheme or a string that is
 * not a URL. The host is WHATWG-normalised (lower case, punycode, IPv6 in brackets).
 */
export function originOf(url: string): BrowserOrigin | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const origin = `${u.protocol}//${u.hostname}:${port}`;
  return BrowserOrigin.safeParse(origin).success ? origin : null;
}

/** The device's own loopback names, exactly (no other 127/8 address, no `*.localhost`): never a host approval (D-11). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1";
}

/**
 * Known cloud metadata endpoints (D-35): AWS IMDS (v4, v6) and ECS, GCP, Azure (the AWS address), Alibaba, OpenStack
 * names. The device refuses them before any navigation, loopback included; the list mirrors `@ocw/egress-policy`.
 */
export const CLOUD_METADATA_HOSTS: readonly string[] = [
  "169.254.169.254",
  "fd00:ec2::254",
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
  "100.100.100.200",
  "169.254.170.2",
];

const METADATA_V4 = new Set(["169.254.169.254", "100.100.100.200", "169.254.170.2"]);
const METADATA_NAMES = new Set(CLOUD_METADATA_HOSTS.filter((h) => !METADATA_V4.has(h) && !h.includes(":")));
/** `fd00:ec2::254` as eight 16-bit groups. */
const METADATA_V6 = [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254];

/** Eight 16-bit groups of an IPv6 literal (embedded dotted IPv4 allowed), or null. String logic only (no `node:net`). */
function ipv6Groups(literal: string): number[] | null {
  let s = literal;
  const dotted = s.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const o = dotted.slice(2, 6).map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${dotted[1]}${((o[0] ?? 0) * 256 + (o[1] ?? 0)).toString(16)}:${((o[2] ?? 0) * 256 + (o[3] ?? 0)).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (p: string | undefined) => (p ? p.split(":") : []);
  const head = part(halves[0]);
  const tail = part(halves[1]);
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 1 ? 0 : fill).fill("0"), ...tail];
  const groups: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    groups.push(Number.parseInt(g, 16));
  }
  return groups.length === 8 ? groups : null;
}

/** The IPv4 address an IPv4-mapped (`::ffff:a.b.c.d`), IPv4-compatible or NAT64 (`64:ff9b::/96`) IPv6 form embeds. */
function embeddedV4(g: number[]): string | null {
  const zeros5 = g.slice(0, 5).every((n) => n === 0);
  const mapped = zeros5 && g[5] === 0xffff;
  const compatible = zeros5 && g[5] === 0;
  const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0);
  if (!mapped && !compatible && !nat64) return null;
  const hi = g[6] ?? 0;
  const lo = g[7] ?? 0;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * True for a cloud metadata host in any spelling: case, a trailing dot, brackets, IPv4 written as one number or in hex
 * (normalised by the WHATWG URL parser), IPv6 compression and IPv4-mapped / -compatible / NAT64 forms.
 */
export function isCloudMetadataHost(hostname: string): boolean {
  let h = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.includes(":")) {
    const g = ipv6Groups(h);
    if (!g) return false;
    if (g.every((n, i) => n === METADATA_V6[i])) return true;
    const v4 = embeddedV4(g);
    return v4 !== null && METADATA_V4.has(v4);
  }
  if (METADATA_NAMES.has(h)) return true;
  let normalised = h;
  try {
    normalised = new URL(`http://${h}/`).hostname;
  } catch {
    return false;
  }
  return METADATA_V4.has(normalised) || METADATA_NAMES.has(normalised);
}

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

/** The fixed sentence the model gets for each refusal (never a host, a path or page content). */
export const WORK_BROWSER_REFUSAL_TEXT: Readonly<Record<WorkBrowserRefusal, string>> = {
  not_allowed: "The browser is not available in this session.",
  policy_changed: "The browser settings changed. Try again in the next turn.",
  paused: "A person is controlling the page. Try again later.",
  approval_denied: "The person you asked did not allow this.",
  approval_expired: "Nobody answered the request in time.",
  navigation_refused: "That address cannot be opened. Only http and https pages can.",
  metadata_refused: "Cloud metadata addresses cannot be opened.",
  timeout: "The page took too long to answer.",
  no_context: "No page is open. Open one first.",
  element_gone: "That element is no longer on the page. Take a new snapshot.",
  screenshot_unavailable: "A screenshot could not be taken.",
  image_model_required: "Screenshots need a model that accepts images.",
  signin_not_allowed: "Sign-ins work only in sessions only you can see.",
  signin_denied: "The person chose not to sign in.",
  signin_expired: "Nobody signed in within 15 minutes.",
  browser_unavailable: "The browser could not start on this device.",
  busy: "The browser is busy with another call. Try again.",
  too_large: "The result was too large.",
};

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

/**
 * What a browser approval asks (PD-10): `host` (a non-loopback origin, once per session), `admin_rule` (an admin's
 * per-tool rule, D-34), `signed_in_host` (another host on a page with a member's sign-in, D-24) and `signin` (D-21).
 */
export const WorkBrowserApprovalKind = z.enum(["host", "admin_rule", "signed_in_host", "signin"]);
export type WorkBrowserApprovalKind = z.infer<typeof WorkBrowserApprovalKind>;

/**
 * The browser part of an approval request: the device fills it, the API stores and shows it. A hint only: who may
 * answer is the API's own decision from its own state (PD-10), never from this field.
 */
export const WorkBrowserApprovalRequest = z.strictObject({
  kind: WorkBrowserApprovalKind,
  origin: BrowserOrigin,
  tool: CanonicalBrowserTool,
  /** The model's sign-in reason (`signin` only), shown to the asker. */
  reason: z.string().max(BROWSER_LIMITS.reasonMaxChars).optional(),
});
export type WorkBrowserApprovalRequest = z.infer<typeof WorkBrowserApprovalRequest>;

/** Audit actions (D-14, D-20 … D-25): actor, ids and `{ origin, action?, refusal?, failure? }` only (PD-25, P3). */
export const WORK_BROWSER_AUDIT = {
  opened: "work_browser.opened",
  navigated: "work_browser.navigated",
  acted: "work_browser.acted",
  closed: "work_browser.closed",
  refused: "work_browser.refused",
  signin_requested: "work_browser.signin_requested",
  takeover_started: "work_browser.takeover_started",
  takeover_ended: "work_browser.takeover_ended",
  signin_saved: "work_browser.signin_saved",
  signin_loaded: "work_browser.signin_loaded",
  signin_revoked: "work_browser.signin_revoked",
} as const;
export type WorkBrowserAuditAction = (typeof WORK_BROWSER_AUDIT)[keyof typeof WORK_BROWSER_AUDIT];

// ---------------------------------------------------------------- live view (D-15, D-20, PD-13 … PD-15)

/**
 * Client → server frames on the Work Zone live socket: take, keep, release (with `save` = "Done, save my sign-in",
 * D-22) and the holder's input. No resize: Work Zone frames are always 960×600. The server answers with the bots'
 * `LiveServerFrame`, unchanged.
 */
export const WorkLiveClientFrame = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("take") }),
  z.strictObject({ type: z.literal("keep") }),
  z.strictObject({ type: z.literal("release"), save: z.boolean() }),
  ...LiveInputFrame.options,
]);
export type WorkLiveClientFrame = z.infer<typeof WorkLiveClientFrame>;

/** The live socket of one session's page. */
export function workLivePath(sessionId: string): string {
  return `/api/v1/live/work-browser/${sessionId}`;
}

/**
 * The session's browser as every viewer of the shared `ws:` stream sees it: so it never names a host or a member
 * (ADR-0031). `live` = a page is open now.
 */
export const WorkSessionBrowserState = z.strictObject({
  status: z.enum(["available", "off_policy", "off_device", "update_device"]),
  live: z.boolean(),
});
export type WorkSessionBrowserState = z.infer<typeof WorkSessionBrowserState>;

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

/**
 * `PUT WORK_BROWSER_SIGNIN_ROUTES.upload` and `.reseal` (device JWT only): the site's state after a hand back or before
 * an unload. `changed` = differs from the device's in-memory fingerprint; the API re-filters to the site and seals only
 * when changed and non-empty (PD-15).
 */
export const WorkBrowserSignInUpload = z.strictObject({
  sessionId: Id,
  origin: BrowserOrigin,
  state: WorkBrowserStorageState,
  changed: z.boolean(),
});
export type WorkBrowserSignInUpload = z.infer<typeof WorkBrowserSignInUpload>;

/**
 * One of the viewer's own Work Zone sign-ins (Settings › Keychain, owner-only, D-23): it proves a sign-in exists and
 * when it expires, nothing else (no cookie, no account name).
 */
export const WorkBrowserSignInItem = z.strictObject({
  id: Id,
  site: BrowserHost,
  scope: z.literal("work_zone"),
  createdAt: IsoDateTime,
  lastUsedAt: IsoDateTime.nullable(),
  expiresAt: IsoDateTime,
  status: z.enum(["active", "expired"]),
});
export type WorkBrowserSignInItem = z.infer<typeof WorkBrowserSignInItem>;

/** `GET WORK_BROWSER_SIGNIN_ROUTES.list`. */
export const WorkBrowserSignInList = z.strictObject({ items: z.array(WorkBrowserSignInItem).max(500) });
export type WorkBrowserSignInList = z.infer<typeof WorkBrowserSignInList>;

export const WORK_BROWSER_SIGNIN_ROUTES = {
  /** The member's own sign-ins (session cookie). */
  list: "/api/v1/work-browser/signins",
  /** Revoke one (`DELETE`, owner only). */
  revoke: "/api/v1/work-browser/signins/:id",
  /** The device's hand-back upload, one use per `uploadId` (device JWT). */
  upload: "/api/v1/runtime/browser-signins/uploads/:uploadId",
  /** The device's re-seal of a loaded sign-in before it unloads it (device JWT). */
  reseal: "/api/v1/runtime/browser-signins/:signinId/state",
} as const;

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
