import type { APIRequestContext, APIResponse } from "@playwright/test";
import { ApiError, Ok } from "../../packages/contracts/src/common.ts";
import { DeviceGrant } from "../../packages/contracts/src/device.ts";
import { OrgUnit, OrgUnitList, UnitMember } from "../../packages/contracts/src/organization.ts";
import type { PermissionMode } from "../../packages/contracts/src/session-events.ts";
import { WorkProjectDetail } from "../../packages/contracts/src/work-projects.ts";
import {
  type SessionAudienceInput,
  UpdateWorkSessionVisibilityResult,
} from "../../packages/contracts/src/work-session.ts";

/**
 * Explicit access to someone else's Work Zone session for the e2e specs (Phase 07.9, D-06, P-07). Since the flip a
 * session is seen by its audience within project access, plus its creator, its device owner and admins; a spec in which
 * a second person follows or acts on a session gives that person access the way a real admin, lead or device owner
 * would, through the public API only (never the database):
 *   - `createTeamProject` + `linkRepo`: a team project holding the people, with the session's repository linked (the
 *     default; it leaves device access unchanged);
 *   - `shareDevice`: a device grant (ADR-0012), only where the spec is about device sharing (it also changes
 *     `device.use` and the person's mode cap).
 * `removeTeamProject` undoes `createTeamProject` in the spec's `finally`: a project with linked repositories cannot be
 * deleted (`unit_has_repositories`), so one left behind would break the next spec that clears every unit (admin-org).
 * Every response is parsed with its contract schema; a refusal throws with the route, the status and the error code.
 * 07.9-10 adds `setAudience`; keep these exports stable.
 */

/** The error code of a refused request (`ApiError`), or `unknown` when the body is not one. */
async function errorCode(res: APIResponse): Promise<string> {
  try {
    const body = ApiError.safeParse(await res.json());
    return body.success ? body.data.error.code : "unknown";
  } catch {
    return "unknown";
  }
}

const refused = (what: string, res: APIResponse, code: string) =>
  new Error(`${what}: HTTP ${res.status()} ${code}`);

/** A contract schema (zod): only `parse` is used, so this file needs no zod import of its own. */
interface Schema<T> {
  parse(data: unknown): T;
}

async function parsed<T>(what: string, res: APIResponse, schema: Schema<T>): Promise<T> {
  if (!res.ok()) throw refused(what, res, await errorCode(res));
  return schema.parse(await res.json());
}

/** A team project `createTeamProject` made; `ownParent`: its parent is the department the helper named for it. */
export interface TeamProject {
  unitId: string;
  parentId: string;
  ownParent: boolean;
}

/**
 * A team project (org unit of kind `project`, D-01) holding `members`, created by `admin` (an admin or a lead of the
 * parent, who becomes its lead automatically, D-13). The parent is the team or department named `parentName`, or a
 * top-level department `"<name> department"`; either is created when it does not exist yet. A project of that name
 * already under the parent (a retried test) is reused, and a person who already belongs to it is left as they are.
 */
export async function createTeamProject(
  admin: APIRequestContext,
  opts: { name: string; parentName?: string; members: Array<{ userId: string; role?: "member" | "lead" }> },
): Promise<TeamProject> {
  const { units } = await parsed("GET /api/v1/units", await admin.get("/api/v1/units"), OrgUnitList);
  const parentName = opts.parentName ?? `${opts.name} department`;
  let parent: OrgUnit | undefined = units.find(
    (u) => u.name === parentName && (u.kind === "team" || u.kind === "department"),
  );
  if (!parent) {
    parent = await parsed(
      "POST /api/v1/units",
      await admin.post("/api/v1/units", { data: { kind: "department", name: parentName, parentId: null } }),
      OrgUnit,
    );
  }
  const parentId = parent.id;
  let unitId = units.find((u) => u.kind === "project" && u.parentId === parentId && u.name === opts.name)?.id;
  if (!unitId) {
    const project = await parsed(
      "POST /api/v1/work-projects",
      await admin.post("/api/v1/work-projects", { data: { name: opts.name, parentId } }),
      WorkProjectDetail,
    );
    unitId = project.id;
  }
  for (const m of opts.members) {
    const res = await admin.post(`/api/v1/units/${unitId}/members`, {
      data: { userId: m.userId, role: m.role ?? "member" },
    });
    if (res.ok()) {
      UnitMember.parse(await res.json());
      continue;
    }
    const code = await errorCode(res);
    if (res.status() === 409 && code === "already_member") continue;
    throw refused(`POST /api/v1/units/${unitId}/members`, res, code);
  }
  return { unitId, parentId, ownParent: opts.parentName === undefined };
}

