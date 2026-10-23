import type { APIRequestContext, APIResponse } from "@playwright/test";
import type { z } from "zod";
import { ApiError } from "../../packages/contracts/src/common.ts";
import { DeviceGrant } from "../../packages/contracts/src/device.ts";
import { OrgUnit, OrgUnitList, UnitMember } from "../../packages/contracts/src/organization.ts";
import type { PermissionMode } from "../../packages/contracts/src/session-events.ts";
import { WorkProjectDetail } from "../../packages/contracts/src/work-projects.ts";

/**
 * Explicit access to someone else's Work Zone session for the e2e specs (Phase 07.9, D-06, P-07). Since the flip a
 * session is seen by its audience within project access, plus its creator, its device owner and admins; a spec in which
 * a second person follows or acts on a session gives that person access the way a real admin, lead or device owner
 * would, through the public API only (never the database):
 *   - `createTeamProject` + `linkRepo`: a team project holding the people, with the session's repository linked (the
 *     default; it leaves device access unchanged);
 *   - `shareDevice`: a device grant (ADR-0012), only where the spec is about device sharing (it also changes
 *     `device.use` and the person's mode cap).
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

async function parsed<S extends z.ZodType>(what: string, res: APIResponse, schema: S): Promise<z.infer<S>> {
  if (!res.ok()) throw refused(what, res, await errorCode(res));
  return schema.parse(await res.json());
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
): Promise<{ unitId: string; parentId: string }> {
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
  return { unitId, parentId };
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
