import {
  Id,
  WORK_BROWSER_LIMITS,
  WORK_BROWSER_SIGNIN_ROUTES,
  WorkBrowserSignInList,
  WorkBrowserSignInUpload,
} from "@ocw/contracts";
import { workBrowsers, workSessions } from "@ocw/db";
import { and, eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { markDecided } from "../../authz";
import { type App, authOf, type Core, tenant } from "../../core";
import { badRequest, conflict, gone, notFound } from "../../lib/errors";
import { authenticateDeviceJwt, bearerValue, type DeviceHub, type DeviceRef, looksLikeJwt } from "../device";
import type { PermissionService } from "../organization";
import { listMine, resealWorkSignIn, revokeWorkSignIn, sealWorkSignIn } from "./signins";
import { loadedPages, unlinkGonePages } from "./sweep";

/**
 * The Work Zone sign-in routes (Phase 07.13; D-22, D-23, D-28, PD-15, P7):
 *
 * - `GET /work-browser/signins` (`authz: user`): the caller's OWN sign-ins (site, dates, status), never anything sealed;
 * - `DELETE /work-browser/signins/:id` (`authz: user`): revokes one of them (the secret goes; a page that had it
 *   loaded is closed on its device, `browser.close { reason: "revoked" }`, and its loaded fields cleared). Another
 *   member's id, an admin's attempt and another organization's id are all 404: the owner-only policy hides the row;
 * - `PUT /runtime/browser-signins/uploads/:uploadId` (device JWT only): the hand-back upload (PD-15). The upload row
 *   must name a session that runs on THIS device, be unexpired and unused; it is consumed once, whatever the outcome,
 *   and the seal runs as the upload's member (owner-only policy). Sealed only when `changed` and something of the site
 *   is left after `keepForSite`: 201 `{ saved: true }`, otherwise 200 `{ saved: false }`;
 * - `PUT /runtime/browser-signins/:signinId/state` (device JWT only, PD-17): the re-seal before an unload, accepted only
 *   while the body's session runs on THIS device and has that sign-in loaded now (`work_browsers.signin_id`); run as
 *   the sign-in's owner. 200 `{ saved }`; another device's session 404; not loaded 409 `not_loaded`.
 *
 * Bodies are parsed with the contracts; no answer, log line or audit row ever echoes a storage state. Logs carry ids
 * and a code only.
 */

const tags = ["work-browser"];
/** Mounted under `/api/v1` by app.ts: the contract's paths without that prefix. */
const routePath = (p: string) => p.replace(/^\/api\/v1/, "");
/** The largest body a device may send: one storage state at its cap plus the envelope. */
const UPLOAD_BODY_LIMIT = WORK_BROWSER_LIMITS.storageStateMaxBytes + 16 * 1024;
/** How long a consumed upload id is remembered (ids only) so a repeat answers 409 rather than 404. */
const USED_TTL_SECONDS = 600;
const usedKey = (uploadId: string) => `ocw:wb:upload-used:${uploadId}`;

const IdParams = z.object({ id: Id });
const UploadParams = z.object({ uploadId: Id });
const ResealParams = z.object({ signinId: Id });

/** The device JWT check (the file-transfer routes' rule, 07.17.1.1 PD-05): a JWT only, never the device token. */
function deviceJwtOnly(core: Core, perms: PermissionService) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearerValue(req.headers);
    const found = token && looksLikeJwt(token) ? await authenticateDeviceJwt(core, perms, req, token) : null;
    if (!found) {
      req.device = undefined;
      return reply.code(401).send({ error: { code: "unauthorized", message: "Invalid device token" } });
    }
  };
}

/** A device body as the contract allows it, or a 400 that names nothing of it. */
function parseUpload(body: unknown): WorkBrowserSignInUpload {
  const parsed = WorkBrowserSignInUpload.safeParse(body);
  if (!parsed.success) throw badRequest("Not a sign-in upload", "invalid_request");
  return parsed.data;
}

export interface SignInRouteDeps {
  core: Core;
  perms: PermissionService;
  /** Where a revoked sign-in's pages are closed (`browser.close`, ephemeral). */
  hub: Pick<DeviceHub, "sendBrowserFrame">;
}

