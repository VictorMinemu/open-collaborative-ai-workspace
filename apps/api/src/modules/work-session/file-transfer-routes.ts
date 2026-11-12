import { posix } from "node:path";
import { pipeline, type Readable } from "node:stream";
import {
  BOT_FILE_LIMITS,
  Id,
  RUNTIME_FILE_LAND_WITHIN_HEADER,
  type RuntimeFilePutAnswer,
  SessionFileReadPayload,
  transferLandMarginMs,
} from "@ocw/contracts";
import { attachments, deviceCommands, messages } from "@ocw/db";
import { and, eq, isNull, or } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { App, Core } from "../../core";
import { gone, HttpError, notFound } from "../../lib/errors";
import {
  attachmentKey,
  type ObjectStorage,
  recordServerAttachment,
  streamServerAttachment,
} from "../artifact";
import { authenticateDeviceJwt, bearerValue, type DeviceRef, looksLikeJwt } from "../device";
import { createPermissionService } from "../organization";
import {
  claimTransferForDevice,
  markTransfer,
  readTransferForDevice,
  type TransferRow,
  transferTimes,
} from "./bot-files";
import { createTransferSlots, guardTransferStream } from "./transfer-slots";

const TransferParams = z.object({ transferId: Id });

/** Answers that never consume the row: the device's retry, or another device, still finds it as it was. */
const busy = () => new HttpError(503, "busy", "The server is moving as many files as it may; retry shortly");
const storageUnavailable = () =>
  new HttpError(503, "storage_unavailable", "File storage is not set up on this server");
const lengthRequired = () => new HttpError(411, "length_required", "Send the file with its content-length");
const tooLarge = () => new HttpError(413, "too_large", "The file is larger than this transfer allows");
const transferFailed = () => new HttpError(502, "transfer_failed", "The file could not be stored");

/** A declared `content-length` as a byte count, or null when absent or not a plain non-negative integer. */
function declaredLength(header: string | undefined): number | null {
  if (header === undefined || !/^\d{1,16}$/u.test(header)) return null;
  const n = Number(header);
  return Number.isSafeInteger(n) ? n : null;
}

/** The device JWT check both routes share (07.17.1.1 PD-05): a JWT only, never the long-lived device token. */
function deviceJwtOnly(core: Core, perms: ReturnType<typeof createPermissionService>) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearerValue(req.headers);
    const found = token && looksLikeJwt(token) ? await authenticateDeviceJwt(core, perms, req, token) : null;
    if (!found) {
      req.device = undefined;
      return reply.code(401).send({ error: { code: "unauthorized", message: "Invalid device token" } });
    }
  };
}

