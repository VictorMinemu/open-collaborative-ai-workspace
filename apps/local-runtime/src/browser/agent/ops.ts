// The Work Zone browser agent on the device (07.13 D-01, D-04, D-07, D-12, D-35, PD-18, PD-24, A-8): a TypeScript port
// of the bots' brw agent ops it needs (`infra/sandbox/browser/agent.mjs`), on one page in one in-memory context, with
// the same redaction, isolated world and masked screenshots from `@ocw/browser-engine`, reused unchanged.
//
// Changed from brw: no proxy (the device's own network), no downloads (the context refuses them), one page per session
// (`open` on an open page navigates it), and every page is http(s): a URL with
// another scheme or a cloud metadata host is refused before navigating, and a route aborts every main-frame navigation
// (a redirect, a link, a pop-up) that is not http(s) and every request to a metadata host. Chromium is launched by
// playwright-core over a pipe (`--remote-debugging-pipe`): no debugging port, no listening socket. Chromium's sandbox is
// on unless `resolveChromiumSandbox` allowed container mode, and a launch that finds no usable sandbox fails; it is never
// retried without it.
//
// The caller never gets page script, DOM, HTML or an evaluated value: a page is seen only through `serializeSnapshot`
// over the accessibility tree and through screenshots with masked fields. Errors are `AgentError`s with fixed messages
// (never page text, a URL or a path); events name a page by its origin only.
//
// Sign-ins (07.13-19, D-22, D-24, D-26, PD-15 … PD-17): the one exception to "never cookies" is `exportState`, which
// answers the site's own storage state (`filterStateForSite`: cookies that domain-match the host, that host's origin
// storage) to the parent, which uploads it to the API and keeps nothing. `openWithState` puts a member's state into a
// NEW in-memory context (`newContext({ storageState })`, never a file) locked to its site: a top-level navigation to
// another host is aborted and reported in the op's answer (`blocked`, an origin only) until the parent says
// `allowCrossSite` after the member's own yes. `fingerprint` hashes the site's state (hex only) so the parent can tell
// whether a hand back changed it.

import { createHash, randomBytes } from "node:crypto";
import {
  type CdpSession,
  type MaskRect,
  maskedScreenshot,
  startScreencast,
} from "@ocw/browser-engine/capture";
import {
  type AXNode,
  backendIdFromRef,
  type FactsMap,
  type FieldFacts,
  isSensitive,
  isSensitiveField,
  type Marks,
  serializeSnapshot,
} from "@ocw/browser-engine/redact";
import { filterStateForSite, type StorageState } from "@ocw/browser-engine/site";
import { createWorld, replaceWorldScript } from "@ocw/browser-engine/world";
import {
  type BrowserOrigin,
  CLOUD_METADATA_HOSTS,
  FRAME_MAX_PAYLOAD_BYTES,
  isCloudMetadataHost,
  LiveInputFrame,
  originOf,
  WORK_BROWSER_LIMITS,
  WORK_BROWSER_REFUSAL_TEXT,
  WORK_BROWSER_TIMEOUTS_MS,
  WorkBrowserActInput,
  type WorkBrowserLaunchFailure,
  WorkBrowserOpenInput,
  type WorkBrowserRefusal,
  WorkBrowserStorageState,
  WorkBrowserWaitInput,
} from "@ocw/contracts";
// Types only: playwright-core is loaded on the first launch, so the daemon bundle never links it at start (it is an
// external installed beside the bundle, PD-22, and a missing install must name the SDK first, 07.12).
import type {
  Browser,
  BrowserContext,
  CDPSession,
  LaunchOptions,
  Page,
  Request,
  Route,
} from "playwright-core";
import { z } from "zod";

// ---------------------------------------------------------------- ops, errors, events

/**
 * The ops the child dispatches (`main.ts` reads only this list); a new op goes here together with its `runOp` arm. 15
 * added `frames` (the live screencast), `takeover` and `input`; 19 the sign-in ops (`exportState`, `fingerprint`,
 * `openWithState`, `lock`, `allowCrossSite`).
 */
export const AGENT_OPS = [
  "open",
  "snapshot",
  "act",
  "wait",
  "screenshot",
  "close",
  "info",
  "frames",
  "takeover",
  "input",
  "exportState",
  "fingerprint",
  "openWithState",
  "lock",
  "allowCrossSite",
] as const;
export type AgentOp = (typeof AGENT_OPS)[number];

export function isAgentOp(op: unknown): op is AgentOp {
  return typeof op === "string" && (AGENT_OPS as readonly string[]).includes(op);
}

/** `invalid_request`: a body the contracts refuse, or an action that does not fit the element (fixed messages). */
export type AgentErrorCode = WorkBrowserRefusal | WorkBrowserLaunchFailure | "invalid_request";

const FAILURE_TEXT: Readonly<Record<WorkBrowserLaunchFailure | "invalid_request", string>> = {
  unsupported_platform: "This device has no pinned browser build.",
  download_failed: "The browser could not be installed.",
  checksum_mismatch: "The browser download did not match its pinned checksum.",
  missing_library: "The browser is missing system libraries.",
  no_usable_sandbox: "The browser's sandbox is not available on this device.",
  launch_failed: "The browser could not be started.",
  invalid_request: "The request is not valid.",
};

/** One refusal or failure. `message` is a fixed sentence of this file (never page text, a URL or a path). */
export class AgentError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message?: string,
  ) {
    super(
      message ??
        (code in WORK_BROWSER_REFUSAL_TEXT
          ? WORK_BROWSER_REFUSAL_TEXT[code as WorkBrowserRefusal]
          : FAILURE_TEXT[code as WorkBrowserLaunchFailure | "invalid_request"]),
    );
    this.name = "AgentError";
  }
}

const fail = (code: AgentErrorCode, message?: string): never => {
  throw new AgentError(code, message);
};

/** What the agent reports on its own (the child forwards these as events): origins only, never a path. */
export type AgentEvent =
  | { event: "navigated"; origin: BrowserOrigin }
  | { event: "refused"; refusal: "navigation_refused" | "metadata_refused" }
  | { event: "crashed"; scope: "page" | "browser" }
  /** During a takeover the focused field became password-like or stopped being so (15, D-20): never its value. */
  | { event: "focus"; sensitive: boolean };

export type OpInput = Readonly<Record<string, unknown>>;

