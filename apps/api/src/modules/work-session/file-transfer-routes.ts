import { BOT_FILE_LIMITS, Id } from "@ocw/contracts";
import { attachments } from "@ocw/db";
import { and, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import type { App, Core } from "../../core";
import { gone, HttpError, notFound } from "../../lib/errors";
import { attachmentKey, type ObjectStorage } from "../artifact";
import { authenticateDeviceJwt, bearerValue, type DeviceRef, looksLikeJwt } from "../device";
import { createPermissionService } from "../organization";
import { claimTransferForDevice, markTransfer, type TransferRow } from "./bot-files";

/**
 * Streams running in this API process (07.17.1.1 PD-05): at most `BOT_FILE_LIMITS.concurrentTransfersPerProcess`. A
 * request beyond that answers 503 `busy` BEFORE its row is claimed, so the row stays `pending` and the daemon's retry
 * (1 s, then 3 s) streams it. A slot is reserved before the claim and released when the stream ends (or the request
 * is refused), so two requests never both pass a check at three.
 */
let active = 0;

const TransferParams = z.object({ transferId: Id });

/** Answers that never consume the row: the device's retry, or another device, still finds it as it was. */
const busy = () => new HttpError(503, "busy", "The server is moving as many files as it may; retry shortly");
const storageUnavailable = () =>
  new HttpError(503, "storage_unavailable", "File storage is not set up on this server");

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
 * - the bytes of `original`, `content-length` = the row's `size_bytes`, `cache-control: no-store`; the row `streamed`
 *   when the last byte is written, `failed` `transfer_failed` when the stream breaks.
 * Logs carry the transfer id, the device id and a code only: never a path, a file name or a byte (P1).
 */
export function registerFileTransferRoutes(
  app: App,
  core: Core,
  deps: { storage: ObjectStorage | null },
): void {
  const perms = createPermissionService(core);
  const max = BOT_FILE_LIMITS.concurrentTransfersPerProcess;

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
        onRequest: async (req, reply) => {
          const token = bearerValue(req.headers);
          // A JWT only: the long-lived device token is exchanged at `POST /devices/token`, never accepted here.
          const found =
            token && looksLikeJwt(token) ? await authenticateDeviceJwt(core, perms, req, token) : null;
          if (!found) {
            req.device = undefined;
            return reply.code(401).send({ error: { code: "unauthorized", message: "Invalid device token" } });
          }
        },
      },
      async (req, reply) => {
        const device = req.device as DeviceRef;
        const { transferId } = TransferParams.parse(req.params);
        const log = req.log;
        // Refusals that are not about the transfer come first: they never consume the row (PD-05).
        if (active >= max) {
          log.info({ transferId, deviceId: device.deviceId, code: "busy" }, "file transfer refused");
          throw busy();
        }
        const storage = deps.storage;
        if (!storage) throw storageUnavailable();
        active += 1;
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
              // The person may have deleted the file since the bot asked: its bytes no longer leave storage.
              const [source] = await tx
                .select({ id: attachments.id })
                .from(attachments)
                .where(
                  and(
                    eq(attachments.id, row.attachmentId),
                    eq(attachments.conversationId, row.conversationId),
                    eq(attachments.status, "ready"),
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
              return row;
            },
          );
          if (claimed === null) {
            log.info({ transferId, deviceId: device.deviceId, code: "not_found" }, "file transfer refused");
            throw notFound("Transfer not found");
          }
          if (claimed === "gone" || claimed === "source_gone") {
            const code = claimed === "gone" ? "gone" : "source_gone";
            log.info({ transferId, deviceId: device.deviceId, code }, "file transfer refused");
            throw gone("This transfer is over");
          }

          let source: Awaited<ReturnType<ObjectStorage["stream"]>>;
          try {
            source = await storage.stream(
              attachmentKey(device.organizationId, claimed.conversationId, claimed.attachmentId, "original"),
            );
          } catch {
            await settle(device, claimed, false, log);
            throw new HttpError(502, "transfer_failed", "The file could not be read from storage");
          }

          let ended = false;
          const end = (ok: boolean) => {
            if (ended) return;
            ended = true;
            active -= 1;
            void settle(device, claimed, ok, log);
          };
          reply.raw.once("finish", () => end(true));
          reply.raw.once("close", () => end(reply.raw.writableFinished));
          source.once("error", () => end(false));
          handedOff = true;
          log.info({ transferId, deviceId: device.deviceId, code: "streaming" }, "file transfer started");
          reply.header("content-type", "application/octet-stream").header("cache-control", "no-store");
          // The enqueue records the source's size on every `to_device` row; the device checks it against the payload.
          if (claimed.sizeBytes !== null) reply.header("content-length", String(claimed.sizeBytes));
          return reply.send(source);
        } finally {
          if (!handedOff) active -= 1;
        }
      },
    );
  });
}
