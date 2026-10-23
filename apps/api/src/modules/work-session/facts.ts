import { type Tx, workSessions } from "@ocw/db";
import { type SQL, sql } from "drizzle-orm";
import { type ResourceFacts, uuidArray, workSessionResource } from "../organization";

type SessionRef = Pick<typeof workSessions.$inferSelect, "id" | "createdBy" | "deviceId">;

/**
 * The audience facts of `userId` on the session of the current `work_sessions` row (lists): the only place in the API
 * that calls the SQL rule, with `sessionFacts` and `sessionFactsForUsers` below.
 */
export const sessionAccessSql = (userId: string): SQL<string[]> =>
  sql<string[]>`app.work_session_access(${workSessions.id}, ${userId}::uuid)`;

/**
 * One session row as the resolver needs it (Phase 07.9, C-01): the device's owner and revocation (Device layer, D-11),
 * the team project's unit path (`[]` for a personal project; unit rules, module rows and lead grants reach the session
 * through it) and the principal's audience facts from `app.work_session_access` (the one SQL rule, P-03).
 */
export interface SessionFactsRow {
  createdBy: string;
  deviceOwnerUserId: string | null;
  deviceRevoked: boolean;
  unitPath: readonly string[];
  access: readonly string[];
}

/**
 * THE builder of a session resource (Pitfall 3): every reader (list, detail, prompts, commands, interrupt, approvals,
 * settings, controls, diff, archive, attachments, the `ws:` authorizer) gets its facts from here, through
 * `sessionFacts`, `sessionFactsForUsers` or `WorkSessionService.readableSessions`, so the audience is never copied.
 */
export function sessionResourceOf(row: SessionFactsRow, userId: string | null, tool?: string): ResourceFacts {
  return workSessionResource(
    {
      createdBy: row.createdBy,
      deviceOwnerUserId: row.deviceOwnerUserId,
      deviceRevoked: row.deviceRevoked,
      access: row.access,
      unitPath: row.unitPath,
      tool: tool ?? null,
    },
    userId,
  );
}

/** The session's own facts (device, project path), shared by every user it is decided for. */
interface SessionShape {
  owner: string | null;
  revoked: boolean;
  unit_path: string[] | null;
}

const fromShape = (
  s: SessionRef,
  shape: SessionShape | undefined,
  access: readonly string[],
): SessionFactsRow => ({
  createdBy: s.createdBy,
  deviceOwnerUserId: shape?.owner ?? null,
  // A session whose device row is gone is treated as on a revoked device (fail closed, as before).
  deviceRevoked: !shape || shape.revoked,
  unitPath: shape?.unit_path ?? [],
  access,
});

/**
 * The device and team-project facts of a session (`app.work_session_shape`, definer, scoped to the tenant). Not read
 * through the caller's RLS: under the audience backstop (07.9-12) a caller outside the audience sees no row, and
 * `sessionFactsForUsers` decides OTHER people (who still reads after a change, the fan-out), whose facts must not
 * depend on the caller's own audience. Ids and the revoked flag only.
 */
const shapeSql = (sessionId: string) => sql`
  select sh.owner, sh.revoked, sh.unit_path::text[] as unit_path from app.work_session_shape(${sessionId}::uuid) sh`;

/**
 * Resolver facts for one person on one session: relations (creator, device owner, viewer), states (revoked device,
 * creator who left), the team project's path and, for approvals, the tool the request would run (Tool layer). One query.
 */
export async function sessionFacts(
  tx: Tx,
  userId: string,
  s: SessionRef,
  tool?: string,
): Promise<ResourceFacts> {
  const res = await tx.execute(sql`
    select shape.*, app.work_session_access(${s.id}::uuid, ${userId}::uuid) as access
      from (${shapeSql(s.id)}) shape`);
  const row = res.rows[0] as (SessionShape & { access: string[] | null }) | undefined;
  return sessionResourceOf(fromShape(s, row, row?.access ?? []), userId, tool);
}

/**
 * The same facts for many people at once (live fan-out, re-authorization): one query over the ids, so every person is
 * decided by the same rule as the request routes. Ids outside the tenant get no facts beyond the relations their ids
 * name (the SQL rule returns `{}` for anyone who is not an active member).
 */
export async function sessionFactsForUsers(
  tx: Tx,
  s: SessionRef,
  userIds: readonly string[],
): Promise<Map<string, ResourceFacts>> {
  const out = new Map<string, ResourceFacts>();
  if (userIds.length === 0) return out;
  const res = await tx.execute(sql`
    select u.id::text as user_id, shape.*, app.work_session_access(${s.id}::uuid, u.id) as access
      from unnest(${uuidArray([...new Set(userIds)])}) as u(id)
      left join (${shapeSql(s.id)}) shape on true`);
  type Row = Omit<SessionShape, "revoked"> & {
    revoked: boolean | null;
    user_id: string;
    access: string[] | null;
  };
  for (const r of res.rows as Row[]) {
    // No joined row (the session is not in this tenant): no device facts, fail closed.
    const shape = r.revoked === null ? undefined : { ...r, revoked: r.revoked };
    out.set(r.user_id, sessionResourceOf(fromShape(s, shape, r.access ?? []), r.user_id));
  }
  return out;
}