export function registerSignInRoutes(app: App, deps: SignInRouteDeps): void {
  const { core, perms } = deps;
  const user = { config: { authz: "user" as const }, preHandler: [core.identity.requireUser] };
  const deviceOnly = deviceJwtOnly(core, perms);

  /** Remembers a consumed upload id for its device (best effort: Redis down only turns a later 409 into a 404). */
  async function markUsed(uploadId: string, deviceId: string): Promise<void> {
    await core.bus.pub
      .set(usedKey(uploadId), deviceId, { expiration: { type: "EX", value: USED_TTL_SECONDS } })
      .catch(() => {});
  }
  async function usedBy(uploadId: string): Promise<string | null> {
    return core.bus.pub.get(usedKey(uploadId)).catch(() => null);
  }

  app.get(
    routePath(WORK_BROWSER_SIGNIN_ROUTES.list),
    { ...user, schema: { tags, response: { 200: WorkBrowserSignInList } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      // The member's own rows: the owner-only policy is the decision (as for the bots' sign-ins).
      markDecided(req);
      const { userId } = authOf(req);
      return { items: await core.db.withTenant(tenant(req), (tx) => listMine(tx, userId)) };
    },
  );

  app.delete(
    routePath(WORK_BROWSER_SIGNIN_ROUTES.revoke),
    { ...user, schema: { tags, params: IdParams } },
    async (req, reply) => {
      // Owner-only: the policy decides (anyone else's id, an admin's included, is simply missing: 404).
      markDecided(req);
      const { userId, organizationId } = authOf(req);
      const { id } = IdParams.parse(req.params);
      // The pages that have it loaded hold its cookies: found (user-less: the page rows are the sessions', and a
      // member may no longer read a session their sign-in is still loaded in) before the revoke unlinks them, used only
      // once the revoke proved the sign-in is the caller's.
      const pages = await core.db.withTenant({ organizationId, userId: null }, (tx) => loadedPages(tx, id));
      const revoked = await core.db.withTenant(tenant(req), (tx) =>
        revokeWorkSignIn(tx, core, { userId, id }),
      );
      if (!revoked) throw notFound("Sign-in not found");
      const closed = await core.db.withTenant({ organizationId, userId: null }, (tx) =>
        unlinkGonePages(tx, pages),
      );
      // D-23: the page ends on its device (ephemeral frame; an offline device simply misses it).
      for (const page of closed) {
        await deps.hub
          .sendBrowserFrame(page.deviceId, {
            type: "browser.close",
            sessionId: page.sessionId,
            reason: "revoked",
          })
          .catch(() => {});
      }
      return reply.code(204).send();
    },
  );

  app.register(async (scope) => {
    scope.put(
      routePath(WORK_BROWSER_SIGNIN_ROUTES.upload),
      {
        config: { authz: "device" },
        bodyLimit: UPLOAD_BODY_LIMIT,
        schema: { hide: true, params: UploadParams },
        // A JWT only: the long-lived device token is exchanged at `POST /devices/token`, never accepted here.
        onRequest: deviceOnly,
      },
      async (req, reply) => {
        const device = req.device as DeviceRef;
        const { uploadId } = UploadParams.parse(req.params);
        const body = parseUpload(req.body);
        const log = req.log;
        const refuse = (code: "not_found" | "upload_used"): never => {
          log.info({ uploadId, deviceId: device.deviceId, code }, "sign-in upload refused");
          if (code === "upload_used") throw conflict("This upload was already used", "upload_used");
          throw notFound("Upload not found");
        };

        // The upload, read in the device's tenant (no user): it must name a session that runs on this device.
        const found = await core.db.withTenant(
          { organizationId: device.organizationId, userId: null },
          async (tx) => {
            const [row] = await tx
              .select({
                sessionId: workBrowsers.workSessionId,
                userId: workBrowsers.uploadUserId,
                origin: workBrowsers.uploadOrigin,
                deviceId: workSessions.deviceId,
              })
              .from(workBrowsers)
              .innerJoin(workSessions, eq(workSessions.id, workBrowsers.workSessionId))
              .where(eq(workBrowsers.uploadId, uploadId))
              .limit(1);
            return row ?? null;
          },
        );
        if (!found) return refuse((await usedBy(uploadId)) === device.deviceId ? "upload_used" : "not_found");
        if (
          found.deviceId !== device.deviceId ||
          !found.userId ||
          body.sessionId !== found.sessionId ||
          body.origin !== found.origin
        ) {
          return refuse("not_found");
        }
        const memberId = found.userId;

        // Consumed and sealed in one transaction as the upload's member (the owner-only policy applies).
        const outcome = await core.db.withTenant(
          { organizationId: device.organizationId, userId: memberId },
          async (tx) => {
            const [row] = await tx
              .select({
                origin: workBrowsers.uploadOrigin,
                expiresAt: workBrowsers.uploadExpiresAt,
              })
              .from(workBrowsers)
              .where(
                and(eq(workBrowsers.workSessionId, found.sessionId), eq(workBrowsers.uploadId, uploadId)),
              )
              .limit(1)
              .for("update");
            if (!row?.origin) return "gone" as const;
            await tx
              .update(workBrowsers)
              .set({
                uploadId: null,
                uploadUserId: null,
                uploadOrigin: null,
                uploadExpiresAt: null,
                updatedAt: new Date().toISOString(),
              })
              .where(eq(workBrowsers.workSessionId, found.sessionId));
            // Before the commit, so a concurrent repeat that waited on the lock already finds it used.
            await markUsed(uploadId, device.deviceId);
            if (!row.expiresAt || Date.parse(String(row.expiresAt)) <= Date.now()) return "expired" as const;
            if (!body.changed) return "unchanged" as const;
            const sealed = await sealWorkSignIn(tx, core, {
              userId: memberId,
              origin: row.origin,
              rawState: JSON.stringify(body.state),
              device: { deviceId: device.deviceId, sessionId: found.sessionId },
            });
            return sealed ? ("saved" as const) : ("empty" as const);
          },
        );
        if (outcome === "gone") {
          return refuse((await usedBy(uploadId)) === device.deviceId ? "upload_used" : "not_found");
        }
        log.info({ uploadId, deviceId: device.deviceId, code: outcome }, "sign-in upload");
        if (outcome === "expired") throw gone("This upload expired", "upload_expired");
        if (outcome === "saved") return reply.code(201).send({ saved: true });
        return reply.code(200).send({ saved: false });
      },
    );

    scope.put(
      routePath(WORK_BROWSER_SIGNIN_ROUTES.reseal),
      {
        config: { authz: "device" },
        bodyLimit: UPLOAD_BODY_LIMIT,
        schema: { hide: true, params: ResealParams },
        onRequest: deviceOnly,
      },
      async (req, reply) => {
        const device = req.device as DeviceRef;
        const { signinId } = ResealParams.parse(req.params);
        const body = parseUpload(req.body);
        const log = req.log;

        // The page, read in the device's tenant (no user): a session of THIS device with that sign-in loaded now.
        const page = await core.db.withTenant(
          { organizationId: device.organizationId, userId: null },
          async (tx) => {
            const [row] = await tx
              .select({
                signinId: workBrowsers.signinId,
                userId: workBrowsers.signinUserId,
                deviceId: workSessions.deviceId,
              })
              .from(workBrowsers)
              .innerJoin(workSessions, eq(workSessions.id, workBrowsers.workSessionId))
              .where(eq(workBrowsers.workSessionId, body.sessionId))
              .limit(1);
            return row ?? null;
          },
        );
        if (!page || page.deviceId !== device.deviceId) {
          log.info({ signinId, deviceId: device.deviceId, code: "not_found" }, "sign-in reseal refused");
          throw notFound("Sign-in not found");
        }
        const notLoaded = () => {
          log.info({ signinId, deviceId: device.deviceId, code: "not_loaded" }, "sign-in reseal refused");
          return conflict("This sign-in is not loaded in that session", "not_loaded");
        };
        if (page.signinId !== signinId || !page.userId) throw notLoaded();
        const memberId = page.userId;

        // Re-sealed as its owner, while the page still has it loaded (locked).
        const outcome = await core.db.withTenant(
          { organizationId: device.organizationId, userId: memberId },
          async (tx) => {
            const [still] = await tx
              .select({ signinId: workBrowsers.signinId })
              .from(workBrowsers)
              .where(
                and(
                  eq(workBrowsers.workSessionId, body.sessionId),
                  eq(workBrowsers.signinId, signinId),
                  eq(workBrowsers.signinUserId, memberId),
                ),
              )
              .limit(1)
              .for("update");
            if (!still) return "not_loaded" as const;
            if (!body.changed) return "unchanged" as const;
            const sealed = await resealWorkSignIn(tx, core, {
              userId: memberId,
              signinId,
              rawState: JSON.stringify(body.state),
            });
            return sealed ? ("saved" as const) : ("unchanged" as const);
          },
        );
        if (outcome === "not_loaded") throw notLoaded();
        log.info({ signinId, deviceId: device.deviceId, code: outcome }, "sign-in reseal");
        return reply.code(200).send({ saved: outcome === "saved" });
      },
    );
  });
}