/**
 * The device side of a bot's file move (07.17.1.1 D-02, D-08, PD-05; ADR-0015: the API is the only ACL, no presigned
 * URL is ever handed to a device). `GET /api/v1/runtime/files/:transferId` streams the source attachment of a
 * `to_device` transfer to the device the transfer names, once:
 * - `onRequest`: a device JWT only (`authenticateDeviceJwt`: not revoked, `device.link` decided); a legacy raw device
 *   token, a user JWT or nothing → 401;
 * - the stream counter full → 503 `busy`; no object storage → 503 `storage_unavailable` (neither touches the row);
 * - then, in a tenant transaction of the device's organization without a user, the claim (`pending` → `streaming`
 *   under `FOR UPDATE`): absent (another organization's under RLS), another device's or a `from_device` row → 404;
 *   not `pending` or past `expires_at` → 410; a source attachment no longer `ready` → the row `failed` `not_found`, 410;
 * - less than `transferLandMarginMs` left before `expires_at` → the row `failed` `timeout`, 410 (review WR-01);
 * - the bytes of `original`, `content-length` = the row's `size_bytes`, `cache-control: no-store` and
 *   `RUNTIME_FILE_LAND_WITHIN_HEADER` (the time the device may still land the file); the row `streamed` when the last
 *   byte is written, `failed` `transfer_failed` when the stream breaks or is cut (at that landing deadline, or after
 *   `transferIdleMs` without progress: review WR-01).
 *
 * `PUT /api/v1/runtime/files/:transferId` (07.17.1.1-08, D-03, PD-17) takes one session file of a `from_device`
 * transfer into its pre-allocated attachment id, never holding it whole:
 * - the same JWT check; the stream counter full → 503 `busy`; no or a malformed `content-length` → 411
 *   `length_required`; no storage → 503 (none of these touches the row, and the connection closes unread);
 * - the row read without a lock: 404 / 410 as for GET; a declared length above `max_bytes` → the row `failed`
 *   `too_large` with that size and 413, before a byte is read (the file is too big; the transfer is over);
 * - the claim, the command's own path (`device_commands`, same id and device), then the body streamed to storage in
 *   parts while it is hashed, sniffed and counted (`streamServerAttachment`, bounded by the declared length); a
 *   body of another length, or any failure, removes the object and fails the row `transfer_failed`; the body is cut at
 *   `expires_at` or after `transferIdleMs` without a byte, and one that ends after `expires_at` never lands (review
 *   WR-01);
 * - in one tenant transaction the row `streamed` (only from `streaming`) with its size and sha256, and the attachment
 *   `pending`, uploaded by the bot, of the turn, named `sanitizeFilename(basename(path))`; the answer is
 *   `RuntimeFilePutAnswer`.
 * Logs carry the transfer id, the device id and a code only: never a path, a file name or a byte (P1).
 */
