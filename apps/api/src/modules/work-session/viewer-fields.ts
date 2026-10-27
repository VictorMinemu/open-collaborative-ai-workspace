import type { Permission, TeamProjectRef, WorkSession, WorkSessionAttention } from "@ocw/contracts";
import { type Tx, workPrompts } from "@ocw/db";
import { and, desc, inArray, isNotNull, sql } from "drizzle-orm";
import { type PermissionService, type ResourceFacts, uuidArray, workProjectResource } from "../organization";

/**
 * Per-viewer session fields (Phase 07.10, PD-03, PD-04, PD-05; UI-SPEC R2).
 *
 * - The team project (PD-04): named to a person only when the resolver lets them open that project
 *   (`work_session.read` on its `work_project` resource, built from `app.work_project_access`: the decision
 *   `GET /projects` makes for 07.9 D-14) or when they created the session (D-12: a creator who left keeps the name).
 *   Anyone else who reads the session (the device owner outside the project, D-11; a person granted the session alone)
 *   gets `teamProject: null` and `teamProjectHidden: true`.
 * - Attention (PD-05): `approval` when the session has a pending approval and the resolver lets this person decide it
 *   (`work_session.approve` on their session facts, built by `facts.ts`: the detail's `viewerCan` decision);
 *   `lastTurnEndedAt` when the session's last finished turn ran this person's prompt.
 *
 * These fields travel only on a viewer's own surfaces: the list and the detail (shaped for the requester) and each
 * `user:` frame (shaped for its recipient). The shared `ws:` stream and the public `WorkSessionService.session` /
 * `sessions` carry the viewer-neutral DTO (`withoutViewerFields`): a surface that forgets the shaping answers less,
 * never more. The visibility panel (`visibility.ts`, 07.10-07) names the project with the same decision
 * (`projectNamedFor`). The decisions are taken by the resolver, never by reading a role; the list and the delivery
 * batch the project access (one query per list or batch).
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

/** One session shaped for one viewer: with that viewer's resolver facts on it (`facts.ts`). */
export interface ViewerSource extends ShapeSource {
  facts: ResourceFacts;
}

/** One delivered session: its recipients and each recipient's resolver facts on it (`sessionFactsForUsers`). */
export interface DeliverySource extends ShapeSource {
  recipients: readonly string[];
  facts: ReadonlyMap<string, ResourceFacts>;
}

/** What one viewer reads of one session beyond the neutral DTO. */
export interface ViewerFields {
  teamProject: TeamProjectRef | null;
  /** True only when the session has a team project this viewer may not see named. */
  teamProjectHidden: boolean;
  attention: WorkSessionAttention;
}

/** The request's own decision for its viewer (`perms.filter(req, tx, …)`: principal facts memoized per request). */
export type ViewerFilter = <T>(
  items: readonly T[],
  permission: Permission,
  toResource: (item: T) => ResourceFacts,
) => Promise<T[]>;

const PER_VIEWER_KEYS = ["teamProject", "teamProjectHidden", "attention"] as const;

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
    attention: fields.attention,
  };
}

function fieldsOf(
  project: SessionProject | null,
  named: boolean,
  attention: WorkSessionAttention,
): ViewerFields {
  if (!project) return { teamProject: null, teamProjectHidden: false, attention };
  return named
    ? { teamProject: { id: project.id, name: project.name }, teamProjectHidden: false, attention }
    : { teamProject: null, teamProjectHidden: true, attention };
}

/** Distinct team projects of `sources` (by unit id). */
function distinctProjects(sources: readonly ShapeSource[]): SessionProject[] {
  const out = new Map<string, SessionProject>();
  for (const s of sources) if (s.project && !out.has(s.project.id)) out.set(s.project.id, s.project);
  return [...out.values()];
}

/** A session's last finished turn: who wrote its prompt and when it ended. */
interface LastTurn {
  authorUserId: string;
  endedAt: string;
}

/**
 * The last finished turn of each session (PD-05), in one query for the batch: per session, the most recent prompt
 * that was dispatched and then completed or failed. Queued, dispatched, running and cancelled prompts never count.
 */
async function lastTurns(tx: Tx, sessionIds: readonly string[]): Promise<Map<string, LastTurn>> {
  const out = new Map<string, LastTurn>();
  if (sessionIds.length === 0) return out;
  const rows = await tx
    .selectDistinctOn([workPrompts.workSessionId], {
      sessionId: workPrompts.workSessionId,
      authorUserId: workPrompts.authorUserId,
      completedAt: workPrompts.completedAt,
    })
    .from(workPrompts)
    .where(
      and(
        inArray(workPrompts.workSessionId, [...sessionIds]),
        inArray(workPrompts.status, ["completed", "failed"]),
        isNotNull(workPrompts.dispatchedAt),
        isNotNull(workPrompts.completedAt),
      ),
    )
    .orderBy(workPrompts.workSessionId, desc(workPrompts.completedAt), desc(workPrompts.position));
  for (const r of rows) {
    if (r.completedAt === null) continue;
    out.set(r.sessionId, { authorUserId: r.authorUserId, endedAt: new Date(r.completedAt).toISOString() });
  }
  return out;
}

const lastTurnFor = (turn: LastTurn | undefined, userId: string): string | null =>
  turn && turn.authorUserId === userId ? turn.endedAt : null;

