import { randomUUID } from "node:crypto";
import {
  type BrowserEndReason,
  type BrowserFocusFrame,
  BrowserHost,
  type LiveInputFrame,
  type LiveServerFrame,
  type LiveStateFrame,
  WORK_BROWSER_AUDIT,
  WORK_BROWSER_LIMITS,
  type WorkBrowserFrame,
  WorkLiveClientFrame,
} from "@ocw/contracts";
import { auditEvents, orgMembers, type Tx, workBrowsers, workSessions } from "@ocw/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";
import { markDecided } from "../../authz";
import type { App, AuthContext, Core } from "../../core";
import { FrameSlot, LIVE_CLOSE } from "../browser";
import type { DeviceHub } from "../device";
import type { PermissionService } from "../organization";
import { authenticateUpgrade, SESSION_RECHECK_MS } from "../realtime";
import { sessionFacts } from "../work-session";
import {
  announceLease,
  askerOf,
  endWorkLease,
  keepWorkLease,
  markWorkLeaseInput,
  pageTakeableBy,
  parseLeaseAnnouncement,
  TAKEOVER_MS,
  TAKEOVER_WARN_MS,
  takeWorkLease,
  tellDeviceEnded,
  WORK_LEASE_CHANNEL,
  type WorkLeaseEnded,
  type WorkLeaseEndReason,
} from "./lease";
import type { LiveRelay } from "./live-relay";

/**
 * The live view of a Work Zone session's browser (07.13-10; D-15, D-20, D-27, D-33, PD-12, PD-13; WZB-05, WZB-08).
 *
 * `GET /api/v1/live/work-browser/<sessionId>` is a dedicated binary WebSocket on the API's own origin, opened exactly like
 * `/ws` and the bots' live view: an allowed Origin and the `ocw.auth.<jwt>` subprotocol, checked before the upgrade
 * (`authenticateUpgrade`). Who watches is the resolver's alone: `work_session.read` on the session resource built by
 * `sessionFacts` (the session's audience, D-15 research correction), decided in the viewer's tenant. Server → client:
 * the bots' JSON `LiveServerFrame`s, unchanged, and binary JPEG frames. Client → server: JSON `WorkLiveClientFrame`s
 * (07.13-18); anything else is dropped unread.
 *
 * Takeover (07.13-18; D-20, D-22, D-33, PD-14, PD-15; `lease.ts`): `viewerCan.control` is the right to take the page
 * (`work_session.prompt` ∧ the asker of the in-flight or last turn). `take` takes the lease on the row (one holder),
 * tells the device `browser.lease { held }` (its agent's browser tools answer `paused`) and the socket `lease
 * { expiresAt }`; from then on only that socket gets frames. Its input frames are batched (≤ 64 events, 20 ms) and
 * forwarded as `browser.input` through `hub.sendBrowserFrame` (directly, or across instances on the device's control
 * channel: Redis transit only, D-33), the first one that may leave something in the page only after `lease_input` is on
 * the row; input from any other socket is dropped. The lease lives 10 minutes after the latest input (`lease` again at
 * 9: the warning) and ends on `release { save }` (the hand back; `save` mints the device's upload), the socket closing,
 * lost access, or the page's end; an end without hand back after input abandons the page. Lease changes are announced
 * on `WORK_LEASE_CHANNEL` (ids only) so every instance re-reads the row at once; the device's focus hint
 * (`browser.focus`) reaches the holder's socket only, wherever it is.
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
 * turned private is dropped). The member sign-in is decided first (HI-03): a lease never shows a member's signed-in page
 * to anyone else.
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
  /**
   * 07.13-18 (D-20): the device's focus hint for lease `leaseId` (the module checked the session runs on that device):
   * sent to the holder's socket only (here, or on the instance holding it); a stale lease's reaches nobody.
   */
  onFocus(organizationId: string, frame: BrowserFocusFrame): Promise<void>;
  /** 07.13-18: ends idle leases (10 minutes without input) and warns their holder at 9 (tests pass a clock). */
  sweep(nowMs?: number): Promise<void>;
  /** Sends every open viewer its current state frame again (the client's liveness signal). */
  heartbeat(): void;
  stats(): WorkLiveStats;
  close(): Promise<void>;
}

interface Decision {
  watch: boolean;
  /** `work_session.prompt`: a holder without it loses the lease (access loss). */
  prompt: boolean;
  /** May take the page (`viewerCan.control`): `prompt` ∧ the asker of the in-flight or last turn (D-20). */
  control: boolean;
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
  /** The socket here holding the page's lease (07.13-18). */
  lease: LocalLease | null;
  /** A frame of the session reached this entry (directly or through the relay): the fast pings stop. */
  framesSeen: boolean;
  fastPings: number;
  /** Ends this instance's follow of the session's watch channel. */
  release: () => void;
  /** This instance's subscription to the frames other instances publish for the session. */
  remote: Promise<(() => Promise<void>) | null>;
}

