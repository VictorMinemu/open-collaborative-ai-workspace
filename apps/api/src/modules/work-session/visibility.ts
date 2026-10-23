import {
  type AlwaysVisible,
  AudiencePeople,
  AudiencePreview,
  type AuthzDenial,
  EventTypes,
  type Permission,
  SessionAudienceInput,
  SessionVisibilityKind,
  UpdateWorkSessionVisibilityRequest,
  UpdateWorkSessionVisibilityResult,
  ViewerReason,
  WORK_PROJECT_LIMITS,
  type WorkProjectPerson,
  WorkProjectSearchQuery,
  type WorkSessionViewer,
  type WorkSessionViewerState,
  WorkSessionVisibilityChangedEvent,
  WorkSessionVisibilityView,
} from "@ocw/contracts";
import {
  conversations,
  devices,
  orgUnits,
  projects,
  type Tx,
  tenantOf,
  withSavepoint,
  workProjectRepos,
  workProjectTeams,
  workSessionGrants,
  workSessions,
} from "@ocw/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { badRequest, HttpError, notFound } from "../../lib/errors";
import { deviceFacts, loadDeviceAccess } from "../device";
import {
  AuthzDeniedError,
  memberDirectory,
  type PermissionService,
  type ResourceFacts,
} from "../organization";
import { sessionFacts, sessionFactsForUsers } from "./facts";
import { assignedTeams, defaultVisibilityOf, projectFacts, subtreeMemberCounts } from "./projects";
import { type SessionRow, type WorkSessionService, wsTopic } from "./service";

/**
 * Who can see a Work Zone session, through the API (Phase 07.9, D-03, D-04, D-11, D-12, D-13; UI-SPEC R2–R4, R12).
 *
 * The audience is stored as `work_sessions.visibility` plus active `work_session_grants` (ADR-0019's grant shape: one
 * active row per subject, soft-revoked); who it lets in is decided only by the SQL rule of post-migrate.sql (the
 * session facts through `facts.ts`, `app.work_session_viewers`, `app.work_project_people`) and the resolver on top of
 * it. Nothing here re-implements the rule: validation, the "who can see it" list, the people search and the draft
 * preview all ask it, a draft through a session row written in a savepoint that is always rolled back.
 *
 * A change applies at once (D-04, ADR-0009): the people it removes lose the session (404), are told on their own
 * `user:` topic (`work_session.removed { id }`, after commit) and lose their live `ws:` subscription through the
 * `work_session.visibility_changed` invalidator. Every change is audited with ids and counts only.
 */

const SessionParams = z.object({ id: z.uuid() });
const RepoParams = z.object({ projectId: z.uuid() });
const IdList = z.union([z.string().max(4000), z.array(z.string().max(100)).max(200)]).optional();
/** `?kind=&teamIds=a,b&userIds=…` (comma lists or repeated keys), validated as `SessionAudienceInput` in the handler. */
const PreviewQuery = z.object({ kind: SessionVisibilityKind, teamIds: IdList, userIds: IdList });

/** A session the caller may not know about reads exactly like a missing one (routes.ts uses the same text). */
const SESSION_NOT_FOUND = "Work session not found";
const PROJECT_NOT_FOUND = "Project not found";
/** A person whose member row is gone (left the organization); never an id or an e-mail. */
const FORMER_MEMBER = "Former member";

// ---------------------------------------------------------------- the repository a session runs on

/** The repository a session runs on (or a new one would): its device and the team project it is linked to. */
export interface AudienceTarget {
  projectId: string;
  device: typeof devices.$inferSelect;
  /** The team project (an org unit of kind `project`); null = a personal repository. */
  unit: { id: string; name: string; path: string[] } | null;
  removed: boolean;
}

