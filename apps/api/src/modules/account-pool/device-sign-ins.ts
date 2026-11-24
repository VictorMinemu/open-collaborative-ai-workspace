import { randomUUID } from "node:crypto";
import {
  type AccountLoginFrame,
  type AccountLoginPayload,
  type AccountLogoutPayload,
  type DeviceSignIn,
  type DeviceSignInState,
  POOL_LIMITS,
  type PoolSignInErrorCode,
  type StartDeviceSignInRequest,
} from "@ocw/contracts";
import { accountPoolAccounts, devices, type TenantCtx, type Tx, tenantOf } from "@ocw/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { conflict, HttpError, notFound } from "../../lib/errors";
import type { DeviceCommandRow, DeviceHub, DeviceRef } from "../device";
import { insertPoolAccount, type PoolAccountRow } from "./store";

/**
 * ChatGPT sign-ins on a service device (Phase 07.18, D-02, D-10, D-13, PD-11, PD-20, A-08). An admin starts one from
 * Settings: the API sends the device an `account.login` command for a new Codex slot, and the daemon runs Codex's own
 * device-code login under that slot's `CODEX_HOME`. The API only:
 *   1. sends the command and audits the start (same transaction),
 *   2. keeps the short-lived flow the admin UI shows (Redis, one per organization and device, auto-expiring, the
 *      provider-auth pattern),
 *   3. records the outcome: on success the slot becomes an enabled `device_slot` pool account of that device.
 * The user code and the verification URL live only in the Redis record and the admin GET: never on a stream (the
 * realtime signal says only that the sign-in changed), never in audit, never in a log line.
 * Frames are matched to the reporting device's own flow by its command id (E11): another device's frame finds nothing.
 */

/** The device must report a code within this window, otherwise the flow reads as `device_offline`. */
export const DEVICE_SIGN_IN_START_TIMEOUT_MS = 45_000;
/** How long a finished flow (connected / error) stays visible; longer than any active record lives. */
const END_TTL_S = Math.ceil(POOL_LIMITS.signInCodeTtlMs / 1000) + 300;
/** The ephemeral type on `org:<id>` when a device sign-in changed (payload `{ deviceId }` only). */
export const DEVICE_SIGN_IN_SIGNAL = "account_pool.sign_in.updated";

interface SignInRecord {
  /** The `account.login` command id, also the flow's id (`DeviceSignIn.id`, the frames' `requestId`). */
  id: string;
  deviceId: string;
  slotId: string;
  label: string;
  state: DeviceSignInState;
  startedAt: string;
  startedBy: string | null;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: string | null;
  error: { code: PoolSignInErrorCode; message: string } | null;
  accountId: string | null;
}

const MESSAGES: Record<PoolSignInErrorCode, string> = {
  expired: "The code expired before it was approved. Start again to get a new one.",
  denied: "The sign-in was denied in the browser.",
  cancelled: "Sign-in cancelled.",
  device_offline: "The device did not answer. Check that its OCW runtime is running and try again.",
  runtime_too_old: "Update the OCW runtime on this device first.",
  cell_offline: "The device did not answer. Check that its OCW runtime is running and try again.",
  unsupported: "Update Codex on this device and try again.",
  failed: "The sign-in failed. Try again.",
};

/** Redis keys: the device's current flow, and the final state of one flow (written once: whoever ends it). */
export const deviceSignInKey = (org: string, deviceId: string) =>
  `ocw:account-pool:sign-in:${org}:${deviceId}`;
const endKey = (org: string, flowId: string) => `ocw:account-pool:sign-in-end:${org}:${flowId}`;

/** How a daemon older than 07.18 acks a command kind it does not know. */
const OLD_DAEMON_ACK = "invalid command frame";

const isActive = (r: SignInRecord | null): r is SignInRecord =>
  r?.state === "starting" || r?.state === "pending";

/** Thrown inside a finishing transaction when another path ended the flow first (rolls the writes back). */
class AlreadyEnded extends Error {}

