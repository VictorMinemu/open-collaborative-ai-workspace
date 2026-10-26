import type { Permission } from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import { sql } from "drizzle-orm";
import { notFound } from "../../lib/errors";
import { AuthzDeniedError } from "../organization";

/**
 * The 404 of a session the caller's transaction does not see (07.9-12, D-09). Under the RESTRICTIVE
 * `audience_backstop` a session outside the caller's relations is absent from every user-context read, so a route that
 * looked it up finds nothing. When it does exist in the tenant (`app.work_session_exists`, a boolean), the refusal is
 * the resolver's own `not_in_audience` denial: the same 404 body as a missing id (`hideAs404`) and the same
 * `authz.denied` audit row as before the backstop, so an attempt is never silenced. Otherwise it is a plain 404.
 */
export async function sessionNotFound(
  tx: Tx,
  sessionId: string,
  message: string,
  permission: Permission = "work_session.read",
): Promise<never> {
  const res = await tx.execute(sql`select app.work_session_exists(${sessionId}::uuid) as e`);
  if ((res.rows[0] as { e: boolean } | undefined)?.e === true) {
    throw new AuthzDeniedError(
      { permission, layer: "resource", reason: "not_in_audience" },
      { hideAs404: true, message },
    );
  }
  throw notFound(message);
}
