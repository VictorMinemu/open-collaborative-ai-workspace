import {
  BROWSER_LIMITS,
  type BrowserSandboxMode,
  encodeFrame,
  FRAME_MAX_PAYLOAD_BYTES,
  FRAME_TYPES,
  SANDBOXD_LABELS,
  type SandboxdActResult,
  type SandboxdBrowserStatus,
  type SandboxdContextAct,
  type SandboxdContextDownload,
  type SandboxdContextHold,
  type SandboxdContextInput,
  type SandboxdContextLock,
  type SandboxdContextNavigate,
  type SandboxdContextOpen,
  type SandboxdContextResize,
  type SandboxdContextTakeover,
  type SandboxdContextWait,
  type SandboxdDownloadContent,
  type SandboxdErrorCode,
  type SandboxdExportStateResult,
  type SandboxdFrameControl,
  type SandboxdNavigateResult,
  type SandboxdTarget,
  type SandboxdWaitResult,
  type ScreenshotResult,
  type SnapshotResult,
} from "@ocw/contracts";
import { AgentError, type AgentLink, openAgentLink } from "./agent-link";
import { type Docker, DockerUnavailableError } from "./docker";
import type { Egress } from "./egress-attach";
import { type Clock, type SandboxdEventInput, SandboxdFailure, type Sandboxes } from "./sandboxes";
import {
  browserNetworkSpec,
  brwSpec,
  type DockerRuntime,
  egressHostsCurrent,
  nameFor,
  ownerLabels,
} from "./spec";

/**
 * Each bot's browser as sandboxd runs it (07.8-13, D-01, D-05, D-06, D-07, D-09, D-11, D-12, D-13, D-14, BRW-01/02).
 * A bot's `brw` container is built only from `brwSpec`, sits alone with `sandbox-egress` on the bot's browser network,
 * and is spoken to only over its attached stdio (`agent-link.ts`). sandboxd keeps per context: who owns it, its last
 * activity, its hold, and the live-view subscribers. It never logs or keeps a frame, an input payload, a snapshot or a
 * storage state: frames go to subscribers latest-frame-wins, everything else is passed through once.
 *
 * Idle (D-12 U-5/U-6): a context with no request and no subscriber for 5 minutes is closed (`idle`); a hold keeps it up
 * to 15 minutes after its last activity; the container stops when its last context closed by idle, or after it had no
 * context for 5 minutes. A posture that does not match the runtime (D-14: `chromium+gvisor` under runsc, `chromium` or
 * `container-only` under runc) is refused, never reported as something else.
 */

export const BROWSER_IDLE_MS = BROWSER_LIMITS.idleStopMinutes * 60_000;
export const BROWSER_HOLD_MS = BROWSER_LIMITS.holdMinutes * 60_000;
export const BROWSER_SWEEP_MS = 30_000;
/** How long a fresh `brw` has to say `ready` (Chromium launch; the agent's own launch timeout is 60 s). */
export const BROWSER_READY_MS = 75_000;
/** Control messages a slow subscriber may have queued before it is cut off. */
const MAX_QUEUED_CONTROLS = 32;

// ---------------------------------------------------------------- frame subscribers (latest-frame-wins)

/** Where a frame stream is written (the HTTP response; tests pass a fake). */
export interface FrameWritable {
  write(chunk: Uint8Array): boolean;
  end(): void;
  once(event: "drain", listener: () => void): unknown;
  readonly writableNeedDrain: boolean;
  readonly writableEnded: boolean;
}

export interface FrameSink {
  frame(jpeg: Buffer): void;
  control(message: SandboxdFrameControl): void;
  end(): void;
}

/**
 * One subscriber's writer: a frame that arrives while the consumer is still draining replaces the waiting one (only the
 * newest is ever held, never a queue); control messages wait in a short queue and a consumer that lets it overflow is
 * ended. Every byte goes out in the contract framing (`encodeFrame`).
 */