export interface PageState {
  /** `URL.host` of the page (`127.0.0.1:8080`), or `about:blank`. */
  host: string;
  secure: boolean;
  title: string;
}
export interface OpenResult extends PageState {
  signedIn: boolean;
}
export interface SnapshotResult extends PageState {
  text: string;
  truncated: boolean;
}
export interface ActResult {
  host: string;
  navigated: boolean;
  /** The context refuses downloads: always null. */
  download: null;
  /** A navigation this action started that the route refused. */
  refused: "navigation_refused" | "metadata_refused" | null;
  /**
   * 19 (D-26): on a site-locked page, the origin of another host this action tried to navigate to. The navigation was
   * aborted (the page stayed); `allowCrossSite` with that host replays it after the member said yes.
   */
  blocked: BrowserOrigin | null;
}
/** 19: the site's storage state (`siteState`) and its fingerprint. Never logged, never written to disk. */
export interface ExportStateResult {
  state: WorkBrowserStorageState;
  fingerprint: string;
}
/** 19: the SHA-256 (hex) of the site's state now, or null when no page is open. */
export interface FingerprintResult {
  fingerprint: string | null;
}
/** 19: a page opened with a member's state, locked to `siteHost`; `fingerprint` is that state's as loaded. */
export interface OpenWithStateResult extends OpenResult {
  fingerprint: string;
}
/** 19: an allowed cross-site navigation (replayed when it was the last one blocked). */
export interface AllowCrossSiteResult {
  host: string;
  navigated: boolean;
}
export interface WaitResult {
  ok: boolean;
  host: string;
}
export interface ScreenshotResult {
  mimeType: "image/jpeg";
  /** base64 */
  data: string;
  width: number;
  height: number;
  /** How many field boxes were painted over. */
  masked: number;
}
export interface InfoResult {
  sandbox: "chromium" | "container";
  /** Chromium's version once launched. */
  version: string | null;
  /** Pages in the context (one at most, PD-24). */
  pages: number;
}

export interface BrowserAgent {
  /**
   * The live screencast (07.13-15, D-15): `{ on }`. Remembered while no page is open, so the next page streams at
   * once. Not queued behind other ops: a frame request never waits for a navigation.
   */
  frames(input: OpInput): Promise<{ on: boolean }>;
  /**
   * A person holds the page (`{ on: true }`) or handed it back (15, D-20, PD-14): the isolated world marks the fields
   * that receive their trusted input, and the focus hint is reported. The manager decides who holds it; this only
   * applies it.
   */
  takeover(input: OpInput): Promise<{ active: boolean }>;
  /**
   * The holder's input (`{ events }`: 1 to 64 `LiveInputFrame`s) through CDP `Input.*` only, while a takeover is active.
   * Never logged, never echoed: the answer is the count.
   */
  input(input: OpInput): Promise<{ applied: number }>;
  open(input: OpInput): Promise<OpenResult>;
  snapshot(input: OpInput): Promise<SnapshotResult>;
  act(input: OpInput): Promise<ActResult>;
  wait(input: OpInput): Promise<WaitResult>;
  screenshot(input: OpInput): Promise<ScreenshotResult>;
  close(input: OpInput): Promise<{ closed: boolean }>;
  info(input: OpInput): Promise<InfoResult>;
  /** 19 (D-22, PD-15): `{ host }` → the site's state; `too_large` over `storageStateMaxBytes`. */
  exportState(input: OpInput): Promise<ExportStateResult>;
  /** 19 (PD-15): `{ host }` → the hash of the site's state now (taken when a person takes control). */
  fingerprint(input: OpInput): Promise<FingerprintResult>;
  /**
   * 19 (D-24, D-26, PD-16): `{ url, state, siteHost }` → closes the open context, opens a new in-memory one with `state`
   * (service workers blocked, downloads refused), locked to `siteHost`, and navigates to `url` (on that host).
   */
  openWithState(input: OpInput): Promise<OpenWithStateResult>;
  /** 19: `{ siteHost }` locks the open context to its site in place (idempotent; another host is refused). */
  lock(input: OpInput): Promise<{ locked: boolean }>;
  /** 19 (D-26): `{ host }` the member allowed on the locked page: allowed from now on, the blocked navigation replayed. */
  allowCrossSite(input: OpInput): Promise<AllowCrossSiteResult>;
}

/** One op by name (`main.ts` calls only this, after `isAgentOp`). */
export function runOp(agent: BrowserAgent, op: AgentOp, input: OpInput): Promise<unknown> {
  switch (op) {
    case "open":
      return agent.open(input);
    case "snapshot":
      return agent.snapshot(input);
    case "act":
      return agent.act(input);
    case "wait":
      return agent.wait(input);
    case "screenshot":
      return agent.screenshot(input);
    case "close":
      return agent.close(input);
    case "info":
      return agent.info(input);
    case "frames":
      return agent.frames(input);
    case "takeover":
      return agent.takeover(input);
    case "input":
      return agent.input(input);
    case "exportState":
      return agent.exportState(input);
    case "fingerprint":
      return agent.fingerprint(input);
    case "openWithState":
      return agent.openWithState(input);
    case "lock":
      return agent.lock(input);
    case "allowCrossSite":
      return agent.allowCrossSite(input);
  }
}

/** The child's deadline for one op: `open` and `openWithState` may launch Chromium first. */
export function opDeadlineMs(op: AgentOp): number {
  return op === "open" || op === "openWithState"
    ? WORK_BROWSER_TIMEOUTS_MS.launch + WORK_BROWSER_TIMEOUTS_MS.op
    : WORK_BROWSER_TIMEOUTS_MS.op;
}

// ---------------------------------------------------------------- sign-in state (19)

/** A host as `URL.host` writes it (`127.0.0.1:8080`, `github.com`), lower case; null for anything else. */
function siteHostOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const h = value.toLowerCase();
  return /^[a-z0-9.\-[\]:]{1,260}$/.test(h) ? h : null;
}

const byKey =
  <T>(key: (v: T) => string) =>
  (a: T, b: T): number => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };

/**
 * The site's part of a storage state (`filterStateForSite`) in a fixed order (cookies by domain, path and name;
 * origins by origin; storage items by name), so the same state always serialises, and so hashes, the same way.
 */
export function siteState(host: string, state: Partial<StorageState>): WorkBrowserStorageState {
  const filtered = filterStateForSite(host, state);
  const cookies = filtered.cookies
    .map((c) => {
      const { partitionKey } = c as { partitionKey?: unknown };
      return {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
        ...(typeof partitionKey === "string" ? { partitionKey } : {}),
      };
    })
    .sort(byKey((c) => `${c.domain}\u0000${c.path}\u0000${c.name}`));
  const origins = filtered.origins
    .map((o) => ({
      origin: o.origin,
      localStorage: o.localStorage.map((i) => ({ name: i.name, value: i.value })).sort(byKey((i) => i.name)),
    }))
    .sort(byKey((o) => o.origin));
  return { cookies, origins };
}