/** The repository `projectId` of the caller's tenant (RLS), or null. */
export async function audienceTarget(tx: Tx, projectId: string): Promise<AudienceTarget | null> {
  const [row] = await tx
    .select({
      p: projects,
      d: devices,
      unitId: orgUnits.id,
      unitName: orgUnits.name,
      unitPath: orgUnits.path,
    })
    .from(projects)
    .innerJoin(devices, eq(devices.id, projects.deviceId))
    .leftJoin(workProjectRepos, eq(workProjectRepos.projectId, projects.id))
    .leftJoin(orgUnits, eq(orgUnits.id, workProjectRepos.unitId))
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return null;
  return {
    projectId: row.p.id,
    device: row.d,
    unit:
      row.unitId !== null && row.unitName !== null && row.unitPath !== null
        ? { id: row.unitId, name: row.unitName, path: row.unitPath }
        : null,
    removed: row.p.removedAt !== null,
  };
}

async function requireTarget(tx: Tx, projectId: string): Promise<AudienceTarget> {
  const target = await audienceTarget(tx, projectId);
  // A session always has its repository (cascade); a missing one would be a broken tenant.
  if (!target) throw new Error("work session without its repository");
  return target;
}

/**
 * D-13 (P-12): starting a session on a team-project repository needs project access, decided by the resolver as
 * `work_session.read` on the project (its `not_in_project` precondition, ADR-0024 module rows on its path). Null = may.
 */
export async function projectAccessDenial(
  tx: Tx,
  perms: PermissionService,
  userId: string,
  unit: { id: string; path: readonly string[] },
): Promise<AuthzDenial | null> {
  const { allowed, denial } = await perms.decide(
    tx,
    { kind: "user", userId },
    "work_session.read",
    await projectFacts(tx, userId, unit),
  );
  if (allowed) return null;
  return denial ?? { permission: "work_session.read", layer: "resource", reason: "not_in_project" };
}

// ---------------------------------------------------------------- stored audience

type GrantSubject = { subjectKind: "user" | "unit"; subjectId: string };

/** The grant rows an audience needs: teams as unit grants, people (never the owner, who is implied) as user grants. */
function grantsFor(input: SessionAudienceInput, ownerUserId: string): GrantSubject[] {
  if (input.kind === "teams") return input.teamIds.map((id) => ({ subjectKind: "unit", subjectId: id }));
  if (input.kind === "people") {
    return input.userIds
      .filter((id) => id !== ownerUserId)
      .map((id) => ({ subjectKind: "user", subjectId: id }));
  }
  return [];
}

const grantKey = (g: GrantSubject) => `${g.subjectKind}:${g.subjectId}`;

/**
 * Store `input` as the session's audience: its kind, and exactly its grants as the active rows (grants no longer in it,
 * including those of another kind, are soft-revoked by `actorUserId`; missing ones are inserted). Call with the session
 * LOCKED and the audience validated. `changed` is false when the stored audience already was `input`.
 */
export async function applyAudience(
  tx: Tx,
  sessionId: string,
  input: SessionAudienceInput,
  actorUserId: string,
): Promise<{ changed: boolean; from: SessionVisibilityKind }> {
  const [s] = await tx
    .select({ visibility: workSessions.visibility, createdBy: workSessions.createdBy })
    .from(workSessions)
    .where(eq(workSessions.id, sessionId));
  if (!s) throw new Error("applyAudience: unknown session");
  const want = grantsFor(input, s.createdBy);
  const active = await tx
    .select({
      id: workSessionGrants.id,
      subjectKind: workSessionGrants.subjectKind,
      subjectId: workSessionGrants.subjectId,
    })
    .from(workSessionGrants)
    .where(and(eq(workSessionGrants.workSessionId, sessionId), isNull(workSessionGrants.revokedAt)));
  const wanted = new Set(want.map(grantKey));
  const held = new Set(active.map(grantKey));
  const revoke = active.filter((g) => !wanted.has(grantKey(g)));
  const add = want.filter((g) => !held.has(grantKey(g)));
  if (revoke.length > 0) {
    await tx
      .update(workSessionGrants)
      .set({ revokedAt: sql`now()`, revokedBy: actorUserId })
      .where(
        inArray(
          workSessionGrants.id,
          revoke.map((g) => g.id),
        ),
      );
  }
  if (add.length > 0) {
    const { organizationId } = tenantOf(tx);
    await tx
      .insert(workSessionGrants)
      .values(add.map((g) => ({ organizationId, workSessionId: sessionId, grantedBy: actorUserId, ...g })))
      .onConflictDoNothing();
  }
  const kindChanged = s.visibility !== input.kind;
  if (kindChanged) {
    await tx
      .update(workSessions)
      .set({ visibility: input.kind, updatedAt: sql`now()` })
      .where(eq(workSessions.id, sessionId));
  }
  return { changed: kindChanged || revoke.length > 0 || add.length > 0, from: s.visibility };
}

