import { z } from "zod";
import { AgentCardRoute } from "./agent-card-route";
import { Id, IsoDateTime, RelativePath } from "./common";
import { BrowserSandboxMode } from "./sandbox";

/**
 * Bot browsers and the live view (Phase 07.8, D-05…D-08, D-11…D-14, BRW-01…04). One bounded schema per payload the API,
 * the OpenClaw plugin and the web exchange: the Agent Channel browser bodies (model-written, untrusted), the live-view
 * frames (a person's browser), the sign-in card link, browser sessions and the bot page's Browser tab.
 *
 * P-07: there is no page-script, DOM, cookie, storage, HAR or network-log surface. The model acts only on opaque refs
 * from the agent's redacted snapshot, never on a selector or a script, and every body is strict so an extra key is
 * refused, not ignored. Imports `common` and the leaf `agent-card-route` only (never 07.8-01's sandbox files);
 * `agent-cards.ts` re-exports this file so the package index stays 07.8-01's alone during the parallel wave.
 */

/** Every accepted default of D-06…D-08 and D-12 as one named constant. */
export const BROWSER_LIMITS = {
  /** Live-view screencast ceiling (frames per second, drop-on-slow). */
  fps: 8,
  frameWidth: 960,
  frameHeight: 600,
  expandedWidth: 1280,
  expandedHeight: 800,
  jpegQuality: 55,
  /** A context with no activity is closed after this. */
  idleStopMinutes: 5,
  /** A context is held this long while a sign-in card or a browser-action approval waits (R9). */
  holdMinutes: 15,
  /** A browser-action approval expires with the held page (R8). */
  approvalPendingMinutes: 15,
  takeoverWarnMinutes: 9,
  /** A takeover lease ends after this unless the person keeps it. */
  takeoverMinutes: 10,
  /** Characters of one pasted `text` input frame. */
  pasteMaxChars: 1000,
  /** Characters of the bot's sign-in reason. */
  reasonMaxChars: 200,
  /** Default `browser_session_max_days` of a sealed session (P-09). */
  sessionMaxDaysDefault: 30,
  /** Mouse-move input frames per second a client sends at most. */
  mouseMoveHz: 30,
  urlMaxChars: 2000,
  /** Characters of one `type` action. */
  typeMaxChars: 2000,
} as const;

const TITLE_MAX = 200;
const SNAPSHOT_TEXT_MAX = 32_000;
const ACTIVITY_MAX = 80;
const NAME_MAX = 200;
/** A masked JPEG at 1280×800 is far below this; base64 characters. */
const IMAGE_DATA_MAX = 4_000_000;
/** Live-view coordinates are CSS pixels of the frame area. */
const COORD_MAX = 4096;
const WHEEL_DELTA_MAX = 10_000;

