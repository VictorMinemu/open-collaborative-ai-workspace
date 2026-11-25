import { randomUUID } from "node:crypto";
import {
  type BrowserEndReason,
  BrowserHost,
  type LiveServerFrame,
  type LiveStateFrame,
  WORK_BROWSER_AUDIT,
  WORK_BROWSER_LIMITS,
  type WorkBrowserFrame,
} from "@ocw/contracts";
import { auditEvents, orgMembers, type Tx, workBrowsers, workSessions } from "@ocw/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { markDecided } from "../../authz";
import type { App, AuthContext, Core } from "../../core";
import { FrameSlot, LIVE_CLOSE } from "../browser";
import type { DeviceHub } from "../device";
import type { PermissionService } from "../organization";
import { authenticateUpgrade, SESSION_RECHECK_MS } from "../realtime";
import { sessionFacts } from "../work-session";
import type { LiveRelay } from "./live-relay";

/**
 * The live view of a Work Zone session's browser (07.13-10; D-15, D-20, D-27, D-33, PD-12, PD-13; WZB-05, WZB-08).
 *
 * `GET /api/v1/live/work-browser/<sessionId>` is a dedicated binary WebSocket on the API's own origin, opened exactly like
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
 * Viewers on another instance (D-33, `live-relay.ts`): every instance with viewers announces its watch with each ping
 * and subscribes to the session's frames channel; the instance holding the link publishes a frame there only while
 * another instance announced within `watchLapseMs`, and never sends `on: false` while one does.
 *
 * The privacy gate (D-20, D-27, PD-13) decides per viewer from the session's `work_browsers` row, polled every second
 * while watched, and is asked again by `FrameSlot` at the moment a frame is written (a frame that waited while the page
 * turned private is dropped):
 * - **takeover:** while `lease_id` is set, frames go only to the socket registered for that lease
 *   (`registerLeaseSocket`, 07.13-18); every other viewer, the holder's other sockets included, gets `private`
 *   (`takeover`). A lease no socket here registered (held on another instance) lets nothing through here;
 * - **member sign-in:** while `signin_user_id` is M, only M's sockets get frames; the others get `private`
 *   (`member_session`) with M's display name, never the page's host;
 * - **ended:** a closed row ends every viewer (`ended` with the reason of the page's last close) and closes 1000.
 *
 * Live re-authorization (ADR-0009): the gateway's invalidation bus (a device grant, a team project, a unit or a rule
 * changed), session revocations and the per-socket session recheck re-decide `work_session.read`; a viewer that lost it
 * gets `no_permission` and 4403, and no frame after. Every viewer gets its current state again every 10 s (heartbeat).
 *
 * Nothing of a frame or an input is persisted, logged or put in a span: log lines carry ids, counts and error names.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WorkLiveDeps {
  core: Core;
  perms: PermissionService;
  hub: DeviceHub;
  allowedOrigins: Set<string>;
  /** Frames to and from the other API instances (D-33); closed with the hub. */
  relay: LiveRelay;
  /** The session's row poll while watched (default 1 s). */
  pollMs?: number;
  /** Session and membership recheck of an open socket (default `SESSION_RECHECK_MS`). */
  sessionRecheckMs?: number;
  /** `browser.frames { on: true }` again this often while watched (default `watchPingMs`). */
  pingMs?: number;
  /** Every viewer gets its current state again this often (default 10 s; `heartbeat()` is also callable). */
  heartbeatMs?: number;
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
  /**
   * 07.13-18: the socket `viewerId` (a viewer of `sessionId` on this instance) holds lease `leaseId`: while the row's
   * `lease_id` is that lease, only this socket receives frames. False when no such viewer is here.
   */
  registerLeaseSocket(sessionId: string, leaseId: string, viewerId: string): boolean;
  /** 07.13-18: this instance holds no socket for the session's lease any more. */
  clearLeaseSocket(sessionId: string): void;
  /** Sends every open viewer its current state frame again (the client's liveness signal). */
  heartbeat(): void;
  stats(): WorkLiveStats;
  close(): Promise<void>;
}

interface Decision {
  watch: boolean;
}

/** Why a Work Zone page ended, as a viewer is told (`closed_by_bot`, `kill_switch` and `module_off` are the bots'). */
type WorkEndReason = Extract<BrowserEndReason, "idle" | "crashed" | "access_lost" | "takeover_abandoned">;
const END_REASONS: readonly string[] = ["idle", "crashed", "access_lost", "takeover_abandoned"];

/** The session's page row as the gate reads it: states and ids only. */
interface PageRow {
  state: "open" | "closed";
  origin: string | null;
  leaseId: string | null;
  controllerUserId: string | null;
  signinUserId: string | null;
}