type DraftSession = Pick<SessionRow, "id" | "createdBy" | "deviceId">;

/**
 * Run `fn` on a session that does not exist yet: a row on the same repository and device, created by `ownerUserId`
 * with `input` as its audience, written in a savepoint that is ALWAYS rolled back. This is how a draft is judged by the
 * one SQL rule (validation of a new audience, the people who could be picked, the draft preview) without a second
 * copy of it. Nothing is published or audited from inside.
 */
async function withDraft<T>(
  tx: Tx,
  target: AudienceTarget,
  ownerUserId: string,
  input: SessionAudienceInput,
  fn: (sp: Tx, draft: DraftSession) => Promise<T>,
): Promise<T> {
  return withSavepoint(
    tx,
    async (sp) => {
      const { organizationId } = tenantOf(sp);
      const [conv] = await sp
        .insert(conversations)
        .values({
          organizationId,
          kind: "work_session",
          name: "Draft",
          visibility: "public",
          createdBy: ownerUserId,
        })
        .returning({ id: conversations.id });
      const [s] = await sp
        .insert(workSessions)
        .values({
          organizationId,
          conversationId: conv!.id,
          projectId: target.projectId,
          deviceId: target.device.id,
          title: "Draft",
          createdBy: ownerUserId,
          visibility: input.kind,
        })
        .returning({ id: workSessions.id });
      await applyAudience(sp, s!.id, input, ownerUserId);
      return fn(sp, { id: s!.id, createdBy: ownerUserId, deviceId: target.device.id });
    },
    () => false,
  );
}

// ---------------------------------------------------------------- validation

export type AudienceRefusalCode = "audience_outside_project" | "team_not_assigned";

/** Why an audience was refused, with the offending entry ids only (never names). */
export interface AudienceRefusal {
  code: AudienceRefusalCode;
  message: string;
  ids: string[];
}

const REFUSAL_MESSAGE: Record<AudienceRefusalCode, string> = {
  audience_outside_project: "Only people with access to the project can be chosen",
  team_not_assigned: "Only teams assigned to the project can be chosen",
};

const refusal = (code: AudienceRefusalCode, ids: string[]): AudienceRefusal => ({
  code,
  message: REFUSAL_MESSAGE[code],
  ids,
});

/** 422 with the entry ids (`details.ids`). */
export const audienceError = (r: AudienceRefusal) => new HttpError(422, r.code, r.message, { ids: r.ids });

/**
 * Whether `input` stays within the repository's access (D-04): every team is assigned to its team project (a personal
 * repository has none: `team_not_assigned`); every person (the owner aside, who is implied) would see a session with
 * that audience by the SQL rule (`viewer`: project access on a team project, the use of the device on a personal
 * one). Ids of another organization are simply not found (RLS): refused, never a 500.
 */