export function createDeviceSignIns(core: Core, hub?: DeviceHub) {
  const redis = core.bus.pub;

  const parse = (raw: string | null): SignInRecord | null => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SignInRecord;
    } catch {
      return null;
    }
  };

  /** The device's flow: its final state when it ended, else the active record. */
  async function read(org: string, deviceId: string): Promise<SignInRecord | null> {
    const flow = parse(await redis.get(deviceSignInKey(org, deviceId)));
    if (!flow) return null;
    return parse(await redis.get(endKey(org, flow.id))) ?? flow;
  }

  async function writeActive(org: string, rec: SignInRecord): Promise<void> {
    const until = Math.max(
      rec.expiresAt ? new Date(rec.expiresAt).getTime() : 0,
      new Date(rec.startedAt).getTime() + POOL_LIMITS.signInCodeTtlMs,
    );
    const ttl = Math.ceil((until - Date.now()) / 1000) + 60;
    await redis.set(deviceSignInKey(org, rec.deviceId), JSON.stringify(rec), {
      expiration: { type: "EX", value: Math.max(ttl, 60) },
    });
  }

  /** Claims the end of a flow (only the first caller wins) and stores its final state. */
  async function claimEnd(org: string, final: SignInRecord): Promise<boolean> {
    const won = await redis.set(endKey(org, final.id), JSON.stringify(final), { EX: END_TTL_S, NX: true });
    if (won !== "OK") return false;
    await redis.set(deviceSignInKey(org, final.deviceId), JSON.stringify(final), {
      expiration: { type: "EX", value: END_TTL_S },
    });
    return true;
  }

  async function notify(org: string, deviceId: string): Promise<void> {
    // Only that it changed: admins refetch the code over the authenticated GET.
    await core.realtime.publishEphemeral(`org:${org}`, DEVICE_SIGN_IN_SIGNAL, { deviceId }).catch(() => {});
  }

  /**
   * Ends a flow: the database writes and audit of `build` and the claim commit together; a flow another path ended
   * first changes nothing (false).
   */
  async function finish(
    org: string,
    rec: SignInRecord,
    build: (tx: Tx) => Promise<SignInRecord>,
    actor: TenantCtx = { organizationId: org, userId: rec.startedBy },
  ): Promise<boolean> {
    try {
      await core.db.withTenant(actor, async (tx) => {
        const final = await build(tx);
        if (!(await claimEnd(org, final))) throw new AlreadyEnded();
      });
    } catch (err) {
      if (err instanceof AlreadyEnded) return false;
      throw err;
    }
    await notify(org, rec.deviceId);
    return true;
  }

  async function fail(
    org: string,
    rec: SignInRecord,
    code: PoolSignInErrorCode,
    message = MESSAGES[code],
  ): Promise<boolean> {
    return finish(org, rec, async (tx) => {
      await core.audit.record(tx, {
        action: "account_pool.sign_in_failed",
        resourceType: "account_pool",
        result: "error",
        deviceId: rec.deviceId,
        metadata: { provider: "chatgpt", deviceId: rec.deviceId, slotId: rec.slotId, label: rec.label, code },
      });
      return {
        ...rec,
        state: "error",
        verificationUrl: null,
        userCode: null,
        expiresAt: null,
        error: { code, message },
      };
    });
  }

  /** The slot is signed in: it joins the pool as an enabled account of this device (origin admin, PD-11). */
  async function complete(org: string, rec: SignInRecord, planType: string | null): Promise<void> {
    try {
      await finish(org, rec, async (tx) => {
        const [existing] = await tx
          .select()
          .from(accountPoolAccounts)
          .where(
            and(
              eq(accountPoolAccounts.kind, "device_slot"),
              eq(accountPoolAccounts.deviceId, rec.deviceId),
              eq(accountPoolAccounts.slotId, rec.slotId),
              isNull(accountPoolAccounts.removedAt),
            ),
          );
        const row: PoolAccountRow =
          existing ??
          (await insertPoolAccount(tx, core.audit, {
            provider: "chatgpt",
            kind: "device_slot",
            label: rec.label,
            origin: "admin",
            enabled: true,
            deviceId: rec.deviceId,
            slotId: rec.slotId,
            planType,
          }));
        await core.audit.record(tx, {
          action: "account_pool.signed_in",
          resourceType: "account_pool_account",
          resourceId: row.id,
          deviceId: rec.deviceId,
          metadata: {
            provider: "chatgpt",
            deviceId: rec.deviceId,
            slotId: rec.slotId,
            label: rec.label,
            planType: row.planType,
          },
        });
        return {
          ...rec,
          state: "connected",
          verificationUrl: null,
          userCode: null,
          expiresAt: null,
          error: null,
          accountId: row.id,
        };
      });
    } catch (err) {
      // The pool filled up while the code was shown: the sign-in ends with the cap's sentence. The slot stays on the
      // device and is reported (disabled, PD-11) once the pool has room.
      if (err instanceof HttpError && err.code === "too_many_accounts") {
        await fail(org, rec, "failed", err.message.slice(0, 300));
        return;
      }
      throw err;
    }
  }

  /** Lazily ages a flow: a silent device or an unapproved code ends without any timer. */
  function aged(rec: SignInRecord, now = Date.now()): PoolSignInErrorCode | null {
    if (
      rec.state === "starting" &&
      now - new Date(rec.startedAt).getTime() > DEVICE_SIGN_IN_START_TIMEOUT_MS
    ) {
      return "device_offline";
    }
    if (rec.state === "pending" && rec.expiresAt && now > new Date(rec.expiresAt).getTime()) return "expired";
    return null;
  }

  /** The device's flow as it is now; an aged one is ended (and audited) once. */
  async function load(org: string, deviceId: string): Promise<SignInRecord | null> {
    const rec = await read(org, deviceId);
    if (!isActive(rec)) return rec;
    const code = aged(rec);
    if (code === null) return rec;
    await fail(org, rec, code);
    return read(org, deviceId);
  }

  async function toDto(org: string, rec: SignInRecord | null): Promise<DeviceSignIn | null> {
    if (!rec) return null;
    if (rec.state === "connected" && rec.accountId) {
      // A finished sign-in whose account was removed since reads as no sign-in.
      const live = await core.db.withTenant({ organizationId: org, userId: null }, (tx) =>
        tx
          .select({ id: accountPoolAccounts.id })
          .from(accountPoolAccounts)
          .where(and(eq(accountPoolAccounts.id, rec.accountId!), isNull(accountPoolAccounts.removedAt))),
      );
      if (live.length === 0) return null;
    }
    const showCode = rec.state === "pending";
    return {
      id: rec.id,
      deviceId: rec.deviceId,
      label: rec.label,
      state: rec.state,
      verificationUrl: showCode ? rec.verificationUrl : null,
      userCode: showCode ? rec.userCode : null,
      expiresAt: showCode ? rec.expiresAt : null,
      error: rec.state === "error" ? rec.error : null,
      accountId: rec.state === "connected" ? rec.accountId : null,
      startedAt: rec.startedAt,
    };
  }

  /**
   * D-10: sign-ins run only on a service device (a headless server; never a member's laptop) that is online, not
   * revoked, and runs a daemon with pool support (an older one could not keep slots apart).
   */
  function refuseDevice(d: typeof devices.$inferSelect): void {
    if (d.revokedAt !== null) {
      throw conflict("This device was removed. Pair it again to sign an account in there.", "device_offline");
    }
    if (d.hostKind !== "service") {
      throw conflict(
        "ChatGPT accounts are signed in only on a server device (the OCW runtime running as a service).",
        "not_a_service_device",
      );
    }
    if (d.accountPoolVersion === null) {
      throw conflict("Update the OCW runtime on this device first.", "not_a_service_device");
    }
    if (d.status !== "online") {
      throw conflict("This device is offline. Start its OCW runtime and try again.", "device_offline");
    }
  }

  /** The pool's and the device's caps, checked before the code is shown (the insert checks the pool's again). */
  async function refuseFullPool(tx: Tx, deviceId: string): Promise<void> {
    const live = await tx
      .select({ deviceId: accountPoolAccounts.deviceId, kind: accountPoolAccounts.kind })
      .from(accountPoolAccounts)
      .where(and(eq(accountPoolAccounts.provider, "chatgpt"), isNull(accountPoolAccounts.removedAt)));
    if (live.length >= POOL_LIMITS.accountsPerProvider) {
      throw conflict(
        `This pool already has ${POOL_LIMITS.accountsPerProvider} accounts. Remove one before adding another.`,
        "too_many_accounts",
      );
    }
    const onDevice = live.filter((r) => r.kind === "device_slot" && r.deviceId === deviceId).length;
    if (onDevice >= POOL_LIMITS.slotsPerDevice) {
      throw conflict(
        `This device already has ${POOL_LIMITS.slotsPerDevice} ChatGPT accounts. Remove one before adding another.`,
        "too_many_accounts",
      );
    }
  }

  const requireHub = (): DeviceHub => {
    if (!hub) throw new Error("device sign-ins need the device hub");
    return hub;
  };

  /**
   * Admin "Add ChatGPT account on a device": one sign-in per device at a time (a second start answers the current
   * one, no second command).
   */
  async function start(ctx: TenantCtx, body: StartDeviceSignInRequest): Promise<DeviceSignIn> {
    const org = ctx.organizationId;
    const h = requireHub();
    // An aged flow ends (audited) before a new one may start.
    await load(org, body.deviceId);
    const rec = await core.db.withTenant(ctx, async (tx) => {
      const [d] = await tx.select().from(devices).where(eq(devices.id, body.deviceId));
      if (!d) throw notFound("Device not found");
      refuseDevice(d);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`account_pool_sign_in:${org}:${d.id}`}, 0))`,
      );
      const cur = await read(org, d.id);
      if (isActive(cur) && aged(cur) === null) return cur;
      await refuseFullPool(tx, d.id);

      const id = randomUUID();
      const slotId = randomUUID();
      const payload: AccountLoginPayload = { provider: "chatgpt", slotId, label: body.label };
      await h.enqueue(tx, { id, deviceId: d.id, workSessionId: null, kind: "account.login", payload });
      await core.audit.record(tx, {
        action: "account_pool.sign_in_started",
        resourceType: "account_pool",
        deviceId: d.id,
        metadata: { provider: "chatgpt", deviceId: d.id, slotId, label: body.label },
      });
      const next: SignInRecord = {
        id,
        deviceId: d.id,
        slotId,
        label: body.label,
        state: "starting",
        startedAt: new Date().toISOString(),
        startedBy: tenantOf(tx).userId ?? null,
        verificationUrl: null,
        userCode: null,
        expiresAt: null,
        error: null,
        accountId: null,
      };
      // Written before commit, so a fast device report always finds its flow.
      await writeActive(org, next);
      tenantOf(tx).afterCommit(() => notify(org, d.id));
      return next;
    });
    return (await toDto(org, rec))!;
  }

  /** What the admin UI shows for the device (`null`: no sign-in). */
  async function status(org: string, deviceId: string): Promise<DeviceSignIn | null> {
    return toDto(org, await load(org, deviceId));
  }

  /** `account.login` progress from the device the link authenticated; another device's or a stale flow: nothing. */
  async function onAccountLogin(device: DeviceRef, frame: AccountLoginFrame): Promise<void> {
    const org = device.organizationId;
    const rec = await load(org, device.deviceId);
    if (!isActive(rec) || rec.id !== frame.requestId || rec.slotId !== frame.slotId) return;
    switch (frame.phase) {
      case "code": {
        if (!frame.verificationUrl || !frame.userCode) return;
        const cap = new Date(rec.startedAt).getTime() + POOL_LIMITS.signInCodeTtlMs;
        const reported = frame.expiresAt ? new Date(frame.expiresAt).getTime() : cap;
        await writeActive(org, {
          ...rec,
          state: "pending",
          verificationUrl: frame.verificationUrl,
          userCode: frame.userCode,
          expiresAt: new Date(Math.min(reported, cap)).toISOString(),
          error: null,
        });
        await notify(org, device.deviceId);
        return;
      }
      case "completed":
        return complete(org, rec, frame.planType?.trim().toLowerCase() || null);
      case "failed": {
        const code = frame.error?.code ?? "failed";
        // The device's own message is never shown: the sentence comes from the code (A-08: `unsupported`).
        await fail(org, rec, code === "cell_offline" ? "failed" : code);
        return;
      }
    }
  }

  /** The device's ack of its `account.login` command: ok completes a flow whose `completed` frame was missed. */
  async function onCommandResult(
    device: DeviceRef,
    command: DeviceCommandRow,
    ok: boolean,
    error: string | null,
  ): Promise<void> {
    if (command.kind !== "account.login") return;
    const org = device.organizationId;
    const rec = await load(org, device.deviceId);
    if (!isActive(rec) || rec.id !== command.id) return;
    if (ok) return complete(org, rec, null);
    // A daemon without the account commands acks them `invalid command frame` (device-link.ts CommandKind).
    await fail(org, rec, error === OLD_DAEMON_ACK ? "runtime_too_old" : "failed");
  }

  /**
   * Admin "Cancel" (PD-25): the device signs the slot out and removes it (`account.logout`); the flow reads
   * `cancelled`. Nothing running: the last flow, unchanged.
   */
  async function cancel(ctx: TenantCtx, deviceId: string): Promise<DeviceSignIn | null> {
    const org = ctx.organizationId;
    const h = requireHub();
    const rec = await load(org, deviceId);
    if (!isActive(rec)) return toDto(org, rec);
    await finish(
      org,
      rec,
      async (tx) => {
        const payload: AccountLogoutPayload = { slotId: rec.slotId };
        await h.enqueue(tx, { deviceId, workSessionId: null, kind: "account.logout", payload });
        await core.audit.record(tx, {
          action: "account_pool.sign_in_failed",
          resourceType: "account_pool",
          result: "error",
          deviceId,
          metadata: {
            provider: "chatgpt",
            deviceId,
            slotId: rec.slotId,
            label: rec.label,
            code: "cancelled",
          },
        });
        return {
          ...rec,
          state: "error",
          verificationUrl: null,
          userCode: null,
          expiresAt: null,
          error: { code: "cancelled", message: MESSAGES.cancelled },
        };
      },
      ctx,
    );
    return status(org, deviceId);
  }

  /** The slot of the device's running sign-in (the slots sync leaves it to the sign-in). */
  async function inFlightSlots(org: string, deviceId: string): Promise<ReadonlySet<string>> {
    const rec = await read(org, deviceId);
    return isActive(rec) ? new Set([rec.slotId]) : new Set();
  }

  return { start, status, cancel, onAccountLogin, onCommandResult, inFlightSlots };
}

export type DeviceSignIns = ReturnType<typeof createDeviceSignIns>;