/** SHA-256 (hex) of a site state as `siteState` orders it. */
export function stateFingerprint(state: WorkBrowserStorageState): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

// ---------------------------------------------------------------- launch

/**
 * Chromium's host resolver maps every cloud metadata host to "not found" (D-35). Playwright's route sees only the first
 * URL of a redirect chain, so this is what stops a redirect (or any later hop) to a metadata endpoint; the route still
 * refuses direct requests first, with the `metadata_refused` code. IPv4 hosts are listed with the IPv4-mapped,
 * -compatible and NAT64 IPv6 spellings the URL parser canonicalises them to. A name that resolves to a metadata address
 * (DNS rebinding) is the documented residual (ADR-0035).
 */
export function metadataResolverRules(): string {
  const hosts: string[] = [];
  for (const h of CLOUD_METADATA_HOSTS) {
    if (h.includes(":")) {
      hosts.push(`[${h}]`);
      continue;
    }
    hosts.push(h);
    const octets = h.split(".").map(Number);
    if (octets.length === 4 && octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255)) {
      const [a = 0, b = 0, c = 0, d = 0] = octets;
      const tail = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
      hosts.push(`[::ffff:${tail}]`, `[::${tail}]`, `[64:ff9b::${tail}]`);
    }
  }
  return hosts.map((h) => `MAP ${h} ~NOTFOUND`).join(", ");
}

/** brw's launch arguments minus the proxy, plus the metadata resolver rules. Playwright adds the pipe itself. */
const LAUNCH_ARGS: readonly string[] = [
  "--disable-quic",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-crash-reporter",
  "--no-pings",
  `--host-resolver-rules=${metadataResolverRules()}`,
];

export interface BrowserAgentOptions {
  executablePath: string;
  /** From `resolveChromiumSandbox` only (PD-18). */
  chromiumSandbox: boolean;
  emit?: (event: AgentEvent) => void;
  /**
   * One live screencast JPEG and its size (07.13-15): at most `WORK_BROWSER_LIMITS.fps` per second, at most
   * `frameWidth`×`frameHeight`, quality `jpegQuality`. `main.ts` sends it as `FRAME_TYPES.jpeg` with a fixed 4-byte size
   * header (`encodeChildJpeg`, frames.ts). Never logged.
   */
  onJpeg?: (jpeg: Uint8Array, size: { width: number; height: number }) => void;
  /** Chromium went away without `close` (the child exits 3). */
  onDisconnected?: () => void;
}

/** The options `chromium.launch` gets (exported for the posture test). */
export function launchOptionsFor(opts: { executablePath: string; chromiumSandbox: boolean }): LaunchOptions {
  return {
    executablePath: opts.executablePath,
    headless: true,
    chromiumSandbox: opts.chromiumSandbox,
    timeout: WORK_BROWSER_TIMEOUTS_MS.launch,
    args: [...LAUNCH_ARGS],
    // The child handles its own signals (main.ts) and closes the browser itself.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };
}

/** Chromium's launch error as a `WorkBrowserLaunchFailure` (like brw: the reason only, never the message). */
export function launchFailureOf(err: unknown): WorkBrowserLaunchFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (/No usable sandbox/i.test(message)) return "no_usable_sandbox";
  if (/error while loading shared libraries/i.test(message)) return "missing_library";
  return "launch_failed";
}

// ---------------------------------------------------------------- URLs

/** Why a URL may not be shown: any scheme but http(s), user info, or a cloud metadata host (D-12, D-35). */
export function urlRefusal(url: string): "navigation_refused" | "metadata_refused" | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "navigation_refused";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "navigation_refused";
  if (u.username !== "" || u.password !== "") return "navigation_refused";
  if (isCloudMetadataHost(u.hostname)) return "metadata_refused";
  return null;
}

const hostOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : null;
  } catch {
    return null;
  }
};

const clip = (s: unknown, max: number): string => String(s ?? "").slice(0, max);
const TITLE_MAX = 200;
const HOST_MAX = 260;
/** A screenshot answer must fit one control frame with its JSON envelope. */
const SCREENSHOT_MAX_BASE64 = FRAME_MAX_PAYLOAD_BYTES - 16 * 1024;
const VIEWPORT = { width: WORK_BROWSER_LIMITS.frameWidth, height: WORK_BROWSER_LIMITS.frameHeight };
const SCREENSHOT_QUALITY = 80;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isTimeout = (err: unknown): boolean => err instanceof Error && err.name === "TimeoutError";

// ---------------------------------------------------------------- CDP

/** Playwright's CDPSession with string method names (the engine's `CdpSession`, results typed at each call). */
interface Cdp extends CdpSession {
  send<T = unknown>(method: string, params?: object): Promise<T>;
}

function cdpOf(raw: CDPSession): Cdp {
  const loose = raw as unknown as {
    send(method: string, params?: object): Promise<unknown>;
    on(event: string, handler: (params: { sessionId: number; data: string }) => void): unknown;
    off(event: string, handler: (params: { sessionId: number; data: string }) => void): unknown;
  };
  return {
    send: <T>(method: string, params?: object) => loose.send(method, params) as Promise<T>,
    on: (event, handler) => loose.on(event, handler),
    off: (event, handler) => loose.off(event, handler),
  };
}

interface RemoteObject {
  objectId?: string;
  value?: unknown;
}
interface EvaluateResult {
  result?: RemoteObject;
}
interface PropertiesResult {
  result: Array<{ name: string; value?: RemoteObject }>;
}
interface QuadsResult {
  quads?: number[][];
}

// ---------------------------------------------------------------- the agent

interface Session {
  context: BrowserContext;
  page: Page;
  cdp: Cdp;
  worldScriptId: string | null;
  /** A person controls the page (15); the world marks their input. */
  takeover: boolean;
  /** A person typed on this page (15): whole frames are masked in screenshots. */
  humanInput: boolean;
  refs: Set<string>;
  navCount: number;
  pendingNav: Set<Request>;
  /** The route's refusal of a main-frame navigation during the current op. */
  refused: "navigation_refused" | "metadata_refused" | null;
  /** The last http(s) URL the page committed (where a refused or failed navigation returns to). */
  lastGoodUrl: string | null;
  /** The running screencast's stop (15), or null. */
  frames: (() => Promise<void>) | null;
  /** Mouse buttons the holder keeps pressed (CDP `buttons` bitmask, 15). */
  buttons: number;
  /** The last focus hint sent (null: none yet in this takeover, so the next report always goes). */
  lastFocusSensitive: boolean | null;
  /** 19 (D-26): the host (`URL.host`) the page is locked to, or null for a public page. */
  siteLock: string | null;
  /** 19: the page was opened with a member's state (`openWithState`). */
  signedIn: boolean;
  /** 19: other hosts the member allowed on this locked page. */
  crossAllowed: Set<string>;
  /** 19: the last top-level navigation the lock aborted (its URL stays here, in the child, never in an answer). */
  blocked: { host: string; url: string } | null;
  /** 19: the origin the lock blocked during the current op. */
  opBlocked: BrowserOrigin | null;
}

