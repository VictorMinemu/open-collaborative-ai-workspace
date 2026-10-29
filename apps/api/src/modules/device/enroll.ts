import { type DevicePlatform, type EnrollDeviceResponse, EventTypes } from "@ocw/contracts";
import { deviceEnrollments, devices } from "@ocw/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { randomToken, sha256Hex } from "../../lib/crypto";
import { badRequest, gone } from "../../lib/errors";
import { memberDirectory } from "../organization";

/** How a device was paired: a code typed into the runtime, or a device-code pairing approved in the web (07.12). */
export type EnrollVia = "code" | "device_code";

/**
 * The one enroll transaction for both pairing paths (07.12-02, D-03): the typed code (`POST /devices/enroll`, hash of
 * the normalized code) and the device-code token poll (`POST /devices/pairings/token`, `pairingEnrollmentHash`). Looks
 * the enrollment up before any tenant exists (SECURITY DEFINER lookup), then in the enrolling member's tenant consumes
 * it, creates the device with only the sha256 of its new `ocwd_` token, audits `device.enrolled` (with `via`) and
 * announces it. The token is returned exactly once.
 *
 * Errors: unknown hash → 400 `invalid_code`; consumed → 410 `code_used`; expired → 410 `code_expired`.
 */
export async function enrollWithCodeHash(
  core: Core,
  codeHash: string,
  opts: { name: string; platform: DevicePlatform; via: EnrollVia },
): Promise<EnrollDeviceResponse> {
  const { name, platform, via } = opts;
  const enrollment = await core.db.lookups.deviceEnrollmentByCodeHash(codeHash);
  if (!enrollment) throw badRequest("This pairing code is not valid", "invalid_code");
  if (enrollment.consumedAt) throw gone("This pairing code was already used", "code_used");
  if (new Date(enrollment.expiresAt).getTime() < Date.now()) {
    throw gone("This pairing code expired. Create a new one in Settings › Devices", "code_expired");
  }
  const deviceToken = `ocwd_${randomToken(32)}`;
  const { organizationId, userId } = enrollment;
  const enrolled = await core.db.withTenant({ organizationId, userId }, async (tx) => {
    const consumed = await tx
      .update(deviceEnrollments)
      .set({ consumedAt: sql`now()` })
      .where(and(eq(deviceEnrollments.codeHash, codeHash), isNull(deviceEnrollments.consumedAt)))
      .returning({ codeHash: deviceEnrollments.codeHash });
    if (consumed.length === 0) throw gone("This pairing code was already used", "code_used");
    const [row] = await tx
      .insert(devices)
      .values({ organizationId, ownerUserId: userId, name, platform, tokenHash: sha256Hex(deviceToken) })
      .returning();
    await core.audit.record(tx, {
      action: "device.enrolled",
      resourceType: "device",
      resourceId: row!.id,
      deviceId: row!.id,
      metadata: { name, platform, via },
    });
    await core.realtime.appendEvent(tx, `org:${organizationId}`, EventTypes.deviceUpdated, {
      deviceId: row!.id,
      status: row!.status,
      changed: true,
    });
    const ownerName = (await memberDirectory(tx)).get(userId)?.displayName ?? null;
    return { deviceId: row!.id, name: row!.name, ownerName };
  });
  const organizationName = await core.identity.organizationName(organizationId);
  return {
    deviceId: enrolled.deviceId,
    organizationId,
    deviceToken,
    name: enrolled.name,
    webUrl: core.env.OCW_PUBLIC_WEB_URL.replace(/\/+$/u, ""),
    ...(organizationName ? { organizationName } : {}),
    ...(enrolled.ownerName ? { ownerName: enrolled.ownerName } : {}),
  };
}