export function frameWriter(out: FrameWritable): FrameSink {
  let waitingFrame: Buffer | null = null;
  const controls: Uint8Array[] = [];
  let draining = false;
  let ended = false;

  const flush = () => {
    draining = false;
    if (ended) return;
    while (controls.length > 0) {
      if (!out.write(controls.shift() as Uint8Array)) return wait();
    }
    if (waitingFrame) {
      const f = waitingFrame;
      waitingFrame = null;
      if (!out.write(f)) return wait();
    }
  };
  const wait = () => {
    if (draining) return;
    draining = true;
    out.once("drain", flush);
  };

  return {
    frame(jpeg) {
      if (ended || jpeg.length > FRAME_MAX_PAYLOAD_BYTES) return;
      const framed = Buffer.from(encodeFrame(FRAME_TYPES.jpeg, jpeg));
      if (draining || out.writableNeedDrain) {
        waitingFrame = framed;
        wait();
        return;
      }
      if (!out.write(framed)) wait();
    },
    control(message) {
      if (ended) return;
      const framed = encodeFrame(FRAME_TYPES.control, Buffer.from(JSON.stringify(message), "utf8"));
      if (draining || out.writableNeedDrain) {
        if (controls.length >= MAX_QUEUED_CONTROLS) {
          this.end();
          return;
        }
        controls.push(framed);
        wait();
        return;
      }
      if (!out.write(framed)) wait();
    },
    end() {
      if (ended) return;
      ended = true;
      waitingFrame = null;
      controls.length = 0;
      if (!out.writableEnded) out.end();
    },
  };
}

// ---------------------------------------------------------------- agent codes → sandboxd codes

const AGENT_CODES: Record<string, { code: SandboxdErrorCode; status: number }> = {
  paused: { code: "paused", status: 409 },
  no_context: { code: "no_context", status: 404 },
  exists: { code: "exists", status: 409 },
  limit_reached: { code: "limit_reached", status: 409 },
  element_gone: { code: "element_gone", status: 409 },
  navigation_refused: { code: "navigation_refused", status: 422 },
  timeout: { code: "timeout", status: 504 },
  invalid_request: { code: "invalid_request", status: 400 },
  too_large: { code: "too_large", status: 413 },
  not_found: { code: "not_found", status: 404 },
};

/**
 * The sandboxd refusal for an agent error. The agent's own fixed message is kept for known codes; `internal`,
 * `sandbox_required`, a lost link and anything unknown become 503 `docker_unavailable` (the API's
 * `service_unavailable`) with fixed text, never the agent's.
 */
export function agentFailure(err: unknown): SandboxdFailure {
  if (err instanceof SandboxdFailure) return err;
  if (err instanceof AgentError) {
    const known = AGENT_CODES[err.code];
    if (known) return new SandboxdFailure(known.code, known.status, err.message.slice(0, 200));
    return new SandboxdFailure("docker_unavailable", 503, "the browser operation failed");
  }
  if (err instanceof DockerUnavailableError) {
    return new SandboxdFailure("docker_unavailable", 503, "the Docker daemon is unavailable");
  }
  return new SandboxdFailure("docker_unavailable", 503, "the browser operation failed");
}

/** D-14: the postures a runtime may honestly report. */
export function postureAllowed(
  runtime: DockerRuntime,
  posture: string | null,
): posture is BrowserSandboxMode {
  if (runtime === "runsc") return posture === "chromium+gvisor";
  return posture === "chromium" || posture === "container-only";
}

/** The agent's resize mode for a request: the caller's, else the live view's two fixed sizes, else custom. */
export function resizeMode(input: Pick<SandboxdContextResize, "width" | "height"> & { mode?: string }) {
  if (input.mode === "small" || input.mode === "expanded" || input.mode === "phone") return input.mode;
  if (input.width === BROWSER_LIMITS.frameWidth && input.height === BROWSER_LIMITS.frameHeight)
    return "small";
  if (input.width === BROWSER_LIMITS.expandedWidth && input.height === BROWSER_LIMITS.expandedHeight) {
    return "expanded";
  }
  return "custom";
}

// ---------------------------------------------------------------- state

interface Context {
  id: string;
  target: SandboxdTarget;
  lastActivity: number;
  holdUntil: number;
  takeover: boolean;
  size: { width: number; height: number } | null;
  subscribers: Set<FrameSink>;
}

interface BotBrowser {
  target: SandboxdTarget;
  containerId: string;
  link: AgentLink;
  runtime: DockerRuntime;
  posture: BrowserSandboxMode;
  contexts: Map<string, Context>;
  /** When the last context went away (or the browser started without one). */
  emptySince: number;
  stopping: boolean;
}

