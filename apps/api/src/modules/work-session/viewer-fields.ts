import type { Permission, TeamProjectRef, WorkSession } from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import { sql } from "drizzle-orm";
import { type PermissionService, type ResourceFacts, uuidArray, workProjectResource } from "../organization";

/**
 * Per-viewer session fields (Phase 07.10, PD-03, PD-04; UI-SPEC R2). A session's team project is named to a person
 * only when the resolver lets them open that project (`work_session.read` on its `work_project` resource, built from
 * `app.work_project_access`: the decision `GET /projects` makes for 07.9 D-14) or when they created the session (D-12:
 * a creator who left keeps the name). Anyone else who reads the session (the device owner outside the project, D-11; a
 * person granted the session alone) gets `teamProject: null` and `teamProjectHidden: true`.
 *
 * These fields travel only on a viewer's own surfaces: the list and the detail (shaped for the requester) and each
 * `user:` frame (shaped for its recipient). The shared `ws:` stream and the public `WorkSessionService.session` /
 * `sessions` carry the viewer-neutral DTO (`withoutViewerFields`): a surface that forgets the shaping answers less,
 * never more. Every decision is batched (never one query per row) and taken by the resolver, never by reading a role.
 */

/** A session's team project as the shaping needs it (its unit path decides module and unit rules); never sent as is. */
export interface SessionProject {
  id: string;
  name: string;
  path: readonly string[];
}

/** One session to shape: its DTO (shaped fields are replaced) and its team project, null for a personal repository. */
export interface ShapeSource {
  dto: WorkSession;
  project: SessionProject | null;
}

/** What one viewer reads of one session beyond the neutral DTO. */
export interface ViewerFields {
  teamProject: TeamProjectRef | null;
  /** True only when the session has a team project this viewer may not see named. */
  teamProjectHidden: boolean;
}

/** The request's own decision for its viewer (`perms.filter(req, tx, …)`: principal facts memoized per request). */
export type ViewerFilter = <T>(
  items: readonly T[],
  permission: Permission,
  toResource: (item: T) => ResourceFacts,
) => Promise<T[]>;

const PER_VIEWER_KEYS = ["teamProject", "teamProjectHidden"] as const;

/** The viewer-neutral DTO: none of the per-viewer fields (the `ws:` snapshot, the public session readers). */
export function withoutViewerFields(dto: WorkSession): WorkSession {
  const out: Record<string, unknown> = { ...dto };
  for (const k of PER_VIEWER_KEYS) delete out[k];
  return out as WorkSession;
}

/** The DTO as `fields`' viewer reads it. Pure. */
export function withViewerFields(dto: WorkSession, fields: ViewerFields): WorkSession {
  return {
    ...withoutViewerFields(dto),
    teamProject: fields.teamProject,
    ...(fields.teamProjectHidden ? { teamProjectHidden: true } : {}),
  };
}

const NO_PROJECT: ViewerFields = { teamProject: null, teamProjectHidden: false };

function fieldsOf(project: SessionProject | null, named: boolean): ViewerFields {
  if (!project) return NO_PROJECT;
  return named
    ? { teamProject: { id: project.id, name: project.name }, teamProjectHidden: false }
    : { teamProject: null, teamProjectHidden: true };
}

/** Distinct team projects of `sources` (by unit id). */
function distinctProjects(sources: readonly ShapeSource[]): SessionProject[] {
  const out = new Map<string, SessionProject>();
  for (const s of sources) if (s.project && !out.has(s.project.id)) out.set(s.project.id, s.project);
  return [...out.values()];
}

/**
 * The per-viewer fields of `sessions` for ONE viewer (the list and the detail), by session id. One project-access
 * query over the distinct team projects the viewer did not create a session in, then one in-memory resolver decision
 * per project through the request's `filter`.
 */