/** A C0/C1 control character or DEL: refused in model-written URLs and keys (the URL parser strips some silently). */
function hasControlCharacter(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/**
 * A page address a bot may open: `http:` or `https:`, parsed by WHATWG `URL`, no user info, no control characters,
 * at most 2,000 characters. Egress, the site lock and D-13 are decided by the API and the proxy, not here.
 */
export const BrowserUrl = z
  .string()
  .min(1)
  .max(BROWSER_LIMITS.urlMaxChars)
  .refine(
    (v) => {
      if (hasControlCharacter(v)) return false;
      let u: URL;
      try {
        u = new URL(v);
      } catch {
        return false;
      }
      return (u.protocol === "http:" || u.protocol === "https:") && u.username === "" && u.password === "";
    },
    { message: "must be an http or https URL without user info" },
  );
export type BrowserUrl = z.infer<typeof BrowserUrl>;

/**
 * A host as `URL.host` reports it (lower case, punycode, `:port` when not the default, IPv6 in brackets). Never a
 * scheme, path or query: the platform keeps hosts only.
 */
export const BrowserHost = z
  .string()
  .min(1)
  .max(260)
  .regex(/^[a-z0-9.\-[\]:]+$/, { message: "must be a lower-case host" });
export type BrowserHost = z.infer<typeof BrowserHost>;

/** Why the API refused a browser tool call (the plugin turns each into a fixed sentence for the model). */
export const BrowserRefusal = z.enum([
  "no_trigger",
  "sandbox_off",
  "module_off",
  "bot_off",
  "not_allowed",
  "killed",
  "cap_reached",
  "cpu_budget",
  "budget_exhausted",
  "tainted",
  "approval_required",
  "approval_pending",
  "approval_denied",
  "approval_used",
  "too_many_pending",
  "policy_changed",
  "service_unavailable",
  "timeout",
  "not_found",
  "too_large",
  "busy",
  "paused",
  "no_context",
  "signin_not_allowed",
  "signin_pending",
  "element_gone",
  "navigation_refused",
  "screenshot_unavailable",
]);
export type BrowserRefusal = z.infer<typeof BrowserRefusal>;

/**
 * HTTP status per refusal: 403 decisions (incl. `no_trigger`, the Agent Channel's existing convention for a call that
 * answers no live turn), 404 what does not exist for this turn, 409 state and approvals, 413 too large, 503 the
 * browser service is down or did not answer.
 */
export const BROWSER_REFUSAL_STATUS: Readonly<Record<BrowserRefusal, 403 | 404 | 409 | 413 | 422 | 503>> = {
  no_trigger: 403,
  sandbox_off: 403,
  module_off: 403,
  bot_off: 403,
  not_allowed: 403,
  killed: 403,
  cap_reached: 403,
  cpu_budget: 403,
  budget_exhausted: 403,
  tainted: 403,
  approval_required: 409,
  approval_pending: 409,
  approval_denied: 409,
  approval_used: 409,
  too_many_pending: 409,
  policy_changed: 409,
  service_unavailable: 503,
  timeout: 503,
  not_found: 404,
  too_large: 413,
  busy: 409,
  paused: 409,
  no_context: 404,
  signin_not_allowed: 403,
  signin_pending: 409,
  element_gone: 409,
  navigation_refused: 403,
  screenshot_unavailable: 404,
};

// ---------------------------------------------------------------- Agent Channel bodies (`/agent-channel/v1/browser/*`)

/** The delivered turn a call answers; the human is always the stored turn's, never a field. */
const turnFields = { eventId: Id, agentId: Id };

/** An opaque node id from the agent's redacted snapshot (never a CSS, XPath or text selector). */
export const BrowserRef = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, { message: "must be a snapshot ref" });
export type BrowserRef = z.infer<typeof BrowserRef>;

/** `POST /agent-channel/v1/browser/open` (`ocw_browser_open`). */
export const AgentChannelBrowserOpen = z.strictObject({ ...turnFields, url: BrowserUrl });
export type AgentChannelBrowserOpen = z.infer<typeof AgentChannelBrowserOpen>;

export const AgentChannelBrowserOpenResponse = z.strictObject({
  contextId: Id,
  host: BrowserHost,
  secure: z.boolean(),
  title: z.string().max(TITLE_MAX),
  /** A member's sealed session for this host is loaded (P-09). */
  signedIn: z.boolean(),
});
export type AgentChannelBrowserOpenResponse = z.infer<typeof AgentChannelBrowserOpenResponse>;

/** `POST /agent-channel/v1/browser/snapshot` (`ocw_browser_snapshot`): the redacted accessibility text. */
export const AgentChannelBrowserSnapshot = z.strictObject(turnFields);
export type AgentChannelBrowserSnapshot = z.infer<typeof AgentChannelBrowserSnapshot>;

export const AgentChannelBrowserSnapshotResponse = z.strictObject({
  contextId: Id,
  host: BrowserHost,
  title: z.string().max(TITLE_MAX),
  /** Refs and roles with names and values; password-like values are always `[redacted]` (P-10). */
  text: z.string().max(SNAPSHOT_TEXT_MAX),
  truncated: z.boolean(),
  signedIn: z.boolean(),
});
export type AgentChannelBrowserSnapshotResponse = z.infer<typeof AgentChannelBrowserSnapshotResponse>;