export async function checkAudience(
  tx: Tx,
  target: AudienceTarget,
  input: SessionAudienceInput,
  ownerUserId: string,
): Promise<AudienceRefusal | null> {
  if (input.kind === "teams") {
    if (!target.unit) return refusal("team_not_assigned", input.teamIds);
    const rows = await tx
      .select({ id: workProjectTeams.teamUnitId })
      .from(workProjectTeams)
      .where(
        and(
          eq(workProjectTeams.projectUnitId, target.unit.id),
          inArray(workProjectTeams.teamUnitId, input.teamIds),
        ),
      );
    const assigned = new Set(rows.map((r) => r.id));
    const missing = input.teamIds.filter((id) => !assigned.has(id));
    return missing.length > 0 ? refusal("team_not_assigned", missing) : null;
  }
  if (input.kind === "people") {
    const ids = input.userIds.filter((id) => id !== ownerUserId);
    if (ids.length === 0) return null;
    // The draft's facts per person (facts.ts, the one builder): `viewer` = the rule lets them see it.
    const seeing = await withDraft(tx, target, ownerUserId, { kind: "people", userIds: ids }, (sp, d) =>
      sessionFactsForUsers(sp, d, ids),
    );
    const outside = ids.filter((id) => !seeing.get(id)?.relations.has("viewer"));
    return outside.length > 0 ? refusal("audience_outside_project", outside) : null;
  }
  return null;
}

/** `checkAudience`, thrown as the 422 (`audience_outside_project`, `team_not_assigned`). */
export async function validateAudience(
  tx: Tx,
  target: AudienceTarget,
  input: SessionAudienceInput,
  ownerUserId: string,
): Promise<void> {
  const r = await checkAudience(tx, target, input, ownerUserId);
  if (r) throw audienceError(r);
}

// ---------------------------------------------------------------- who can see it

interface Reader {
  userId: string;
  reason: ViewerReason;
  via: string | null;
}

/**
 * Who can see the session now: `app.work_session_viewers` (the one enumerator, never admins for being admins) filtered
 * by the resolver's `work_session.read` on each person's own facts (a role without the Work Zone, a deny rule or the
 * module off on the project's path takes a person out).
 */
async function readers(tx: Tx, perms: PermissionService, s: DraftSession): Promise<Reader[]> {
  const res = await tx.execute(sql`
    select v.user_id::text as user_id, v.reason, v.via::text as via from app.work_session_viewers(${s.id}::uuid) v`);
  const rows = (res.rows as Array<{ user_id: string; reason: string; via: string | null }>).flatMap((r) => {
    const reason = ViewerReason.safeParse(r.reason);
    return reason.success ? [{ userId: r.user_id, reason: reason.data, via: r.via }] : [];
  });
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.userId);
  const facts = await sessionFactsForUsers(tx, s, ids);
  const allowed = new Set(
    await perms.usersAllowed(tx, {
      candidates: ids,
      permission: "work_session.read",
      resourceFor: (id) => facts.get(id) as ResourceFacts,
    }),
  );
  return rows.filter((r) => allowed.has(r.userId));
}

/** Of `userIds` (people who could read before a change), those who still may now. */
async function stillReading(
  tx: Tx,
  perms: PermissionService,
  s: DraftSession,
  userIds: readonly string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const facts = await sessionFactsForUsers(tx, s, userIds);
  return new Set(
    await perms.usersAllowed(tx, {
      candidates: userIds,
      permission: "work_session.read",
      resourceFor: (id) => facts.get(id) as ResourceFacts,
    }),
  );
}

type Directory = Awaited<ReturnType<typeof memberDirectory>>;

const nameIn = (dir: Directory, userId: string) => dir.get(userId)?.displayName ?? FORMER_MEMBER;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const byName = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

/** Owner first, then the device owner, then by name (UI-SPEC "See all"). */
function sortReaders(rows: Reader[], dir: Directory): Reader[] {
  const rank = (r: ViewerReason) => (r === "owner" || r === "owner_left" ? 0 : r === "device_owner" ? 1 : 2);
  return [...rows].sort(
    (a, b) =>
      rank(a.reason) - rank(b.reason) ||
      byName(nameIn(dir, a.userId), nameIn(dir, b.userId)) ||
      (a.userId < b.userId ? -1 : 1),
  );
}

