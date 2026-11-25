// The device's Work Zone browser manager (07.13 D-02, D-05, D-07, D-09 … D-14, D-18, D-19, D-34, PD-08 … PD-11, PD-20,
// PD-23, PD-24, PD-28; ADR-0035). One per daemon. It owns every session's browser and decides every call, so both
// runtimes follow the same rules (principle 5: the adapters only expose the tools it hands them).
//
// Per call, in this order: the device owner's opt-in read now (an `ocw-runtime browser off` refuses the next call) →
// the running turn's grant (`allowed`, decided by the API per turn, PD-09) → the lease (a person holds the page:
// `paused`, answered at once) → the body (Zod, from the contracts) → approvals (admin rule modes, then the host gate)
// → the session's child (`BrowserChild`, started lazily, the pinned browser installed on first use) → the result.
//
// What leaves the manager: results for the model (page text only inside `pageContent`'s untrusted block), timeline
// summaries (action and `host:port`), `browser.event` frames with ids, codes and an origin only, and the approval and
// status events of the session's normal event path (`emit` = the daemon's `forwardEvent`, which sanitises them). Never
// a URL path, a title, typed text or page text in an event or a frame (D-09, D-14, P1, P3).

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  type ApprovalDecision,
  type ApprovalOutcome,
  type BrowserOrigin,
  type BrowserServerFrame,
  canonicalBrowserTool,
  type DeviceToServerFrame,
  isLoopbackHost,
  originOf,
  type SessionBrowserGrant,
  type SessionEvent,
  WORK_BROWSER_INPUTS,
  WORK_BROWSER_LIMITS,
  type WorkBrowserAction,
  type WorkBrowserEventKind,
  WorkBrowserLaunchFailure,
  WorkBrowserRefusal,
  type WorkBrowserSignInInput,
  type WorkBrowserTool,
} from "@ocw/contracts";
import { type Logger, silentLogger } from "../logger.js";
import type {
  ActResult,
  AgentOp,
  FingerprintResult,
  OpenResult,
  OpenWithStateResult,
  ScreenshotResult,
  SnapshotResult,
  WaitResult,
} from "./agent/ops.js";
import { BrowserApprovalBroker } from "./approvals.js";
import { BrowserChild, type BrowserChildEvent, sessionRunDir } from "./child.js";
import { type LiveClock, LiveFrames } from "./frames.js";
import { BrowserInstallError, installBrowser, installedBrowser } from "./install.js";
import { ensureShimToken, SHIM_TOKEN_FILE, verifyShimToken } from "./shim-token.js";
import { reseal, SignInLoads, saveHandback, siteHostOfOrigin } from "./signin.js";
import { Takeover } from "./takeover.js";
import {
  browserToolSummary,
  hostPortOf,
  invalidResult,
  pageContent,
  refusedResult,
  textResult,
  type WorkBrowserToolResult,
} from "./tools.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What an adapter gets for one session (`StartSessionOptions.browser`). The adapter only exposes the tools, and only
 * while `available`; every rule is the manager's.
 */
export interface SessionBrowserTools {
  /** The device's opt-in is on, the session's latest grant allows the browser and the adapter did not mark it off. */
  readonly available: boolean;
  /** One tool call. Never throws: a refusal or a bad body is an `isError` result. */
  call(tool: WorkBrowserTool, args: unknown, signal?: AbortSignal): Promise<WorkBrowserToolResult>;
  /** The adapter cannot offer the tools (a project MCP server shadows `ocw_browser`, or the runtime refused them). */
  markUnavailable(reason: "shadowed" | "runtime"): void;
  /** Called with the new `available` whenever it changes; returns the unsubscribe. */
  onAvailableChange(cb: (available: boolean) => void): () => void;
  /** The session's current model accepts images (PD-23); off (the default) = `screenshot` answers `image_model_required`. */
  setImageInput(on: boolean): void;
  /** The session's 0600 shim token file (created once), for the Codex shim's env (PD-08). */
  shimTokenFile(): Promise<string>;
}

/** The child as the manager drives it (`BrowserChild`, or a scripted one in tests). */
export interface ManagedChild {
  readonly state: "running" | "closing" | "closed" | "crashed";
  readonly closed: Promise<void>;
  call(op: AgentOp, input: Readonly<Record<string, unknown>>): Promise<unknown>;
  close(): Promise<void>;
}

export interface ChildFactoryOptions {
  sessionId: string;
  root: string;
  executablePath: string;
  sandbox: boolean;
  entry?: string[];
  onEvent: (event: BrowserChildEvent) => void;
  onFrame: (jpeg: Uint8Array) => void;
}

export interface BrowserExecutable {
  executable: string;
  version: string;
}

export interface BrowserManagerOptions {
  /** `browsersRoot()`: run dirs live under `<root>/run/<sessionId>`. */
  root: string;
  /** The Device Link: JSON frames (sent only while connected) and binary live frames (15). */
  link: { send(frame: DeviceToServerFrame): void; sendBinary(bytes: Uint8Array): boolean };
  /** The daemon's device-JWT HTTP client: a PUT to `{serverUrl}{path}`, answering the HTTP status (19). */
  api: { put(path: string, body: unknown): Promise<number> };
  /** The device owner's local opt-in, read on every call (D-10). */
  optIn: () => boolean;
  /** Chromium's sandbox for the next launch (`resolveChromiumSandbox`, PD-18). */
  sandbox: () => boolean;
  /** The session's normal event path (the daemon's `forwardEvent`). */
  emit: (sessionId: string, event: SessionEvent) => void;
  /** The device's Full access opt-in (ADR-0012), read on every call: a Full access turn skips host approvals only while on. */
  fullAccessAllowed?: () => boolean;
  /** The pinned browser: what is installed, and the install (shared download, D-05, Pitfall 9). */
  browsers?: { installed(): Promise<BrowserExecutable | null>; install(): Promise<BrowserExecutable> };
  /** Tests: a scripted child instead of `BrowserChild`. */
  createChild?: (opts: ChildFactoryOptions) => ManagedChild;
  /** Tests: the runtime's entry script(s) the child re-executes (default `[process.argv[1]]`). */
  childEntry?: string[];
  /** A page with no call for this long closes (default `WORK_BROWSER_LIMITS.idleMinutes`, PD-24). */
  idleMs?: number;
  /** Tests: the clock of the live frames' watch lapse (15). */
  liveClock?: LiveClock;
  /** Tests: how long an `open` waits for the API's answer to a sign-in load (default `SIGNIN_LOAD_TIMEOUT_MS`, 19). */
  signinLoadTimeoutMs?: number;
  log?: Logger;
}

