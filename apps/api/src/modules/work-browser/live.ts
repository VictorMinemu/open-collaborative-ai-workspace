import { randomUUID } from "node:crypto";
import {
  BrowserHost,
  type LiveServerFrame,
  type LiveStateFrame,
  WORK_BROWSER_LIMITS,
  type WorkBrowserFrame,
} from "@ocw/contracts";
import { workBrowsers, workSessions } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { markDecided } from "../../authz";
import type { App, AuthContext, Core } from "../../core";
import { FrameSlot, LIVE_CLOSE } from "../browser";
import type { DeviceHub } from "../device";
import type { PermissionService } from "../organization";
import { authenticateUpgrade, SESSION_RECHECK_MS } from "../realtime";
import { sessionFacts } from "../work-session";

/**
 * The live view of a Work Zone session's browser (07.13-10; D-15, D-20, D-27, D-33, PD-12, PD-13; WZB-05, WZB-08).
 *
 * `GET /api/v1/live/work-browser/:sessionId` is a dedicated binary WebSocket on the API's own origin, opened exactly like
 * `/ws` and the bots' live view: an allowed Origin and the `ocw.auth.<jwt>` subprotocol, checked before the upgrade
 * (`authenticateUpgrade`). Who watches is the resolver's alone: `work_session.read` on the session resource built by
 * `sessionFacts` (the session's audience, D-15 research correction), decided in the viewer's tenant. Server → client:
 * the bots' JSON `LiveServerFrame`s, unchanged, and binary JPEG frames; client → server frames (lease, input) arrive
 * with 07.13-18.
 *
 * One hub per API instance, one entry per watched session. The device streams only while someone watches (PD-12): the
 * instance with at least one allowed viewer sends `browser.frames { on: true }` through `hub.sendBrowserFrame` at once
 * and again every `WORK_BROWSER_LIMITS.watchPingMs`; the last viewer leaving sends `on: false`. Frames arrive on the
 * Device Link of the instance holding the device (`onFrame`, after the module checked the session runs on that
 * device) and are fanned out through the bots' `FrameSlot` (latest wins: a slow viewer never buffers more than the
 * frame being written plus one waiting).
 *
 * Nothing of a frame or an input is persisted, logged or put in a span: log lines carry ids, counts and error names.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkLiveDeps {
  core: Core;
  perms: PermissionService;
  hub: DeviceHub;
  allowedOrigins: Set<string>;
  /** The session's row poll while watched (default 1 s). */
  pollMs?: number;
  /** Session and membership recheck of an open socket (default `SESSION_RECHECK_MS`). */
  sessionRecheckMs?: number;
  /** `browser.frames { on: true }` again this often while watched (default `watchPingMs`). */
  pingMs?: number;
}

export interface WorkLiveStats {
  sessions: Array<{
    sessionId: string;
    viewers: Array<{ viewerId: string; userId: string; frames: boolean; sent: number; dropped: number }>;
  }>;
}

export interface WorkLiveHub {
  /** A frame of `sessionId` from the device link of this instance (the module checked it runs on that device). */
  onFrame(organizationId: string, frame: WorkBrowserFrame): void;
  stats(): WorkLiveStats;
  close(): Promise<void>;
}

interface Decision {
  watch: boolean;
}

/** The session and its page as the hub reads them (system, the session's tenant): ids, origin and states only. */
interface View {
  deviceId: string;
  page: { state: "open" | "closed"; origin: string | null } | null;
}

interface Viewer {
  id: string;
  auth: AuthContext;
  socket: WebSocket;
  entry: Entry;
  decision: Decision | null;
  slot: FrameSlot;
  /** May receive binary frames now (the gate's last pushed answer). */
  frames: boolean;
  last: { viewerCan?: string; state?: string };
  closed: boolean;
  deciding: boolean;
  again: boolean;
  recheck: NodeJS.Timeout | null;
}

interface Entry {
  orgId: string;
  sessionId: string;
  viewers: Set<Viewer>;
  /** Null until read, or when the session is not in the organization. */
  view: View | null;
  poll: NodeJS.Timeout;
  refreshing: boolean;
  refreshAgain: boolean;
  /** The ping timer while the device is asked for frames. */
  ping: NodeJS.Timeout | null;
  /** The device the last `on: true` went to (the `on: false` goes there too). */
  pinged: string | null;
}