/** This instance's view of a lease one of its sockets holds (07.13-18). */
interface LocalLease {
  leaseId: string;
  viewer: Viewer;
  /** The session's device (input, lease and hand back frames go there); null when unknown. */
  deviceId: string | null;
  /** The row showed this lease (take wrote it, or a read found it): a row without it now means it ended elsewhere. */
  seen: boolean;
  /** 10 minutes after the latest input (this instance's clock; the row's expiry is written at most every 30 s). */
  expiresAtMs: number;
  lastKeepMs: number;
  warned: boolean;
  /** The end is being written: no input, keep or second end is taken; frames stay the holder's until it committed. */
  ending: boolean;
  /** The row records input in this lease (`markWorkLeaseInput`, before the first such input is sent). */
  inputMarked: boolean;
  inputs: LiveInputFrame[];
  flush: NodeJS.Timeout | null;
  flushing: boolean;
}

/** The holder's lease is written again after this much input (the sweep's view of it stays fresh). */
const KEEP_EVERY_MS = 30_000;
/** Input events queued per page at most (a stalled link drops the newest instead of growing). */
const INPUT_QUEUE_MAX = 256;
/** At most this many input events per `browser.input` frame, gathered for at most `INPUT_BATCH_MS`. */
const INPUT_BATCH_MAX = 64;
const INPUT_BATCH_MS = 20;

/** Redis channel of the device's focus hint for a lease held on another instance: ids and the flag only. */
const WORK_FOCUS_CHANNEL = "ocw:wb:focus";

/**
 * Input that may leave something in the page (ADR-0029: typed, clicked, pasted, tapped). Pointer moves and wheel scrolls
 * enter nothing: a person who only looked hands nothing over when their control ends.
 */
const entersSomething = (e: LiveInputFrame) =>
  !(e.type === "wheel" || (e.type === "mouse" && e.event === "move"));

/** Pings before the first frame, one a second (see `ping`). */
const FAST_PINGS = 10;
const FAST_PING_MS = 1_000;

const name = (err: unknown) => (err as Error | undefined)?.name ?? "Error";

