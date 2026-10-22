import { randomUUID } from "node:crypto";
import {
  ActivityStep,
  AgentCardRoute,
  AgentChannelEventTypes,
  BROWSER_LIMITS,
  type BrowserEndReason,
  decodeFrameHeader,
  FRAME_HEADER_BYTES,
  FRAME_TYPES,
  LiveClientFrame,
  type LiveInputFrame,
  type LiveServerFrame,
  type LiveStateFrame,
  type SandboxdFrameControl,
  SandboxdFrameControl as SandboxdFrameControlSchema,
} from "@ocw/contracts";
import { agents, botTurnActivity, orgMembers, sandboxPolicies, type Tx, tenantOf } from "@ocw/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { markDecided } from "../../authz";
import type { App, AuthContext, Core } from "../../core";
import type { ConversationAccess } from "../chat";
import { browserContextResource, orgResource, type PermissionService } from "../organization";
import { authenticateUpgrade, SESSION_RECHECK_MS } from "../realtime";
import { type SandboxdClient, SandboxdRefusedError } from "../sandbox";
import { auditClosed, type BrowserContextRecord, closeContext, contextById } from "./contexts";
import {
  announce,
  auditEnded,
  clearExpired,
  keep,
  LEASE_CHANNEL,
  type LeaseEndReason,
  leaseLive,
  parseAnnouncement,
  release,
  TAKEOVER_MS,
  TAKEOVER_WARN_MS,
  take,
} from "./takeover";

/**
 * The live view of a bot's browser (07.8-16; BRW-02, BRW-03; D-06, D-07, D-11 F-5, D-12 U-2; P-08, P-10).
 *
 * `GET /api/v1/live/browser/:contextId` is a dedicated binary WebSocket on the API's own origin (no WebRTC, no extra
 * port). It is opened exactly like `/ws`: an allowed Origin and the `ocw.auth.<jwt>` subprotocol, checked before the
 * upgrade (`authenticateUpgrade`). What the person may do is the resolver's alone: `browser.watch` and `browser.control`
 * on a browser-context resource (policy.ts) whose facts are the person's own `channel.read` of the conversation (the
 * readable set), the bot's owner, the requester and the member-session flag. Server → client: JSON text control frames
 * (`LiveServerFrame`) and binary JPEG frames. Client → server: JSON text `LiveClientFrame` (lease, resize, input).
 *
 * One `Hub` per API instance: one upstream `contextFrames` stream per watched context (only while at least one viewer
 * may receive frames), fanned out to viewers through a one-frame slot each (latest wins; a slow socket never buffers more
 * than the frame being written). The privacy filter decides per viewer, per frame:
 * - **takeover (F-5):** while a person holds the lease, frames go only to the socket that took it; every other viewer
 *   (the same person's other devices included) gets `state: private` (`takeover`) and no binary frame;
 * - **member session (U-2):** while a member's sealed session is loaded, the resolver lets only that member watch; the
 *   bot's owner and other readers get `state: private` (`member_session`, with the member's name) and no frame.
 *
 * Live re-authorization (ADR-0009): the gateway's invalidation bus (membership, rules, units, AI chat grants), the cell's
 * `cell.config.changed` events (the bot's switch, the organization's switch), the lease channel, a per-context poll of
 * the context row (the bot's close, a crash, holds, activity, a loaded session) and the per-socket session recheck each
 * re-decide; a viewer that lost access gets `no_permission` (or `ended`) and no frame after.
 *
 * Nothing here is persisted or logged except ids and error names: frames, input frames and typed text never reach a
 * log line, a span, the audit, a stream event or Redis (P-10; Semgrep `ocw.live-input-logging`).
 */

const SMALL = { width: BROWSER_LIMITS.frameWidth, height: BROWSER_LIMITS.frameHeight };
const EXPANDED = { width: BROWSER_LIMITS.expandedWidth, height: BROWSER_LIMITS.expandedHeight };
/** The controller's lease is written again after this much input, so the bot's view of it stays fresh. */
const KEEP_EVERY_MS = 30_000;
/** Input events queued per page at most (a stalled sandboxd drops the newest instead of growing). */
const INPUT_QUEUE_MAX = 256;
const INPUT_BATCH_MAX = 64;
const OP_TIMEOUT_MS = 15_000;
const RECONNECT_MS = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Close codes of the live-view socket (4xxx: application). */
export const LIVE_CLOSE = { ended: 1000, noPermission: 4403, sessionExpired: 4401 } as const;

/** A step of the turn's activity as the hub reads it (stored JSON: the fields it uses only). */
interface StoredStep {
  contextId?: string | null;
  outcome?: { kind?: string };
  approvalMessageRoute?: string | null;
}

export interface LiveViewDeps {
  core: Core;
  perms: PermissionService;
  access: ConversationAccess;
  client: SandboxdClient | null;
  allowedOrigins: Set<string>;
  /** The live phrase of a turn's step ("clicking “Orders” on panel.example"), from the Agent Channel's activity. */
  activityPhrase?(step: ActivityStep): string;
  /** Context row poll while watched (default 1 s). */
  pollMs?: number;
  /** Session and membership recheck of an open socket (default `SESSION_RECHECK_MS`). */
  sessionRecheckMs?: number;
  /** Lease sweep interval (default 15 s); `sweep(nowMs)` is also callable (tests). */
  sweepMs?: number;
  /**
   * 07.8-22: every viewer gets its current state again this often (default 10 s; `heartbeat()` is also callable), so a
   * client tells a dead socket (no message for 20 s) from a quiet page (a static page sends no frame).
   */
  heartbeatMs?: number;
}