export function registerFileTransferRoutes(
  app: App,
  core: Core,
  deps: { storage: ObjectStorage | null; idleMs?: number },
): void {
  const perms = createPermissionService(core);
  const deviceOnly = deviceJwtOnly(core, perms);
  /**
   * Streams this app serves at once (07.17.1.1 PD-05): at most `BOT_FILE_LIMITS.concurrentTransfersPerProcess`, and at
   * most `concurrentTransfersPerOrganization` of them for one organization (review WR-01). One set per app (review
   * IN-11). A request beyond that answers 503 `busy` BEFORE its row is claimed, so the row stays `pending` and the
   * daemon's retry (1 s, then 3 s) streams it. A slot is reserved before the claim and released when the stream ends
   * (or the request is refused), so two requests never both pass a check at three.
   */
  const slots = createTransferSlots();
  const idleMs = deps.idleMs ?? BOT_FILE_LIMITS.transferIdleMs;

  /** Record how a claimed transfer's stream ended; a row the deadline sweep already closed is left alone. */
  async function settle(
    device: DeviceRef,
    row: TransferRow,
    ok: boolean,
    log: FastifyBaseLogger,
  ): Promise<void> {
    const code = ok ? "streamed" : "transfer_failed";
    try {
      await core.db.withTenant({ organizationId: device.organizationId, userId: null }, (tx) =>
        markTransfer(
          tx,
          row.id,
          ok
            ? { status: "streamed" }
            : { status: "failed", failure: "transfer_failed", completedAt: new Date().toISOString() },
          { from: ["streaming"] },
        ),
      );
      log.info({ transferId: row.id, deviceId: device.deviceId, code }, "file transfer ended");
    } catch (err) {
      log.warn(
        { err, transferId: row.id, deviceId: device.deviceId, code },
        "could not record a file transfer",
      );
    }
  }

  app.register(async (scope) => {
    scope.get(
      "/runtime/files/:transferId",
      {
        config: { authz: "device" },
        // A HEAD twin would run the handler and spend the single-use row.
        exposeHeadRoute: false,
        schema: { hide: true, params: TransferParams },
        // A JWT only: the long-lived device token is exchanged at `POST /devices/token`, never accepted here.
        onRequest: deviceOnly,
      },
      async (req, reply) => {
        const device = req.device as DeviceRef;
        const { transferId } = TransferParams.parse(req.params);
        const log = req.log;
        // Refusals that are not about the transfer come first: they never consume the row (PD-05).
        const release = slots.take(device.organizationId);
        if (!release) {
          log.info({ transferId, deviceId: device.deviceId, code: "busy" }, "file transfer refused");
          throw busy();
        }
        const storage = deps.storage;
        if (!storage) {
          release();
          throw storageUnavailable();
        }
        let handedOff = false;
        try {
          const claimed = await core.db.withTenant(
            { organizationId: device.organizationId, userId: null },
            async (tx) => {
              const row = await claimTransferForDevice(tx, {
                id: transferId,
                deviceId: device.deviceId,
                direction: "to_device",
              });
              if (row === null || row === "gone") return row;
              // Review WR-01: the bytes must reach the device a margin before the deadline, so it lands the file and
              // acks before the API gives up. Less than that left: the transfer is over.
              const times = await transferTimes(tx, row.id);
              const landWithinMs = times.remainingMs - transferLandMarginMs(times.totalMs);
              if (landWithinMs <= 0) {
                await markTransfer(tx, row.id, {
                  status: "failed",
                  failure: "timeout",
                  completedAt: new Date().toISOString(),
                });
                return "late" as const;
              }
              // The person may have deleted the file, or its message, since the bot asked: its bytes no longer leave
              // storage. A tombstone decides, whatever the file's own status says (07.15 rule, review IN-02).
              const [source] = await tx
                .select({ id: attachments.id })
                .from(attachments)
                .leftJoin(messages, eq(messages.id, attachments.messageId))
                .where(
                  and(
                    eq(attachments.id, row.attachmentId),
                    eq(attachments.conversationId, row.conversationId),
                    eq(attachments.status, "ready"),
                    or(isNull(attachments.messageId), isNull(messages.deletedAt)),
                  ),
                )
                .limit(1);
              if (!source) {
                await markTransfer(tx, row.id, {
                  status: "failed",
                  failure: "not_found",
                  completedAt: new Date().toISOString(),
                });
                return "source_gone" as const;
              }
              return { row, landWithinMs };
            },
          );
          if (claimed === null) {
            log.info({ transferId, deviceId: device.deviceId, code: "not_found" }, "file transfer refused");
            throw notFound("Transfer not found");
          }
          if (claimed === "gone" || claimed === "source_gone" || claimed === "late") {
            log.info({ transferId, deviceId: device.deviceId, code: claimed }, "file transfer refused");
            throw gone("This transfer is over");
          }
          const { row: claimedRow, landWithinMs } = claimed;

          let source: Awaited<ReturnType<ObjectStorage["stream"]>>;
          try {
            source = await storage.stream(
              attachmentKey(
                device.organizationId,
                claimedRow.conversationId,
                claimedRow.attachmentId,
                "original",
              ),
            );
          } catch {
            await settle(device, claimedRow, false, log);
            throw new HttpError(502, "transfer_failed", "The file could not be read from storage");
          }

          let ended = false;
          // Review WR-01: the stream's own deadline (the landing deadline) and idle cut; either frees the slot.
          const guard = guardTransferStream({
            deadlineMs: landWithinMs,
            idleMs,
            onExpire: () => {
              log.info({ transferId, deviceId: device.deviceId, code: "cut" }, "file transfer cut");
              source.destroy();
              reply.raw.destroy();
            },
          });
          const end = (ok: boolean) => {
            if (ended) return;
            ended = true;
            guard.clear();
            release();
            void settle(device, claimedRow, ok, log);
          };
          reply.raw.once("finish", () => end(true));
          reply.raw.once("close", () => end(reply.raw.writableFinished));
          source.once("error", (err) => {
            guard.meter.destroy(err);
            end(false);
          });
          handedOff = true;
          log.info({ transferId, deviceId: device.deviceId, code: "streaming" }, "file transfer started");
          reply
            .header("content-type", "application/octet-stream")
            .header("cache-control", "no-store")
            .header(RUNTIME_FILE_LAND_WITHIN_HEADER, String(landWithinMs));
          // The enqueue records the source's size on every `to_device` row; the device checks it against the payload.
          if (claimedRow.sizeBytes !== null) reply.header("content-length", String(claimedRow.sizeBytes));
          return reply.send(source.pipe(guard.meter));
        } finally {
          if (!handedOff) release();
        }
      },
    );

    // The PUT body is the raw request stream, read by the route as it is stored (never buffered whole: up to 1 GiB).
    // Only in this scope; a parser an outer scope registered for the type (buffered) does not apply here.
    if (scope.hasContentTypeParser("application/octet-stream"))
      scope.removeContentTypeParser("application/octet-stream");
    scope.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

    scope.put(
      "/runtime/files/:transferId",
      {
        config: { authz: "device" },
        bodyLimit: BOT_FILE_LIMITS.ceilingMaxBytes,
        schema: { hide: true, params: TransferParams },
        onRequest: deviceOnly,
      },
      async (req, reply): Promise<RuntimeFilePutAnswer> => {
        const device = req.device as DeviceRef;
        const { transferId } = TransferParams.parse(req.params);
        const log = req.log;
        const tenant = { organizationId: device.organizationId, userId: null };
        const refuse = (code: string, err: HttpError) => {
          log.info({ transferId, deviceId: device.deviceId, code }, "file transfer refused");
          // A refused upload's body is never read: the connection closes instead of draining it.
          reply.header("connection", "close");
          return err;
        };
        // Refusals that are not about the file come first: they never consume the row (PD-05).
        const release = slots.take(device.organizationId);
        if (!release) throw refuse("busy", busy());
        let guard: ReturnType<typeof guardTransferStream> | null = null;
        try {
          const declared = declaredLength(req.headers["content-length"]);
          if (declared === null) throw refuse("length_required", lengthRequired());
          const storage = deps.storage;
          if (!storage) throw refuse("storage_unavailable", storageUnavailable());
          const found = await core.db.withTenant(tenant, (tx) =>
            readTransferForDevice(tx, {
              id: transferId,
              deviceId: device.deviceId,
              direction: "from_device",
            }),
          );
          if (found === null) throw refuse("not_found", notFound("Transfer not found"));
          if (found === "gone") throw refuse("gone", gone("This transfer is over"));
          if (declared > found.maxBytes) {
            // The file itself is too big: the transfer is over, before a byte is read.
            await core.db.withTenant(tenant, (tx) =>
              markTransfer(
                tx,
                found.id,
                {
                  status: "failed",
                  failure: "too_large",
                  sizeBytes: declared,
                  completedAt: new Date().toISOString(),
                },
                { from: ["pending"] },
              ),
            );
            throw refuse("too_large", tooLarge());
          }

          const claimed = await core.db.withTenant(tenant, async (tx) => {
            const row = await claimTransferForDevice(tx, {
              id: transferId,
              deviceId: device.deviceId,
              direction: "from_device",
            });
            if (row === null || row === "gone") return row;
            // The file's name comes from the command the device was given (same id, same device), never the ledger.
            const [command] = await tx
              .select({ payload: deviceCommands.payload })
              .from(deviceCommands)
              .where(
                and(
                  eq(deviceCommands.id, row.id),
                  eq(deviceCommands.deviceId, device.deviceId),
                  eq(deviceCommands.kind, "session.file.read"),
                ),
              )
              .limit(1);
            const payload = SessionFileReadPayload.safeParse(command?.payload);
            if (!payload.success) {
              await markTransfer(tx, row.id, {
                status: "failed",
                failure: "transfer_failed",
                completedAt: new Date().toISOString(),
              });
              return "no_command" as const;
            }
            const { remainingMs } = await transferTimes(tx, row.id);
            return { row, path: payload.data.path, remainingMs };
          });
          if (claimed === null) throw refuse("not_found", notFound("Transfer not found"));
          if (claimed === "gone") throw refuse("gone", gone("This transfer is over"));
          if (claimed === "no_command") throw refuse("no_command", transferFailed());

          const { row, path, remainingMs } = claimed;
          const key = attachmentKey(device.organizationId, row.conversationId, row.attachmentId, "original");
          log.info({ transferId, deviceId: device.deviceId, code: "streaming" }, "file transfer started");
          // The raw request stream (the parser above), or the request itself when no body was parsed (empty).
          const raw = (req.body as Readable | undefined) ?? req.raw;
          // Review WR-01: the body is cut at the transfer's deadline, or after the idle time without a byte.
          const cut = guardTransferStream({
            deadlineMs: remainingMs,
            idleMs,
            onExpire: () => {
              log.info({ transferId, deviceId: device.deviceId, code: "cut" }, "file transfer cut");
              cut.meter.destroy(new Error("the transfer's deadline passed"));
              req.raw.destroy();
            },
          });
          guard = cut;
          pipeline(raw, cut.meter, () => undefined);
          let sizeBytes: number;
          try {
            const stored = await streamServerAttachment(storage, {
              organizationId: device.organizationId,
              conversationId: row.conversationId,
              attachmentId: row.attachmentId,
              body: cut.meter,
              // Counted as it streams: never more than the device declared (itself at most the row's bound).
              maxBytes: declared,
            });
            if (stored.sizeBytes !== declared) throw new Error("the body is shorter than its content-length");
            sizeBytes = stored.sizeBytes;
            const recorded = await core.db.withTenant(tenant, async (tx) => {
              // Review WR-01: a body that ended after the deadline never lands, even before the sweep ran.
              if ((await transferTimes(tx, row.id)).remainingMs <= 0) {
                await markTransfer(
                  tx,
                  row.id,
                  { status: "failed", failure: "timeout", completedAt: new Date().toISOString() },
                  { from: ["streaming"] },
                );
                return false;
              }
              // Only from `streaming`: a row the deadline sweep already failed is never revived.
              const moved = await markTransfer(
                tx,
                row.id,
                { status: "streamed", sizeBytes: stored.sizeBytes, sha256: stored.sha256 },
                { from: ["streaming"] },
              );
              if (!moved) return false;
              await recordServerAttachment(tx, {
                id: row.attachmentId,
                conversationId: row.conversationId,
                uploaderAgentId: row.agentId,
                eventId: row.eventId,
                name: posix.basename(path),
                sizeBytes: stored.sizeBytes,
                sha256: stored.sha256,
                contentType: stored.contentType,
              });
              return true;
            });
            if (!recorded) {
              await storage.remove([key]).catch(() => undefined);
              throw refuse("gone", gone("This transfer is over"));
            }
          } catch (err) {
            if (err instanceof HttpError) throw err;
            // Nothing half-stored survives: the object goes (a multipart upload was already aborted) and the row fails.
            await storage.remove([key]).catch(() => undefined);
            await core.db
              .withTenant(tenant, (tx) =>
                markTransfer(
                  tx,
                  row.id,
                  { status: "failed", failure: "transfer_failed", completedAt: new Date().toISOString() },
                  { from: ["streaming"] },
                ),
              )
              .catch((e: unknown) =>
                log.warn(
                  { err: e, transferId, deviceId: device.deviceId, code: "transfer_failed" },
                  "could not record a file transfer",
                ),
              );
            log.info(
              {
                transferId,
                deviceId: device.deviceId,
                code: "transfer_failed",
                cause: (err as { name?: string } | null)?.name ?? "Error",
              },
              "file transfer ended",
            );
            throw transferFailed();
          }
          log.info({ transferId, deviceId: device.deviceId, code: "streamed" }, "file transfer ended");
          return { ok: true, sizeBytes };
        } finally {
          guard?.clear();
          release();
        }
      },
    );
  });
}