/**
 * Removes a team project made by `createTeamProject`: unlinks its repositories (`DELETE …/repos/:projectId`, which needs
 * only `work_project.manage`, so a revoked device's repository unlinks too), deletes the project unit, then the
 * department the helper named for it unless other units still sit there. A project already gone is a no-op.
 */
export async function removeTeamProject(admin: APIRequestContext, project: TeamProject): Promise<void> {
  const res = await admin.get(`/api/v1/work-projects/${project.unitId}`);
  if (res.status() === 404) return;
  const detail = await parsed(`GET /api/v1/work-projects/${project.unitId}`, res, WorkProjectDetail);
  for (const repo of detail.repos) {
    const path = `/api/v1/work-projects/${project.unitId}/repos/${repo.projectId}`;
    await parsed(`DELETE ${path}`, await admin.delete(path), WorkProjectDetail);
  }
  await parsed(
    `DELETE /api/v1/units/${project.unitId}`,
    await admin.delete(`/api/v1/units/${project.unitId}`),
    Ok,
  );
  if (!project.ownParent) return;
  const parent = await admin.delete(`/api/v1/units/${project.parentId}`);
  if (parent.ok()) return;
  const code = await errorCode(parent);
  if (parent.status() === 409 && code === "unit_has_children") return;
  throw refused(`DELETE /api/v1/units/${project.parentId}`, parent, code);
}

/**
 * Links the repository `projectId` (an `app.projects` row a device announced) to the team project `unitId`
 * (`POST /api/v1/work-projects/:unitId/repos`): its sessions then belong to the project. `lead` needs
 * `work_project.manage` on the project and `device.use` on the repository's device (D-10).
 */
export async function linkRepo(lead: APIRequestContext, unitId: string, projectId: string): Promise<void> {
  await parsed(
    `POST /api/v1/work-projects/${unitId}/repos`,
    await lead.post(`/api/v1/work-projects/${unitId}/repos`, { data: { projectId } }),
    WorkProjectDetail,
  );
}

/**
 * The device owner shares `deviceId` with `userId` up to `maxMode` (`PUT /api/v1/devices/:id/grants/user/:userId`,
 * ADR-0012). Use it only where the spec is about device sharing; `createTeamProject` + `linkRepo` is the default.
 */
export async function shareDevice(
  owner: APIRequestContext,
  deviceId: string,
  userId: string,
  maxMode: PermissionMode = "default",
): Promise<void> {
  await parsed(
    `PUT /api/v1/devices/${deviceId}/grants/user/${userId}`,
    await owner.put(`/api/v1/devices/${deviceId}/grants/user/${userId}`, { data: { maxMode } }),
    DeviceGrant,
  );
}

/**
 * Sets who can see the session `sessionId` (`PUT /api/v1/work-sessions/:id/visibility`, 07.9-06) as `editor` (its
 * creator, a project lead or an admin) and returns the API's answer: the new panel view and who lost access. Entries
 * outside the project are refused by the API (422), never filtered here (07.9-10).
 */
export async function setAudience(
  editor: APIRequestContext,
  sessionId: string,
  input: SessionAudienceInput,
): Promise<UpdateWorkSessionVisibilityResult> {
  const path = `/api/v1/work-sessions/${sessionId}/visibility`;
  return parsed(`PUT ${path}`, await editor.put(path, { data: input }), UpdateWorkSessionVisibilityResult);
}