const name = (err: unknown) => (err as Error | undefined)?.name ?? "Error";

/** The page's host as a viewer in the audience may learn it (`host:port` of the origin), or null. */
function hostOf(origin: string | null): { host: string | null; secure: boolean | null } {
  if (!origin) return { host: null, secure: null };
  try {
    const url = new URL(origin);
    const host = BrowserHost.safeParse(url.host.toLowerCase());
    return { host: host.success ? host.data : null, secure: url.protocol === "https:" };
  } catch {
    return { host: null, secure: null };
  }
}

/** Registers `GET /live/work-browser/:sessionId` (mounted under `/api/v1`) and returns this instance's hub. */
export function registerWorkLiveView(app: App, deps: WorkLiveDeps): WorkLiveHub {
  const { core, perms, hub } = deps;
  const log = core.log;
  const pollMs = deps.pollMs ?? 1_000;
  const recheckMs = deps.sessionRecheckMs ?? SESSION_RECHECK_MS;
  const pingMs = deps.pingMs ?? WORK_BROWSER_LIMITS.watchPingMs;
  const entries = new Map<string, Entry>();
  const keyOf = (orgId: string, sessionId: string) => `${orgId}:${sessionId.toLowerCase()}`;

  // ---------------------------------------------------------------- reading the session (system, its tenant)

  async function readView(e: Entry): Promise<View | null> {
    return core.db.withTenant({ organizationId: e.orgId, userId: null }, async (tx) => {
      const [session] = await tx
        .select({ deviceId: workSessions.deviceId })
        .from(workSessions)
        .where(eq(workSessions.id, e.sessionId))
        .limit(1);
      if (!session) return null;
      const [row] = await tx
        .select({ state: workBrowsers.state, origin: workBrowsers.origin })
        .from(workBrowsers)
        .where(eq(workBrowsers.workSessionId, e.sessionId))
        .limit(1);
      return { deviceId: session.deviceId, page: row ?? null };
    });
  }

  /** Re-reads the session and pushes the new state to every viewer (coalesced: at most one read per session). */
  function refresh(e: Entry): void {
    if (e.refreshing) {
      e.refreshAgain = true;
      return;
    }
    e.refreshing = true;
    void (async () => {
      try {
        e.view = await readView(e);
        for (const v of e.viewers) pushState(v);
      } catch (err) {
        log.warn({ sessionId: e.sessionId, error: name(err) }, "work live view refresh failed");
      } finally {
        e.refreshing = false;
        if (e.refreshAgain) {
          e.refreshAgain = false;
          refresh(e);
        }
      }
    })();
  }

  // ---------------------------------------------------------------- deciding one viewer (the resolver)

  async function decide(v: Viewer): Promise<Decision> {
    const { auth } = v;
    return core.db.withTenant({ organizationId: auth.organizationId, userId: auth.userId }, async (tx) => {
      // RLS and the audience backstop: a session of another organization (or outside the person's relations) is not
      // found here, which is a refusal.
      const [row] = await tx
        .select({ id: workSessions.id, createdBy: workSessions.createdBy, deviceId: workSessions.deviceId })
        .from(workSessions)
        .where(eq(workSessions.id, v.entry.sessionId))
        .limit(1);
      if (!row) return { watch: false };
      const read = await perms.decide(
        tx,
        { kind: "user", userId: auth.userId },
        "work_session.read",
        await sessionFacts(tx, auth.userId, row),
      );
      return { watch: read.allowed };
    });
  }

  /** Decides the viewer again (coalesced) and pushes what changed. */
  function redecide(v: Viewer): void {
    if (v.closed) return;
    if (v.deciding) {
      v.again = true;
      return;
    }
    v.deciding = true;
    void (async () => {
      try {
        const d = await decide(v);
        if (v.closed) return;
        v.decision = d;
        pushState(v);
      } catch (err) {
        // A failed decision is not a grant: the viewer keeps its last answer until the next one.
        log.warn({ sessionId: v.entry.sessionId, error: name(err) }, "work live view decision failed");
      } finally {
        v.deciding = false;
        if (v.again && !v.closed) {
          v.again = false;
          redecide(v);
        }
      }
    })();
  }

  // ---------------------------------------------------------------- what each viewer sees (the privacy gate)

  /** What the viewer sees now, and whether binary frames may pass to it. */
  function stateOf(v: Viewer): { frame: LiveStateFrame; frames: boolean; close: number | null } {
    const d = v.decision;
    const view = v.entry.view;
    const base = {
      type: "state" as const,
      pausedFor: null,
      activity: null,
      host: null,
      secure: null,
      controller: null,
    };
    if (!d?.watch || !view) {
      return { frame: { ...base, state: "no_permission" }, frames: false, close: LIVE_CLOSE.noPermission };
    }
    const page = view.page;
    // No page yet: nothing private can be loaded in it (a sign-in and a lease live on the page's row).
    if (!page) return { frame: { ...base, state: "connecting" }, frames: true, close: null };
    return { frame: { ...base, ...hostOf(page.origin), state: "live" }, frames: true, close: null };
  }

  function sendJson(v: Viewer, frame: LiveServerFrame): void {
    if (v.socket.readyState === v.socket.OPEN) v.socket.send(JSON.stringify(frame));
  }

  /** Sends the viewer's rights and state when they changed, applies the gate, then the device ping. */
  function pushState(v: Viewer): void {
    // Nothing before the first decision and the session's first read: the first frames are `viewerCan`, then `state`.
    if (v.closed || !v.decision) return;
    const d = v.decision;
    const can = JSON.stringify({ type: "viewerCan", watch: d.watch, control: false });
    if (v.last.viewerCan !== can) {
      v.last.viewerCan = can;
      sendJson(v, { type: "viewerCan", watch: d.watch, control: false });
    }
    const s = stateOf(v);
    v.frames = s.frames;
    if (!s.frames) v.slot.clear();
    const key = JSON.stringify(s.frame);
    if (v.last.state !== key) {
      v.last.state = key;
      sendJson(v, s.frame);
    }
    if (s.close !== null) {
      v.closed = true;
      v.socket.close(s.close, s.frame.state);
    }
    syncPing(v.entry);
  }

  /** The gate per frame, at the moment it is written (FrameSlot asks again): the viewer's answer for the page now. */
  function mayReceive(v: Viewer): boolean {
    return !v.closed && v.frames && stateOf(v).frames;
  }

  // ---------------------------------------------------------------- frames on / off (PD-12)

  /** The device is asked for frames while at least one viewer here may watch the session. */
  function wantsFrames(e: Entry): string | null {
    const deviceId = e.view?.deviceId ?? null;
    if (!deviceId || e.view?.page?.state === "closed") return null;
    return [...e.viewers].some((v) => !v.closed && v.decision?.watch) ? deviceId : null;
  }

  function sendFrames(e: Entry, deviceId: string, on: boolean): void {
    void hub
      .sendBrowserFrame(deviceId, { type: "browser.frames", sessionId: e.sessionId, on })
      .catch((err: unknown) =>
        log.warn({ sessionId: e.sessionId, error: name(err) }, "work live view frames request failed"),
      );
  }

  function syncPing(e: Entry): void {
    const deviceId = wantsFrames(e);
    if (deviceId && !e.ping) {
      e.pinged = deviceId;
      const ping = () => sendFrames(e, deviceId, true);
      ping();
      e.ping = setInterval(ping, pingMs);
      e.ping.unref();
    } else if (!deviceId && e.ping) {
      stopPing(e);
    }
  }

  function stopPing(e: Entry): void {
    if (e.ping) clearInterval(e.ping);
    e.ping = null;
    if (e.pinged) sendFrames(e, e.pinged, false);
    e.pinged = null;
  }

  function deliver(e: Entry, jpeg: Uint8Array): void {
    for (const v of e.viewers) if (mayReceive(v)) v.slot.offer(jpeg);
  }

  // ---------------------------------------------------------------- the route

  function entryFor(orgId: string, sessionId: string): Entry {
    const key = keyOf(orgId, sessionId);
    let e = entries.get(key);
    if (!e) {
      const created: Entry = {
        orgId,
        sessionId: sessionId.toLowerCase(),
        viewers: new Set(),
        view: null,
        poll: setInterval(() => refresh(created), pollMs),
        refreshing: false,
        refreshAgain: false,
        ping: null,
        pinged: null,
      };
      created.poll.unref();
      entries.set(key, created);
      e = created;
    }
    return e;
  }

  function leave(v: Viewer): void {
    v.closed = true;
    if (v.recheck) clearInterval(v.recheck);
    v.slot.clear();
    const e = v.entry;
    e.viewers.delete(v);
    if (e.viewers.size === 0) {
      clearInterval(e.poll);
      stopPing(e);
      entries.delete(keyOf(e.orgId, e.sessionId));
    } else {
      syncPing(e);
    }
  }

  app.get<{ Params: { sessionId: string } }>(
    "/live/work-browser/:sessionId",
    {
      websocket: true,
      // A person's socket: the JWT authenticates it before the upgrade; watching is the resolver's.
      config: { authz: "user" },
      // The upgrade's own log line only; no message of this socket is ever logged.
      logLevel: "warn",
      schema: { hide: true },
      onRequest: async (req, reply) => {
        const verdict = await authenticateUpgrade(req, {
          identity: core.identity,
          allowedOrigins: deps.allowedOrigins,
        });
        if ("refused" in verdict)
          return reply.code(verdict.refused.status).send({ error: verdict.refused.error });
        const sessionId = (req.params as { sessionId?: string }).sessionId ?? "";
        if (!UUID.test(sessionId)) {
          return reply.code(404).send({ error: { code: "not_found", message: "Not found" } });
        }
        req.auth = verdict.auth;
      },
    },
    (socket: WebSocket, req: FastifyRequest<{ Params: { sessionId: string } }>) => {
      const auth = req.auth as AuthContext;
      markDecided(req);
      const e = entryFor(auth.organizationId, req.params.sessionId);
      const v: Viewer = {
        id: randomUUID(),
        auth,
        socket,
        entry: e,
        decision: null,
        slot: new FrameSlot({
          get bufferedAmount() {
            return socket.bufferedAmount;
          },
          open: () => socket.readyState === socket.OPEN,
          // The gate again when the frame is handed to the socket (it may have waited behind a slow write).
          allowed: () => mayReceive(v),
          write: (frame, done) => socket.send(frame, { binary: true }, () => done()),
        }),
        frames: false,
        last: {},
        closed: false,
        deciding: false,
        again: false,
        recheck: null,
      };
      e.viewers.add(v);
      // Client frames (lease, input) arrive with 07.13-18; until then every client message is dropped unread.
      socket.on("close", () => leave(v));
      v.recheck = setInterval(async () => {
        const still = await Promise.all([
          core.identity.isSessionActive(auth.sessionId),
          core.identity.isMemberActive(auth.organizationId, auth.userId),
        ]).then(
          ([session, member]) => session && member,
          () => true,
        );
        if (!still) {
          v.closed = true;
          socket.close(LIVE_CLOSE.sessionExpired, "session expired");
          return;
        }
        redecide(v);
      }, recheckMs);
      v.recheck.unref();
      void (async () => {
        try {
          const decision = await decide(v);
          if (!e.view) e.view = await readView(e);
          v.decision = decision;
          pushState(v);
        } catch (err) {
          log.warn({ sessionId: e.sessionId, error: name(err) }, "work live view open failed");
          v.closed = true;
          socket.close(1011, "unavailable");
        }
      })();
    },
  );

  return {
    onFrame(organizationId, frame) {
      const e = entries.get(keyOf(organizationId, frame.sessionId));
      if (e) deliver(e, frame.jpeg);
    },
    stats() {
      return {
        sessions: [...entries.values()].map((e) => ({
          sessionId: e.sessionId,
          viewers: [...e.viewers].map((v) => ({
            viewerId: v.id,
            userId: v.auth.userId,
            frames: v.frames,
            sent: v.slot.sent,
            dropped: v.slot.dropped,
          })),
        })),
      };
    },
    async close() {
      for (const e of entries.values()) {
        clearInterval(e.poll);
        if (e.ping) clearInterval(e.ping);
        for (const v of e.viewers) if (v.recheck) clearInterval(v.recheck);
      }
      entries.clear();
    },
  };
}