export async function loadViewerFields(
  tx: Tx,
  a: { viewerId: string; sessions: readonly ShapeSource[]; filter: ViewerFilter },
): Promise<Map<string, ViewerFields>> {
  const toDecide = distinctProjects(a.sessions.filter((s) => s.dto.createdBy !== a.viewerId));
  const open = new Set<string>();
  if (toDecide.length > 0) {
    const res = await tx.execute(sql`
      select u.id::text as unit_id, app.work_project_access(u.id, ${a.viewerId}::uuid) as access
        from unnest(${uuidArray(toDecide.map((p) => p.id))}) as u(id)`);
    const access = new Map(
      (res.rows as Array<{ unit_id: string; access: string | null }>).map((r) => [r.unit_id, r.access]),
    );
    const allowed = await a.filter(toDecide, "work_session.read", (p) =>
      workProjectResource({ id: p.id, path: p.path, access: access.get(p.id) ?? null }, a.viewerId),
    );
    for (const p of allowed) open.add(p.id);
  }
  const out = new Map<string, ViewerFields>();
  for (const s of a.sessions) {
    const named = s.dto.createdBy === a.viewerId || (s.project !== null && open.has(s.project.id));
    out.set(s.dto.id, fieldsOf(s.project, named));
  }
  return out;
}

/**
 * The per-viewer fields of each delivered session for EACH of its recipients (the `user:` fan-out), by session id then
 * user id. One project-access query over every (project, recipient) pair of the batch, then one resolver decision per
 * distinct project over its recipients (`usersAllowed`, rules loaded once per call).
 */
export async function loadViewerFieldsForRecipients(
  tx: Tx,
  perms: Pick<PermissionService, "usersAllowed">,
  deliveries: ReadonlyArray<ShapeSource & { recipients: readonly string[] }>,
): Promise<Map<string, Map<string, ViewerFields>>> {
  // Recipients to decide per project: the session's creator is named without a decision (D-12).
  const byProject = new Map<string, { project: SessionProject; users: Set<string> }>();
  for (const d of deliveries) {
    if (!d.project) continue;
    const entry = byProject.get(d.project.id) ?? { project: d.project, users: new Set<string>() };
    for (const uid of d.recipients) if (uid !== d.dto.createdBy) entry.users.add(uid);
    byProject.set(d.project.id, entry);
  }
  const units: string[] = [];
  const users: string[] = [];
  for (const { project, users: us } of byProject.values()) {
    for (const uid of us) {
      units.push(project.id);
      users.push(uid);
    }
  }
  const key = (unitId: string, userId: string) => `${unitId}:${userId}`;
  const open = new Set<string>();
  if (units.length > 0) {
    const res = await tx.execute(sql`
      select x.unit_id::text as unit_id, x.user_id::text as user_id,
             app.work_project_access(x.unit_id, x.user_id) as access
        from unnest(${uuidArray(units)}, ${uuidArray(users)}) as x(unit_id, user_id)`);
    const access = new Map(
      (res.rows as Array<{ unit_id: string; user_id: string; access: string | null }>).map((r) => [
        key(r.unit_id, r.user_id),
        r.access,
      ]),
    );
    for (const { project, users: us } of byProject.values()) {
      if (us.size === 0) continue;
      const allowed = await perms.usersAllowed(tx, {
        candidates: [...us],
        permission: "work_session.read",
        resourceFor: (uid) =>
          workProjectResource(
            { id: project.id, path: project.path, access: access.get(key(project.id, uid)) ?? null },
            uid,
          ),
      });
      for (const uid of allowed) open.add(key(project.id, uid));
    }
  }
  const out = new Map<string, Map<string, ViewerFields>>();
  for (const d of deliveries) {
    const perUser = new Map<string, ViewerFields>();
    for (const uid of d.recipients) {
      const named = uid === d.dto.createdBy || (d.project !== null && open.has(key(d.project.id, uid)));
      perUser.set(uid, fieldsOf(d.project, named));
    }
    out.set(d.dto.id, perUser);
  }
  return out;
}