/** The session and its page as the hub reads them (system, the session's tenant): ids, origin and states only. */
interface View {
  deviceId: string;
  page: PageRow | null;
  /** The signed-in member's display name (`member_session`). */
  memberName: string | null;
  /** The lease holder's display name (`takeover`). */
  controllerName: string | null;
  /** The reason of the page's last close, when the row is closed. */
  endReason: WorkEndReason | null;
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
  /** The socket here holding the page's lease (07.13-18), with the lease id it holds. */
  lease: { leaseId: string; viewerId: string } | null;
  /** A frame of the session reached this entry (directly or through the relay): the fast pings stop. */
  framesSeen: boolean;
  fastPings: number;
  /** Ends this instance's follow of the session's watch channel. */
  release: () => void;
  /** This instance's subscription to the frames other instances publish for the session. */
  remote: Promise<(() => Promise<void>) | null>;
}

/** Pings before the first frame, one a second (see `ping`). */
const FAST_PINGS = 10;
const FAST_PING_MS = 1_000;

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

/** Registers `GET /live/work-browser/<sessionId>` (mounted under `/api/v1`) and returns this instance's hub. */
export function registerWorkLiveView(app: App, deps: WorkLiveDeps): WorkLiveHub {
  const { core, perms, hub, relay } = deps;
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
        .select({
          state: workBrowsers.state,
          origin: workBrowsers.origin,
          leaseId: workBrowsers.leaseId,
          controllerUserId: workBrowsers.controllerUserId,
          signinUserId: workBrowsers.signinUserId,
        })
        .from(workBrowsers)
        .where(eq(workBrowsers.workSessionId, e.sessionId))
        .limit(1);
      const page = row ?? null;
      const people = [page?.signinUserId, page?.controllerUserId].filter((x): x is string => !!x);
      const names = people.length
        ? await tx
            .select({ userId: orgMembers.userId, name: orgMembers.displayName })
            .from(orgMembers)
            .where(inArray(orgMembers.userId, people))
        : [];
      const nameOf = (id: string | null | undefined) =>
        id ? (names.find((n) => n.userId === id)?.name ?? null) : null;
      return {
        deviceId: session.deviceId,
        page,
        memberName: nameOf(page?.signinUserId),
        controllerName: nameOf(page?.controllerUserId),
        endReason: page?.state === "closed" ? await lastEndReason(tx, e.sessionId) : null,
      };
    });
  }

  /** The `endReason` of the page's last `work_browser.closed` audit (a plain close is `idle`: the device's idle close). */
  async function lastEndReason(tx: Tx, sessionId: string): Promise<WorkEndReason> {
    const [last] = await tx
      .select({ metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceType, "work_session"),
          eq(auditEvents.resourceId, sessionId),
          eq(auditEvents.action, WORK_BROWSER_AUDIT.closed),
        ),
      )
      .orderBy(desc(auditEvents.occurredAt))
      .limit(1);
    const reason = last?.metadata.endReason;
    return typeof reason === "string" && END_REASONS.includes(reason) ? (reason as WorkEndReason) : "idle";
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
    if (page.state === "closed") {
      return {
        frame: { ...base, state: "ended", endReason: view.endReason ?? "idle" },
        frames: false,
        close: LIVE_CLOSE.ended,
      };
    }
    if (page.leaseId) {
      const lease = v.entry.lease;
      if (lease && lease.leaseId === page.leaseId && lease.viewerId === v.id) {
        return {
          frame: { ...base, ...hostOf(page.origin), state: "controlling", controller: "self" },
          frames: true,
          close: null,
        };
      }
      // D-20: during a takeover only the controlling socket receives frames.
      return {
        frame: {
          ...base,
          state: "private",
          privateReason: "takeover",
          controller: page.controllerUserId === v.auth.userId ? "other_device" : "other",
          ...(view.controllerName ? { memberName: view.controllerName.slice(0, 200) } : {}),
        },
        frames: false,
        close: null,
      };
    }
    if (page.signinUserId && page.signinUserId !== v.auth.userId) {
      // D-27: a member's signed-in page is theirs alone; the others learn who, not where.
      return {
        frame: {
          ...base,
          state: "private",
          privateReason: "member_session",
          ...(view.memberName ? { memberName: view.memberName.slice(0, 200) } : {}),
        },
        frames: false,
        close: null,
      };
    }
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

  /**
   * One ping: the device is asked for frames (wherever its link is) and the other instances learn this one watches.
   * Until the first frame arrived the ping repeats every second (at most `FAST_PINGS` times): the instance holding the
   * link follows the watch channel only once the session's frames reach it, so it misses the very first announcement.
   */
  function ping(e: Entry, deviceId: string): void {
    sendFrames(e, deviceId, true);
    void relay
      .announceWatch(e.sessionId)
      .catch((err: unknown) =>
        log.warn({ sessionId: e.sessionId, error: name(err) }, "work live view watch announce failed"),
      );
    const fast = !e.framesSeen && e.fastPings < FAST_PINGS;
    if (fast) e.fastPings++;
    e.ping = setTimeout(() => ping(e, deviceId), fast ? FAST_PING_MS : pingMs);
    e.ping.unref();
  }

  function syncPing(e: Entry): void {
    const deviceId = wantsFrames(e);
    if (deviceId && !e.ping) {
      e.pinged = deviceId;
      ping(e, deviceId);
    } else if (!deviceId && e.ping) {
      stopPing(e);
    }
  }

  /** The device stops streaming, unless another instance still watches (its pings keep it on). */
  function stopPing(e: Entry): void {
    if (e.ping) clearTimeout(e.ping);
    e.ping = null;
    if (e.pinged && !relay.remoteWatching(e.sessionId)) sendFrames(e, e.pinged, false);
    e.pinged = null;
    e.fastPings = 0;
  }

  function deliver(e: Entry, jpeg: Uint8Array): void {
    e.framesSeen = true;
    for (const v of e.viewers) if (mayReceive(v)) v.slot.offer(jpeg);
  }

  // ---------------------------------------------------------------- re-authorization (shared subscriptions, once)

  let shared: Promise<Array<() => Promise<void>>> | null = null;
  const ensureShared = () => {
    shared ??= Promise.all([
      core.realtime.onRevocation((ev) => {
        for (const e of entries.values()) {
          for (const v of e.viewers) {
            if (ev.sessionIds?.includes(v.auth.sessionId) || (ev.userId && ev.userId === v.auth.userId)) {
              v.closed = true;
              v.socket.close(LIVE_CLOSE.sessionExpired, "session revoked");
            }
          }
        }
      }),
      core.realtime.onSubscriptionInvalidation((ev) => {
        for (const e of entries.values()) {
          if (e.orgId !== ev.organizationId) continue;
          // A topic-scoped invalidation concerns this session only when it names its `ws:` stream.
          if (ev.topics && !ev.topics.includes(`ws:${e.sessionId}`)) continue;
          for (const v of e.viewers) if (!ev.userIds || ev.userIds.includes(v.auth.userId)) redecide(v);
        }
      }),
    ]);
    shared.catch(() => {
      shared = null;
    });
    return shared;
  };

  /** The liveness signal: the last state each viewer was sent, again (no new decision, nothing else). */
  function heartbeat(): void {
    for (const e of entries.values()) {
      for (const v of e.viewers) {
        if (v.closed || !v.last.state || v.socket.readyState !== v.socket.OPEN) continue;
        v.socket.send(v.last.state);
      }
    }
  }
  const beat = setInterval(heartbeat, deps.heartbeatMs ?? 10_000);
  beat.unref();

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
        lease: null,
        framesSeen: false,
        fastPings: 0,
        // While this instance has viewers: it learns of watches elsewhere (an `on: false` would stop them) and
        // receives the frames the instance holding the link publishes.
        release: relay.hold(sessionId),
        remote: relay
          .subscribeFrames(sessionId, (f) => deliver(created, f.jpeg))
          .catch((err: unknown) => {
            log.warn({ sessionId, error: name(err) }, "work live view frames subscribe failed");
            return null;
          }),
      };
      created.poll.unref();
      entries.set(key, created);
      e = created;
    }
    return e;
  }

  function dropEntry(e: Entry): void {
    clearInterval(e.poll);
    stopPing(e);
    e.release();
    void e.remote.then((stop) => stop?.()).catch(() => {});
    entries.delete(keyOf(e.orgId, e.sessionId));
  }

  function leave(v: Viewer): void {
    v.closed = true;
    if (v.recheck) clearInterval(v.recheck);
    v.slot.clear();
    const e = v.entry;
    e.viewers.delete(v);
    if (e.lease?.viewerId === v.id) e.lease = null;
    if (e.viewers.size === 0) {
      dropEntry(e);
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
        await ensureShared();
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
      // This instance holds the link: it follows the session's watch channel while its frames arrive, and publishes
      // each frame only while another instance watches (the relay decides; nothing goes out otherwise).
      relay.touch(frame.sessionId);
      void relay
        .publishFrame(frame.sessionId, frame)
        .catch((err: unknown) =>
          log.warn({ sessionId: frame.sessionId, error: name(err) }, "work live view frame publish failed"),
        );
    },
    registerLeaseSocket(sessionId, leaseId, viewerId) {
      for (const e of entries.values()) {
        if (e.sessionId !== sessionId.toLowerCase()) continue;
        if (![...e.viewers].some((v) => v.id === viewerId && !v.closed)) continue;
        e.lease = { leaseId, viewerId };
        for (const v of e.viewers) pushState(v);
        return true;
      }
      return false;
    },
    clearLeaseSocket(sessionId) {
      for (const e of entries.values()) {
        if (e.sessionId !== sessionId.toLowerCase() || !e.lease) continue;
        e.lease = null;
        for (const v of e.viewers) pushState(v);
      }
    },
    heartbeat,
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
      clearInterval(beat);
      for (const e of [...entries.values()]) {
        for (const v of e.viewers) if (v.recheck) clearInterval(v.recheck);
        dropEntry(e);
      }
      await relay.close();
      const stops = await shared?.catch(() => []);
      for (const stop of stops ?? []) await stop().catch(() => {});
    },
  };
}
