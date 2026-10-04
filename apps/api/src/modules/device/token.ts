import type { IncomingHttpHeaders } from "node:http";
import { DeviceAccessToken } from "@ocw/contracts";
import type { App, Core } from "../../core";
import { sha256Hex } from "../../lib/crypto";
import { unauthorized } from "../../lib/errors";
import { createPermissionService } from "../organization";

/** A compact JWS (three base64url segments). Raw device tokens (`ocwd_…`) never contain a dot. */
const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The `Authorization: Bearer <value>` credential, or "" when absent. */
export function bearerValue(headers: IncomingHttpHeaders): string {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(headers.authorization ?? "");
  return m?.[1] ?? "";
}

export function looksLikeJwt(value: string): boolean {
  return COMPACT_JWT.test(value);
}

/**
 * `POST /api/v1/devices/token` (AUTH-06, D-03): the daemon exchanges its long-lived device token (Bearer,
 * SHA-256 lookup of a non-revoked device) for a 10-minute device JWT (aud `ocw:device-link`) before each
 * Device Link connect. Neither credential is ever logged; the answer is never cached.
 */
export function registerDeviceTokenRoute(app: App, core: Core): void {
  const perms = createPermissionService(core);

  app.post(
    "/devices/token",
    {
      config: { authz: "device", rateLimit: { max: 60, timeWindow: "1 minute" } },
      schema: { tags: ["device"], response: { 200: DeviceAccessToken } },
    },
    async (req, reply) => {
      const token = bearerValue(req.headers);
      // A JWT is never accepted here: only the device's own long-lived credential mints a device JWT.
      const found =
        token && !looksLikeJwt(token) ? await core.db.lookups.deviceByTokenHash(sha256Hex(token)) : null;
      if (!found) throw unauthorized("Invalid device token", "invalid_device_token");
      req.device = found;
      await core.db.withTenant({ organizationId: found.organizationId, userId: null }, (tx) =>
        perms.assertCan(req, tx, "device.link"),
      );
      reply.header("cache-control", "no-store");
      return core.identity.signDeviceAccessToken({
        deviceId: found.deviceId,
        organizationId: found.organizationId,
      });
    },
  );
}