export interface BrowsersOptions {
  docker: Docker;
  sandboxes: Sandboxes;
  egress: Egress | null;
  ns: string;
  /** OCW_SANDBOX_BRW_IMAGE; null refuses every browser op (503) instead of guessing an image. */
  image: string | null;
  /** The seccomp profile JSON for `brw` (OCW_SANDBOX_BRW_SECCOMP), or null for Docker's default. */
  seccompProfile: string | null;
  clock?: Clock;
  onEvent?: (event: SandboxdEventInput) => void;
  /** Tests inject a fake link; production attaches to the container. */
  openLink?: (docker: Docker, containerId: string) => Promise<AgentLink>;
  readyTimeoutMs?: number;
}

export interface Browsers {
  ensure(target: SandboxdTarget): Promise<SandboxdBrowserStatus>;
  open(input: SandboxdContextOpen): Promise<{ contextId: string }>;
  navigate(input: SandboxdContextNavigate): Promise<SandboxdNavigateResult>;
  snapshot(input: { target: SandboxdTarget; contextId: string }): Promise<SnapshotResult>;
  act(input: SandboxdContextAct): Promise<SandboxdActResult>;
  screenshot(input: { target: SandboxdTarget; contextId: string }): Promise<ScreenshotResult>;
  wait(input: SandboxdContextWait): Promise<SandboxdWaitResult>;
  exportState(input: { target: SandboxdTarget; contextId: string }): Promise<SandboxdExportStateResult>;
  close(input: { target: SandboxdTarget; contextId: string }): Promise<{ closed: true }>;
  hold(input: SandboxdContextHold): Promise<{ held: boolean }>;
  /** 07.8-21: site-locks an open context in place after a member signed in to it (D-13). */
  lock(input: SandboxdContextLock): Promise<{ locked: true }>;
  takeover(input: SandboxdContextTakeover): Promise<{ active: boolean }>;
  resize(input: SandboxdContextResize): Promise<{ ok: true }>;
  input(input: SandboxdContextInput): Promise<{ accepted: number }>;
  download(input: SandboxdContextDownload): Promise<SandboxdDownloadContent>;
  /** Adds a live-view subscriber; returns its unsubscribe. 404 `no_context` for another bot's or a closed context. */
  subscribe(target: SandboxdTarget, contextId: string, sink: FrameSink): Promise<() => void>;
  /** The idle rule (contexts, then containers). */
  sweep(now?: number): Promise<void>;
  /** D-14: the posture of the last browser this process started or re-attached; null until then. */
  posture(): BrowserSandboxMode | null;
  start(intervalMs?: number): void;
  stop(): void;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const keyOf = (t: SandboxdTarget) => `${t.orgId}:${t.agentId}`;

export function createBrowsers(options: BrowsersOptions): Browsers {
  const { docker, sandboxes, egress, ns } = options;
  const clock: Clock = options.clock ?? { now: () => Date.now() };
  const emit = options.onEvent ?? (() => {});
  const openLink = options.openLink ?? openAgentLink;
  const readyTimeoutMs = options.readyTimeoutMs ?? BROWSER_READY_MS;
  const bots = new Map<string, BotBrowser>();
  const locks = new Map<string, Promise<unknown>>();
  let lastPosture: BrowserSandboxMode | null = null;
  let timer: NodeJS.Timeout | null = null;

  async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    locks.set(key, settled);
    try {
      return await run;
    } finally {
      if (locks.get(key) === settled) locks.delete(key);
    }
  }

