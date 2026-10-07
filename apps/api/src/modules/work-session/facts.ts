import { devices, type Tx, type workSessions } from "@ocw/db";
import { eq } from "drizzle-orm";
import { type ResourceFacts, workSessionResource } from "../organization";

/**
 * Resolver facts for a session: the caller's relations (creator, device owner), the Device layer (revoked device)
 * and, for approvals, the tool the request would run (Tool layer). Shared by the session routes and the attachment
 * scope (06.1), so a session image is decided exactly like the session.
 */
export async function sessionFacts(
  tx: Tx,
  userId: string,
  s: Pick<typeof workSessions.$inferSelect, "createdBy" | "deviceId">,
  tool?: string,
): Promise<ResourceFacts> {
  const [d] = await tx
    .select({ owner: devices.ownerUserId, revokedAt: devices.revokedAt })
    .from(devices)
    .where(eq(devices.id, s.deviceId));
  return workSessionResource(
    {
      createdBy: s.createdBy,
      deviceOwnerUserId: d?.owner ?? null,
      deviceRevoked: !d || d.revokedAt !== null,
      tool: tool ?? null,
    },
    userId,
  );
}