export const BrowserActAction = z.enum(["click", "type", "select", "press", "scroll"]);
export type BrowserActAction = z.infer<typeof BrowserActAction>;

export const BrowserScrollDirection = z.enum(["up", "down", "left", "right"]);
export type BrowserScrollDirection = z.infer<typeof BrowserScrollDirection>;

/** `POST /agent-channel/v1/browser/act` (`ocw_browser_act`): one action on a snapshot ref. */
export const AgentChannelBrowserAct = z
  .strictObject({
    ...turnFields,
    action: BrowserActAction,
    ref: BrowserRef.optional(),
    text: z.string().max(BROWSER_LIMITS.typeMaxChars).optional(),
    /** A key name such as `Enter`, `Tab` or `a` (no chords beyond what the agent maps). */
    key: z
      .string()
      .min(1)
      .max(32)
      .refine((k) => !hasControlCharacter(k), { message: "no control characters" })
      .optional(),
    option: z.string().min(1).max(NAME_MAX).optional(),
    direction: BrowserScrollDirection.optional(),
  })
  .superRefine((v, ctx) => {
    const need = (field: "ref" | "text" | "key" | "option" | "direction") => {
      if (v[field] === undefined)
        ctx.addIssue({ code: "custom", path: [field], message: `${v.action} needs ${field}` });
    };
    if (v.action === "click" || v.action === "type" || v.action === "select") need("ref");
    if (v.action === "type") need("text");
    if (v.action === "select") need("option");
    if (v.action === "press") need("key");
    if (v.action === "scroll") need("direction");
  });
export type AgentChannelBrowserAct = z.infer<typeof AgentChannelBrowserAct>;

/** Where a download landed (P-11): the bot's workspace, or the conversation when a member session was loaded. */
export const BrowserDownload = z
  .strictObject({
    name: z.string().min(1).max(255),
    size: z.number().int().nonnegative(),
    stored: z.enum(["workspace", "conversation"]),
    /** Workspace-relative (`downloads/<name>`); never an absolute path. */
    path: RelativePath.optional(),
    attachmentId: Id.optional(),
  })
  .refine((d) => (d.stored === "workspace" ? d.path !== undefined : d.attachmentId !== undefined), {
    message: "a workspace download has a path, a conversation download an attachment",
  });
export type BrowserDownload = z.infer<typeof BrowserDownload>;

export const AgentChannelBrowserActResponse = z.strictObject({
  contextId: Id,
  host: BrowserHost,
  signedIn: z.boolean(),
  navigated: z.boolean(),
  download: BrowserDownload.nullable(),
});
export type AgentChannelBrowserActResponse = z.infer<typeof AgentChannelBrowserActResponse>;

/** `POST /agent-channel/v1/browser/screenshot` (`ocw_browser_screenshot`, image-capable models only, D-14). */
export const AgentChannelBrowserScreenshot = z.strictObject(turnFields);
export type AgentChannelBrowserScreenshot = z.infer<typeof AgentChannelBrowserScreenshot>;

export const AgentChannelBrowserScreenshotResponse = z.strictObject({
  contextId: Id,
  host: BrowserHost,
  image: z.strictObject({
    mimeType: z.literal("image/jpeg"),
    data: z
      .string()
      .max(IMAGE_DATA_MAX)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, { message: "must be base64" }),
    width: z.number().int().positive().max(BROWSER_LIMITS.expandedWidth),
    height: z.number().int().positive().max(BROWSER_LIMITS.expandedHeight),
    /** Fields the agent masked with drawn boxes (password-like and takeover-typed, P-10). */
    masked: z.number().int().nonnegative(),
  }),
});
export type AgentChannelBrowserScreenshotResponse = z.infer<typeof AgentChannelBrowserScreenshotResponse>;