/**
 * The team projects among `projects` that ONE viewer may open (PD-04): `work_session.read` on each project's
 * `work_project` resource, built from `app.work_project_access` (the `GET /projects` decision, 07.9 D-14), through the
 * request's `filter`. One query for every project. Every surface that names a session's project to its reader decides
 * it here (the list, the detail, the visibility panel), so the rule cannot drift between them.
 */
export async function openProjects(
  tx: Tx,
  a: { viewerId: string; projects: readonly SessionProject[]; filter: ViewerFilter },
): Promise<Set<string>> {
  const open = new Set<string>();
  if (a.projects.length === 0) return open;
  const res = await tx.execute(sql`
    select u.id::text as unit_id, app.work_project_access(u.id, ${a.viewerId}::uuid) as access
      from unnest(${uuidArray(a.projects.map((p) => p.id))}) as u(id)`);
  const access = new Map(
    (res.rows as Array<{ unit_id: string; access: string | null }>).map((r) => [r.unit_id, r.access]),
  );
  const allowed = await a.filter(a.projects, "work_session.read", (p) =>
    workProjectResource({ id: p.id, path: p.path, access: access.get(p.id) ?? null }, a.viewerId),
  );
  for (const p of allowed) open.add(p.id);
  return open;
}

/**
 * Whether ONE viewer reads a session's team project named: its creator always (D-12), anyone else only when they may
 * open the project (`openProjects`). A personal repository has no project to name (true).
 */
export async function projectNamedFor(
  tx: Tx,
  a: { viewerId: string; createdBy: string; project: SessionProject | null; filter: ViewerFilter },
): Promise<boolean> {
  if (!a.project || a.createdBy === a.viewerId) return true;
  return (await openProjects(tx, { viewerId: a.viewerId, projects: [a.project], filter: a.filter })).has(
    a.project.id,
  );
}

/**
 * The per-viewer fields of `sessions` for ONE viewer (the list and the detail), by session id. One project-access
 * query over the distinct team projects the viewer did not create a session in and one last-turn query over the
 * sessions, then in-memory resolver decisions through the request's `filter` (one per project, one per session with a
 * pending approval).
 */
export async function loadViewerFields(
  tx: Tx,
  a: { viewerId: string; sessions: readonly ViewerSource[]; filter: ViewerFilter },
): Promise<Map<string, ViewerFields>> {
  const toDecide = distinctProjects(a.sessions.filter((s) => s.dto.createdBy !== a.viewerId));
  const [turns, open] = await Promise.all([
    lastTurns(
      tx,
      a.sessions.map((s) => s.dto.id),
    ),
    openProjects(tx, { viewerId: a.viewerId, projects: toDecide, filter: a.filter }),
  ]);
  // PD-05: the session-level approve decision on the viewer's own facts, only where something is pending.
  const approves = new Set(
    (
      await a.filter(
        a.sessions.filter((s) => s.dto.pendingApprovals > 0),
        "work_session.approve",
        (s) => s.facts,
      )
    ).map((s) => s.dto.id),
  );
  const out = new Map<string, ViewerFields>();
  for (const s of a.sessions) {
    const named = s.dto.createdBy === a.viewerId || (s.project !== null && open.has(s.project.id));
    out.set(
      s.dto.id,
      fieldsOf(s.project, named, {
        approval: approves.has(s.dto.id),
        lastTurnEndedAt: lastTurnFor(turns.get(s.dto.id), a.viewerId),
      }),
    );
  }
  return out;
}

/**
 * The per-viewer fields of each delivered session for EACH of its recipients (the `user:` fan-out), by session id then
 * user id. One project-access query over every (project, recipient) pair of the batch and one last-turn query over its
 * sessions; then one resolver decision per distinct project over its recipients and one per session with a pending
 * approval over its recipients (`usersAllowed`, on the facts the delivery already built).
 */
export async function loadViewerFieldsForRecipients(
  tx: Tx,
  perms: Pick<PermissionService, "usersAllowed">,
  deliveries: readonly DeliverySource[],
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
  const key = (a: string, b: string) => `${a}:${b}`;
  const open = new Set<string>();
  const turns = await lastTurns(
    tx,
    deliveries.map((d) => d.dto.id),
  );
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
  // PD-05: who among each session's recipients may decide its pending approvals, on the facts the delivery built.
  const approves = new Set<string>();
  for (const d of deliveries) {
    if (d.dto.pendingApprovals === 0 || d.recipients.length === 0) continue;
    const allowed = await perms.usersAllowed(tx, {
      candidates: [...d.recipients],
      permission: "work_session.approve",
      resourceFor: (uid) => {
        const f = d.facts.get(uid);
        if (!f) throw new Error("session facts missing for a recipient");
        return f;
      },
    });
    for (const uid of allowed) approves.add(key(d.dto.id, uid));
  }
  const out = new Map<string, Map<string, ViewerFields>>();
  for (const d of deliveries) {
    const perUser = new Map<string, ViewerFields>();
    for (const uid of d.recipients) {
      const named = uid === d.dto.createdBy || (d.project !== null && open.has(key(d.project.id, uid)));
      perUser.set(
        uid,
        fieldsOf(d.project, named, {
          approval: approves.has(key(d.dto.id, uid)),
          lastTurnEndedAt: lastTurnFor(turns.get(d.dto.id), uid),
        }),
      );
    }
    out.set(d.dto.id, perUser);
  }
  return out;
}