/** A `WORK_FOCUS_CHANNEL` message (`{"o","s","l","f"}`: ids and the flag), or null. */
function parseFocus(raw: string): { o: string; s: string; l: string; f: boolean } | null {
  try {
    const v = JSON.parse(raw) as { o?: unknown; s?: unknown; l?: unknown; f?: unknown };
    return typeof v.o === "string" &&
      typeof v.s === "string" &&
      typeof v.l === "string" &&
      typeof v.f === "boolean"
      ? { o: v.o, s: v.s, l: v.l, f: v.f }
      : null;
  } catch {
    return null;
  }
}

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
        reconcileLease(e);
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
      const none = { watch: false, prompt: false, control: false };
      if (!row) return none;
      const user = { kind: "user" as const, userId: auth.userId };
      const facts = await sessionFacts(tx, auth.userId, row);
      const read = await perms.decide(tx, user, "work_session.read", facts);
      if (!read.allowed) return none;
      const prompt = (await perms.decide(tx, user, "work_session.prompt", facts)).allowed;
      // D-20: only the person whose turn it is (in flight, else the last one) takes control; HI-03: never a page that
      // holds another member's sign-in.
      const control =
        prompt &&
        (await askerOf(tx, v.entry.sessionId)) === auth.userId &&
        (await pageTakeableBy(tx, v.entry.sessionId, auth.userId));
      return { watch: true, prompt, control };
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
        // Access loss (D-20): a holder who may no longer read or prompt the session loses the lease.
        const l = v.entry.lease;
        if (l?.viewer === v && !l.ending && (!d.watch || !d.prompt)) await endLease(v.entry, "access_lost");
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
    if (page.signinUserId && page.signinUserId !== v.auth.userId) {
      // D-27: a member's signed-in page is theirs alone; the others learn who, not where. HI-03: decided before the
      // lease, so a lease holder who is not that member never gets the frames of their signed-in page either.
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
    if (page.leaseId) {
      const lease = v.entry.lease;
      if (lease && lease.leaseId === page.leaseId && lease.viewer === v) {
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
    const can: LiveServerFrame = { type: "viewerCan", watch: d.watch, control: d.watch && d.control };
    const canKey = JSON.stringify(can);
    if (v.last.viewerCan !== canKey) {
      v.last.viewerCan = canKey;
      sendJson(v, can);
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

  // ---------------------------------------------------------------- the lease (07.13-18: take, keep, input, end)

  function newLease(viewer: Viewer, leaseId: string, deviceId: string | null, seen: boolean): LocalLease {
    const now = Date.now();
    return {
      leaseId: leaseId.toLowerCase(),
      viewer,
      deviceId,
      seen,
      expiresAtMs: now + TAKEOVER_MS,
      lastKeepMs: now,
      warned: false,
      ending: false,
      inputMarked: false,
      inputs: [],
      flush: null,
      flushing: false,
    };
  }

  /** Forgets this instance's lease (no write: it ended elsewhere, or is ending here). */
  function dropLease(e: Entry, l: LocalLease): void {
    l.inputs = [];
    if (l.flush) clearTimeout(l.flush);
    l.flush = null;
    if (e.lease === l) e.lease = null;
  }

  /**
   * The local lease must match the row: once the row showed it, a row without it (another instance's end, the sweep,
   * the page's own close) drops it here; a closed page or a session that is gone drops it at once.
   */
  function reconcileLease(e: Entry): void {
    const l = e.lease;
    if (!l || l.ending) return;
    const page = e.view?.page;
    if (page && page.state === "open" && page.leaseId === l.leaseId) {
      l.seen = true;
      if (!l.deviceId) l.deviceId = e.view?.deviceId ?? null;
      return;
    }
    if (l.seen || !e.view || page?.state === "closed") dropLease(e, l);
  }

  const leaseFrame = (l: LocalLease): LiveServerFrame => ({
    type: "lease",
    expiresAt: new Date(l.expiresAtMs).toISOString(),
  });

  async function onTake(v: Viewer): Promise<void> {
    const e = v.entry;
    const mine = e.lease;
    if (mine?.viewer === v && !mine.ending) {
      sendJson(v, leaseFrame(mine));
      return;
    }
    const d = await decide(v);
    if (v.closed) return;
    v.decision = d;
    if (!d.watch || !d.control) {
      sendJson(v, { type: "refused", op: "take", reason: "not_allowed" });
      pushState(v);
      return;
    }
    if (mine) {
      // Another socket here holds it (or its end is being written).
      sendJson(v, { type: "refused", op: "take", reason: "someone_else" });
      return;
    }
    const { auth } = v;
    const taken = await core.db.withTenant(
      { organizationId: auth.organizationId, userId: auth.userId, sessionId: auth.sessionId },
      (tx) => takeWorkLease(tx, core, perms, { sessionId: e.sessionId, userId: auth.userId }),
    );
    if ("refused" in taken) {
      sendJson(v, { type: "refused", op: "take", reason: taken.refused });
      refresh(e);
      return;
    }
    const l = newLease(v, taken.lease.leaseId, taken.lease.deviceId, true);
    l.expiresAtMs = Date.parse(taken.lease.expiresAt);
    e.lease = l;
    if (v.closed) {
      await endLease(e, "closed");
      return;
    }
    // The device pauses its agent's browser tools first; a device this instance cannot reach ends the lease again.
    const sent = await hub
      .sendBrowserFrame(taken.lease.deviceId, {
        type: "browser.lease",
        sessionId: e.sessionId,
        leaseId: l.leaseId,
        state: "held",
      })
      .catch(() => "closed" as const);
    if (sent === "closed" || sent === "too_large" || sent === "unsupported") {
      await endLease(e, "upstream_failed");
      sendJson(v, { type: "refused", op: "take", reason: "expired" });
      return;
    }
    sendJson(v, { type: "lease", expiresAt: taken.lease.expiresAt });
    await announceLease(core.bus, e.orgId, e.sessionId);
    refresh(e);
  }

  async function onKeep(v: Viewer, nowMs = Date.now()): Promise<void> {
    const e = v.entry;
    const l = e.lease;
    if (!l || l.viewer !== v || l.ending) return;
    const { auth } = v;
    const kept = await core.db
      .withTenant({ organizationId: auth.organizationId, userId: auth.userId }, (tx) =>
        keepWorkLease(tx, { sessionId: e.sessionId, leaseId: l.leaseId, userId: auth.userId, nowMs }),
      )
      .catch(() => undefined);
    if (kept === undefined || e.lease !== l || l.ending) return;
    if (kept === null) {
      dropLease(e, l);
      refresh(e);
      return;
    }
    l.expiresAtMs = Math.max(l.expiresAtMs, Date.parse(kept.expiresAt));
    l.lastKeepMs = nowMs;
    l.warned = false;
    sendJson(v, leaseFrame(l));
  }

  /** Input from the holder's socket only: queued, batched and forwarded in order; anyone else's is dropped. */
  function onInput(v: Viewer, event: LiveInputFrame): void {
    const e = v.entry;
    const l = e.lease;
    if (!l || l.viewer !== v || l.ending || !l.seen) return;
    if (l.inputs.length >= INPUT_QUEUE_MAX) return;
    l.inputs.push(event);
    const now = Date.now();
    // 10 minutes after the latest input; the row learns it at most every 30 s (the sweep's grace covers the gap).
    l.expiresAtMs = now + TAKEOVER_MS;
    l.warned = false;
    if (l.inputMarked && now - l.lastKeepMs >= KEEP_EVERY_MS) {
      l.lastKeepMs = now;
      void onKeep(v, now).catch(() => {});
    }
    if (!l.flush && !l.flushing) {
      l.flush = setTimeout(() => void flushInputs(e, l), INPUT_BATCH_MS);
      l.flush.unref();
    }
  }

  async function flushInputs(e: Entry, l: LocalLease): Promise<void> {
    l.flush = null;
    if (l.flushing) return;
    l.flushing = true;
    try {
      while (l.inputs.length && e.lease === l && !l.ending) {
        const batch = l.inputs.splice(0, INPUT_BATCH_MAX);
        if (!l.inputMarked && batch.some(entersSomething)) {
          // ADR-0029: the row learns of the holder's input before the device does, so a lease abandoned from here on
          // closes the page on any instance or sweep. Not recorded (the lease ended, the database failed): nothing of
          // it is sent (fail closed).
          const { auth } = l.viewer;
          const marked = await core.db
            .withTenant({ organizationId: auth.organizationId, userId: auth.userId }, (tx) =>
              markWorkLeaseInput(tx, { sessionId: e.sessionId, leaseId: l.leaseId, userId: auth.userId }),
            )
            .catch(() => null);
          if (!marked || e.lease !== l || l.ending) {
            l.inputs = [];
            if (!marked) log.warn({ sessionId: e.sessionId }, "work live view input not recorded, dropped");
            return;
          }
          l.inputMarked = true;
          l.lastKeepMs = Date.now();
          l.expiresAtMs = Math.max(l.expiresAtMs, Date.parse(marked.expiresAt));
          sendJson(l.viewer, leaseFrame(l));
        }
        if (!l.deviceId) {
          l.inputs = [];
          return;
        }
        // D-33: across instances this crosses Redis in transit only; never logged (the error's name at most).
        await hub
          .sendBrowserFrame(l.deviceId, {
            type: "browser.input",
            sessionId: e.sessionId,
            leaseId: l.leaseId,
            events: batch,
          })
          .catch((err: unknown) =>
            log.warn({ sessionId: e.sessionId, error: name(err) }, "work live view input not delivered"),
          );
      }
    } finally {
      l.flushing = false;
      if (l.inputs.length && e.lease === l && !l.ending && !l.flush) {
        l.flush = setTimeout(() => void flushInputs(e, l), INPUT_BATCH_MS);
        l.flush.unref();
      }
    }
  }

  /**
   * Ends this instance's lease (the holder's socket is here): written in the session's tenant without a user (a holder
   * who lost access still ends it), the device told after the commit, every instance told (ids only). Until the commit
   * the lease stays this socket's, marked `ending`: input is dropped and frames stay private. A failed write leaves the
   * row's lease to the sweep, which ends it the same way.
   */
  async function endLease(e: Entry, reason: WorkLeaseEndReason, save = false): Promise<void> {
    const l = e.lease;
    if (!l || l.ending) return;
    l.ending = true;
    l.inputs = [];
    if (l.flush) clearTimeout(l.flush);
    l.flush = null;
    const userId = l.viewer.auth.userId;
    let ended: WorkLeaseEnded | null = null;
    try {
      ended = await core.db.withTenant({ organizationId: e.orgId, userId: null }, (tx) =>
        endWorkLease(tx, core, { sessionId: e.sessionId, leaseId: l.leaseId, userId, reason, save }),
      );
    } catch (err) {
      log.warn({ sessionId: e.sessionId, error: name(err) }, "work live view lease end failed");
    }
    if (e.lease === l) e.lease = null;
    if (ended) await tellDeviceEnded(hub, ended);
    await announceLease(core.bus, e.orgId, e.sessionId);
    if (entries.get(keyOf(e.orgId, e.sessionId)) === e) refresh(e);
  }

  /** The idle end and the 9-minute warning of this instance's leases. */
  async function sweep(nowMs = Date.now()): Promise<void> {
    for (const e of [...entries.values()]) {
      const l = e.lease;
      if (!l || l.ending) continue;
      if (nowMs >= l.expiresAtMs) {
        await endLease(e, "idle");
      } else if (!l.warned && nowMs >= l.expiresAtMs - (TAKEOVER_MS - TAKEOVER_WARN_MS)) {
        l.warned = true;
        sendJson(l.viewer, leaseFrame(l));
      }
    }
  }
  const sweeper = setInterval(() => void sweep().catch(() => {}), 15_000);
  sweeper.unref();

  /** The focus hint to the holder's socket here; false when no socket here holds that lease. */
  function deliverFocus(
    organizationId: string,
    sessionId: string,
    leaseId: string,
    sensitive: boolean,
  ): boolean {
    const l = entries.get(keyOf(organizationId, sessionId))?.lease;
    if (!l || l.ending || l.leaseId !== leaseId.toLowerCase() || l.viewer.closed) return false;
    sendJson(l.viewer, { type: "focus", sensitive });
    return true;
  }

  async function onMessage(v: Viewer, raw: RawData, isBinary: boolean): Promise<void> {
    if (isBinary || v.closed) return;
    let frame: WorkLiveClientFrame;
    try {
      const parsed = WorkLiveClientFrame.safeParse(JSON.parse(String(raw)));
      // An unknown or malformed frame is dropped without an echo: nothing of it is logged.
      if (!parsed.success) return;
      frame = parsed.data;
    } catch {
      return;
    }
    switch (frame.type) {
      case "take":
        return onTake(v);
      case "keep":
        return onKeep(v);
      case "release":
        if (v.entry.lease?.viewer === v) await endLease(v.entry, "released", frame.save);
        return;
      default:
        onInput(v, frame);
    }
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
      // 07.13-18: a lease changed on another instance (or the sweep): the row is read again at once.
      core.bus.subscribe(WORK_LEASE_CHANNEL, (raw) => {
        const a = parseLeaseAnnouncement(raw);
        const e = a ? entries.get(keyOf(a.organizationId, a.sessionId)) : undefined;
        if (e) refresh(e);
      }),
      // 07.13-18: a focus hint the device's instance could not deliver (the holder's socket is elsewhere).
      core.bus.subscribe(WORK_FOCUS_CHANNEL, (raw) => {
        const f = parseFocus(raw);
        if (f) deliverFocus(f.o, f.s, f.l, f.f);
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
    // D-20: the holder's socket closed without a hand back (abandoned after input).
    if (e.lease?.viewer === v) void endLease(e, "closed");
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
      // Attached synchronously so early frames are not lost; handled in order once the first decision is known.
      let ready: Promise<void> = Promise.resolve();
      socket.on("message", (raw, isBinary) => {
        ready = ready
          .then(() => onMessage(v, raw, isBinary))
          .catch((err: unknown) =>
            log.warn({ sessionId: e.sessionId, error: name(err) }, "work live view message failed"),
          );
      });
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
          if (e.lease?.viewer === v) await endLease(e, "access_lost");
          v.closed = true;
          socket.close(LIVE_CLOSE.sessionExpired, "session expired");
          return;
        }
        redecide(v);
      }, recheckMs);
      v.recheck.unref();
      ready = (async () => {
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
        const viewer = [...e.viewers].find((v) => v.id === viewerId && !v.closed);
        if (!viewer) continue;
        if (e.lease) dropLease(e, e.lease);
        e.lease = newLease(viewer, leaseId, e.view?.deviceId ?? null, false);
        for (const v of e.viewers) pushState(v);
        return true;
      }
      return false;
    },
    clearLeaseSocket(sessionId) {
      for (const e of entries.values()) {
        if (e.sessionId !== sessionId.toLowerCase() || !e.lease) continue;
        dropLease(e, e.lease);
        for (const v of e.viewers) pushState(v);
      }
    },
    async onFocus(organizationId, frame) {
      if (deliverFocus(organizationId, frame.sessionId, frame.leaseId, frame.sensitive)) return;
      // The holder's socket may be on another instance: ids and the flag only (never a field's value or name).
      await core.bus
        .publish(
          WORK_FOCUS_CHANNEL,
          JSON.stringify({ o: organizationId, s: frame.sessionId, l: frame.leaseId, f: frame.sensitive }),
        )
        .catch(() => {});
    },
    sweep,
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
      clearInterval(sweeper);
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