/** `POST /agent-channel/v1/browser/wait` (`ocw_browser_wait`). */
export const AgentChannelBrowserWait = z
  .strictObject({
    ...turnFields,
    for: z.enum(["load", "text", "time"]),
    text: z.string().min(1).max(NAME_MAX).optional(),
    ms: z.number().int().positive().max(30_000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.for === "text" && v.text === undefined) {
      ctx.addIssue({ code: "custom", path: ["text"], message: "wait for text needs text" });
    }
    if (v.for === "time" && v.ms === undefined) {
      ctx.addIssue({ code: "custom", path: ["ms"], message: "wait for time needs ms" });
    }
  });
export type AgentChannelBrowserWait = z.infer<typeof AgentChannelBrowserWait>;

export const AgentChannelBrowserWaitResponse = z.strictObject({
  contextId: Id,
  host: BrowserHost,
  ok: z.boolean(),
});
export type AgentChannelBrowserWaitResponse = z.infer<typeof AgentChannelBrowserWaitResponse>;

/**
 * `POST /agent-channel/v1/browser/signin` (`ocw_browser_signin`): the bot supplies only the reason; the host and the
 * card are composed by the API from the context (UI-SPEC Surface 2).
 */
export const AgentChannelBrowserSignIn = z.strictObject({
  ...turnFields,
  reason: z.string().trim().min(1).max(BROWSER_LIMITS.reasonMaxChars),
});
export type AgentChannelBrowserSignIn = z.infer<typeof AgentChannelBrowserSignIn>;

export const AgentChannelBrowserSignInResponse = z.strictObject({
  posted: z.literal(true),
  host: BrowserHost,
});
export type AgentChannelBrowserSignInResponse = z.infer<typeof AgentChannelBrowserSignInResponse>;

/** `POST /agent-channel/v1/browser/close` (`ocw_browser_close`). */
export const AgentChannelBrowserClose = z.strictObject(turnFields);
export type AgentChannelBrowserClose = z.infer<typeof AgentChannelBrowserClose>;

export const AgentChannelBrowserCloseResponse = z.strictObject({ closed: z.literal(true) });
export type AgentChannelBrowserCloseResponse = z.infer<typeof AgentChannelBrowserCloseResponse>;

// ---------------------------------------------------------------- live view (P-08, UI-SPEC §1.4, R3)

export const BrowserContextState = z.enum([
  "connecting",
  "live",
  "idle",
  "paused",
  "private",
  "controlling",
  "reconnecting",
  "ended",
  "no_permission",
]);
export type BrowserContextState = z.infer<typeof BrowserContextState>;

/** The server's `endReason` (UI-SPEC ended-reasons table). */
export const BrowserEndReason = z.enum([
  "closed_by_bot",
  "idle",
  "kill_switch",
  "module_off",
  "crashed",
  "access_lost",
]);
export type BrowserEndReason = z.infer<typeof BrowserEndReason>;

/** Why frames go to one person only: their takeover lease, or their sealed session is loaded (D-12 U-2). */
export const BrowserPrivateReason = z.enum(["takeover", "member_session"]);
export type BrowserPrivateReason = z.infer<typeof BrowserPrivateReason>;

/** Server → client control frame `state` (JSON text; frames themselves are binary JPEG). */
export const LiveStateFrame = z
  .strictObject({
    type: z.literal("state"),
    state: BrowserContextState,
    endReason: BrowserEndReason.optional(),
    pausedFor: z.enum(["approval", "signin"]).nullable(),
    /** Server-composed, masked ("clicking “Orders”"), ≤ 80 characters. */
    activity: z.string().max(ACTIVITY_MAX).nullable(),
    /** Null when the viewer may not learn the page (`no_permission`, `connecting` before the first navigation). */
    host: BrowserHost.nullable(),
    secure: z.boolean().nullable(),
    controller: z.enum(["self", "other_device", "other"]).nullable(),
    privateReason: BrowserPrivateReason.optional(),
    /** The member whose session or lease makes the view private ("Private browsing for {member}"). */
    memberName: z.string().max(NAME_MAX).optional(),
    /** The pending approval's permalink (the `Review` link of the paused state). */
    approvalRoute: AgentCardRoute.optional(),
    /**
     * 07.8-22 (additive): the member the bot browses for, sent only with the page (states that carry the host). The web
     * words "Only {person} can take control here." and "Waiting for {person} to sign in" with it.
     */
    requesterName: z.string().max(NAME_MAX).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.state === "ended" && v.endReason === undefined) {
      ctx.addIssue({ code: "custom", path: ["endReason"], message: "an ended state names its reason" });
    }
    if (v.state === "private" && v.privateReason === undefined) {
      ctx.addIssue({ code: "custom", path: ["privateReason"], message: "a private state names its reason" });
    }
  });