  async function call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
    try {
      return await docker.request(method, path, body);
    } catch (err) {
      throw agentFailure(err);
    }
  }

  const down = (message: string) => new SandboxdFailure("docker_unavailable", 503, message);
  const mismatch = () =>
    new SandboxdFailure("label_mismatch", 409, "the object exists but is not this bot's browser");

  function labelsMatch(labels: unknown, target: SandboxdTarget, kind: string): boolean {
    const have = asRecord(labels);
    for (const [k, v] of Object.entries(ownerLabels({ ns, orgId: target.orgId, agentId: target.agentId }))) {
      if (have[k] !== v) return false;
    }
    return have[SANDBOXD_LABELS.kind] === kind;
  }

  async function ensureBrowserNetwork(target: SandboxdTarget): Promise<string> {
    const spec = browserNetworkSpec({ ns, orgId: target.orgId, agentId: target.agentId });
    const res = await call("GET", `/networks/${encodeURIComponent(spec.Name)}`);
    if (res.status === 200) {
      const n = asRecord(res.body);
      if (!labelsMatch(n.Labels, target, "brw") || n.Internal !== true) throw mismatch();
      return spec.Name;
    }
    if (res.status !== 404) throw down("the Docker daemon is unavailable");
    const created = await call("POST", "/networks/create", spec);
    if (created.status !== 201 && created.status !== 409) throw down("the Docker daemon is unavailable");
    return spec.Name;
  }

  async function inspectBrowser(target: SandboxdTarget): Promise<Record<string, unknown> | null> {
    const res = await call(
      "GET",
      `/containers/${encodeURIComponent(nameFor("brw", ns, target.agentId))}/json`,
    );
    if (res.status === 404) return null;
    if (res.status !== 200) throw down("the Docker daemon is unavailable");
    const c = asRecord(res.body);
    if (!labelsMatch(asRecord(c.Config).Labels, target, "brw")) throw mismatch();
    return c;
  }

  // ------------------------------------------------------------ agent output → subscribers and events

  function endContext(bot: BotBrowser, ctx: Context, event: "closed" | "crashed") {
    bot.contexts.delete(ctx.id);
    if (bot.contexts.size === 0) bot.emptySince = clock.now();
    for (const sink of ctx.subscribers) {
      sink.control({ kind: "closed" });
      sink.end();
    }
    ctx.subscribers.clear();
    emit({ type: "browser", target: ctx.target, contextId: ctx.id, event });
  }

  function onAgentEvent(bot: BotBrowser, msg: Record<string, unknown>) {
    const contextId = typeof msg.contextId === "string" ? msg.contextId : null;
    const ctx = contextId ? bot.contexts.get(contextId) : undefined;
    switch (msg.event) {
      case "navigated": {
        if (!ctx || typeof msg.host !== "string" || msg.host.length === 0) return;
        const host = msg.host.slice(0, 260);
        for (const sink of ctx.subscribers)
          sink.control({ kind: "navigated", host, secure: msg.secure === true });
        emit({ type: "browser", target: ctx.target, contextId: ctx.id, event: "navigated", host });
        return;
      }
      case "size": {
        if (!ctx || !Number.isInteger(msg.width) || !Number.isInteger(msg.height)) return;
        ctx.size = { width: msg.width as number, height: msg.height as number };
        for (const sink of ctx.subscribers) sink.control({ kind: "size", ...ctx.size });
        return;
      }
      case "focus": {
        if (!ctx) return;
        const sensitive = msg.sensitive === true;
        for (const sink of ctx.subscribers) sink.control({ kind: "focus", sensitive });
        if (sensitive)
          emit({ type: "browser", target: ctx.target, contextId: ctx.id, event: "focus_sensitive" });
        return;
      }
      case "download": {
        if (!ctx || typeof msg.name !== "string" || typeof msg.token !== "string") return;
        const size = typeof msg.size === "number" && msg.size >= 0 ? Math.floor(msg.size) : 0;
        emit({
          type: "browser",
          target: ctx.target,
          contextId: ctx.id,
          event: "download",
          download: { name: msg.name.slice(0, 255), size, token: msg.token },
        });
        return;
      }
      case "closed":
        if (ctx) endContext(bot, ctx, "closed");
        return;
      case "crashed":
        if (ctx) endContext(bot, ctx, "crashed");
        else if (msg.scope === "browser")
          for (const c of [...bot.contexts.values()]) endContext(bot, c, "crashed");
        return;
      default:
        // blockedNavigation and downloadRefused travel in the op's own result; nothing else is forwarded.
        return;
    }
  }

  function wire(bot: BotBrowser) {
    bot.link.onFrame((contextId, jpeg) => {
      const ctx = bot.contexts.get(contextId);
      if (!ctx) return;
      for (const sink of ctx.subscribers) sink.frame(jpeg);
    });
    bot.link.onEvent((msg) => onAgentEvent(bot, msg));
    bot.link.onClose(() => {
      if (bots.get(keyOf(bot.target)) === bot) bots.delete(keyOf(bot.target));
      const expected = bot.stopping || sandboxes.wasStoppedByBroker(bot.containerId);
      for (const ctx of [...bot.contexts.values()]) endContext(bot, ctx, expected ? "closed" : "crashed");
      if (!expected) {
        emit({ type: "state", target: bot.target, kind: "brw", state: "stopped", reason: null });
      }
    });
  }

  // ------------------------------------------------------------ lifecycle

  async function ensureLocked(target: SandboxdTarget): Promise<BotBrowser> {
    const existing = bots.get(keyOf(target));
    if (existing && !existing.link.closed && !existing.stopping) return existing;
    if (!options.image || !egress) {
      throw down("the browser is not configured on this sandboxd");
    }
    const runtime = await sandboxes.dockerRuntime();
    const policy = sandboxes.policyOf(target.orgId);
    if (!policy)
      throw new SandboxdFailure("policy_missing", 409, "sandboxd holds no policy for this organization");

    // The proxy first, so the browser's first request already has a way out (or a refusal) waiting.
    const network = await ensureBrowserNetwork(target);
    // Its address there now names the proxy in brw's /etc/hosts (gVisor answers no Docker DNS on the bot network).
    const egressAddress = await egress.attach(target, "brw", network);

    let c = await inspectBrowser(target);
    if (
      c &&
      asRecord(c.State).Running !== true &&
      !egressHostsCurrent(asRecord(c.HostConfig).ExtraHosts, egressAddress)
    ) {
      // Stopped with a stale entry (the proxy restarted, or brw predates the entry): created again below. brw keeps
      // nothing outside its tmpfs, so removing the stopped container loses nothing.
      const removed = await call("DELETE", `/containers/${encodeURIComponent(String(c.Id))}?force=1`);
      if (removed.status !== 204 && removed.status !== 404) throw down("the Docker daemon is unavailable");
      c = null;
    }
    if (!c) {
      const spec = brwSpec({
        ns,
        orgId: target.orgId,
        agentId: target.agentId,
        image: options.image,
        runtime,
        network,
        limits: {
          nanoCpus: policy.browserLimits.nanoCpus,
          memoryBytes: policy.browserLimits.memoryBytes,
          pids: policy.browserLimits.pids,
        },
        chromiumSandbox: true,
        seccompProfile: options.seccompProfile,
        egressAddress,
      });
      const name = nameFor("brw", ns, target.agentId);
      const created = await call("POST", `/containers/create?name=${encodeURIComponent(name)}`, spec);
      if (created.status !== 201 && created.status !== 409) throw down("the Docker daemon is unavailable");
      c = await inspectBrowser(target);
      if (!c) throw down("the Docker daemon is unavailable");
    }
    const containerId = String(c.Id);
    const containerRuntime: DockerRuntime = asRecord(c.HostConfig).Runtime === "runsc" ? "runsc" : "runc";
    const wasRunning = asRecord(c.State).Running === true;

    // Attach before starting, so the agent's `ready` (or its refusal) is never missed.
    let link: AgentLink;
    try {
      link = await openLink(docker, containerId);
    } catch (err) {
      throw agentFailure(err);
    }
    let posture: string | null;
    try {
      if (wasRunning) {
        // A sandboxd restart: the agent said `ready` long ago; ask it again.
        posture = String(asRecord(await link.request("info", {})).browserSandbox ?? "") || null;
      } else {
        const started = await call("POST", `/containers/${encodeURIComponent(containerId)}/start`);
        if (started.status !== 204 && started.status !== 304) throw down("the Docker daemon is unavailable");
        posture = (await link.ready(readyTimeoutMs)).browserSandbox;
      }
    } catch (err) {
      link.close();
      if (err instanceof SandboxdFailure) throw err;
      // `fatal` (e.g. sandbox_required under runsc), a timeout or a lost link: the browser did not start.
      await stopContainer(containerId).catch(() => undefined);
      throw down("the browser could not start");
    }
    if (!postureAllowed(containerRuntime, posture)) {
      // D-14: a posture the runtime cannot have is a lie or a silent fallback; never reported, never used.
      link.close();
      await stopContainer(containerId).catch(() => undefined);
      throw down("the browser's sandbox does not match its runtime");
    }
    const bot: BotBrowser = {
      target,
      containerId,
      link,
      runtime: containerRuntime,
      posture,
      contexts: new Map(),
      emptySince: clock.now(),
      stopping: false,
    };
    bots.set(keyOf(target), bot);
    wire(bot);
    lastPosture = posture;
    if (!wasRunning) emit({ type: "state", target, kind: "brw", state: "running", reason: null });
    return bot;
  }

  async function stopContainer(containerId: string) {
    sandboxes.expectStop(containerId);
    await call("POST", `/containers/${encodeURIComponent(containerId)}/stop?t=5`);
  }

  async function stopBot(bot: BotBrowser, reason: "idle") {
    if (bot.stopping) return;
    bot.stopping = true;
    await stopContainer(bot.containerId).catch(() => undefined);
    bot.link.close();
    if (bots.get(keyOf(bot.target)) === bot) bots.delete(keyOf(bot.target));
    emit({ type: "state", target: bot.target, kind: "brw", state: "stopped", reason });
  }

  const ensure = (target: SandboxdTarget) => locked(keyOf(target), () => ensureLocked(target));

  // ------------------------------------------------------------ context ops

  function contextOf(target: SandboxdTarget, contextId: string): { bot: BotBrowser; ctx: Context } {
    const bot = bots.get(keyOf(target));
    const ctx = bot?.contexts.get(contextId);
    // Another bot's context is no context (the same answer as an unknown one).
    if (!bot || !ctx || ctx.target.orgId !== target.orgId || ctx.target.agentId !== target.agentId) {
      throw new SandboxdFailure("no_context", 404, "no such browser context");
    }
    return { bot, ctx };
  }

  /** One agent op on a context; an op is activity (except a hold, which never extends itself). */
  async function onContext<T>(
    input: { target: SandboxdTarget; contextId: string },
    op: string,
    body: Record<string, unknown>,
    opts: { activity?: boolean } = {},
  ): Promise<T> {
    const { bot, ctx } = contextOf(input.target, input.contextId);
    if (opts.activity !== false) ctx.lastActivity = clock.now();
    try {
      return (await bot.link.request(op, { contextId: input.contextId, ...body })) as T;
    } catch (err) {
      if (err instanceof AgentError && err.code === "no_context") endContext(bot, ctx, "closed");
      throw agentFailure(err);
    } finally {
      if (opts.activity !== false) ctx.lastActivity = clock.now();
    }
  }

  return {
    async ensure(target) {
      const bot = await ensure(target);
      return {
        target,
        state: "running",
        runtime: bot.runtime === "runsc" ? "gvisor" : "hardened-runc",
        browserSandbox: bot.posture,
      };
    },

    async open(input) {
      const bot = await ensure(input.target);
      if (bot.contexts.has(input.contextId))
        throw new SandboxdFailure("exists", 409, "the browser context exists");
      const body: Record<string, unknown> = { contextId: input.contextId, viewport: input.viewport };
      if (input.memberId !== undefined) body.memberId = input.memberId;
      if (input.storageState !== undefined) body.storageState = input.storageState;
      if (input.siteLock !== undefined) body.siteLock = input.siteLock;
      try {
        await bot.link.request("contextOpen", body);
      } catch (err) {
        throw agentFailure(err);
      }
      const now = clock.now();
      bot.contexts.set(input.contextId, {
        id: input.contextId,
        target: input.target,
        lastActivity: now,
        holdUntil: 0,
        takeover: false,
        size: null,
        subscribers: new Set(),
      });
      return { contextId: input.contextId };
    },

    navigate(input) {
      const body: Record<string, unknown> = { url: input.url };
      if (input.allowCrossSite !== undefined) body.allowCrossSite = input.allowCrossSite;
      return onContext<SandboxdNavigateResult>(input, "contextNavigate", body);
    },

    snapshot: (input) => onContext<SnapshotResult>(input, "contextSnapshot", {}),

    act(input) {
      const { target: _t, contextId: _c, ...rest } = input;
      return onContext<SandboxdActResult>(input, "contextAct", rest);
    },

    async screenshot(input) {
      const shot = asRecord(await onContext<unknown>(input, "contextScreenshot", {}));
      // The agent's mask rectangles stay with the agent: the model gets the masked image and the count only.
      return {
        mimeType: shot.mimeType,
        data: shot.data,
        width: shot.width,
        height: shot.height,
        masked: shot.masked,
      } as ScreenshotResult;
    },

    wait(input) {
      const { target: _t, contextId: _c, ...rest } = input;
      return onContext<SandboxdWaitResult>(input, "contextWait", rest);
    },

    exportState: (input) => onContext<SandboxdExportStateResult>(input, "contextExportState", {}),

    async close(input) {
      const { bot, ctx } = contextOf(input.target, input.contextId);
      try {
        await bot.link.request("contextClose", { contextId: input.contextId });
      } catch (err) {
        if (!(err instanceof AgentError) || err.code !== "no_context") throw agentFailure(err);
      }
      if (bot.contexts.has(ctx.id)) endContext(bot, ctx, "closed");
      return { closed: true };
    },

    async hold(input) {
      const { ctx } = contextOf(input.target, input.contextId);
      const now = clock.now();
      // Up to 15 minutes, never beyond 15 minutes after the context's last real activity.
      ctx.holdUntil = input.hold ? Math.min(now + BROWSER_HOLD_MS, ctx.lastActivity + BROWSER_HOLD_MS) : 0;
      await onContext<unknown>(input, "contextHold", { hold: input.hold }, { activity: false });
      return { held: ctx.holdUntil > now };
    },

    async lock(input) {
      await onContext<unknown>(input, "contextLock", { memberId: input.memberId, siteLock: input.siteLock });
      return { locked: true };
    },

    async takeover(input) {
      const { ctx } = contextOf(input.target, input.contextId);
      const res = asRecord(await onContext<unknown>(input, "contextTakeover", { active: input.active }));
      ctx.takeover = res.active === true;
      return { active: ctx.takeover };
    },

    async resize(input) {
      await onContext<unknown>(input, "contextResize", {
        mode: resizeMode(input),
        width: input.width,
        height: input.height,
      });
      return { ok: true };
    },

    async input(input) {
      // Passed through once to the agent's stdin; never logged, never kept.
      const res = asRecord(await onContext<unknown>(input, "contextInput", { events: input.events }));
      const applied = typeof res.applied === "number" ? res.applied : input.events.length;
      return { accepted: applied };
    },

    download: (input) => onContext<SandboxdDownloadContent>(input, "contextDownload", { token: input.token }),

    async subscribe(target, contextId, sink) {
      const { bot, ctx } = contextOf(target, contextId);
      const first = ctx.subscribers.size === 0;
      ctx.subscribers.add(sink);
      ctx.lastActivity = clock.now();
      if (ctx.size) sink.control({ kind: "size", ...ctx.size });
      if (first) {
        // The agent screencasts only while someone watches.
        await bot.link.request("contextFrames", { contextId, on: true }).catch((err) => {
          ctx.subscribers.delete(sink);
          throw agentFailure(err);
        });
      }
      let done = false;
      return () => {
        if (done) return;
        done = true;
        ctx.subscribers.delete(sink);
        ctx.lastActivity = clock.now();
        if (ctx.subscribers.size === 0 && bot.contexts.get(contextId) === ctx && !bot.link.closed) {
          void bot.link.request("contextFrames", { contextId, on: false }).catch(() => undefined);
        }
      };
    },

    async sweep(now = clock.now()) {
      for (const bot of [...bots.values()]) {
        if (bot.stopping || bot.link.closed) continue;
        let closedByIdle = false;
        for (const ctx of [...bot.contexts.values()]) {
          if (ctx.subscribers.size > 0 || ctx.takeover) continue;
          if (now < ctx.holdUntil) continue;
          if (now - ctx.lastActivity < BROWSER_IDLE_MS) continue;
          await bot.link.request("contextClose", { contextId: ctx.id }).catch(() => undefined);
          if (bot.contexts.has(ctx.id)) endContext(bot, ctx, "closed");
          closedByIdle = true;
        }
        if (bot.contexts.size === 0 && (closedByIdle || now - bot.emptySince >= BROWSER_IDLE_MS)) {
          await locked(keyOf(bot.target), () => stopBot(bot, "idle"));
        }
      }
    },

    posture: () => lastPosture,

    start(intervalMs = BROWSER_SWEEP_MS) {
      if (timer) return;
      timer = setInterval(() => {
        void this.sweep().catch(() => undefined);
      }, intervalMs);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      // Shutdown: the browsers keep running (a new sandboxd re-attaches); nothing here is a crash.
      for (const bot of bots.values()) {
        bot.stopping = true;
        bot.link.close();
      }
    },
  };
}
