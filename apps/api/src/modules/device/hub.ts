import {
  type AckFrame,
  type CapabilitiesFrame,
  type CommandKind,
  type DiffResultFrame,
  DiffResultFrame as DiffResultFrameSchema,
  type EventFrame,
  EventTypes,
  type HelloFrame,
  type ServerToDeviceFrame,
} from "@ocw/contracts";
import { deviceCommands, devices, type TenantDb, type Tx, tenantOf } from "@ocw/db";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import type { RedisBus } from "../../lib/redis";
import type { RealtimeService } from "../realtime";

/** The authenticated device behind a Device Link socket (from the bearer token lookup). */
export interface DeviceRef {
  deviceId: string;
  organizationId: string;
  ownerUserId: string;
}

export type DeviceCommandRow = typeof deviceCommands.$inferSelect;

/**
 * Implemented by the work-session module (registered with `hub.setSessionHandler`). Called sequentially per
 * device socket, in frame order.
 */
export interface DeviceSessionHandler {
  /** A device said hello: reconcile its sessions with `hello.sessions` (the ones alive on the device). */
  onHello(device: DeviceRef, hello: HelloFrame): Promise<void>;
  /** The device stayed disconnected past the grace period. */
  onOffline(device: DeviceRef): Promise<void>;
  onEvent(device: DeviceRef, frame: EventFrame): Promise<void>;
  onCommandResult(
    device: DeviceRef,
    command: DeviceCommandRow,
    ok: boolean,
    error: string | null,
  ): Promise<void>;
  /** A `diff.result` for a session's `diff.request` (also relayed to any waiting requester). */
  onDiffResult(device: DeviceRef, workSessionId: string, frame: DiffResultFrame): Promise<void>;
}

export interface EnqueueCommand {
  /** Pre-generated id (e.g. to subscribe to a diff result before the command is delivered). */
  id?: string;
  deviceId: string;
  workSessionId: string | null;
  kind: CommandKind;
  payload: Record<string, unknown>;
}

interface LocalLink {
  device: DeviceRef;
  socket: WebSocket;
  /** Serializes command delivery for this device. */
  sending: Promise<void>;
  stopListening: () => Promise<void>;
}

const deviceChannel = (deviceId: string) => `ocw:device:${deviceId}`;
const diffChannel = (requestId: string) => `ocw:diff:${requestId}`;

type ControlMessage = { op: "flush" } | { op: "close"; code: number; reason: string };

export interface DeviceHubOptions {
  db: TenantDb;
  bus: RedisBus;
  realtime: RealtimeService;
  log: FastifyBaseLogger;
  /** How long a device may stay disconnected before it is marked offline (default 10 s). */
  offlineGraceMs?: number;
}

/**
 * Device Link hub: owns the live device sockets of this API instance, the persistent command queue
 * (at-least-once, redelivered in order on reconnect) and presence (online/offline with a grace period).
 * Cross-instance delivery goes through Redis: enqueue → after commit publish `flush` on the device channel →
 * whichever instance holds the socket sends the pending commands.
 */
export class DeviceHub {
  private readonly links = new Map<string, LocalLink>();
  private readonly offlineTimers = new Map<string, NodeJS.Timeout>();
  private handler: DeviceSessionHandler | null = null;
  readonly offlineGraceMs: number;

  constructor(private readonly opts: DeviceHubOptions) {
    this.offlineGraceMs = opts.offlineGraceMs ?? 10_000;
  }

  setSessionHandler(handler: DeviceSessionHandler): void {
    this.handler = handler;
  }

  get sessionHandler(): DeviceSessionHandler | null {
    return this.handler;
  }

  /** Persist a command in the caller's transaction; it is delivered after COMMIT. Returns its id. */
  async enqueue(tx: Tx, cmd: EnqueueCommand): Promise<string> {
    const ctx = tenantOf(tx);
    const [row] = await tx
      .insert(deviceCommands)
      .values({
        ...(cmd.id ? { id: cmd.id } : {}),
        organizationId: ctx.organizationId,
        deviceId: cmd.deviceId,
        workSessionId: cmd.workSessionId,
        kind: cmd.kind,
        payload: cmd.payload,
      })
      .returning({ id: deviceCommands.id });
    ctx.afterCommit(() => this.requestFlush(cmd.deviceId));
    return row!.id;
  }

  /** Ask the instance holding the device socket (maybe this one) to send pending commands. */
  async requestFlush(deviceId: string): Promise<void> {
    if (this.links.has(deviceId)) return this.flush(deviceId, false);
    await this.publishControl(deviceId, { op: "flush" });
  }

  /** Close the device's socket wherever it is connected (revocation). */
  async disconnect(deviceId: string, code: number, reason: string): Promise<void> {
    const local = this.links.get(deviceId);
    if (local) local.socket.close(code, reason);
    else await this.publishControl(deviceId, { op: "close", code, reason });
  }