export type LiveStateFrame = z.infer<typeof LiveStateFrame>;

export const LiveServerFrame = z.union([
  LiveStateFrame,
  z.strictObject({ type: z.literal("viewerCan"), watch: z.boolean(), control: z.boolean() }),
  z.strictObject({ type: z.literal("lease"), expiresAt: IsoDateTime }),
  /** The focused field is password-like: the client shows the masking hint (never the value). */
  z.strictObject({ type: z.literal("focus"), sensitive: z.boolean() }),
  /**
   * 07.8-16 (additive): a `take` the server refused. `not_allowed`: the resolver's `browser.control` (only the member the
   * bot browses for); `someone_else`: another socket holds the lease; `expired`: the page ended meanwhile.
   */
  z.strictObject({
    type: z.literal("refused"),
    op: z.literal("take"),
    reason: z.enum(["not_allowed", "someone_else", "expired"]),
  }),
]);
export type LiveServerFrame = z.infer<typeof LiveServerFrame>;

const Coord = z.number().finite().min(0).max(COORD_MAX);
const WheelDelta = z.number().finite().min(-WHEEL_DELTA_MAX).max(WHEEL_DELTA_MAX);

const LiveKeyFrame = z.strictObject({
  type: z.literal("key"),
  event: z.enum(["down", "up"]),
  key: z.string().min(1).max(32),
  code: z.string().min(1).max(32),
  /** CDP bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
  modifiers: z.number().int().min(0).max(15),
});
const LiveTextFrame = z.strictObject({
  type: z.literal("text"),
  text: z.string().min(1).max(BROWSER_LIMITS.pasteMaxChars),
});
const LiveMouseFrame = z.strictObject({
  type: z.literal("mouse"),
  event: z.enum(["move", "down", "up"]),
  x: Coord,
  y: Coord,
  button: z.enum(["none", "left", "middle", "right"]),
});
const LiveWheelFrame = z.strictObject({
  type: z.literal("wheel"),
  x: Coord,
  y: Coord,
  dx: WheelDelta,
  dy: WheelDelta,
});
const LiveTouchFrame = z.strictObject({
  type: z.literal("touch"),
  event: z.enum(["start", "end"]),
  x: Coord,
  y: Coord,
});

/** Input from the person in control (never logged, P-10); forwarded only while they hold the lease. */
export const LiveInputFrame = z.discriminatedUnion("type", [
  LiveKeyFrame,
  LiveTextFrame,
  LiveMouseFrame,
  LiveWheelFrame,
  LiveTouchFrame,
]);
export type LiveInputFrame = z.infer<typeof LiveInputFrame>;

const LiveResizeFrame = z
  .strictObject({
    type: z.literal("resize"),
    mode: z.enum(["small", "expanded", "phone"]),
    width: z.number().int().min(200).max(2000).optional(),
    height: z.number().int().min(200).max(2000).optional(),
  })
  .refine((v) => v.mode !== "phone" || (v.width !== undefined && v.height !== undefined), {
    message: "phone mode names the frame area",
  });

/** Client → server JSON text frames: the lease (take, release, keep), resize (R10) and input. A closed union. */
export const LiveClientFrame = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("take") }),
  z.strictObject({ type: z.literal("release") }),
  z.strictObject({ type: z.literal("keep") }),
  LiveResizeFrame,
  LiveKeyFrame,
  LiveTextFrame,
  LiveMouseFrame,
  LiveWheelFrame,
  LiveTouchFrame,
]);
export type LiveClientFrame = z.infer<typeof LiveClientFrame>;