const personOf = (dir: Directory, userId: string): WorkProjectPerson => ({
  userId,
  name: nameIn(dir, userId),
  avatarUrl: dir.get(userId)?.avatarUrl ?? null,
});

/** D-11: the device owner always sees the session; named in the footer when they are not its owner. */
function alwaysVisibleOf(
  target: AudienceTarget,
  creatorId: string,
  callerId: string,
  dir: Directory,
): AlwaysVisible {
  const owner = target.device.ownerUserId;
  return {
    admins: true,
    deviceOwner:
      owner && owner !== creatorId
        ? {
            userId: owner,
            firstName: firstName(nameIn(dir, owner)),
            deviceName: target.device.name,
            isViewer: owner === callerId,
          }
        : null,
  };
}

/**
 * D-12 for the caller: `left_project` when they created the session, left its team project since and the resolver
 * therefore refuses them new prompts (an admin creator, or the device owner, keeps every right: null).
 */
export async function viewerStateOf(
  perms: PermissionService,
  tx: Tx,
  userId: string,
  facts: ResourceFacts,
): Promise<WorkSessionViewerState | null> {
  if (!facts.state.has("creator_left")) return null;
  const { denial } = await perms.decide(tx, { kind: "user", userId }, "work_session.prompt", facts);
  return denial?.reason === "left_project" ? "left_project" : null;
}

/** The visibility panel (UI-SPEC Surface 1, R2, R12) of session `s` for the request's caller. */
export async function visibilityView(
  req: FastifyRequest,
  tx: Tx,
  perms: PermissionService,
  s: SessionRow,
): Promise<WorkSessionVisibilityView> {
  const { userId } = authOf(req);
  const target = await requireTarget(tx, s.projectId);
  const facts = await sessionFacts(tx, userId, s);
  const dir = await memberDirectory(tx);
  const grants = await tx
    .select({ subjectKind: workSessionGrants.subjectKind, subjectId: workSessionGrants.subjectId })
    .from(workSessionGrants)
    .where(and(eq(workSessionGrants.workSessionId, s.id), isNull(workSessionGrants.revokedAt)));

  // Teams: every assigned team, plus selected teams no longer assigned (shown inactive, UI-SPEC §1.5).
  const teams: WorkSessionVisibilityView["teams"] = [];
  if (target.unit) {
    const selected = new Set(grants.filter((g) => g.subjectKind === "unit").map((g) => g.subjectId));
    const assigned = await assignedTeams(tx, target.unit.id);
    for (const t of assigned) teams.push({ ...t, selected: selected.has(t.id), active: true });
    const gone = [...selected].filter((id) => !assigned.some((t) => t.id === id));
    if (gone.length > 0) {
      const units = await tx
        .select({ id: orgUnits.id, name: orgUnits.name, kind: orgUnits.kind })
        .from(orgUnits)
        .where(inArray(orgUnits.id, gone));
      const counts = await subtreeMemberCounts(
        tx,
        units.map((u) => u.id),
      );
      for (const u of units.sort((a, b) => byName(a.name, b.name))) {
        if (u.kind === "project") continue;
        teams.push({
          id: u.id,
          name: u.name,
          kind: u.kind,
          memberCount: counts.get(u.id) ?? 0,
          selected: true,
          active: false,
        });
      }
    }
  }

  // People: the chosen people (owner aside); `active` = the rule still lets them see it (project access, D-04).
  const chosen = grants
    .filter((g) => g.subjectKind === "user" && g.subjectId !== s.createdBy)
    .map((g) => g.subjectId);
  const seeing = await sessionFactsForUsers(tx, s, chosen);
  const people = chosen
    .map((id) => ({ ...personOf(dir, id), active: seeing.get(id)?.relations.has("viewer") === true }))
    .sort((a, b) => byName(a.name, b.name) || (a.userId < b.userId ? -1 : 1));

  // Who can see it now, with one reason each.
  const list = sortReaders(await readers(tx, perms, s), dir);
  const shown = list.slice(0, WORK_PROJECT_LIMITS.viewersMax);
  const teamIds = [...new Set(shown.flatMap((r) => (r.reason === "team" && r.via ? [r.via] : [])))];
  const teamNames = new Map(
    teamIds.length === 0
      ? []
      : (
          await tx
            .select({ id: orgUnits.id, name: orgUnits.name })
            .from(orgUnits)
            .where(inArray(orgUnits.id, teamIds))
        ).map((u) => [u.id, u.name]),
  );
  const viewers: WorkSessionViewer[] = shown.map((r) => {
    let via: WorkSessionViewer["via"] = null;
    if (r.reason === "team" && r.via && teamNames.has(r.via)) {
      via = { id: r.via, name: teamNames.get(r.via) as string };
    } else if (r.reason === "device") {
      via = { id: target.device.id, name: target.device.name };
    }
    return { ...personOf(dir, r.userId), reason: r.reason, via };
  });

  return WorkSessionVisibilityView.parse({
    kind: s.visibility,
    projectDefault: target.unit ? await defaultVisibilityOf(tx, target.unit.id) : null,
    project: target.unit
      ? { kind: "team", id: target.unit.id, name: target.unit.name }
      : { kind: "personal", deviceName: target.device.name },
    owner: { userId: s.createdBy, name: nameIn(dir, s.createdBy) },
    teams,
    people,
    viewers: { count: list.length, people: viewers, more: list.length - shown.length },
    alwaysVisible: alwaysVisibleOf(target, s.createdBy, userId, dir),
    viewerCan: { change: await perms.can(req, tx, "work_session.visibility", facts) },
    viewerState: await viewerStateOf(perms, tx, userId, facts),
  });
}