  /** Wait for the `diff.result` answering command `requestId` (published by whichever instance got it). */
  async waitForDiff(requestId: string, timeoutMs: number): Promise<DiffResultFrame | null> {
    let stop: (() => Promise<void>) | null = null;
    try {
      return await new Promise<DiffResultFrame | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), timeoutMs);
        void this.opts.bus
          .subscribe(diffChannel(requestId), (msg) => {
            const parsed = DiffResultFrameSchema.safeParse(JSON.parse(msg));
            if (!parsed.success) return;
            clearTimeout(timer);
            resolve(parsed.data);
          })
          .then((unsub) => {
            stop = unsub;
          });
      });
    } finally {
      await (stop as (() => Promise<void>) | null)?.();
    }
  }

  isConnectedHere(deviceId: string): boolean {
    return this.links.has(deviceId);
  }

  // ------------------------------------------------------------------ link lifecycle (used by link.ts)

  /** Register a socket after a valid hello. Replaces (closes) an older socket of the same device. */
  async attach(device: DeviceRef, socket: WebSocket, hello: HelloFrame): Promise<void> {
    const timer = this.offlineTimers.get(device.deviceId);
    if (timer) clearTimeout(timer);
    this.offlineTimers.delete(device.deviceId);

    const previous = this.links.get(device.deviceId);
    if (previous && previous.socket !== socket) {
      this.links.delete(device.deviceId);
      await previous.stopListening().catch(() => {});
      previous.socket.close(4409, "replaced by a newer connection");
    }

    const link: LocalLink = { device, socket, sending: Promise.resolve(), stopListening: async () => {} };
    this.links.set(device.deviceId, link);
    link.stopListening = await this.opts.bus.subscribe(deviceChannel(device.deviceId), (msg) => {
      if (this.links.get(device.deviceId) !== link) return;
      let control: ControlMessage;
      try {
        control = JSON.parse(msg) as ControlMessage;
      } catch {
        return;
      }
      if (control.op === "flush") void this.flush(device.deviceId, false);
      else if (control.op === "close") socket.close(control.code, control.reason);
    });

    const runtimes = hello.runtimes;
    await this.opts.db.withTenant({ organizationId: device.organizationId, userId: null }, async (tx) => {
      const [before] = await tx
        .select({ status: devices.status })
        .from(devices)
        .where(eq(devices.id, device.deviceId));
      await tx
        .update(devices)
        .set({
          status: "online",
          lastSeenAt: sql`now()`,
          runtimeInfo: runtimes,
          daemonVersion: hello.device.daemonVersion ?? hello.device.appVersion ?? null,
          platform: hello.device.platform,
          // ADR-0012: only the device itself reports its owner's local opt-in (absent = off, older daemons).
          fullAccessOptIn: hello.fullAccessOptIn ?? false,
        })
        .where(eq(devices.id, device.deviceId));
      await this.opts.realtime.appendEvent(tx, `org:${device.organizationId}`, EventTypes.deviceUpdated, {
        deviceId: device.deviceId,
        status: "online",
        changed: before?.status !== "online",
      });
    });
    this.send(socket, { type: "welcome", deviceId: device.deviceId, organizationId: device.organizationId });
    await this.handler?.onHello(device, hello);
    // Redeliver everything not acked yet (at-least-once), then anything new.
    await this.flush(device.deviceId, true);
  }

  /** Socket closed: start the grace timer; mark offline only if the device did not come back. */
  detach(device: DeviceRef, socket: WebSocket): void {
    const link = this.links.get(device.deviceId);
    if (!link || link.socket !== socket) return;
    this.links.delete(device.deviceId);
    void link.stopListening().catch(() => {});
    const disconnectedAt = new Date();
    const timer = setTimeout(() => {
      this.offlineTimers.delete(device.deviceId);
      void this.markOffline(device, disconnectedAt).catch((err) =>
        this.opts.log.error({ err }, "device offline transition failed"),
      );
    }, this.offlineGraceMs);
    timer.unref();
    this.offlineTimers.set(device.deviceId, timer);
  }

  async touch(device: DeviceRef): Promise<void> {
    await this.opts.db.withTenant({ organizationId: device.organizationId, userId: null }, (tx) =>
      tx.update(devices).set({ lastSeenAt: sql`now()` }).where(eq(devices.id, device.deviceId)),
    );
  }

  /**
   * P-05: store what the device's runtimes offer and its owner's local full-access opt-in. Written only from the
   * authenticated device socket; no user route can set either column (T-03.2-01-07).
   */
  async onCapabilities(device: DeviceRef, frame: CapabilitiesFrame): Promise<void> {
    await this.opts.db.withTenant({ organizationId: device.organizationId, userId: null }, async (tx) => {
      const rows = await tx
        .update(devices)
        .set({ runtimeCatalog: frame.catalogs, fullAccessOptIn: frame.fullAccessOptIn })
        .where(eq(devices.id, device.deviceId))
        .returning({ status: devices.status });
      if (rows.length === 0) return;
      await this.opts.realtime.appendEvent(tx, `org:${device.organizationId}`, EventTypes.deviceUpdated, {
        deviceId: device.deviceId,
        status: rows[0]!.status,
        changed: true,
      });
    });
  }

  async onAck(device: DeviceRef, frame: AckFrame): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(frame.commandId)) return;
    const ok = frame.ok !== false;
    const error = ok ? null : (frame.error ?? "command failed").slice(0, 2000);
    const row = await this.opts.db.withTenant(
      { organizationId: device.organizationId, userId: null },
      async (tx) => {
        const [updated] = await tx
          .update(deviceCommands)
          .set({ status: ok ? "acked" : "failed", error, ackedAt: sql`now()` })
          .where(
            and(
              eq(deviceCommands.id, frame.commandId),
              eq(deviceCommands.deviceId, device.deviceId),
              inArray(deviceCommands.status, ["pending", "sent"]),
            ),
          )
          .returning();
        return updated ?? null;
      },
    );
    // A repeated ack (redelivered command the daemon had already executed) changes nothing.
    if (row) await this.handler?.onCommandResult(device, row, ok, error);
  }

  async onDiffResult(device: DeviceRef, frame: DiffResultFrame): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(frame.requestId)) return;
    // Only relay answers to commands this device was actually asked for.
    const [cmd] = await this.opts.db.withTenant(
      { organizationId: device.organizationId, userId: null },
      (tx) =>
        tx
          .select({ id: deviceCommands.id, workSessionId: deviceCommands.workSessionId })
          .from(deviceCommands)
          .where(
            and(
              eq(deviceCommands.id, frame.requestId),
              eq(deviceCommands.deviceId, device.deviceId),
              eq(deviceCommands.kind, "diff.request"),
            ),
          ),
    );
    if (!cmd) return;
    await this.opts.bus.publish(diffChannel(frame.requestId), JSON.stringify(frame));
    if (cmd.workSessionId) await this.handler?.onDiffResult(device, cmd.workSessionId, frame);
  }

  async closeAll(): Promise<void> {
    for (const t of this.offlineTimers.values()) clearTimeout(t);
    this.offlineTimers.clear();
    for (const link of this.links.values()) {
      await link.stopListening().catch(() => {});
      link.socket.close(1012, "server restarting");
    }
    this.links.clear();
  }

  // ------------------------------------------------------------------ internals

  private send(socket: WebSocket, frame: ServerToDeviceFrame): boolean {
    if (socket.readyState !== socket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  private async publishControl(deviceId: string, msg: ControlMessage): Promise<void> {
    await this.opts.bus.publish(deviceChannel(deviceId), JSON.stringify(msg));
  }

  /** Send pending (and, on reconnect, already-sent but unacked) commands in creation order. */
  private flush(deviceId: string, includeSent: boolean): Promise<void> {
    const link = this.links.get(deviceId);
    if (!link) return Promise.resolve();
    const run = async () => {
      if (this.links.get(deviceId) !== link) return;
      const { device, socket } = link;
      await this.opts.db.withTenant({ organizationId: device.organizationId, userId: null }, async (tx) => {
        const rows = await tx
          .select()
          .from(deviceCommands)
          .where(
            and(
              eq(deviceCommands.deviceId, deviceId),
              inArray(deviceCommands.status, includeSent ? ["pending", "sent"] : ["pending"]),
            ),
          )
          .orderBy(asc(deviceCommands.createdAt), asc(deviceCommands.id))
          .limit(500);
        const sent: string[] = [];
        for (const row of rows) {
          const ok = this.send(socket, {
            type: "command",
            id: row.id,
            kind: row.kind,
            sessionId: row.workSessionId ?? "00000000-0000-0000-0000-000000000000",
            payload: row.payload,
          });
          if (!ok) break;
          sent.push(row.id);
        }
        if (sent.length > 0) {
          await tx
            .update(deviceCommands)
            .set({ status: "sent", sentAt: sql`now()` })
            .where(and(inArray(deviceCommands.id, sent), eq(deviceCommands.status, "pending")));
        }
      });
    };
    link.sending = link.sending.then(run, run).catch((err) => {
      this.opts.log.error({ err }, "device command flush failed");
    });
    return link.sending;
  }

  private async markOffline(device: DeviceRef, disconnectedAt: Date): Promise<void> {
    if (this.links.has(device.deviceId)) return;
    const changed = await this.opts.db.withTenant(
      { organizationId: device.organizationId, userId: null },
      async (tx) => {
        const rows = await tx
          .update(devices)
          .set({ status: "offline" })
          .where(
            and(
              eq(devices.id, device.deviceId),
              eq(devices.status, "online"),
              // Reconnected to another instance meanwhile (hello bumps last_seen_at): stay online.
              lt(devices.lastSeenAt, disconnectedAt.toISOString()),
            ),
          )
          .returning({ id: devices.id });
        if (rows.length > 0) {
          await this.opts.realtime.appendEvent(tx, `org:${device.organizationId}`, EventTypes.deviceUpdated, {
            deviceId: device.deviceId,
            status: "offline",
            changed: true,
          });
        }
        return rows.length > 0;
      },
    );
    if (changed) await this.handler?.onOffline(device);
  }
}