// ---------------------------------------------------------------- sign-in card, sessions, Browser tab (R1, R7)

export const BrowserSignInStatus = z.enum([
  "waiting",
  "signing_in",
  "signed_in",
  "skipped",
  "expired",
  "stopped",
]);
export type BrowserSignInStatus = z.infer<typeof BrowserSignInStatus>;

const Actor = z.strictObject({ id: Id, displayName: z.string().max(NAME_MAX) });

/**
 * One sealed browser session of the viewer (owner-only, P-09, D-12 U-3: member × site × bot). Never a cookie, a
 * username or any sealed value: the list proves a session exists, nothing else.
 */
export const BrowserSessionItem = z.strictObject({
  id: Id,
  /** The exact host the session was sealed for (P-09). */
  site: BrowserHost,
  agentId: Id,
  agentName: z.string().max(NAME_MAX),
  createdAt: IsoDateTime,
  lastUsedAt: IsoDateTime.nullable(),
  expiresAt: IsoDateTime,
  status: z.enum(["active", "expired"]),
});
export type BrowserSessionItem = z.infer<typeof BrowserSessionItem>;

/** `GET /api/v1/browser-sessions`. */
export const BrowserSessionList = z.strictObject({ items: z.array(BrowserSessionItem).max(500) });
export type BrowserSessionList = z.infer<typeof BrowserSessionList>;

export const BrowserConversationKind = z.enum(["channel", "thread", "dm", "group", "ai_chat"]);
export type BrowserConversationKind = z.infer<typeof BrowserConversationKind>;

/** An open context in the bot page's Browser tab ("Open now"). */
export const BrowserContextRow = z.strictObject({
  contextId: Id,
  host: BrowserHost,
  secure: z.boolean(),
  state: BrowserContextState,
  conversation: z.strictObject({
    kind: BrowserConversationKind,
    name: z.string().max(NAME_MAX),
    route: AgentCardRoute,
  }),
  openedAt: IsoDateTime,
  viewerCan: z.strictObject({ watch: z.boolean(), control: z.boolean() }),
  /** The person the view is private for (display name), or null. */
  privateFor: z.string().max(NAME_MAX).nullable(),
  /**
   * Why the row is private (07.8-27; UI-SPEC § 3.6): `takeover` = someone is signing in ("Private sign-in in progress"),
   * `member_session` = the page carries a member's saved sign-in ("Private browsing for {member}"). Null otherwise.
   */
  privateReason: BrowserPrivateReason.nullable().optional(),
});
export type BrowserContextRow = z.infer<typeof BrowserContextRow>;

/** A host-level event ("Recent activity"): pages and addresses are never kept. */
export const BrowserActivityItem = z.strictObject({
  kind: z.enum(["opened", "signed_in", "stopped"]),
  host: BrowserHost,
  conversation: z.strictObject({ kind: BrowserConversationKind, name: z.string().max(NAME_MAX) }),
  at: IsoDateTime,
  actor: Actor.nullable(),
});
export type BrowserActivityItem = z.infer<typeof BrowserActivityItem>;

/** `GET /api/v1/agents/:id/browser`. */
export const BrowserTabView = z.strictObject({
  open: z.array(BrowserContextRow).max(50),
  activity: z.array(BrowserActivityItem).max(20),
  nextCursor: z.string().max(200).nullable(),
  runtime: z.enum(["gvisor", "hardened-runc"]).nullable(),
  /** D-14; absent when the broker did not report it. */
  browserSandbox: BrowserSandboxMode.nullable().optional(),
});
export type BrowserTabView = z.infer<typeof BrowserTabView>;
