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
  type BrowserOrigin,
  type DeviceToServerFrame,
  originOf,
  type SessionBrowserGrant,
  type SessionEvent,
  WORK_BROWSER_INPUTS,
  type WorkBrowserAction,
  type WorkBrowserEventKind,
  WorkBrowserLaunchFailure,
  WorkBrowserRefusal,
  type WorkBrowserTool,
} from "@ocw/contracts";
import { type Logger, silentLogger } from "../logger.js";
import type {
  ActResult,
  AgentOp,
  OpenResult,
  ScreenshotResult,
  SnapshotResult,
  WaitResult,
} from "./agent/ops.js";
import { BrowserChild, type BrowserChildEvent, sessionRunDir } from "./child.js";
import { BrowserInstallError, installBrowser, installedBrowser } from "./install.js";
import {
  browserToolSummary,
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
  /** A person holds the page (`browser.lease held`, 15): every call answers `paused`. */
  leaseId: string | null;
  unavailable: "shadowed" | "runtime" | null;
  imageInput: boolean;
  availableCallbacks: Set<(available: boolean) => void>;
  lastAvailable: boolean;
  /** Calls of one session run one after the other. */
  chain: Promise<void>;
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

export class BrowserManager {
  private readonly sessions = new Map<string, SessionState>();
  private readonly log: Logger;
  private readonly browsers: NonNullable<BrowserManagerOptions["browsers"]>;

  constructor(private readonly opts: BrowserManagerOptions) {
    this.log = opts.log ?? silentLogger;
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
  }

  /** `prompt.completed`: calls outside a turn are refused. */
  onTurnEnded(sessionId: string, promptId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.turn?.promptId !== promptId) return;
    s.turn = null;
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
    await this.closePage(s, "closed", null);
    if (UUID.test(sessionId)) {
      await rm(sessionRunDir(this.opts.root, sessionId), { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Daemon stop: every page closes. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.endSession(id)));
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
      if (s.leaseId) return this.refuse(s, turn, tool, "paused");
      if (tool === "signin") return this.refuse(s, turn, tool, "not_allowed");
      const parsed = WORK_BROWSER_INPUTS[tool].safeParse(args);
      if (!parsed.success) return invalidResult(tool, parseMessage(parsed.error), s.origin);
      const body = parsed.data as Record<string, unknown>;
      return await this.serial(s, () => this.run(s, turn, tool, body, signal));
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
    _signal: AbortSignal | undefined,
  ): Promise<WorkBrowserToolResult> {
    // Re-checked after waiting behind an earlier call of the session.
    if (!this.opts.optIn() || s.turn !== turn) return this.refuse(s, null, tool, "not_allowed");
    if (s.leaseId) return this.refuse(s, turn, tool, "paused");
    if (tool === "close") return this.closeTool(s, turn);
    if (tool !== "open" && !s.child) return this.refuse(s, turn, tool, "no_context");
    try {
      switch (tool) {
        case "open":
          return await this.open(s, turn, body);
        case "snapshot":
          return await this.snapshot(s);
        case "act":
          return await this.act(s, turn, body);
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

  private async open(s: SessionState, turn: TurnState, body: Record<string, unknown>) {
    const url = String(body.url);
    const child = await this.ensureChild(s, turn);
    s.opening = true;
    let res: OpenResult;
    try {
      res = (await child.call("open", { url })) as OpenResult;
    } finally {
      s.opening = false;
    }
    // The child reported the committed origin (redirects included) before its answer; the URL is the fallback.
    const origin = s.origin ?? originOf(url);
    s.origin = origin;
    this.event(s, turn.promptId, "opened", origin, { action: "open" });
    const summary = browserToolSummary("open", body, { origin });
    return textResult(summary, origin, [
      `Signed in: ${res.signedIn ? "yes" : "no"}`,
      "",
      pageContent(origin, `Title: ${res.title}`),
    ]);
  }

  private async snapshot(s: SessionState) {
    const child = s.child as ManagedChild;
    const res = (await child.call("snapshot", {})) as SnapshotResult;
    const origin = s.origin;
    const summary = browserToolSummary("snapshot", {}, { origin });
    const text = `Title: ${res.title}\n\n${res.text}${res.truncated ? "\n[snapshot truncated]" : ""}`;
    return textResult(summary, origin, ["", pageContent(origin, text)]);
  }

  private async act(s: SessionState, turn: TurnState, body: Record<string, unknown>) {
    const child = s.child as ManagedChild;
    const res = (await child.call("act", body)) as ActResult;
    const origin = s.origin;
    this.event(s, turn.promptId, "acted", origin, { action: actionOf("act", body) });
    const rest: string[] = [];
    if (res.navigated) rest.push("The page navigated. Take a new snapshot to read it.");
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
      // Live frames are 07.13-15's; nothing is kept here.
      onFrame: () => {},
    };
    child = this.opts.createChild ? this.opts.createChild(factoryOpts) : new BrowserChild(factoryOpts);
    return child;
  }

  private onChildEvent(s: SessionState, child: ManagedChild, e: BrowserChildEvent): void {
    switch (e.event) {
      case "navigated": {
        const changed = s.origin !== e.origin;
        s.origin = e.origin;
        if (!s.opening && changed) this.event(s, s.turn?.promptId ?? null, "navigated", e.origin);
        return;
      }
      case "crashed": {
        const origin = s.origin;
        s.origin = null;
        if (e.scope === "process" || child.state !== "running") s.child = null;
        this.event(s, s.turn?.promptId ?? null, "crashed", origin);
        return;
      }
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
    }
  }

  /** Ends the session's page (when one is open) and reports it. */
  private async closePage(
    s: SessionState,
    kind: Extract<WorkBrowserEventKind, "closed" | "takeover_abandoned">,
    promptId: string | null,
  ): Promise<void> {
    const starting = s.starting;
    if (starting) await starting.catch(() => null);
    const child = s.child;
    if (!child) return;
    s.child = null;
    const origin = s.origin;
    s.origin = null;
    s.leaseId = null;
    this.event(s, promptId, kind, origin, kind === "closed" ? { action: "close" } : {});
    await child.close().catch(() => {});
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
      leaseId: null,
      unavailable: null,
      imageInput: false,
      availableCallbacks: new Set(),
      lastAvailable: false,
      chain: Promise.resolve(),
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

  private async shimTokenFile(_s: SessionState): Promise<string> {
    throw new Error("the shim token is not available yet");
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

/** The status line of a failed first-use install (D-05): fixed sentences, never a path. */
const INSTALL_FAILURE_TEXT: Readonly<Record<WorkBrowserLaunchFailure, string>> = {
  unsupported_platform: "The browser is not available for this device's platform",
  download_failed: "The browser could not be downloaded",
  checksum_mismatch: "The browser download did not match its pinned checksum",
  missing_library: "The browser is missing system libraries",
  no_usable_sandbox: "The browser's sandbox is not available on this device",
  launch_failed: "The browser could not be started",
};