// ---------------------------------------------------------------- people search and draft preview

/** Lower-cased, accent-free text for the name search ("Álvarez" matches "alv"). */
const fold = (v: string) =>
  v
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/**
 * People who may be chosen for a session on `target` (D-04): project access on a team project
 * (`app.work_project_people`, never admins as such), the use of the device on a personal one (the rule's `device`
 * reason, judged on a draft). Not the owner (implied) nor the device owner (always sees, D-11). Active members only,
 * matched on the display name, at most 10.
 */
async function searchPeople(
  tx: Tx,
  target: AudienceTarget,
  ownerUserId: string,
  q: string | undefined,
): Promise<WorkProjectPerson[]> {
  let ids: string[];
  if (target.unit) {
    const res = await tx.execute(
      sql`select user_id::text as user_id from app.work_project_people(${target.unit.id}::uuid)`,
    );
    ids = (res.rows as Array<{ user_id: string }>).map((r) => r.user_id);
  } else {
    ids = await withDraft(tx, target, ownerUserId, { kind: "project" }, async (sp, d) => {
      const res = await sp.execute(sql`
        select user_id::text as user_id from app.work_session_viewers(${d.id}::uuid) where reason = 'device'`);
      return (res.rows as Array<{ user_id: string }>).map((r) => r.user_id);
    });
  }
  const dir = await memberDirectory(tx);
  const needle = q ? fold(q) : "";
  return ids
    .filter((id) => id !== ownerUserId && id !== target.device.ownerUserId)
    .flatMap((id) => {
      const m = dir.get(id);
      if (m?.status !== "active") return [];
      return needle === "" || fold(m.displayName).includes(needle) ? [personOf(dir, id)] : [];
    })
    .sort((a, b) => byName(a.name, b.name) || (a.userId < b.userId ? -1 : 1))
    .slice(0, WORK_PROJECT_LIMITS.peopleSearchMax);
}

/** A comma list or repeated key, as ids (shape only; `SessionAudienceInput` checks them). */
const idsOf = (v: string | string[] | undefined) =>
  v === undefined
    ? undefined
    : (Array.isArray(v) ? v : [v])
        .flatMap((x) => x.split(","))
        .map((x) => x.trim())
        .filter((x) => x !== "");

