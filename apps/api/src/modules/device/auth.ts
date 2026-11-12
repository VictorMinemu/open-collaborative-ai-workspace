import { devices } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Core } from "../../core";
import type { PermissionService } from "../organization";
import type { DeviceRef } from "./hub";

declare module "fastify" {
  interface FastifyRequest {
    device?: DeviceRef;
  }
}

/**
 * The one device-JWT check (AUTH-06, D-03; 07.17.1.1 PD-05): a 10-minute device JWT (aud `ocw:device-link`, from `POST
 * /api/v1/devices/token`) verified against the JWKS, then the device row re-checked in the JWT's organization (a revoked
 * device is refused even with a JWT it still holds), then the resolver decides `device.link` for the device principal.
 * Returns the device (also set as `req.device`) or null. The Device Link (`GET /runtime/ws`) and the file transfer route
 * (`GET|PUT /api/v1/runtime/files/:transferId`) both authenticate through it. A user JWT never verifies here.
 */
export async function authenticateDeviceJwt(
  core: Core,
  perms: PermissionService,
  req: FastifyRequest,
  token: string,
): Promise<DeviceRef | null> {
  const claims = await core.identity.verifyDeviceAccessToken(token);
  if (!claims) return null;
  return core.db.withTenant({ organizationId: claims.organizationId, userId: null }, async (tx) => {
    const [row] = await tx
      .select({ ownerUserId: devices.ownerUserId, revokedAt: devices.revokedAt })
      .from(devices)
      .where(eq(devices.id, claims.deviceId))
      .limit(1);
    if (!row || row.revokedAt) return null;
    const ref: DeviceRef = { ...claims, ownerUserId: row.ownerUserId };
    req.device = ref;
    return (await perms.can(req, tx, "device.link")) ? ref : null;
  });
}