/**
 * The one-frame slot of a viewer (drop-on-slow, P-08): `offer` replaces the waiting frame; the next frame is written
 * only once the previous write completed. A slow socket therefore holds at most the frame being written plus the one
 * waiting, and receives the latest frame when it catches up.
 */
export class FrameSlot {
  private pending: Uint8Array | null = null;
  private writing = false;
  sent = 0;
  dropped = 0;
  maxBuffered = 0;
  constructor(
    private readonly sink: {
      readonly bufferedAmount: number;
      open(): boolean;
      write(frame: Uint8Array, done: () => void): void;
    },
  ) {}
  offer(frame: Uint8Array): void {
    if (this.pending) this.dropped++;
    this.pending = frame;
    this.pump();
  }
  clear(): void {
    if (this.pending) this.dropped++;
    this.pending = null;
  }
  private pump(): void {
    if (this.writing || !this.pending || !this.sink.open()) return;
    const frame = this.pending;
    this.pending = null;
    this.writing = true;
    this.maxBuffered = Math.max(this.maxBuffered, this.sink.bufferedAmount);
    this.sink.write(frame, () => {
      this.writing = false;
      this.sent++;
      this.pump();
    });
  }
}

interface Decision {
  watch: boolean;
  control: boolean;
  /** Why `browser.watch` was refused on the page (`member_session`, `not_conversation_reader`, …). */
  denial: string | null;
  /** The Browser module is off for this person (`browser.watch` refused at organization scope). */
  moduleOff: boolean;
}

interface Viewer {
  id: string;
  auth: AuthContext;
  socket: WebSocket;
  watched: Watched;
  decision: Decision | null;
  slot: FrameSlot;
  /** May receive binary frames now (the privacy filter's answer). */
  frames: boolean;
  last: { viewerCan?: string; state?: string };
  mode: "small" | "expanded" | "phone";
  phone: { width: number; height: number } | null;
  closed: boolean;
  deciding: boolean;
  again: boolean;
  recheck: NodeJS.Timeout | null;
}

interface ContextView {
  row: BrowserContextRecord;
  botBrowser: boolean;
  orgEnabled: boolean;
  killed: boolean;
  activity: string | null;
  approvalRoute: string | null;
  memberName: string | null;
  controllerName: string | null;
}

interface LocalLease {
  viewer: Viewer;
  expiresAtMs: number;
  lastKeepMs: number;
  warned: boolean;
}

interface Watched {
  orgId: string;
  contextId: string;
  view: ContextView | null;
  viewers: Set<Viewer>;
  upstream: AbortController | null;
  reconnecting: boolean;
  retry: NodeJS.Timeout | null;
  poll: NodeJS.Timeout;
  refreshing: boolean;
  refreshAgain: boolean;
  lease: LocalLease | null;
  applied: string | null;
  inputs: LiveInputFrame[];
  flushing: boolean;
  /** The upstream said the page closed (or sandboxd lost it): the next refresh ends the row. */
  lost: BrowserEndReason | null;
}

export interface LiveViewStats {
  contexts: Array<{
    contextId: string;
    upstream: boolean;
    viewers: Array<{ userId: string; frames: boolean; sent: number; dropped: number; maxBuffered: number }>;
  }>;
}

export interface LiveViewHub {
  /** Ends idle leases (10 minutes without input) and warns their controller at 9 minutes. */
  sweep(nowMs?: number): Promise<void>;
  /** Sends every open viewer its current state frame again (the client's liveness signal). */
  heartbeat(): void;
  stats(): LiveViewStats;
  close(): Promise<void>;
}

const name = (err: unknown) => (err as Error | undefined)?.name ?? "Error";