// ---------------------------------------------------------------- routes

export function registerVisibilityRoutes(
  app: App,
  core: Core,
  deps: { perms: PermissionService; svc: WorkSessionService },
): void {
  const { perms, svc } = deps;
  const tags = ["work-session"];
  const user = { config: { authz: "user" as const }, preHandler: core.identity.requireUser };

  // D-04, ADR-0009 (P-09): an audience change re-decides every live subscription to the session's stream through the
  // `ws:` topic authorizer, so someone it removed loses the live view at once (the AI-chat grant precedent).
  core.realtime.registerSubscriptionInvalidator(EventTypes.workSessionVisibilityChanged, (topic, payload) =>
    topic.startsWith("ws:") && WorkSessionVisibilityChangedEvent.safeParse(payload).success
      ? { topics: [topic] }
      : null,
  );

  /** `permission` on `resource`, every denial served as a 404 with `message` (same body as a missing id). */
  async function assertHidden(
    req: FastifyRequest,
    tx: Tx,
    permission: Permission,
    resource: ResourceFacts,
    message: string,
  ): Promise<void> {
    await perms.assertCan(req, tx, permission, resource, { hideAs404: true }).catch((err) => {
      if (err instanceof AuthzDeniedError && err.hidden) {
        throw new AuthzDeniedError(err.denial, { hideAs404: true, message });
      }
      throw err;
    });
  }

  /** The session (locked for a write), readable by the caller (else the 404 of a missing session), and its facts. */
  async function readable(req: FastifyRequest, tx: Tx, id: string, lock: boolean) {
    const s = lock
      ? await svc.lock(tx, id)
      : ((await tx.select().from(workSessions).where(eq(workSessions.id, id)))[0] ?? null);
    if (!s) throw notFound(SESSION_NOT_FOUND);
    const facts = await sessionFacts(tx, authOf(req).userId, s);
    await assertHidden(req, tx, "work_session.read", facts, SESSION_NOT_FOUND);
    return { s, facts };
  }

  /**
   * A repository the caller could start a session on (D-13, P-12): `device.use` on its device and, for a team-project
   * repository, project access. Anything else is the 404 of a missing project.
   */
  async function starterTarget(req: FastifyRequest, tx: Tx, projectId: string): Promise<AudienceTarget> {
    const { userId } = authOf(req);
    const target = await audienceTarget(tx, projectId);
    if (!target || target.removed || target.device.revokedAt !== null) throw notFound(PROJECT_NOT_FOUND);
    const access = await loadDeviceAccess(tx, userId);
    await assertHidden(req, tx, "device.use", deviceFacts(target.device, userId, access), PROJECT_NOT_FOUND);
    if (target.unit) {
      await assertHidden(
        req,
        tx,
        "work_session.read",
        await projectFacts(tx, userId, target.unit),
        PROJECT_NOT_FOUND,
      );
    }
    return target;
  }

  app.get(
    "/work-sessions/:id/visibility",
    { ...user, schema: { tags, params: SessionParams, response: { 200: WorkSessionVisibilityView } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { s } = await readable(req, tx, req.params.id, false);
        return visibilityView(req, tx, perms, s);
      }),
  );

  app.put(
    "/work-sessions/:id/visibility",
    {
      ...user,
      schema: {
        tags,
        params: SessionParams,
        body: UpdateWorkSessionVisibilityRequest,
        response: { 200: UpdateWorkSessionVisibilityResult },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const input = req.body;
        const { s, facts } = await readable(req, tx, req.params.id, true);
        // The creator, a project lead (ADR-0024 as implemented) or an admin; a creator who left is `left_project`.
        await perms.assertCan(req, tx, "work_session.visibility", facts);
        await validateAudience(tx, await requireTarget(tx, s.projectId), input, s.createdBy);

        const before = (await readers(tx, perms, s)).map((r) => r.userId);
        const { changed, from } = await applyAudience(tx, s.id, input, auth.userId);
        let removed: string[] = [];
        if (changed) {
          const still = await stillReading(tx, perms, s, before);
          removed = before.filter((id) => !still.has(id));
          await core.audit.record(tx, {
            action: "work_session.visibility_changed",
            resourceType: "work_session",
            resourceId: s.id,
            sessionId: s.id,
            deviceId: s.deviceId,
            clientKind: auth.clientKind,
            // Ids and counts only (T-07.9-06-04).
            metadata: {
              from,
              to: input.kind,
              teamCount: input.kind === "teams" ? input.teamIds.length : 0,
              peopleCount: grantsFor(input, s.createdBy).filter((g) => g.subjectKind === "user").length,
              removedCount: removed.length,
            },
          });
          await core.realtime.appendEvent(tx, wsTopic(s.id), EventTypes.workSessionVisibilityChanged, {
            workSessionId: s.id,
          });
          await svc.emitSession(tx, s.id);
          const gone = [...removed];
          tenantOf(tx).afterCommit(async () => {
            for (const uid of gone) {
              await core.realtime.publishEphemeral(`user:${uid}`, EventTypes.workSessionRemoved, {
                id: s.id,
              });
            }
          });
        }
        const dir = await memberDirectory(tx);
        const [fresh] = await tx.select().from(workSessions).where(eq(workSessions.id, s.id));
        return {
          visibility: await visibilityView(req, tx, perms, fresh ?? s),
          removedCount: removed.length,
          // Names go only to the editor, in this response (never in the audit or an event).
          removedNames: removed
            .map((id) => nameIn(dir, id))
            .sort(byName)
            .slice(0, WORK_PROJECT_LIMITS.removedNamesMax),
        };
      }),
  );

  app.get(
    "/work-sessions/:id/visibility/people",
    {
      ...user,
      schema: {
        tags,
        params: SessionParams,
        querystring: WorkProjectSearchQuery,
        response: { 200: AudiencePeople },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { s, facts } = await readable(req, tx, req.params.id, false);
        // Only an editor searches the people of the project (T-07.9-06-07).
        await perms.assertCan(req, tx, "work_session.visibility", facts);
        return {
          people: await searchPeople(tx, await requireTarget(tx, s.projectId), s.createdBy, req.query.q),
        };
      }),
  );

  app.get(
    "/projects/:projectId/audience/people",
    {
      ...user,
      schema: {
        tags,
        params: RepoParams,
        querystring: WorkProjectSearchQuery,
        response: { 200: AudiencePeople },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const target = await starterTarget(req, tx, req.params.projectId);
        return { people: await searchPeople(tx, target, authOf(req).userId, req.query.q) };
      }),
  );

  app.get(
    "/projects/:projectId/audience/preview",
    {
      ...user,
      schema: { tags, params: RepoParams, querystring: PreviewQuery, response: { 200: AudiencePreview } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { userId } = authOf(req);
        const target = await starterTarget(req, tx, req.params.projectId);
        const teamIds = idsOf(req.query.teamIds);
        const userIds = idsOf(req.query.userIds);
        const parsed = SessionAudienceInput.safeParse({
          kind: req.query.kind,
          ...(teamIds !== undefined ? { teamIds } : {}),
          ...(userIds !== undefined ? { userIds } : {}),
        });
        if (!parsed.success) throw badRequest("This audience is not valid", "invalid_audience");
        await validateAudience(tx, target, parsed.data, userId);
        // The would-be viewers of a session with this audience, started by the caller on this repository.
        const list = await withDraft(tx, target, userId, parsed.data, (sp, d) => readers(sp, perms, d));
        const dir = await memberDirectory(tx);
        return {
          count: list.length,
          people: sortReaders(list, dir)
            .slice(0, WORK_PROJECT_LIMITS.previewPeople)
            .map((r) => personOf(dir, r.userId)),
          alwaysVisible: alwaysVisibleOf(target, userId, userId, dir),
        };
      }),
  );
}