/** The live screencast's settings (D-15): the bounds of every Work Zone frame. */
export const SCREENCAST = {
  maxWidth: WORK_BROWSER_LIMITS.frameWidth,
  maxHeight: WORK_BROWSER_LIMITS.frameHeight,
  quality: WORK_BROWSER_LIMITS.jpegQuality,
  fps: WORK_BROWSER_LIMITS.fps,
} as const;

/** One page in one in-memory context of one Chromium. Ops run one at a time, in order. */
export function createBrowserAgent(opts: BrowserAgentOptions): BrowserAgent {
  const emit = opts.emit ?? (() => {});
  let browser: Browser | null = null;
  let session: Session | null = null;
  let closing = false;
  let queue: Promise<unknown> = Promise.resolve();
  /** Someone watches (`frames { on: true }`): the page streams, and so does the next one. */
  let wantFrames = false;

  async function startFrames(s: Session): Promise<void> {
    if (s.frames || !opts.onJpeg || session !== s) return;
    const onJpeg = opts.onJpeg;
    s.frames = await startScreencast(s.cdp, SCREENCAST, (jpeg, size) => {
      if (session === s && s.frames) onJpeg(jpeg, size);
    });
    // Stopped or closed while the screencast was starting.
    if (!wantFrames || session !== s) await stopFrames(s);
  }

  async function stopFrames(s: Session): Promise<void> {
    const stop = s.frames;
    s.frames = null;
    await stop?.().catch(() => {});
  }

  /** Run `fn` after every earlier op (ops on one page never interleave). */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  async function launch(): Promise<Browser> {
    if (browser) return browser;
    let launched: Browser;
    try {
      const { chromium } = await import("playwright-core");
      launched = await chromium.launch(launchOptionsFor(opts));
    } catch (err) {
      return fail(launchFailureOf(err));
    }
    launched.on("disconnected", () => {
      if (browser !== launched) return;
      browser = null;
      session = null;
      if (closing) return;
      emit({ event: "crashed", scope: "browser" });
      opts.onDisconnected?.();
    });
    browser = launched;
    return launched;
  }

  async function onRoute(s: Session, route: Route): Promise<void> {
    const req = route.request();
    const url = req.url();
    // A request to a metadata host is never sent, whoever makes it (a page, a frame, a script).
    const metadata = urlRefusal(url) === "metadata_refused";
    if (!metadata && !req.isNavigationRequest()) return route.fallback();
    // A pop-up's first navigation is issued before its frame exists: `frame()` throws, so it counts as top level.
    let topLevel = true;
    try {
      topLevel = req.frame().parentFrame() === null;
    } catch {
      topLevel = true;
    }
    if (!metadata && !topLevel) return route.fallback();
    const refusal = urlRefusal(url);
    if (!refusal) {
      // 19 (D-26): a locked page's top-level navigation to another host waits for the member's yes.
      const host = hostOf(url);
      if (host && lockedOut(s, host)) {
        s.blocked = { host, url };
        s.opBlocked = originOf(url);
        return route.abort("aborted");
      }
      return route.fallback();
    }
    if (req.isNavigationRequest() && topLevel) {
      s.refused = refusal;
      emit({ event: "refused", refusal });
    }
    // net::ERR_ABORTED commits no error page: the current document stays.
    return route.abort("aborted");
  }

  /** 19: the page is locked to its site and `host` is neither that site nor one the member allowed. */
  function lockedOut(s: Session, host: string): boolean {
    const h = host.toLowerCase();
    return s.siteLock !== null && h !== s.siteLock && !s.crossAllowed.has(h);
  }

  /** A URL the page may not stay on: a refused one, or another host while the page is locked (19). */
  function offLimits(s: Session, url: string): boolean {
    if (urlRefusal(url) !== null) return true;
    const host = hostOf(url);
    return host !== null && lockedOut(s, host);
  }

  /** Single-page policy (PD-24): a pop-up is never kept; an http(s) one is opened in the session's page instead. */
  async function onPopup(s: Session, popup: Page): Promise<void> {
    if (popup === s.page) return;
    await popup.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
    const url = popup.url();
    await popup.close().catch(() => {});
    if (offLimits(s, url)) return;
    await serial(async () => {
      if (session !== s) return;
      await s.page.goto(url, { timeout: WORK_BROWSER_TIMEOUTS_MS.navigation }).catch(() => {});
    });
  }

  function attachPage(s: Session): void {
    const page = s.page;
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      s.navCount += 1;
      const url = frame.url();
      const origin = originOf(url);
      if (origin && !offLimits(s, url)) {
        s.lastGoodUrl = url;
        emit({ event: "navigated", origin });
      } else if (url !== "about:blank") {
        // A redirect the route does not see took a locked page to another host (19): reported like a block.
        const host = hostOf(url);
        if (host && urlRefusal(url) === null && lockedOut(s, host)) {
          s.blocked = { host, url };
          s.opBlocked ??= origin;
        }
        // An error page or another scheme committed outside an op's own check: go back before the next op runs.
        void serial(() => (session === s ? restore(s) : Promise.resolve()));
      }
    });
    page.on("crash", () => {
      if (session !== s) return;
      session = null;
      s.frames = null;
      emit({ event: "crashed", scope: "page" });
      void s.context.close().catch(() => {});
    });
    // The context refuses downloads; a download answers its navigation without committing a document.
    page.on("download", () => s.pendingNav.clear());
    s.context.on("request", (req) => {
      if (!isMainNavigation(req, page)) return;
      s.pendingNav.add(req);
      // A redirect hop the route does not see: the resolver rules stop it, this names the refusal.
      if (req.redirectedFrom()) {
        const refusal = urlRefusal(req.url());
        if (refusal && !s.refused) {
          s.refused = refusal;
          emit({ event: "refused", refusal });
        }
      }
    });
    const done = (req: Request) => s.pendingNav.delete(req);
    s.context.on("requestfinished", done);
    s.context.on("requestfailed", done);
    s.context.on("page", (p) => void onPopup(s, p));
  }

  /**
   * The session's one context and page, created on first use. 19: `signIn` opens it with a member's state, held in
   * memory only (`newContext({ storageState })` with an object, never a file), and locked to that site.
   */
  async function openSession(signIn?: {
    state: WorkBrowserStorageState;
    siteHost: string;
  }): Promise<Session> {
    if (session) return session;
    const b = await launch();
    const context = await b.newContext({
      viewport: VIEWPORT,
      // A service worker could answer a navigation outside request routing (and so outside the site lock).
      serviceWorkers: "block",
      acceptDownloads: false,
      ...(signIn ? { storageState: signIn.state } : {}),
    });
    try {
      const page = await context.newPage();
      const cdp = cdpOf(await context.newCDPSession(page));
      const s: Session = {
        context,
        page,
        cdp,
        worldScriptId: null,
        takeover: false,
        humanInput: false,
        refs: new Set(),
        navCount: 0,
        pendingNav: new Set(),
        refused: null,
        lastGoodUrl: null,
        frames: null,
        buttons: 0,
        lastFocusSensitive: null,
        siteLock: signIn ? signIn.siteHost : null,
        signedIn: signIn !== undefined,
        crossAllowed: new Set(),
        blocked: null,
        opBlocked: null,
      };
      await context.route("**/*", (route) => onRoute(s, route));
      await cdp.send("Page.enable");
      s.worldScriptId = await replaceWorldScript(cdp, null, false);
      attachPage(s);
      session = s;
      if (wantFrames) await startFrames(s).catch(() => {});
      return s;
    } catch (err) {
      await context.close().catch(() => {});
      throw err;
    }
  }

  /**
   * Only http(s) pages are ever shown (A-8): when a navigation the route could not see (a redirect to `file:`, a network
   * error) committed Chromium's error page or any other scheme, the page goes back to its last http(s) URL, else to
   * `about:blank`.
   */
  async function restore(s: Session): Promise<void> {
    const url = s.page.url();
    if (url === "about:blank" || !offLimits(s, url)) return;
    const timeout = WORK_BROWSER_TIMEOUTS_MS.navigation;
    if (s.lastGoodUrl) {
      await s.page.goBack({ timeout }).catch(() => null);
      if (!offLimits(s, s.page.url())) return;
      await s.page.goto(s.lastGoodUrl, { timeout }).catch(() => null);
      if (!offLimits(s, s.page.url())) return;
    }
    await s.page.goto("about:blank", { timeout }).catch(() => null);
  }

  function current(): Session {
    if (!session) return fail("no_context");
    return session;
  }

  async function pageState(s: Session): Promise<PageState> {
    const url = s.page.url();
    const title = clip(await s.page.title().catch(() => ""), TITLE_MAX);
    return { host: clip(hostOf(url) ?? "about:blank", HOST_MAX), secure: url.startsWith("https:"), title };
  }

  // ------------------------------------------------------------ the isolated world (world.mjs)

  /** backendNodeIds of the elements of an array object. */
  async function backendIds(cdp: Cdp, arrayObjectId: string): Promise<number[]> {
    const { result } = await cdp.send<PropertiesResult>("Runtime.getProperties", {
      objectId: arrayObjectId,
      ownProperties: true,
    });
    const items = result
      .filter((p) => /^\d+$/.test(p.name) && p.value?.objectId)
      .sort((a, b) => Number(a.name) - Number(b.name));
    const ids: number[] = [];
    for (const p of items) {
      const { node } = await cdp.send<{ node: { backendNodeId: number } }>("DOM.describeNode", {
        objectId: p.value?.objectId,
      });
      ids.push(node.backendNodeId);
    }
    return ids;
  }

  /** The DOM facts the redaction needs (never a value) and the marks of fields a person typed into. */
  async function readFieldState(s: Session): Promise<{ facts: FactsMap; marks: Marks; contextId: number }> {
    const contextId = await createWorld(s.cdp, s.takeover);
    const cdp = s.cdp;
    const group = `ocw-${randomBytes(6).toString("hex")}`;
    try {
      const fields = await cdp.send<EvaluateResult>("Runtime.evaluate", {
        contextId,
        expression: "__ocw.fields()",
        objectGroup: group,
      });
      const facts: FactsMap = new Map();
      if (fields.result?.objectId) {
        const ids = await backendIds(cdp, fields.result.objectId);
        const { result } = await cdp.send<EvaluateResult>("Runtime.callFunctionOn", {
          objectId: fields.result.objectId,
          functionDeclaration: "function () { return __ocw.factsOf(this); }",
          returnByValue: true,
        });
        const list = Array.isArray(result?.value) ? (result.value as FieldFacts[]) : [];
        ids.forEach((id, i) => {
          const f = list[i];
          if (f) facts.set(id, f);
        });
      }
      const marked = await cdp.send<EvaluateResult>("Runtime.evaluate", {
        contextId,
        expression: "__ocw.marked()",
        objectGroup: group,
      });
      const marks: Marks = new Set(
        marked.result?.objectId ? await backendIds(cdp, marked.result.objectId) : [],
      );
      return { facts, marks, contextId };
    } finally {
      await cdp.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
    }
  }

  /** The only view of a page the caller ever gets. */
  async function redactedSnapshot(s: Session) {
    const { facts, marks } = await readFieldState(s);
    const { nodes } = await s.cdp.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
    return serializeSnapshot(nodes, marks, facts, { maxText: WORK_BROWSER_LIMITS.snapshotTextMax });
  }

  // ------------------------------------------------------------ actions on snapshot refs

  /** After an action: let a navigation it started commit and load. */
  async function settle(s: Session): Promise<void> {
    await sleep(300);
    const until = Date.now() + 10_000;
    while (s.pendingNav.size > 0 && Date.now() < until) await sleep(50);
    s.pendingNav.clear();
    await s.page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
  }

  function resolveRef(s: Session, ref: string): number {
    const id = backendIdFromRef(ref);
    if (id === null || !s.refs.has(ref)) return fail("element_gone");
    return id;
  }

  async function boxOf(s: Session, backendNodeId: number): Promise<MaskRect> {
    try {
      await s.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
      const { quads } = await s.cdp.send<QuadsResult>("DOM.getContentQuads", { backendNodeId });
      if (!quads?.length) return fail("element_gone");
      return quadBox(quads);
    } catch (err) {
      if (err instanceof AgentError) throw err;
      return fail("element_gone");
    }
  }

  /** Call `fn` on the element in the agent's isolated world (never the page's), returning a JSON value. */
  async function callOnElement(
    s: Session,
    backendNodeId: number,
    fn: string,
    args: unknown[] = [],
  ): Promise<unknown> {
    const contextId = await createWorld(s.cdp, s.takeover);
    let objectId: string | undefined;
    try {
      ({
        object: { objectId },
      } = await s.cdp.send<{ object: RemoteObject }>("DOM.resolveNode", {
        backendNodeId,
        executionContextId: contextId,
      }));
    } catch {
      return fail("element_gone");
    }
    if (!objectId) return fail("element_gone");
    try {
      const { result } = await s.cdp.send<EvaluateResult>("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: fn,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
      });
      return result?.value;
    } finally {
      await s.cdp.send("Runtime.releaseObject", { objectId }).catch(() => {});
    }
  }

  async function perform(
    s: Session,
    input: WorkBrowserActInput,
    backendNodeId: number | null,
  ): Promise<void> {
    const cdp = s.cdp;
    switch (input.action) {
      case "click": {
        const b = await boxOf(s, backendNodeId as number);
        await mouseClick(cdp, b.x + b.width / 2, b.y + b.height / 2);
        return;
      }
      case "type": {
        const text = input.text ?? "";
        const id = backendNodeId as number;
        await boxOf(s, id);
        const ok = await callOnElement(s, id, FOCUS_FOR_TYPING);
        if (ok !== true) fail("invalid_request", "The element is not editable.");
        if (text === "") {
          for (const type of ["rawKeyDown", "keyUp"])
            await cdp.send("Input.dispatchKeyEvent", {
              type,
              key: "Backspace",
              code: "Backspace",
              windowsVirtualKeyCode: 8,
            });
        } else await cdp.send("Input.insertText", { text });
        return;
      }
      case "select": {
        const res = await callOnElement(s, backendNodeId as number, SELECT_OPTION, [input.option ?? ""]);
        if (res === "not_select") fail("invalid_request", "The element is not a list.");
        if (res !== "ok") fail("invalid_request", "The list has no such option.");
        return;
      }
      case "press": {
        const key = input.key ?? "";
        if (!/^[A-Za-z0-9+]{1,32}$/.test(key)) fail("invalid_request", "The key is not a key name.");
        if (backendNodeId !== null) {
          try {
            await cdp.send("DOM.focus", { backendNodeId });
          } catch {
            fail("element_gone");
          }
        }
        try {
          await s.page.keyboard.press(key);
        } catch {
          fail("invalid_request", "The key is not a key name.");
        }
        return;
      }
      case "scroll": {
        const d = SCROLL[input.direction ?? "down"];
        let at = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
        if (backendNodeId !== null) {
          const b = await boxOf(s, backendNodeId);
          at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        }
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: at.x,
          y: at.y,
          deltaX: d[0],
          deltaY: d[1],
        });
        return;
      }
    }
  }

  /** Viewport boxes of every field the snapshot would redact, and of every frame once a person typed on this page. */
  async function maskRects(s: Session): Promise<MaskRect[]> {
    const { facts, marks, contextId } = await readFieldState(s);
    const { nodes } = await s.cdp.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
    const ids = new Set<number>(marks);
    for (const node of nodes) {
      if (node.backendDOMNodeId && isSensitive(node, marks, facts)) ids.add(node.backendDOMNodeId);
    }
    for (const [id, f] of facts) if (isSensitiveField(f)) ids.add(id);
    if (s.humanInput) {
      // Fields inside frames are outside this document's tree: after a takeover, whole frames are masked.
      const group = `ocw-${randomBytes(6).toString("hex")}`;
      try {
        const frames = await s.cdp.send<EvaluateResult>("Runtime.evaluate", {
          contextId,
          expression: 'Array.from(document.querySelectorAll("iframe, frame, embed, object"))',
          objectGroup: group,
        });
        if (frames.result?.objectId)
          for (const id of await backendIds(s.cdp, frames.result.objectId)) ids.add(id);
      } finally {
        await s.cdp.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
      }
    }
    const rects: MaskRect[] = [];
    for (const backendNodeId of ids) {
      const { quads } = await s.cdp
        .send<QuadsResult>("DOM.getContentQuads", { backendNodeId })
        .catch((): QuadsResult => ({ quads: [] }));
      if (quads?.length) rects.push(quadBox(quads));
    }
    return rects;
  }

  // ------------------------------------------------------------ takeover input (brw's dispatchInput, reportFocus)

  /** One `LiveInputFrame` (already parsed): applied to the page through CDP and written nowhere else. */
  async function dispatchInput(s: Session, ev: LiveInputFrame): Promise<void> {
    const cdp = s.cdp;
    switch (ev.type) {
      case "key": {
        const modifiers = ev.modifiers & 15;
        const printable = [...ev.key].length === 1;
        // Ctrl or Meta held: a shortcut, not text.
        const text =
          ev.event === "down" && (modifiers & 6) === 0
            ? (NAMED_KEYS[ev.key]?.[1] ?? (printable ? ev.key : undefined))
            : undefined;
        await cdp.send("Input.dispatchKeyEvent", {
          type: ev.event === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
          key: ev.key,
          code: ev.code,
          modifiers,
          windowsVirtualKeyCode: keyCode(ev.key),
          ...(text ? { text, unmodifiedText: text } : {}),
        });
        return;
      }
      case "text":
        await cdp.send("Input.insertText", { text: ev.text });
        return;
      case "mouse": {
        if (ev.event === "down") s.buttons |= BUTTON_BITS[ev.button];
        if (ev.event === "up") s.buttons &= ~BUTTON_BITS[ev.button];
        await cdp.send("Input.dispatchMouseEvent", {
          type: MOUSE_TYPES[ev.event],
          x: ev.x,
          y: ev.y,
          button: ev.button,
          buttons: s.buttons,
          clickCount: ev.event === "move" ? 0 : 1,
        });
        return;
      }
      case "wheel":
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: ev.x,
          y: ev.y,
          deltaX: ev.dx,
          deltaY: ev.dy,
        });
        return;
      case "touch":
        // The device's page is never in phone mode: a touch is a left click.
        await cdp.send("Input.dispatchMouseEvent", {
          type: ev.event === "start" ? "mousePressed" : "mouseReleased",
          x: ev.x,
          y: ev.y,
          button: "left",
          buttons: ev.event === "start" ? 1 : 0,
          clickCount: 1,
        });
        return;
    }
  }

  /** `focus { sensitive }` when the focused field turns password-like or stops being so (never its value or name). */
  async function reportFocus(s: Session): Promise<void> {
    const contextId = await createWorld(s.cdp, s.takeover);
    const { result } = await s.cdp.send<EvaluateResult>("Runtime.evaluate", {
      contextId,
      expression: "__ocw.focusFacts()",
      returnByValue: true,
    });
    const facts = (result?.value ?? null) as FieldFacts | null;
    // No focused field (brw): nothing to mask. A field without facts is sensitive (doubt redacts).
    const sensitive = facts ? isSensitiveField(facts) : false;
    if (sensitive === s.lastFocusSensitive) return;
    s.lastFocusSensitive = sensitive;
    emit({ event: "focus", sensitive });
  }

  // ------------------------------------------------------------ ops

  return {
    async frames(input) {
      wantFrames = input.on === true;
      const s = session;
      if (s) {
        if (wantFrames) await startFrames(s).catch(() => {});
        else await stopFrames(s);
      }
      return { on: wantFrames && session !== null && session.frames !== null };
    },

    takeover(input) {
      const on = input.on === true;
      return serial(async () => {
        const s = current();
        s.takeover = on;
        // New documents get the flag from the registered script, the current one from `createWorld`.
        s.worldScriptId = await replaceWorldScript(s.cdp, s.worldScriptId, on);
        await createWorld(s.cdp, on);
        if (on) {
          s.lastFocusSensitive = null;
          await reportFocus(s).catch(() => {});
        } else s.buttons = 0;
        return { active: on };
      });
    },

    input(input) {
      const parsed = TakeoverInput.safeParse(input.events);
      if (!parsed.success) return Promise.reject(new AgentError("invalid_request"));
      const events = parsed.data;
      return serial(async () => {
        const s = current();
        if (!s.takeover) return fail("invalid_request", "No takeover is active.");
        // From now on whole frames are masked in screenshots too (fields inside frames are not in the marks).
        s.humanInput = true;
        for (const ev of events) await dispatchInput(s, ev);
        await reportFocus(s).catch(() => {});
        return { applied: events.length };
      });
    },

    async open(input) {
      const url = typeof input.url === "string" ? input.url : "";
      const refusal = urlRefusal(url);
      if (refusal) {
        emit({ event: "refused", refusal });
        return fail(refusal);
      }
      if (!WorkBrowserOpenInput.safeParse({ url }).success) return fail("invalid_request");
      return serial(async () => {
        const s = await openSession();
        s.refused = null;
        try {
          await s.page.goto(url, { waitUntil: "load", timeout: WORK_BROWSER_TIMEOUTS_MS.navigation });
        } catch (err) {
          // Chromium commits its error page (an unsafe redirect, a network error) after `goto` rejects.
          await settle(s);
          await restore(s);
          if (s.refused) return fail(s.refused);
          if (isTimeout(err)) return fail("timeout");
          return fail("navigation_refused");
        }
        if (s.refused || urlRefusal(s.page.url()) !== null) {
          await restore(s);
          return fail(s.refused ?? "navigation_refused");
        }
        return { ...(await pageState(s)), signedIn: s.signedIn };
      });
    },

    snapshot() {
      return serial(async () => {
        const s = current();
        const snap = await redactedSnapshot(s);
        s.refs = new Set(snap.nodes.map((n) => n.ref));
        return { ...(await pageState(s)), text: snap.text, truncated: snap.truncated };
      });
    },

    act(input) {
      const parsed = WorkBrowserActInput.safeParse(input);
      if (!parsed.success) return Promise.reject(new AgentError("invalid_request"));
      const body = parsed.data;
      return serial(async () => {
        const s = current();
        let backendNodeId: number | null = null;
        if (body.ref !== undefined) backendNodeId = resolveRef(s, body.ref);
        s.refused = null;
        s.opBlocked = null;
        const before = s.navCount;
        await perform(s, body, backendNodeId);
        await settle(s);
        await restore(s);
        return {
          host: (await pageState(s)).host,
          navigated: s.navCount > before,
          download: null,
          refused: s.refused,
          blocked: s.opBlocked,
        };
      });
    },

    wait(input) {
      const parsed = WorkBrowserWaitInput.safeParse(input);
      if (!parsed.success) return Promise.reject(new AgentError("invalid_request"));
      const body = parsed.data;
      return serial(async () => {
        const s = current();
        const ms = body.ms ?? 10_000;
        let ok = true;
        if (body.for === "time") await sleep(ms);
        else if (body.for === "load") {
          ok = await s.page.waitForLoadState("load", { timeout: ms }).then(
            () => true,
            () => false,
          );
        } else {
          // Matched against the redacted snapshot, never the page's own text: a text probe must not become an oracle
          // for what was typed into a password field.
          const text = body.text ?? "";
          const until = Date.now() + ms;
          ok = false;
          for (;;) {
            const seen = await redactedSnapshot(s).then(
              (snap) => snap.text,
              () => "",
            );
            if (seen.includes(text)) {
              ok = true;
              break;
            }
            if (Date.now() >= until) break;
            await sleep(250);
          }
        }
        return { ok, host: (await pageState(s)).host };
      });
    },

    screenshot() {
      return serial(async () => {
        const s = current();
        let shot: Awaited<ReturnType<typeof maskedScreenshot>>;
        try {
          shot = await maskedScreenshot(s.cdp, await maskRects(s), {
            format: "jpeg",
            quality: SCREENSHOT_QUALITY,
          });
        } catch {
          return fail("screenshot_unavailable");
        }
        if (shot.data.length > SCREENSHOT_MAX_BASE64) return fail("too_large");
        return {
          mimeType: "image/jpeg" as const,
          data: shot.data,
          width: shot.width,
          height: shot.height,
          masked: shot.masked,
        };
      });
    },

    close() {
      return serial(async () => {
        const had = session !== null || browser !== null;
        closing = true;
        try {
          const s = session;
          session = null;
          if (s) await stopFrames(s);
          await s?.context.close().catch(() => {});
          const b = browser;
          browser = null;
          await b?.close().catch(() => {});
        } finally {
          closing = false;
        }
        return { closed: had };
      });
    },

    async info() {
      return {
        sandbox: opts.chromiumSandbox ? "chromium" : "container",
        version: browser?.version() ?? null,
        pages: session ? session.context.pages().length : 0,
      };
    },

    exportState(input) {
      return serial(async () => {
        const s = current();
        const host = exportHost(s, input.host);
        const state = siteState(host, await s.context.storageState());
        if (Buffer.byteLength(JSON.stringify(state), "utf8") > WORK_BROWSER_LIMITS.storageStateMaxBytes) {
          return fail("too_large");
        }
        return { state, fingerprint: stateFingerprint(state) };
      });
    },

    fingerprint(input) {
      return serial(async () => {
        const s = session;
        if (!s) return { fingerprint: null };
        const host = exportHost(s, input.host);
        return { fingerprint: stateFingerprint(siteState(host, await s.context.storageState())) };
      });
    },

    openWithState(input) {
      const url = typeof input.url === "string" ? input.url : "";
      const siteHost = siteHostOf(input.siteHost);
      const parsed = WorkBrowserStorageState.safeParse(input.state);
      const refusal = urlRefusal(url);
      if (refusal) {
        emit({ event: "refused", refusal });
        return Promise.reject(new AgentError(refusal));
      }
      if (!siteHost || !parsed.success || hostOf(url)?.toLowerCase() !== siteHost) {
        return Promise.reject(new AgentError("invalid_request"));
      }
      // Only the site's own part ever goes into the context, whatever the API sent.
      const state = siteState(siteHost, parsed.data);
      return serial(async () => {
        await closeSession();
        const s = await openSession({ state, siteHost });
        try {
          // The state as loaded: a later re-seal says whether it changed since (PD-17).
          const fingerprint = stateFingerprint(siteState(siteHost, await s.context.storageState()));
          s.refused = null;
          s.opBlocked = null;
          try {
            await s.page.goto(url, { waitUntil: "load", timeout: WORK_BROWSER_TIMEOUTS_MS.navigation });
          } catch (err) {
            await settle(s);
            if (s.refused) return fail(s.refused);
            if (isTimeout(err)) return fail("timeout");
            return fail("navigation_refused");
          }
          if (s.refused || offLimits(s, s.page.url())) return fail(s.refused ?? "navigation_refused");
          return { ...(await pageState(s)), signedIn: true, fingerprint };
        } catch (err) {
          // A signed-in page that did not open is not kept: the member's state leaves memory with its context.
          if (session === s) await closeSession();
          throw err;
        }
      });
    },

    lock(input) {
      const lock = siteHostOf(input.siteHost);
      if (!lock) return Promise.reject(new AgentError("invalid_request", "siteHost is not a host."));
      return serial(async () => {
        const s = current();
        if (s.siteLock && s.siteLock !== lock) {
          return fail("invalid_request", "The page is locked to another site.");
        }
        s.siteLock = lock;
        return { locked: true };
      });
    },

    allowCrossSite(input) {
      const host = siteHostOf(input.host);
      if (!host) return Promise.reject(new AgentError("invalid_request"));
      return serial(async () => {
        const s = current();
        if (!s.siteLock) return { host: (await pageState(s)).host, navigated: false };
        s.crossAllowed.add(host);
        const blocked = s.blocked;
        s.blocked = null;
        if (blocked?.host.toLowerCase() !== host) {
          return { host: (await pageState(s)).host, navigated: false };
        }
        const before = s.navCount;
        s.refused = null;
        await s.page
          .goto(blocked.url, { waitUntil: "load", timeout: WORK_BROWSER_TIMEOUTS_MS.navigation })
          .catch(() => null);
        await settle(s);
        await restore(s);
        return { host: (await pageState(s)).host, navigated: s.navCount > before };
      });
    },
  };

  /** The host a state is exported for: the asked one, which must be the page's lock when the page is locked. */
  function exportHost(s: Session, asked: unknown): string {
    const host = siteHostOf(asked);
    if (!host) return fail("invalid_request");
    if (s.siteLock && s.siteLock !== host)
      return fail("invalid_request", "The page is locked to another site.");
    return host;
  }

  /** Ends the open context; the browser stays for the next one. */
  async function closeSession(): Promise<void> {
    const s = session;
    session = null;
    if (!s) return;
    await stopFrames(s);
    await s.context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- helpers (brw's, unchanged)

function isMainNavigation(req: Request, page: Page): boolean {
  try {
    return req.isNavigationRequest() && req.frame() === page.mainFrame();
  } catch {
    return false;
  }
}

function quadBox(quads: number[][]): MaskRect {
  const xs = quads.flatMap((q) => [q[0] ?? 0, q[2] ?? 0, q[4] ?? 0, q[6] ?? 0]);
  const ys = quads.flatMap((q) => [q[1] ?? 0, q[3] ?? 0, q[5] ?? 0, q[7] ?? 0]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

async function mouseClick(cdp: Cdp, x: number, y: number): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

/** A takeover's input batch: the contracts' `LiveInputFrame`s, as many as one `browser.input` frame carries. */
const TakeoverInput = z.array(LiveInputFrame).min(1).max(64);

/** brw's named keys: Windows virtual key code, and the text a key down types (none for the rest). */
const NAMED_KEYS: Readonly<Record<string, readonly [number, string?]>> = {
  Enter: [13, "\r"],
  Tab: [9],
  Backspace: [8],
  Delete: [46],
  Escape: [27],
  ArrowLeft: [37],
  ArrowUp: [38],
  ArrowRight: [39],
  ArrowDown: [40],
  Home: [36],
  End: [35],
  PageUp: [33],
  PageDown: [34],
  Shift: [16],
  Control: [17],
  Alt: [18],
  Meta: [91],
  " ": [32, " "],
};

function keyCode(key: string): number {
  const named = NAMED_KEYS[key];
  if (named) return named[0];
  if (key.length === 1) {
    const c = key.toUpperCase().charCodeAt(0);
    if ((c >= 65 && c <= 90) || (c >= 48 && c <= 57)) return c;
  }
  return 0;
}

const MOUSE_TYPES = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" } as const;
const BUTTON_BITS = { none: 0, left: 1, right: 2, middle: 4 } as const;

const SCROLL: Readonly<Record<"up" | "down" | "left" | "right", readonly [number, number]>> = {
  up: [0, -400],
  down: [0, 400],
  left: [-400, 0],
  right: [400, 0],
};

const FOCUS_FOR_TYPING = `function () {
  const el = this;
  const t = el.localName === "input" ? String(el.type || "text").toLowerCase() : null;
  const nonText = ["button", "checkbox", "radio", "submit", "reset", "file", "image", "range", "color", "hidden"];
  const textual = el.localName === "textarea" || el.isContentEditable || (t !== null && !nonText.includes(t));
  if (!textual || el.disabled || el.readOnly) return false;
  el.focus();
  if (typeof el.select === "function") el.select();
  else {
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }
  return true;
}`;

const SELECT_OPTION = `function (wanted) {
  if (this.localName !== "select" || this.disabled) return "not_select";
  const o = Array.from(this.options).find((o) => o.value === wanted || o.label === wanted || o.text.trim() === wanted);
  if (!o) return "no_option";
  this.value = o.value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return "ok";
}`;