/** Registers `GET /live/browser/:contextId` (mounted under `/api/v1`) and returns this instance's hub. */
export function registerLiveView(app: App, deps: LiveViewDeps): LiveViewHub {
  const { core, perms, access } = deps;
  const log = core.log;
  const pollMs = deps.pollMs ?? 1_000;
  const recheckMs = deps.sessionRecheckMs ?? SESSION_RECHECK_MS;
  const watched = new Map<string, Watched>();
  const phraseOf = (step: StoredStep) => {
    const parsed = ActivityStep.safeParse(step);
    return parsed.success && deps.activityPhrase ? deps.activityPhrase(parsed.data) || null : null;
  };

  // ---------------------------------------------------------------- shared subscriptions (lazy, once)

  let shared: Promise<Array<() => Promise<void>>> | null = null;
  const cellListeners = new Map<string, Promise<() => Promise<void>>>();
  const ensureShared = () => {
    shared ??= Promise.all([
      core.realtime.onRevocation((e) => {
        for (const w of watched.values()) {
          for (const v of w.viewers) {
            if (e.sessionIds?.includes(v.auth.sessionId) || (e.userId && e.userId === v.auth.userId)) {
              v.socket.close(LIVE_CLOSE.sessionExpired, "session revoked");
            }
          }
        }
      }),
      core.realtime.onSubscriptionInvalidation((e) => {
        for (const w of watched.values()) {
          if (w.orgId !== e.organizationId) continue;
          const topic = w.view ? `conv:${w.view.row.conversationId}` : null;
          // A topic-scoped invalidation (a membership change of one conversation) concerns only that conversation's
          // pages; an organization-wide one (rules, units, roles) concerns every page.
          if (e.topics && (!topic || !e.topics.includes(topic))) continue;
          for (const v of w.viewers) {
            if (!e.userIds || e.userIds.includes(v.auth.userId)) redecide(v);
          }
        }
      }),
      core.bus.subscribe(LEASE_CHANNEL, (raw) => {
        const a = parseAnnouncement(raw);
        const w = a ? watched.get(`${a.organizationId}:${a.contextId}`) : undefined;
        if (w) refresh(w);
      }),
    ]);
    shared.catch(() => {
      shared = null;
    });
    return shared;
  };

  /** The cell topic of an organization with watched pages: a bot's switch or the organization's settings changed. */
  const watchCell = (orgId: string) => {
    if (cellListeners.has(orgId)) return;
    const stop = core.realtime.listen(`cell:${orgId}`, (frame) => {
      if (frame.op !== "ev" || frame.type !== AgentChannelEventTypes.configChanged) return;
      for (const w of watched.values()) {
        if (w.orgId !== orgId) continue;
        refresh(w, { redecide: true });
      }
    });
    cellListeners.set(orgId, stop);
    stop.catch(() => cellListeners.delete(orgId));
  };
  const unwatchCell = async (orgId: string) => {
    if ([...watched.values()].some((w) => w.orgId === orgId)) return;
    const stop = cellListeners.get(orgId);
    cellListeners.delete(orgId);
    await (await stop?.catch(() => null))?.();
  };

  // ---------------------------------------------------------------- reading the page (system, the page's tenant)

  async function readView(
    w: Watched,
  ): Promise<{ view: ContextView | null; ended: BrowserContextRecord | null }> {
    return core.db.withTenant({ organizationId: w.orgId, userId: null }, async (tx) => {
      const ctx = await contextById(tx, w.contextId);
      if (!ctx) return { view: null, ended: null };
      const [bot] = await tx
        .select({ capabilities: agents.capabilities, status: agents.status, deletedAt: agents.deletedAt })
        .from(agents)
        .where(eq(agents.id, ctx.agentId))
        .limit(1);
      const [policy] = await tx
        .select({ enabled: sandboxPolicies.enabled, killedAt: sandboxPolicies.killedAt })
        .from(sandboxPolicies)
        .limit(1);
      const caps = (bot?.capabilities ?? {}) as Record<string, unknown>;
      const botBrowser =
        !!bot && bot.deletedAt === null && bot.status !== "disabled" && caps.browser === true;
      const orgEnabled = policy?.enabled === true;
      const killed = !!policy?.killedAt;
      let row: BrowserContextRecord = ctx;
      let ended: BrowserContextRecord | null = null;
      if (ctx.closedAt === null) {
        // A page whose browser may no longer run ends here, for every viewer at once (and in sandboxd after the commit).
        const reason: BrowserEndReason | null = killed
          ? "kill_switch"
          : !orgEnabled || !botBrowser
            ? "module_off"
            : w.lost;
        if (reason) {
          const closed = await closeContext(tx, ctx.id, reason);
          if (closed) {
            await auditClosed(tx, core, closed, reason);
            if (ctx.controllerUserId) {
              await auditEnded(
                tx,
                core,
                { ...closed, requestedFor: closed.requestedForUserId, actorUserId: null },
                reason === "kill_switch" ? "kill_switch" : "context_ended",
              );
            }
            row = closed;
            ended = closed;
          }
        } else if (ctx.controllerUserId && !leaseLive(ctx)) {
          // The holder's instance is gone and nobody released it: cleared as idle (once, conditional).
          await clearExpired(tx, core, { contextId: ctx.id });
          row = { ...ctx, controllerUserId: null, leaseExpiresAt: null };
          tenantOf(tx).afterCommit(() => takeoverOff(w));
        }
      }
      const activity = row.closedAt === null ? await activityOf(tx, row) : { phrase: null, route: null };
      const people = [row.requestedForUserId, row.controllerUserId].filter((x): x is string => !!x);
      const names = people.length
        ? await tx
            .select({ userId: orgMembers.userId, name: orgMembers.displayName })
            .from(orgMembers)
            .where(inArray(orgMembers.userId, people))
        : [];
      const nameOf = (id: string | null) => (id ? (names.find((n) => n.userId === id)?.name ?? null) : null);
      return {
        view: {
          row,
          botBrowser,
          orgEnabled,
          killed,
          activity: activity.phrase,
          approvalRoute: activity.route,
          memberName: nameOf(row.requestedForUserId),
          controllerName: nameOf(row.controllerUserId),
        },
        ended,
      };
    });
  }

  /** The bot's current step on this page (masked phrase, never typed text) and the waiting approval's permalink. */
  async function activityOf(tx: Tx, row: BrowserContextRecord) {
    const [turn] = await tx
      .select({ steps: botTurnActivity.steps, running: botTurnActivity.running })
      .from(botTurnActivity)
      .where(
        and(eq(botTurnActivity.agentId, row.agentId), eq(botTurnActivity.conversationId, row.conversationId)),
      )
      .orderBy(desc(botTurnActivity.updatedAt))
      .limit(1);
    const steps = (turn?.steps ?? []) as StoredStep[];
    const step = [...steps].reverse().find((s) => s.contextId === row.id);
    if (!turn?.running || !step) return { phrase: null, route: null };
    const route =
      step.outcome?.kind === "approval" && AgentCardRoute.safeParse(step.approvalMessageRoute).success
        ? (step.approvalMessageRoute as string)
        : null;
    const phrase = phraseOf(step);
    return { phrase: phrase ? phrase.slice(0, 80) : null, route };
  }

  /** Re-reads the page and pushes the new state to every viewer (coalesced: at most one read runs per page). */
  function refresh(w: Watched, opts: { redecide?: boolean } = {}): void {
    if (opts.redecide) for (const v of w.viewers) redecide(v);
    if (w.refreshing) {
      w.refreshAgain = true;
      return;
    }
    w.refreshing = true;
    void (async () => {
      try {
        const before = w.view;
        const { view, ended } = await readView(w);
        w.view = view;
        if (ended) await afterEnded(w, ended);
        // A loaded session changes who may watch (U-2): every viewer is decided again.
        if (!!before?.row.sessionId !== !!view?.row.sessionId) for (const v of w.viewers) redecide(v);
        reconcileLease(w);
        for (const v of w.viewers) pushState(v);
      } catch (err) {
        log.warn({ contextId: w.contextId, error: name(err) }, "live view refresh failed");
      } finally {
        w.refreshing = false;
        if (w.refreshAgain) {
          w.refreshAgain = false;
          refresh(w);
        }
      }
    })();
  }

  /** A page that ended here: sandboxd closes it too (best effort; it may already be gone). */
  async function afterEnded(w: Watched, row: BrowserContextRecord) {
    w.lease = null;
    if (!deps.client) return;
    await deps.client
      .call(
        "contextClose",
        { target: { orgId: w.orgId, agentId: row.agentId }, contextId: row.id },
        { timeoutMs: OP_TIMEOUT_MS },
      )
      .catch(() => {});
  }

  /** The local lease must match the row: another holder (or none) in the row drops it here. */
  function reconcileLease(w: Watched) {
    const row = w.view?.row;
    if (!w.lease) return;
    if (!row || row.closedAt !== null || row.controllerUserId !== w.lease.viewer.auth.userId) w.lease = null;
  }

  // ---------------------------------------------------------------- deciding one viewer (the resolver)

  async function decide(v: Viewer): Promise<Decision> {
    const { auth } = v;
    return core.db.withTenant({ organizationId: auth.organizationId, userId: auth.userId }, async (tx) => {
      const none = { watch: false, control: false, denial: "missing", moduleOff: false };
      // RLS: another organization's page does not exist here (ids resolved inside the tenant, 07.4 #169).
      const ctx = await contextById(tx, v.watched.contextId);
      if (!ctx) return none;
      const principal = { kind: "user" as const, userId: auth.userId };
      const moduleOff = !(await perms.decide(tx, principal, "browser.watch", orgResource())).allowed;
      const reader = await access.isReadable(tx, auth.userId, ctx.conversationId, {
        kinds: ["channel", "dm", "group", "ai_chat"],
      });
      const [bot] = await tx
        .select({ ownerUserId: agents.ownerUserId })
        .from(agents)
        .where(eq(agents.id, ctx.agentId))
        .limit(1);
      const resource = browserContextResource({
        reader,
        botOwner: !!bot?.ownerUserId && bot.ownerUserId === auth.userId,
        requester: ctx.requestedForUserId === auth.userId,
        memberSession: ctx.sessionId !== null,
      });
      const watch = await perms.decide(tx, principal, "browser.watch", resource);
      const control = await perms.decide(tx, principal, "browser.control", resource);
      return {
        watch: watch.allowed,
        control: control.allowed,
        denial: watch.allowed ? null : (watch.denial?.reason ?? "missing_permission"),
        moduleOff,
      };
    });
  }

  /** Decides the viewer again (coalesced) and pushes what changed; a controller who lost control hands back. */
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
        if (v.watched.lease?.viewer === v && (!d.control || d.moduleOff)) {
          await endLease(v.watched, "access_lost");
        }
        pushState(v);
      } catch (err) {
        // A failed decision is not a grant: the viewer keeps its last answer until the next one (fail closed for new).
        log.warn({ contextId: v.watched.contextId, error: name(err) }, "live view decision failed");
      } finally {
        v.deciding = false;
        if (v.again && !v.closed) {
          v.again = false;
          redecide(v);
        }
      }
    })();
  }

  // ---------------------------------------------------------------- what each viewer sees (the privacy filter)

  function stateOf(v: Viewer): { frame: LiveStateFrame; frames: boolean; close: number | null } {
    const w = v.watched;
    const d = v.decision;
    const view = w.view;
    const base = {
      type: "state" as const,
      pausedFor: null,
      activity: null,
      host: null,
      secure: null,
      controller: null,
    };
    if (!d || !view) {
      return {
        frame: { ...base, state: d ? "no_permission" : "connecting" },
        frames: false,
        close: d ? LIVE_CLOSE.noPermission : null,
      };
    }
    const row = view.row;
    if (d.moduleOff && d.denial !== "not_conversation_reader") {
      return {
        frame: { ...base, state: "ended", endReason: "module_off" },
        frames: false,
        close: LIVE_CLOSE.ended,
      };
    }
    if (!d.watch) {
      if (d.denial === "member_session") {
        // U-2: the member's page is theirs alone; the others learn who, not where.
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
      return { frame: { ...base, state: "no_permission" }, frames: false, close: LIVE_CLOSE.noPermission };
    }
    if (row.closedAt !== null) {
      return {
        frame: {
          ...base,
          state: "ended",
          endReason: row.endReason ?? "crashed",
          host: row.host,
          secure: row.secure,
        },
        frames: false,
        close: LIVE_CLOSE.ended,
      };
    }
    // 07.8-22: the requester's name travels with the page only, never to a viewer the page is withheld from.
    const page = {
      host: row.host,
      secure: row.secure,
      ...(view.memberName ? { requesterName: view.memberName.slice(0, 200) } : {}),
    };
    if (leaseLive(row)) {
      if (w.lease?.viewer === v) {
        return {
          frame: { ...base, ...page, state: "controlling", controller: "self" },
          frames: true,
          close: null,
        };
      }
      // F-5: during a takeover only the controlling socket receives frames.
      return {
        frame: {
          ...base,
          state: "private",
          privateReason: "takeover",
          controller: row.controllerUserId === v.auth.userId ? "other_device" : "other",
          ...(view.controllerName ? { memberName: view.controllerName.slice(0, 200) } : {}),
        },
        frames: false,
        close: null,
      };
    }
    if (w.reconnecting) {
      return { frame: { ...base, ...page, state: "reconnecting" }, frames: true, close: null };
    }
    if (row.pausedFor) {
      return {
        frame: {
          ...base,
          ...page,
          state: "paused",
          pausedFor: row.pausedFor,
          activity: view.activity,
          ...(view.approvalRoute ? { approvalRoute: view.approvalRoute } : {}),
        },
        frames: true,
        close: null,
      };
    }
    return {
      frame: { ...base, ...page, state: row.state === "idle" ? "idle" : "live", activity: view.activity },
      frames: true,
      close: null,
    };
  }

  function sendJson(v: Viewer, frame: LiveServerFrame): void {
    if (v.socket.readyState === v.socket.OPEN) v.socket.send(JSON.stringify(frame));
  }

  /** Sends the viewer's rights and state when they changed, applies the frame filter, then the page's upstream. */
  function pushState(v: Viewer): void {
    // Nothing before the first decision: the first frames a viewer receives are `viewerCan`, then `state`.
    if (v.closed || !v.decision) return;
    const d = v.decision;
    {
      const can = {
        type: "viewerCan" as const,
        watch: d.watch && !d.moduleOff,
        control: d.control && !d.moduleOff,
      };
      const key = JSON.stringify(can);
      if (v.last.viewerCan !== key) {
        v.last.viewerCan = key;
        sendJson(v, can);
      }
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
    syncUpstream(v.watched);
  }

  // ---------------------------------------------------------------- upstream (one per page, while someone may watch)

  function wantsUpstream(w: Watched): boolean {
    return (
      !!deps.client &&
      !!w.view &&
      w.view.row.closedAt === null &&
      [...w.viewers].some((v) => v.frames && !v.closed)
    );
  }

  function syncUpstream(w: Watched): void {
    if (wantsUpstream(w)) {
      if (!w.upstream && !w.retry) startUpstream(w);
      else applySize(w);
    } else if (w.upstream) {
      w.upstream.abort();
      w.upstream = null;
      w.applied = null;
    }
  }

  function startUpstream(w: Watched): void {
    const client = deps.client;
    const view = w.view;
    if (!client || !view) return;
    const abort = new AbortController();
    w.upstream = abort;
    const target = { orgId: w.orgId, agentId: view.row.agentId };
    void (async () => {
      let closedByPage = false;
      try {
        const body = await client.stream(
          "contextFrames",
          { orgId: target.orgId, agentId: target.agentId, contextId: w.contextId },
          { signal: abort.signal },
        );
        applySize(w);
        closedByPage = await pumpFrames(w, body, abort.signal);
      } catch (err) {
        if (abort.signal.aborted) return;
        if (err instanceof SandboxdRefusedError && err.code === "no_context") {
          // sandboxd lost the page (its restart forgot the context map): it ends cleanly, nobody reopens it blind.
          w.lost = "crashed";
        } else if (err instanceof SandboxdRefusedError && err.code === "killed") {
          w.lost = "kill_switch";
        } else {
          log.warn({ contextId: w.contextId, error: name(err) }, "live view upstream failed");
        }
      } finally {
        if (w.upstream === abort) {
          w.upstream = null;
          w.applied = null;
        }
      }
      if (abort.signal.aborted) return;
      if (closedByPage && !w.lost) w.lost = "idle";
      if (w.lost) {
        refresh(w);
        return;
      }
      // The stream ended without the page closing (a broker hiccup): reconnect while someone watches.
      w.reconnecting = true;
      for (const v of w.viewers) pushState(v);
      w.retry = setTimeout(() => {
        w.retry = null;
        if (wantsUpstream(w)) startUpstream(w);
      }, RECONNECT_MS);
      w.retry.unref();
    })();
  }

  /** Reads the framed stream; returns true when sandboxd said the page closed. */
  async function pumpFrames(w: Watched, body: ReadableStream<Uint8Array>, signal: AbortSignal) {
    const reader = body.getReader();
    signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
    let buf: Uint8Array = new Uint8Array(0);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return false;
        buf = buf.length ? concat(buf, value) : value;
        for (;;) {
          const header = decodeFrameHeader(buf);
          if (!header || buf.length < FRAME_HEADER_BYTES + header.length) break;
          const payload = buf.slice(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + header.length);
          buf = buf.slice(FRAME_HEADER_BYTES + header.length);
          if (header.type === FRAME_TYPES.jpeg) {
            if (w.reconnecting) {
              w.reconnecting = false;
              for (const v of w.viewers) pushState(v);
            }
            for (const v of w.viewers) if (v.frames && !v.closed) v.slot.offer(payload);
          } else if (onControl(w, payload)) {
            return true;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** A control message of the stream; true when the page closed. */
  function onControl(w: Watched, payload: Uint8Array): boolean {
    let msg: SandboxdFrameControl;
    try {
      const parsed = SandboxdFrameControlSchema.safeParse(JSON.parse(Buffer.from(payload).toString("utf8")));
      if (!parsed.success) return false;
      msg = parsed.data;
    } catch {
      return false;
    }
    switch (msg.kind) {
      case "closed":
        return true;
      case "focus":
        for (const v of w.viewers) {
          if (v.frames && !v.closed) sendJson(v, { type: "focus", sensitive: msg.sensitive });
        }
        return false;
      case "navigated":
        // The row's host moves through sandboxd's event feed (host only); re-read now.
        refresh(w);
        return false;
      default:
        return false;
    }
  }

  /** The size the page should have now (R10): the controller's phone, else expanded while anyone expanded, else small. */
  function desiredSize(w: Watched) {
    const lease = w.lease?.viewer;
    if (lease?.mode === "phone" && lease.phone) return { ...lease.phone, mode: "phone" as const };
    const expanded = [...w.viewers].some((v) => v.frames && !v.closed && v.mode === "expanded");
    return expanded ? { ...EXPANDED, mode: "expanded" as const } : { ...SMALL, mode: "small" as const };
  }

  function applySize(w: Watched): void {
    const client = deps.client;
    const view = w.view;
    if (!client || !view || !w.upstream) return;
    const size = desiredSize(w);
    const key = `${size.mode}:${size.width}x${size.height}`;
    if (w.applied === key) return;
    w.applied = key;
    void client
      .call(
        "contextResize",
        { target: { orgId: w.orgId, agentId: view.row.agentId }, contextId: w.contextId, ...size },
        { timeoutMs: OP_TIMEOUT_MS },
      )
      .catch((err: unknown) => {
        if (w.applied === key) w.applied = null;
        log.warn({ contextId: w.contextId, error: name(err) }, "live view resize failed");
      });
  }

  // ---------------------------------------------------------------- the lease (take, keep, release, input)

  async function takeoverIn(w: Watched, active: boolean): Promise<void> {
    const view = w.view;
    if (!deps.client || !view) throw new Error("sandboxd unavailable");
    await deps.client.call(
      "contextTakeover",
      { target: { orgId: w.orgId, agentId: view.row.agentId }, contextId: w.contextId, active },
      { timeoutMs: OP_TIMEOUT_MS },
    );
  }

  async function takeoverOff(w: Watched): Promise<void> {
    await takeoverIn(w, false).catch(() => {});
  }

  async function onTake(v: Viewer): Promise<void> {
    const w = v.watched;
    if (w.lease?.viewer === v) {
      sendJson(v, { type: "lease", expiresAt: new Date(w.lease.expiresAtMs).toISOString() });
      return;
    }
    const d = await decide(v);
    v.decision = d;
    if (!d.control || d.moduleOff) {
      sendJson(v, { type: "refused", op: "take", reason: "not_allowed" });
      pushState(v);
      return;
    }
    const { auth } = v;
    const taken = await core.db.withTenant(
      { organizationId: auth.organizationId, userId: auth.userId, sessionId: auth.sessionId },
      (tx) => take(tx, core, { contextId: w.contextId, userId: auth.userId }),
    );
    if ("refused" in taken) {
      sendJson(v, { type: "refused", op: "take", reason: taken.refused });
      refresh(w);
      return;
    }
    const now = Date.now();
    w.lease = { viewer: v, expiresAtMs: Date.parse(taken.lease.expiresAt), lastKeepMs: now, warned: false };
    try {
      await takeoverIn(w, true);
    } catch (err) {
      if (err instanceof SandboxdRefusedError && err.code === "no_context") w.lost = "crashed";
      await endLease(w, "upstream_failed");
      sendJson(v, { type: "refused", op: "take", reason: "expired" });
      return;
    }
    sendJson(v, { type: "lease", expiresAt: taken.lease.expiresAt });
    await announce(core.bus, w.orgId, w.contextId);
    refresh(w);
  }

  /** Ends this instance's lease of the page (the holder's socket is here) and tells sandboxd and every instance. */
  async function endLease(w: Watched, reason: LeaseEndReason): Promise<void> {
    const lease = w.lease;
    if (!lease) return;
    w.lease = null;
    w.inputs = [];
    const { auth } = lease.viewer;
    try {
      await core.db.withTenant({ organizationId: auth.organizationId, userId: auth.userId }, (tx) =>
        release(tx, core, { contextId: w.contextId, userId: auth.userId, reason }),
      );
    } catch (err) {
      log.warn({ contextId: w.contextId, error: name(err) }, "live view lease release failed");
    }
    await takeoverOff(w);
    await announce(core.bus, w.orgId, w.contextId);
    refresh(w);
  }

  async function onKeep(v: Viewer, nowMs = Date.now()): Promise<void> {
    const w = v.watched;
    const lease = w.lease;
    if (!lease || lease.viewer !== v) return;
    const { auth } = v;
    const kept = await core.db.withTenant(
      { organizationId: auth.organizationId, userId: auth.userId },
      (tx) => keep(tx, { contextId: w.contextId, userId: auth.userId, nowMs }),
    );
    if (!kept) {
      w.lease = null;
      refresh(w);
      return;
    }
    lease.expiresAtMs = Date.parse(kept.expiresAt);
    lease.lastKeepMs = nowMs;
    lease.warned = false;
    sendJson(v, { type: "lease", expiresAt: kept.expiresAt });
  }

  /** Input from the controller's socket only: queued and forwarded in order; anyone else's is ignored. */
  function onInput(v: Viewer, event: LiveInputFrame): void {
    const w = v.watched;
    const lease = w.lease;
    if (!lease || lease.viewer !== v || !w.view || !leaseLive(w.view.row)) return;
    if (w.inputs.length >= INPUT_QUEUE_MAX) return;
    w.inputs.push(event);
    const now = Date.now();
    if (now - lease.lastKeepMs >= KEEP_EVERY_MS) {
      lease.lastKeepMs = now;
      void onKeep(v, now).catch(() => {});
    }
    void flushInputs(w);
  }

  async function flushInputs(w: Watched): Promise<void> {
    if (w.flushing) return;
    w.flushing = true;
    try {
      while (w.inputs.length && deps.client && w.view && w.lease) {
        const events = w.inputs.splice(0, INPUT_BATCH_MAX);
        const target = { orgId: w.orgId, agentId: w.view.row.agentId };
        try {
          await deps.client.call(
            "contextInput",
            { target, contextId: w.contextId, events },
            { timeoutMs: OP_TIMEOUT_MS },
          );
        } catch (err) {
          // The error's name only: never the events (P-10).
          log.warn({ contextId: w.contextId, error: name(err) }, "live view input not delivered");
        }
      }
    } finally {
      w.flushing = false;
    }
  }

  // ---------------------------------------------------------------- the sweep (idle leases)

  async function sweep(nowMs = Date.now()): Promise<void> {
    for (const w of watched.values()) {
      const lease = w.lease;
      if (!lease) continue;
      if (nowMs >= lease.expiresAtMs) {
        await endLease(w, "idle");
      } else if (!lease.warned && nowMs >= lease.expiresAtMs - (TAKEOVER_MS - TAKEOVER_WARN_MS)) {
        lease.warned = true;
        sendJson(lease.viewer, { type: "lease", expiresAt: new Date(lease.expiresAtMs).toISOString() });
      }
    }
  }
  const sweeper = setInterval(() => void sweep().catch(() => {}), deps.sweepMs ?? 15_000);
  sweeper.unref();

  /** The liveness signal: the last state each viewer was sent, again (no new decision, nothing else). */
  function heartbeat(): void {
    for (const w of watched.values()) {
      for (const v of w.viewers) {
        if (v.closed || !v.last.state || v.socket.readyState !== v.socket.OPEN) continue;
        v.socket.send(v.last.state);
      }
    }
  }
  const beat = setInterval(heartbeat, deps.heartbeatMs ?? 10_000);
  beat.unref();

  // ---------------------------------------------------------------- the route

  function watchedFor(orgId: string, contextId: string): Watched {
    const key = `${orgId}:${contextId}`;
    let w = watched.get(key);
    if (!w) {
      const created: Watched = {
        orgId,
        contextId,
        view: null,
        viewers: new Set(),
        upstream: null,
        reconnecting: false,
        retry: null,
        poll: setInterval(() => refresh(created), pollMs),
        refreshing: false,
        refreshAgain: false,
        lease: null,
        applied: null,
        inputs: [],
        flushing: false,
        lost: null,
      };
      created.poll.unref();
      watched.set(key, created);
      watchCell(orgId);
      w = created;
    }
    return w;
  }

  async function leave(v: Viewer): Promise<void> {
    v.closed = true;
    if (v.recheck) clearInterval(v.recheck);
    const w = v.watched;
    w.viewers.delete(v);
    if (w.lease?.viewer === v) await endLease(w, "closed");
    if (w.viewers.size === 0) {
      clearInterval(w.poll);
      if (w.retry) clearTimeout(w.retry);
      w.upstream?.abort();
      w.upstream = null;
      watched.delete(`${w.orgId}:${w.contextId}`);
      await unwatchCell(w.orgId);
    } else {
      syncUpstream(w);
    }
  }

  async function onMessage(v: Viewer, raw: unknown, isBinary: boolean): Promise<void> {
    if (isBinary || v.closed) return;
    let frame: LiveClientFrame;
    try {
      const parsed = LiveClientFrame.safeParse(JSON.parse(String(raw)));
      // An unknown or malformed frame is dropped without an echo: nothing of it is logged.
      if (!parsed.success) return;
      frame = parsed.data;
    } catch {
      return;
    }
    switch (frame.type) {
      case "take":
        return onTake(v);
      case "release":
        if (v.watched.lease?.viewer === v) await endLease(v.watched, "released");
        return;
      case "keep":
        return onKeep(v);
      case "resize":
        if (frame.mode === "phone") {
          // R10: phone emulation changes the page for everyone, so only the controller asks for it.
          if (v.watched.lease?.viewer !== v || frame.width === undefined || frame.height === undefined)
            return;
          v.mode = "phone";
          v.phone = { width: frame.width, height: frame.height };
        } else {
          v.mode = frame.mode;
          v.phone = null;
        }
        applySize(v.watched);
        return;
      default:
        onInput(v, frame);
    }
  }

  app.get<{ Params: { contextId: string } }>(
    "/live/browser/:contextId",
    {
      websocket: true,
      // A person's socket: the JWT authenticates it before the upgrade; watch and control are the resolver's.
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
        const contextId = (req.params as { contextId?: string }).contextId ?? "";
        if (!UUID.test(contextId)) {
          return reply.code(404).send({ error: { code: "not_found", message: "Not found" } });
        }
        await ensureShared();
        req.auth = verdict.auth;
      },
    },
    (socket: WebSocket, req: FastifyRequest<{ Params: { contextId: string } }>) => {
      const auth = req.auth as AuthContext;
      markDecided(req);
      const w = watchedFor(auth.organizationId, req.params.contextId.toLowerCase());
      const v: Viewer = {
        id: randomUUID(),
        auth,
        socket,
        watched: w,
        decision: null,
        slot: new FrameSlot({
          get bufferedAmount() {
            return socket.bufferedAmount;
          },
          open: () => socket.readyState === socket.OPEN,
          write: (frame, done) => socket.send(frame, { binary: true }, () => done()),
        }),
        frames: false,
        last: {},
        mode: "small",
        phone: null,
        closed: false,
        deciding: false,
        again: false,
        recheck: null,
      };
      w.viewers.add(v);
      // Attached synchronously so early frames are not lost; handled once the first decision is known.
      let ready: Promise<void> = Promise.resolve();
      socket.on("message", (raw, isBinary) => {
        ready = ready
          .then(() => onMessage(v, raw, isBinary))
          .catch((err: unknown) =>
            log.warn({ contextId: w.contextId, error: name(err) }, "live view message failed"),
          );
      });
      socket.on("close", () => void leave(v));
      v.recheck = setInterval(async () => {
        const still = await Promise.all([
          core.identity.isSessionActive(auth.sessionId),
          core.identity.isMemberActive(auth.organizationId, auth.userId),
        ]).then(
          ([session, member]) => session && member,
          () => true,
        );
        if (!still) {
          if (w.lease?.viewer === v) await endLease(w, "access_lost");
          socket.close(LIVE_CLOSE.sessionExpired, "session expired");
          return;
        }
        redecide(v);
        refresh(w);
      }, recheckMs);
      v.recheck.unref();
      ready = (async () => {
        try {
          const first = w.view === null;
          v.decision = await decide(v);
          if (first || !w.view) {
            const { view, ended } = await readView(w);
            w.view = view;
            if (ended) await afterEnded(w, ended);
          }
          pushState(v);
        } catch (err) {
          log.warn({ contextId: w.contextId, error: name(err) }, "live view open failed");
          v.closed = true;
          socket.close(1011, "unavailable");
        }
      })();
    },
  );

  return {
    sweep,
    heartbeat,
    stats() {
      return {
        contexts: [...watched.values()].map((w) => ({
          contextId: w.contextId,
          upstream: w.upstream !== null,
          viewers: [...w.viewers].map((v) => ({
            userId: v.auth.userId,
            frames: v.frames,
            sent: v.slot.sent,
            dropped: v.slot.dropped,
            maxBuffered: v.slot.maxBuffered,
          })),
        })),
      };
    },
    async close() {
      clearInterval(sweeper);
      clearInterval(beat);
      for (const w of watched.values()) {
        clearInterval(w.poll);
        if (w.retry) clearTimeout(w.retry);
        w.upstream?.abort();
        for (const v of w.viewers) if (v.recheck) clearInterval(v.recheck);
      }
      watched.clear();
      const stops = await shared?.catch(() => []);
      for (const stop of stops ?? []) await stop().catch(() => {});
      for (const stop of cellListeners.values()) await (await stop.catch(() => null))?.();
      cellListeners.clear();
    },
  };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