interface TurnState {
  promptId: string;
  grant: SessionBrowserGrant | undefined;
  /** The turn runs in Full access (the daemon's effective mode for it). */
  fullAccess: boolean;
}

interface SessionState {
  id: string;
  tools: SessionBrowserTools;
  /** Grants of prompts handed to the adapter, by prompt id, until their turn starts. */
  pendingGrants: Map<string, { grant: SessionBrowserGrant | undefined; fullAccess: boolean }>;
  /** The newest grant the session got (start or prompt): decides `available`. */
  latestGrant: SessionBrowserGrant | undefined;
  turn: TurnState | null;
  child: ManagedChild | null;
  starting: Promise<ManagedChild> | null;
  /** The page's origin now (null: no page). */
  origin: BrowserOrigin | null;
  /** An `open` runs: its own navigations are reported as `opened`, not `navigated`. */
  opening: boolean;
  /** Origins a person allowed for the rest of the session ("Allow for session", PD-10). */
  allowedOrigins: Set<BrowserOrigin>;
  /** The origin the page was approved on (once): later calls on the same page do not ask again. */
  pageApproved: BrowserOrigin | null;
  /** A non-loopback page was open in this session (`whenTainted` rules, D-34). */
  tainted: boolean;
  unavailable: "shadowed" | "runtime" | null;
  imageInput: boolean;
  availableCallbacks: Set<(available: boolean) => void>;
  lastAvailable: boolean;
  /** Calls of one session run one after the other. */
  chain: Promise<void>;
  /** The idle close of the open page (PD-24). */
  idle: NodeJS.Timeout | null;
  /** 19 (PD-15): the lease held now and the fingerprint of the page's site state taken when it was taken. */
  held: { leaseId: string; fingerprint: Promise<string | null> } | null;
  /** 19 (D-21): `ocw_browser_signin` calls waiting for the person's saved sign-in, by origin. */
  signinWaits: Set<{ origin: BrowserOrigin; saved: () => void }>;
  /** 19 (D-24, PD-16): the member's sign-in loaded into the page now (ids and a hash only, never the state). */
  loaded: LoadedSignIn | null;
  /**
   * 19 (D-25): the person who took control of this page (the asker of the turn running then, or of the last one):
   * whatever they typed into it is theirs, so the page closes before anyone else's call.
   */
  memberPage: string | null;
  /** The asker of the turn running now or of the last one (the API lets only them take control, PD-14). */
  lastAskerId: string | null;
  /** 19: origins the API had no sign-in to load for in this turn (asked once per turn). */
  noSignIn: Set<BrowserOrigin>;
}

interface LoadedSignIn {
  signinId: string;
  /** The member whose turn loaded it: any other asker's call unloads it first. */
  userId: string;
  origin: BrowserOrigin;
  /** The state's hash as loaded (the re-seal's `changed`). */
  fingerprint: string;
}

/** At most this many prompts' grants are kept waiting for their turn (a steady queue is far smaller). */
const MAX_PENDING_GRANTS = 64;

const ACTIONS: Readonly<Record<WorkBrowserTool, WorkBrowserAction>> = {
  open: "open",
  snapshot: "snapshot",
  act: "click",
  screenshot: "screenshot",
  wait: "wait",
  close: "close",
  signin: "signin",
};

function actionOf(tool: WorkBrowserTool, body: unknown): WorkBrowserAction {
  if (tool === "act") {
    const a = (body as { action?: unknown } | null)?.action;
    if (a === "click" || a === "type" || a === "select" || a === "press" || a === "scroll") return a;
  }
  return ACTIONS[tool];
}

type CallOutcome = { refusal: WorkBrowserRefusal; failure?: WorkBrowserLaunchFailure } | { invalid: string };

/** A child's or the installer's error as a refusal (never its message, except the fixed `invalid_request` text). */
function outcomeOf(err: unknown): CallOutcome {
  if (err instanceof BrowserInstallError) return { refusal: "browser_unavailable", failure: err.code };
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "invalid_request") {
    return { invalid: err instanceof Error ? err.message.slice(0, 200) : "The request is not valid." };
  }
  const refusal = WorkBrowserRefusal.safeParse(code);
  if (refusal.success) return { refusal: refusal.data };
  const failure = WorkBrowserLaunchFailure.safeParse(code);
  if (failure.success) return { refusal: "browser_unavailable", failure: failure.data };
  return { refusal: "browser_unavailable" };
}

/** The parse issues of a refused body, for the model (paths and our fixed messages). */
function parseMessage(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}) {
  return error.issues
    .slice(0, 5)
    .map((i) => (i.path.length ? `${i.path.map(String).join(".")}: ${i.message}` : i.message))
    .join("; ")
    .slice(0, 500);
}

/** `scheme://host:port` names the device itself (`localhost`, `127.0.0.1`, `[::1]`): never a host approval (D-11). */
function isLoopbackOrigin(origin: BrowserOrigin): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function refusalOfOutcome(outcome: ApprovalOutcome): WorkBrowserRefusal | null {
  if (outcome === "once" || outcome === "session") return null;
  return outcome === "expired" ? "approval_expired" : "approval_denied";
}

const APPROVAL_ACT: Readonly<Record<string, string>> = {
  click: "Click on",
  type: "Type on",
  select: "Select on",
  press: "Press a key on",
  scroll: "Scroll",
};

/** What a person reads in the approval (an action and the origin; never an element, a value or page text). */
function approvalSummary(tool: WorkBrowserTool, body: unknown, origin: BrowserOrigin): string {
  switch (tool) {
    case "open":
      return `Open ${origin}`;
    case "snapshot":
      return `Read ${origin}`;
    case "act": {
      const action = (body as { action?: unknown } | null)?.action;
      return `${(typeof action === "string" && APPROVAL_ACT[action]) || "Act on"} ${origin}`;
    }
    case "screenshot":
      return `Take a screenshot of ${origin}`;
    case "wait":
      return `Wait on ${origin}`;
    case "close":
      return `Close the browser on ${origin}`;
    case "signin":
      return `Sign in to ${origin}`;
  }
}

export class BrowserManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly log: Logger;
  private readonly browsers: NonNullable<BrowserManagerOptions["browsers"]>;
  private readonly broker: BrowserApprovalBroker;
  /** Who watches which session's page (15): frames flow only while someone does. */
  private readonly live: LiveFrames;
  /** Who holds which session's page (15): the agent waits, only the holder's input reaches it. */
  private readonly takeover: Takeover;
  /** The `browser.signin.load` requests waiting for the API's answer (19). */
  private readonly signins: SignInLoads;

  constructor(private readonly opts: BrowserManagerOptions) {
    this.log = opts.log ?? silentLogger;
    this.signins = new SignInLoads({
      send: (frame) => opts.link.send(frame),
      ...(opts.signinLoadTimeoutMs !== undefined ? { timeoutMs: opts.signinLoadTimeoutMs } : {}),
    });
    this.takeover = new Takeover({
      child: (sessionId) => {
        const child = this.sessions.get(sessionId)?.child ?? null;
        return child?.state === "running" ? child : null;
      },
      send: (frame) => opts.link.send(frame),
      abandon: async (sessionId) => {
        const s = this.sessions.get(sessionId);
        if (s) await this.closePage(s, "takeover_abandoned", null);
      },
      touched: (sessionId) => {
        const s = this.sessions.get(sessionId);
        if (s) this.armIdle(s);
      },
      held: (sessionId, leaseId) => this.onHeld(sessionId, leaseId),
      save: (sessionId, leaseId, uploadId) => this.onSave(sessionId, leaseId, uploadId),
    });
    this.live = new LiveFrames({
      link: opts.link,
      control: (sessionId, on) => this.frameControl(sessionId, on),
      ...(opts.liveClock ? { clock: opts.liveClock } : {}),
    });
    this.broker = new BrowserApprovalBroker({ emit: opts.emit });
    this.browsers = opts.browsers ?? {
      installed: () => installedBrowser(opts.root),
      install: () => installBrowser({ root: opts.root }),
    };
  }

  /** Pages open now (the daemon's `status`). */
  get openPages(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.child) n++;
    return n;
  }

  /** The session's tools (one object per session, created on first use). */
  forSession(sessionId: string): SessionBrowserTools {
    return this.state(sessionId).tools;
  }

  /**
   * A grant arrived with `session.start` (`promptId` null) or a `prompt` (PD-09). The turn that prompt starts uses it;
   * the newest one decides `available`. `fullAccess` = the turn's effective mode is Full access.
   */
  onPrompt(
    sessionId: string,
    promptId: string | null,
    grant: SessionBrowserGrant | undefined,
    opts: { fullAccess?: boolean } = {},
  ): void {
    const s = this.state(sessionId);
    s.latestGrant = grant;
    if (promptId !== null) {
      s.pendingGrants.delete(promptId);
      s.pendingGrants.set(promptId, { grant, fullAccess: opts.fullAccess === true });
      while (s.pendingGrants.size > MAX_PENDING_GRANTS) {
        const first = s.pendingGrants.keys().next().value;
        if (first === undefined) break;
        s.pendingGrants.delete(first);
      }
    }
    this.notifyAvailable(s);
  }

  /** `prompt.started`: the turn's calls use the grant of that prompt (absent = not allowed). */
  onTurnStarted(sessionId: string, promptId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const pending = s.pendingGrants.get(promptId);
    s.pendingGrants.delete(promptId);
    s.turn = { promptId, grant: pending?.grant, fullAccess: pending?.fullAccess ?? false };
    s.lastAskerId = pending?.grant?.askerId ?? null;
    s.noSignIn.clear();
  }

  /**
   * `prompt.completed`: calls outside a turn are refused, and an approval still waiting ends as `deny`. A loaded
   * sign-in is re-sealed and unloaded now (D-32: the transcript keeps what the agent read, so it lives one turn).
   */
  onTurnEnded(sessionId: string, promptId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.turn?.promptId !== promptId) return;
    s.turn = null;
    this.broker.cancelSession(sessionId);
    if (s.loaded) void this.serial(s, () => this.closePage(s, "closed", promptId)).catch(() => {});
  }

  /** The device's opt-in may have changed (`reloadConfig`): `available` re-read; off closes every page now. */
  async onOptInChanged(): Promise<void> {
    const on = this.opts.optIn();
    for (const s of this.sessions.values()) this.notifyAvailable(s);
    if (on) return;
    await Promise.all([...this.sessions.values()].map((s) => this.closePage(s, "closed", null)));
  }

  /** The session left the device: its page closes and its run dir (shim token included) goes. */
  async endSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    this.sessions.delete(sessionId);
    s.turn = null;
    this.live.stop(sessionId);
    this.broker.cancelSession(sessionId);
    this.signins.cancelSession(sessionId);
    await this.closePage(s, "closed", null);
    if (UUID.test(sessionId)) {
      await rm(sessionRunDir(this.opts.root, sessionId), { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Daemon stop: every page closes. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.endSession(id)));
  }

  /** `<root>/run/<sessionId>` (the child's temp dir and the shim token's home). */
  runDir(sessionId: string): string {
    return sessionRunDir(this.opts.root, sessionId);
  }

  /**
   * The six ephemeral `browser.*` server frames (never queued, never acked). Here: `browser.close` closes that
   * session's page (opt-in revoked, policy off, access lost, abandoned takeover), `browser.frames` streams the page
   * while someone watches (15), and `browser.lease`, `browser.input` and `browser.handback` go to the takeover (15:
   * the agent's calls are paused while a person holds the page, and only that person's input reaches it), and
   * `browser.signin.state` answers one of this device's sign-in loads (19). A `browser.close { reason: "revoked" }`
   * closes the page without re-sealing its sign-in.
   */
  async onServerFrame(frame: BrowserServerFrame): Promise<void> {
    switch (frame.type) {
      case "browser.close": {
        const s = this.sessions.get(frame.sessionId);
        if (!s) return;
        const kind = frame.reason === "takeover_abandoned" ? "takeover_abandoned" : "closed";
        // A revoked sign-in is gone at the API: its page closes without re-sealing it (19, PD-17).
        await this.closePage(s, kind, null, { reseal: frame.reason !== "revoked" });
        return;
      }
      case "browser.signin.state":
        // The answer to one of this device's loads (by request id); any other is dropped.
        this.signins.onState(frame);
        return;
      case "browser.frames": {
        // Someone watches (re-sent every `watchPingMs`), or nobody does any more.
        if (!this.sessions.has(frame.sessionId)) return;
        if (frame.on) this.live.ping(frame.sessionId);
        else this.live.stop(frame.sessionId);
        return;
      }
      case "browser.lease":
        if (!this.sessions.has(frame.sessionId)) return;
        await this.takeover.onLease(frame);
        return;
      case "browser.input":
        // Synchronous up to the child's stdin: batches reach the page in the order they arrived. Never logged.
        if (!this.sessions.has(frame.sessionId)) return;
        this.takeover.onInput(frame);
        return;
      case "browser.handback":
        if (!this.sessions.has(frame.sessionId)) return;
        await this.takeover.onHandback(frame);
        return;
      default:
        return;
    }
  }

  /**
   * The Codex shim's call over the control socket (PD-08): only with the session's own token, read from its 0600 file
   * now (a removed file refuses). Throws `not allowed` otherwise; the token is never logged.
   */
  async shimCall(req: {
    session: string;
    token: string;
    tool: WorkBrowserTool;
    args: unknown;
  }): Promise<WorkBrowserToolResult> {
    const s = this.sessions.get(req.session);
    if (!s || !UUID.test(req.session) || !(await verifyShimToken(this.runDir(req.session), req.token))) {
      throw new Error("not allowed");
    }
    return s.tools.call(req.tool, req.args);
  }

  // ------------------------------------------------------------------ sign-ins (19: D-22, PD-15)

  /** A person took control: the page's site state is fingerprinted now (hex, in memory), for the hand back's `changed`. */
  private onHeld(sessionId: string, leaseId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const child = s.child;
    const origin = s.origin;
    // The API lets only the asker of the running (or last) turn take control: what they type is theirs (D-25).
    if (child && !s.loaded) s.memberPage = s.turn?.grant?.askerId ?? s.lastAskerId;
    const fingerprint =
      child?.state === "running" && origin
        ? child.call("fingerprint", { host: siteHostOfOrigin(origin) }).then(
            (r) => (r as FingerprintResult).fingerprint,
            () => null,
          )
        : Promise.resolve(null);
    s.held = { leaseId, fingerprint };
  }

  /**
   * "Done, save my sign-in" (D-22, PD-15): the page's site state is exported and uploaded once (`signin.ts`). Sealed
   * (201): the page holds the member's sign-in in a context that is not locked to its site, so it closes now; the next
   * `open` in one of their turns loads the sealed state into a locked page (D-24, D-26). Too large: never sent, and
   * reported as `refused too_large`.
   */
  private async onSave(sessionId: string, leaseId: string, uploadId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    const child = s?.child;
    const origin = s?.origin ?? null;
    if (!s || !child || child.state !== "running" || !origin) return;
    const fingerprintAtHeld = s.held?.leaseId === leaseId ? await s.held.fingerprint : null;
    const outcome = await saveHandback({
      child,
      api: this.opts.api,
      sessionId: s.id,
      uploadId,
      origin,
      fingerprintAtHeld,
    });
    const promptId = s.turn?.promptId ?? null;
    if (outcome.kind === "refused" && outcome.refusal === "too_large") {
      this.event(s, promptId, "refused", origin, { refusal: "too_large" });
    }
    if (outcome.kind !== "saved") return;
    for (const wait of s.signinWaits) if (wait.origin === origin) wait.saved();
    if (s.child === child) await this.closePage(s, "closed", promptId);
  }

  /**
   * D-24, D-32, PD-16: an `open` in a turn whose grant allows sign-ins (a person's own turn in a session only they and
   * the device owner can see) first asks the API for that person's sealed sign-in for the origin. With one, the page
   * opens in a NEW in-memory context with that state, locked to its site (`openWithState`), and the API knows it is
   * loaded (`signin_loaded`); without one (or no answer within 5 s) the caller opens a public page. The state is
   * handed to the child and dropped: the manager keeps its id and hash only.
   */
  private async loadSignIn(
    s: SessionState,
    turn: TurnState,
    child: ManagedChild,
    url: string,
    origin: BrowserOrigin,
  ): Promise<OpenResult | null> {
    const grant = turn.grant;
    if (!grant?.signinAllowed || grant.askerIsBot || !grant.askerId || s.noSignIn.has(origin)) return null;
    const answer = await this.signins.request(s.id, turn.promptId, origin);
    if (!answer?.ok) {
      s.noSignIn.add(origin);
      return null;
    }
    // The turn may have ended, or the opt-in gone off, while the API answered: then nothing is loaded.
    if (s.turn !== turn || !this.opts.optIn() || s.child !== child) {
      this.event(s, turn.promptId, "signin_unloaded", origin);
      return null;
    }
    try {
      const res = (await child.call("openWithState", {
        url,
        state: answer.state,
        siteHost: siteHostOfOrigin(origin),
      })) as OpenWithStateResult;
      s.loaded = { signinId: answer.signinId, userId: grant.askerId, origin, fingerprint: res.fingerprint };
      s.memberPage = null;
      this.event(s, turn.promptId, "signin_loaded", origin);
      return res;
    } catch (err) {
      // The child closed the context it had opened with the state: the page is gone, and the sign-in is not loaded.
      s.origin = null;
      s.pageApproved = null;
      this.event(s, turn.promptId, "signin_unloaded", origin);
      throw err;
    }
  }

  /**
   * D-26: on a page with a member's sign-in, the action tried to go to another host. The navigation was stopped (the
   * page stayed); it goes there only after the member's own yes (`signed_in_host`, 15 minutes, member-only at the API;
   * Full access never skips it), and then that host stays allowed on this signed-in page. Answers the refusal, or null.
   */
  private async askSignedInHost(
    s: SessionState,
    loaded: LoadedSignIn,
    blocked: BrowserOrigin,
    signal: AbortSignal | undefined,
  ): Promise<WorkBrowserRefusal | null> {
    const outcome = await this.broker.ask(s.id, {
      kind: "signed_in_host",
      origin: blocked,
      tool: canonicalBrowserTool("act"),
      summary: `Leave your signed-in page on ${hostPortOf(loaded.origin)} for ${blocked}`,
      ...(signal ? { signal } : {}),
    });
    return refusalOfOutcome(outcome);
  }

  /**
   * `ocw_browser_signin { host, reason }` (D-21, D-32): only in a turn whose grant allows sign-ins (a person's turn in a
   * session only they and the device owner can see), else `signin_not_allowed` at once. The page first opens the site
   * through the normal `open` path and its gates (so the person who takes control lands on it), then the turn's asker
   * is asked (`signin`, 15 minutes). Only this call waits: the turn's other calls go on. A sealed save for that origin
   * answers "Signed in" (and resolves the request); "Not now" `signin_denied`; nothing in 15 minutes `signin_expired`.
   */
  private async signin(
    s: SessionState,
    turn: TurnState,
    body: { host: string; reason: string },
    signal: AbortSignal | undefined,
  ): Promise<WorkBrowserToolResult> {
    const grant = turn.grant;
    if (!grant?.signinAllowed || grant.askerIsBot || !grant.askerId) {
      return this.refuse(s, turn, "signin", "signin_not_allowed");
    }
    const site = siteOfHost(body.host);
    if (!site) return invalidResult("signin", "host: must be a host name such as github.com", s.origin);
    const { origin, url } = site;
    if (s.origin !== origin || !s.child) {
      const opened = await this.serial(s, async () => {
        this.clearIdle(s);
        try {
          return await this.run(s, turn, "open", { url }, signal);
        } finally {
          this.armIdle(s);
        }
      });
      if (opened.isError) return opened;
    }
    if (!this.opts.optIn() || s.turn !== turn) return this.refuse(s, null, "signin", "not_allowed");
    if (this.takeover.isPaused(s.id)) return this.refuse(s, turn, "signin", "paused");
    // Their sealed sign-in for the site is already loaded (the open above loaded it): nobody needs to be asked.
    if (s.loaded?.origin === origin && s.loaded.userId === grant.askerId) {
      return textResult(browserToolSummary("signin", body, { origin }), origin, [
        `Signed in to ${hostPortOf(origin)}: the saved sign-in is loaded in this page.`,
      ]);
    }

    const deadline = Date.now() + WORK_BROWSER_LIMITS.signinWaitMinutes * 60_000;
    const approvalId = randomUUID();
    let saved = false;
    let onSaved: () => void = () => {};
    const savedNow = new Promise<void>((resolve) => {
      onSaved = resolve;
    });
    const wait = {
      origin,
      saved: () => {
        saved = true;
        onSaved();
        this.broker.resolve(s.id, approvalId, "once");
      },
    };
    s.signinWaits.add(wait);
    try {
      const outcome = await this.broker.ask(s.id, {
        approvalId,
        kind: "signin",
        origin,
        tool: canonicalBrowserTool("signin"),
        summary: `Sign in to ${hostPortOf(origin)}: ${body.reason}`,
        reason: body.reason,
        ...(signal ? { signal } : {}),
      });
      if (!saved) {
        if (outcome === "deny") return this.refuse(s, turn, "signin", "signin_denied");
        if (outcome === "expired") return this.refuse(s, turn, "signin", "signin_expired");
        // A yes on the request ("Open and sign in"): the person is signing in; the save is awaited until the 15 minutes end.
        const done = await untilSaved(savedNow, deadline - Date.now(), signal, () => s.turn !== turn);
        if (done === "ended") return this.refuse(s, null, "signin", "not_allowed");
        if (done === "expired") return this.refuse(s, turn, "signin", "signin_expired");
      }
      return textResult(browserToolSummary("signin", body, { origin }), origin, [
        `Signed in to ${hostPortOf(origin)}.`,
        "The sign-in is saved for that site only. Open the site again to continue signed in.",
      ]);
    } finally {
      s.signinWaits.delete(wait);
    }
  }

  // ------------------------------------------------------------------ the call

  private async call(
    s: SessionState,
    tool: WorkBrowserTool,
    args: unknown,
    signal: AbortSignal | undefined,
  ): Promise<WorkBrowserToolResult> {
    try {
      if (s.unavailable || !UUID.test(s.id)) return refusedResult(tool, "browser_unavailable", s.origin);
      const turn = s.turn;
      if (!this.opts.optIn() || !turn?.grant?.allowed) return this.refuse(s, turn, tool, "not_allowed");
      if (this.takeover.isPaused(s.id)) return this.refuse(s, turn, tool, "paused");
      const parsed = WORK_BROWSER_INPUTS[tool].safeParse(args);
      if (!parsed.success) return invalidResult(tool, parseMessage(parsed.error), s.origin);
      // The sign-in waits for a person outside the session's call chain (its own `open` runs inside it).
      if (tool === "signin") return await this.signin(s, turn, parsed.data as WorkBrowserSignInInput, signal);
      const body = parsed.data as Record<string, unknown>;
      return await this.serial(s, async () => {
        this.clearIdle(s);
        try {
          return await this.run(s, turn, tool, body, signal);
        } finally {
          this.armIdle(s);
        }
      });
    } catch (err) {
      this.log.warn("browser call failed", { tool, error: err instanceof Error ? err.name : "error" });
      return refusedResult(tool, "browser_unavailable", s.origin);
    }
  }

  private async run(
    s: SessionState,
    turn: TurnState,
    tool: WorkBrowserTool,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<WorkBrowserToolResult> {
    // Re-checked after waiting behind an earlier call of the session.
    if (!this.opts.optIn() || s.turn !== turn) return this.refuse(s, null, tool, "not_allowed");
    if (this.takeover.isPaused(s.id)) return this.refuse(s, turn, tool, "paused");
    // 19 (D-25, PD-17): a page holding a member's sign-in (loaded, or one they signed in to by hand) is theirs: before
    // anyone else's call (another person, a bot) it is re-sealed and closed; the call then finds no page.
    const owner = s.loaded?.userId ?? (s.child ? s.memberPage : null);
    if (owner && (turn.grant?.askerIsBot !== false || turn.grant.askerId !== owner)) {
      await this.closePage(s, "closed", null);
    }
    if (tool !== "open" && !s.child) {
      return tool === "close" ? this.closeTool(s, turn) : this.refuse(s, turn, tool, "no_context");
    }
    const gate = await this.approve(s, turn, tool, body, signal);
    if (gate) return this.refuse(s, turn, tool, gate, undefined, body);
    // A person may have taken minutes to answer: the opt-in, the turn and the lease are read again.
    if (!this.opts.optIn() || s.turn !== turn) return this.refuse(s, null, tool, "not_allowed");
    if (this.takeover.isPaused(s.id)) return this.refuse(s, turn, tool, "paused");
    try {
      switch (tool) {
        case "close":
          return await this.closeTool(s, turn);
        case "open":
          return await this.open(s, turn, body, signal);
        case "snapshot":
          return await this.snapshot(s);
        case "act":
          return await this.act(s, turn, body, signal);
        case "screenshot":
          return await this.screenshot(s, turn);
        case "wait":
          return await this.wait(s, body);
        default:
          return this.refuse(s, turn, tool, "not_allowed");
      }
    } catch (err) {
      const outcome = outcomeOf(err);
      this.forgetDeadChild(s);
      if ("invalid" in outcome) return invalidResult(tool, outcome.invalid, s.origin);
      return this.refuse(s, turn, tool, outcome.refusal, outcome.failure, body);
    }
  }

  private async open(
    s: SessionState,
    turn: TurnState,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) {
    const url = String(body.url);
    const target = originOf(url);
    // A loaded sign-in is for its own site: another site's page opens without it (re-sealed and unloaded first).
    if (s.loaded && s.loaded.origin !== target) await this.closePage(s, "closed", turn.promptId);
    const child = await this.ensureChild(s, turn);
    s.opening = true;
    let res: OpenResult;
    try {
      const signedIn = target && !s.loaded ? await this.loadSignIn(s, turn, child, url, target) : null;
      res = signedIn ?? ((await child.call("open", { url })) as OpenResult);
    } finally {
      s.opening = false;
    }
    // The child reported the committed origin (redirects included) before its answer; the URL is the fallback.
    const origin = s.origin ?? target;
    s.origin = origin;
    this.markTainted(s, origin);
    // A redirect landed on another origin: it needs its own yes before anything of it reaches the model.
    if (origin && origin !== target && this.needsHost(s, turn, "open", origin)) {
      const refusal = await this.askHost(s, turn, "open", body, origin, signal);
      if (refusal) {
        await this.closePage(s, "closed", turn.promptId);
        return this.refuse(s, turn, "open", refusal, undefined, body);
      }
    }
    s.pageApproved = origin;
    this.event(s, turn.promptId, "opened", origin, { action: "open" });
    const summary = browserToolSummary("open", body, { origin });
    return textResult(summary, origin, [
      `Signed in: ${res.signedIn ? "yes" : "no"}`,
      "",
      pageContent(origin, `Title: ${res.title}`),
    ]);
  }

  // ------------------------------------------------------------------ approvals (D-11, D-34, PD-10)

  /**
   * The admin's rule first (`alwaysAsk`, or `whenTainted` once a non-loopback page was open in the session: every call,
   * loopback and Full access included, kind `admin_rule`), then the host gate (a non-loopback origin the session did not
   * allow, outside Full access: kind `host`). A yes to the rule also covers the host for that call. For tools other
   * than `open` the origin is the page's own: a page an action navigated to an origin nobody allowed asks before the
   * next call reads or acts on it. Answers the refusal, or null to go on.
   */
  private async approve(
    s: SessionState,
    turn: TurnState,
    tool: WorkBrowserTool,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<WorkBrowserRefusal | null> {
    const grant = turn.grant;
    const origin = tool === "open" ? originOf(String(body.url)) : s.origin;
    if (!grant || !origin) return null;
    const rule = grant.alwaysAsk.includes(tool) || (s.tainted && grant.whenTainted.includes(tool));
    if (rule) {
      const outcome = await this.broker.ask(s.id, {
        kind: "admin_rule",
        origin,
        tool: canonicalBrowserTool(tool),
        summary: approvalSummary(tool, body, origin),
        ...(signal ? { signal } : {}),
      });
      const refusal = refusalOfOutcome(outcome);
      if (refusal) return refusal;
      if (outcome === "session" && !isLoopbackOrigin(origin)) s.allowedOrigins.add(origin);
      if (tool !== "open") s.pageApproved = origin;
      return null;
    }
    if (!this.needsHost(s, turn, tool, origin)) return null;
    return this.askHost(s, turn, tool, body, origin, signal);
  }

  /** The host gate: loopback, an origin allowed for the session, the page's own approved origin or Full access pass. */
  private needsHost(s: SessionState, turn: TurnState, tool: WorkBrowserTool, origin: BrowserOrigin): boolean {
    if (isLoopbackOrigin(origin) || s.allowedOrigins.has(origin)) return false;
    if (tool !== "open" && s.pageApproved === origin) return false;
    const fullAccess = turn.fullAccess && (this.opts.fullAccessAllowed?.() ?? false);
    return !fullAccess;
  }

  private async askHost(
    s: SessionState,
    _turn: TurnState,
    tool: WorkBrowserTool,
    body: Record<string, unknown>,
    origin: BrowserOrigin,
    signal: AbortSignal | undefined,
  ): Promise<WorkBrowserRefusal | null> {
    const outcome = await this.broker.ask(s.id, {
      kind: "host",
      origin,
      tool: canonicalBrowserTool(tool),
      summary: approvalSummary(tool, body, origin),
      ...(signal ? { signal } : {}),
    });
    const refusal = refusalOfOutcome(outcome);
    if (refusal) return refusal;
    if (outcome === "session") s.allowedOrigins.add(origin);
    if (tool !== "open") s.pageApproved = origin;
    return null;
  }

  /** A person's answer to a browser approval (the daemon asks here before the adapter). */
  resolveApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): boolean {
    return this.broker.resolve(sessionId, approvalId, decision);
  }

  /** Browser approvals of the session waiting now. */
  pendingApprovals(sessionId: string): number {
    return this.broker.pending(sessionId);
  }

  /** Any non-loopback page in the session taints it for `whenTainted` rules (D-34). */
  private markTainted(s: SessionState, origin: BrowserOrigin | null): void {
    if (origin && !isLoopbackOrigin(origin)) s.tainted = true;
  }

  private async snapshot(s: SessionState) {
    const child = s.child as ManagedChild;
    const res = (await child.call("snapshot", {})) as SnapshotResult;
    const origin = s.origin;
    const summary = browserToolSummary("snapshot", {}, { origin });
    const text = `Title: ${res.title}\n\n${res.text}${res.truncated ? "\n[snapshot truncated]" : ""}`;
    return textResult(summary, origin, ["", pageContent(origin, text)]);
  }

  private async act(
    s: SessionState,
    turn: TurnState,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ) {
    const child = s.child as ManagedChild;
    const res = (await child.call("act", body)) as ActResult;
    const origin = s.origin;
    this.event(s, turn.promptId, "acted", origin, { action: actionOf("act", body) });
    const rest: string[] = [];
    let navigated = res.navigated;
    const loaded = s.loaded;
    if (res.blocked && loaded) {
      const refusal = await this.askSignedInHost(s, loaded, res.blocked, signal);
      if (refusal) return this.refuse(s, turn, "act", refusal, undefined, body);
      // The member may have taken minutes: the page must still be the same signed-in one.
      if (s.child !== child || s.loaded !== loaded || s.turn !== turn)
        return this.refuse(s, null, "act", "no_context");
      const allowed = (await child.call("allowCrossSite", { host: siteHostOfOrigin(res.blocked) })) as {
        navigated: boolean;
      };
      s.pageApproved = res.blocked;
      navigated ||= allowed.navigated;
    }
    if (navigated) rest.push("The page navigated. Take a new snapshot to read it.");
    if (res.refused) {
      this.event(s, turn.promptId, "refused", origin, { action: "navigate", refusal: res.refused });
      rest.push(
        `The page tried to go somewhere it cannot: ${res.refused === "metadata_refused" ? "a cloud metadata address" : "a non-http address"}. It stayed where it was.`,
      );
    }
    return textResult(browserToolSummary("act", body, { origin }), origin, rest);
  }

  private async screenshot(s: SessionState, turn: TurnState) {
    if (!s.imageInput) return this.refuse(s, turn, "screenshot", "image_model_required");
    const child = s.child as ManagedChild;
    const res = (await child.call("screenshot", {})) as ScreenshotResult;
    const origin = s.origin;
    const summary = browserToolSummary("screenshot", {}, { origin });
    const fields = res.masked === 1 ? "field" : "fields";
    return {
      content: [
        { type: "text" as const, text: `${summary}\nMasked ${res.masked} sensitive ${fields}.` },
        { type: "image" as const, data: res.data, mimeType: "image/jpeg" as const },
      ],
      isError: false,
      summary,
      origin,
    };
  }

  private async wait(s: SessionState, body: Record<string, unknown>) {
    const child = s.child as ManagedChild;
    const res = (await child.call("wait", body)) as WaitResult;
    const origin = s.origin;
    const rest = res.ok ? [] : ["The wait ended before that happened."];
    return textResult(browserToolSummary("wait", body, { origin }), origin, rest);
  }

  private async closeTool(s: SessionState, turn: TurnState) {
    await this.closePage(s, "closed", turn.promptId);
    return textResult(browserToolSummary("close", {}, { origin: null }), null);
  }

  // ------------------------------------------------------------------ the child

  /**
   * The session's running child, started on first use. A missing browser is installed first, with a status line in
   * the session (D-05); the download runs to its end even when the turn is cancelled (Pitfall 9).
   */
  private ensureChild(s: SessionState, turn: TurnState): Promise<ManagedChild> {
    if (s.child && s.child.state === "running") return Promise.resolve(s.child);
    s.starting ??= (async () => {
      const exe = await this.executable(s, turn);
      const child = this.spawn(s, exe);
      s.child = child;
      return child;
    })().finally(() => {
      s.starting = null;
    });
    return s.starting;
  }

  private async executable(s: SessionState, turn: TurnState): Promise<BrowserExecutable> {
    const found = await this.browsers.installed().catch(() => null);
    if (found) return found;
    const toolUseId = `ocw-browser-install-${randomUUID()}`;
    this.opts.emit(s.id, {
      type: "tool.started",
      toolUseId,
      name: "ocw_browser_install",
      summary: "Downloading the browser for first use (about 120 MB)",
    });
    try {
      const installed = await this.browsers.install();
      this.opts.emit(s.id, {
        type: "tool.completed",
        toolUseId,
        ok: true,
        summary: `Browser ready (${installed.version})`,
      });
      return installed;
    } catch (err) {
      const failure = err instanceof BrowserInstallError ? err.code : "download_failed";
      this.opts.emit(s.id, {
        type: "tool.completed",
        toolUseId,
        ok: false,
        summary: INSTALL_FAILURE_TEXT[failure],
      });
      this.log.warn("browser install failed", { failure, promptId: turn.promptId });
      throw err instanceof BrowserInstallError
        ? err
        : new BrowserInstallError(failure, INSTALL_FAILURE_TEXT[failure]);
    }
  }

  private spawn(s: SessionState, exe: BrowserExecutable): ManagedChild {
    let child: ManagedChild | null = null;
    const onEvent = (e: BrowserChildEvent) => {
      if (child && s.child === child) this.onChildEvent(s, child, e);
    };
    const factoryOpts: ChildFactoryOptions = {
      sessionId: s.id,
      root: this.opts.root,
      executablePath: exe.executable,
      sandbox: this.opts.sandbox(),
      ...(this.opts.childEntry ? { entry: this.opts.childEntry } : {}),
      onEvent,
      // A live JPEG: sent now if someone watches, else dropped; never kept.
      onFrame: (payload) => {
        if (child && s.child === child) this.live.onJpeg(s.id, payload);
      },
    };
    // The shim token outlives a child: the manager removes it with the run dir at session end.
    child = this.opts.createChild
      ? this.opts.createChild(factoryOpts)
      : new BrowserChild({ ...factoryOpts, keepFiles: [SHIM_TOKEN_FILE] });
    // Someone already watches: the first page streams as soon as it exists.
    if (this.live.watching(s.id)) void child.call("frames", { on: true }).catch(() => {});
    return child;
  }

  private onChildEvent(s: SessionState, child: ManagedChild, e: BrowserChildEvent): void {
    switch (e.event) {
      case "navigated": {
        const changed = s.origin !== e.origin;
        s.origin = e.origin;
        this.markTainted(s, e.origin);
        if (!s.opening && changed) this.event(s, s.turn?.promptId ?? null, "navigated", e.origin);
        return;
      }
      case "crashed": {
        const origin = s.origin;
        s.origin = null;
        if (e.scope === "process" || child.state !== "running") s.child = null;
        // The API ends the lease on `crashed` too: the page a person held is gone.
        this.takeover.end(s.id);
        this.event(s, s.turn?.promptId ?? null, "crashed", origin);
        this.dropLoaded(s);
        return;
      }
      case "focus":
        this.takeover.onFocus(s.id, e.sensitive);
        return;
      default:
        // `refused` is reported with the call it belongs to; `ready` needs nothing.
        return;
    }
  }

  /** A child that died during a call is dropped, so the next `open` starts a new one (PD-24). */
  private forgetDeadChild(s: SessionState): void {
    if (s.child && s.child.state !== "running") {
      s.child = null;
      s.origin = null;
      this.dropLoaded(s);
    }
  }

  /**
   * Ends the session's page (when one is open) and reports it. With a member's sign-in loaded (19, PD-17): its state is
   * re-sealed first (unless `reseal: false`, a revoked sign-in), then the page closes, then `signin_unloaded` tells the
   * API (after it, a re-seal answers 409). The whole child goes, so nothing of the state stays in the browser's memory.
   */
  private async closePage(
    s: SessionState,
    kind: Extract<WorkBrowserEventKind, "closed" | "takeover_abandoned">,
    promptId: string | null,
    opts: { reseal?: boolean } = {},
  ): Promise<void> {
    const starting = s.starting;
    if (starting) await starting.catch(() => null);
    this.clearIdle(s);
    // No page, no takeover: input that arrives later is ignored (the API ends the lease on any close).
    this.takeover.end(s.id);
    s.held = null;
    s.memberPage = null;
    const loaded = s.loaded;
    s.loaded = null;
    const child = s.child;
    if (!child) {
      if (loaded) this.event(s, promptId, "signin_unloaded", loaded.origin);
      return;
    }
    s.child = null;
    const origin = s.origin;
    s.origin = null;
    s.pageApproved = null;
    if (loaded && opts.reseal !== false) {
      await reseal({
        child,
        api: this.opts.api,
        sessionId: s.id,
        signinId: loaded.signinId,
        origin: loaded.origin,
        fingerprintAtLoad: loaded.fingerprint,
      });
    }
    this.event(s, promptId, kind, origin, kind === "closed" ? { action: "close" } : {});
    await child.close().catch(() => {});
    if (loaded) this.event(s, promptId, "signin_unloaded", loaded.origin);
  }

  /** The page died with a member's sign-in in it (19): nothing to re-seal, but the API learns it is unloaded. */
  private dropLoaded(s: SessionState): void {
    const loaded = s.loaded;
    s.loaded = null;
    s.memberPage = null;
    if (loaded) this.event(s, s.turn?.promptId ?? null, "signin_unloaded", loaded.origin);
  }

  /** The session's screencast on or off in its child (a no-op without a running page). */
  private frameControl(sessionId: string, on: boolean): void {
    const child = this.sessions.get(sessionId)?.child;
    if (child?.state !== "running") return;
    void child.call("frames", { on }).catch(() => {});
  }

  // ------------------------------------------------------------------ helpers

  private state(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const s: SessionState = {
      id: sessionId,
      tools: undefined as unknown as SessionBrowserTools,
      pendingGrants: new Map(),
      latestGrant: undefined,
      turn: null,
      child: null,
      starting: null,
      origin: null,
      opening: false,
      allowedOrigins: new Set(),
      pageApproved: null,
      tainted: false,
      unavailable: null,
      imageInput: false,
      availableCallbacks: new Set(),
      lastAvailable: false,
      chain: Promise.resolve(),
      idle: null,
      held: null,
      signinWaits: new Set(),
      loaded: null,
      memberPage: null,
      lastAskerId: null,
      noSignIn: new Set(),
    };
    const manager = this;
    s.tools = {
      get available() {
        return manager.isAvailable(s);
      },
      call: (tool, args, signal) => this.call(s, tool, args, signal),
      markUnavailable: (reason) => {
        s.unavailable = reason;
        this.notifyAvailable(s);
      },
      onAvailableChange: (cb) => {
        s.availableCallbacks.add(cb);
        return () => s.availableCallbacks.delete(cb);
      },
      setImageInput: (on) => {
        s.imageInput = on;
      },
      shimTokenFile: () => this.shimTokenFile(s),
    };
    this.sessions.set(sessionId, s);
    return s;
  }

  private isAvailable(s: SessionState): boolean {
    return (
      this.sessions.get(s.id) === s &&
      UUID.test(s.id) &&
      s.unavailable === null &&
      this.opts.optIn() &&
      s.latestGrant?.allowed === true
    );
  }

  private notifyAvailable(s: SessionState): void {
    const now = this.isAvailable(s);
    if (now === s.lastAvailable) return;
    s.lastAvailable = now;
    for (const cb of s.availableCallbacks) {
      try {
        cb(now);
      } catch {
        // An adapter's callback never breaks the manager.
      }
    }
  }

  private async shimTokenFile(s: SessionState): Promise<string> {
    if (!UUID.test(s.id)) throw new Error("the session id is not a uuid");
    return ensureShimToken(this.runDir(s.id));
  }

  /** The idle close (PD-24): a page with no call for `idleMs` closes; a held lease keeps it (a person is on it). */
  private armIdle(s: SessionState): void {
    this.clearIdle(s);
    if (!s.child || this.sessions.get(s.id) !== s) return;
    s.idle = setTimeout(
      () => {
        s.idle = null;
        if (this.takeover.isPaused(s.id)) return this.armIdle(s);
        void this.serial(s, () => this.closePage(s, "closed", null));
      },
      this.opts.idleMs ?? WORK_BROWSER_LIMITS.idleMinutes * 60_000,
    );
    s.idle.unref?.();
  }

  private clearIdle(s: SessionState): void {
    if (s.idle) clearTimeout(s.idle);
    s.idle = null;
  }

  private serial<T>(s: SessionState, fn: () => Promise<T>): Promise<T> {
    const run = s.chain.then(fn, fn);
    s.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** A refused call: its result, and a `refused` event when a turn asked (audit, D-14). */
  private refuse(
    s: SessionState,
    turn: TurnState | null,
    tool: WorkBrowserTool,
    refusal: WorkBrowserRefusal,
    failure?: WorkBrowserLaunchFailure,
    body?: unknown,
  ): WorkBrowserToolResult {
    const origin =
      tool === "open" ? originOf(String((body as { url?: unknown } | undefined)?.url ?? "")) : s.origin;
    if (turn && UUID.test(s.id)) {
      this.event(s, turn.promptId, "refused", origin ?? s.origin, {
        action: actionOf(tool, body),
        refusal,
        ...(failure ? { failure } : {}),
      });
    }
    return refusedResult(tool, refusal, s.origin);
  }

  private event(
    s: SessionState,
    promptId: string | null,
    kind: WorkBrowserEventKind,
    origin: BrowserOrigin | null,
    extra: {
      action?: WorkBrowserAction;
      refusal?: WorkBrowserRefusal;
      failure?: WorkBrowserLaunchFailure;
    } = {},
  ): void {
    if (!UUID.test(s.id)) return;
    this.opts.link.send({ type: "browser.event", sessionId: s.id, promptId, kind, origin, ...extra });
  }
}

/**
 * The site a sign-in names (`github.com`, `127.0.0.1:3000`): its origin and the page the person lands on. A loopback
 * host is the device's own `http:` server; any other host is `https:`.
 */
function siteOfHost(host: string): { origin: BrowserOrigin; url: string } | null {
  let hostname: string;
  try {
    hostname = new URL(`http://${host}/`).hostname;
  } catch {
    return null;
  }
  const url = `${isLoopbackHost(hostname) ? "http" : "https"}://${host}/`;
  const origin = originOf(url);
  return origin ? { origin, url } : null;
}

/** Waits for a sign-in's save: `saved`, `expired` after `ms`, or `ended` (cancelled, or the turn is over). */
function untilSaved(
  saved: Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
  ended: () => boolean,
): Promise<"saved" | "expired" | "ended"> {
  if (ms <= 0) return Promise.resolve("expired");
  return new Promise((resolve) => {
    let poll: NodeJS.Timeout | undefined;
    const finish = (r: "saved" | "expired" | "ended") => {
      clearTimeout(timer);
      clearTimeout(poll);
      signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const onAbort = () => finish("ended");
    const timer = setTimeout(() => finish("expired"), ms);
    timer.unref?.();
    const check = () => {
      if (ended()) return finish("ended");
      poll = setTimeout(check, 1_000);
      poll.unref?.();
    };
    check();
    signal?.addEventListener("abort", onAbort, { once: true });
    void saved.then(() => finish("saved"));
  });
}

/** The status line of a failed first-use install (D-05): fixed sentences, never a path. */
const INSTALL_FAILURE_TEXT: Readonly<Record<WorkBrowserLaunchFailure, string>> = {
  unsupported_platform: "The browser is not available for this device's platform",
  download_failed: "The browser could not be downloaded",
  checksum_mismatch: "The browser download did not match its pinned checksum",
  missing_library: "The browser is missing system libraries",
  no_usable_sandbox: "The browser's sandbox is not available on this device",
  launch_failed: "The browser could not be started",
};
