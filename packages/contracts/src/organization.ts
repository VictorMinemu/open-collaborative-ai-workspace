import { z } from "zod";
import { Id, IsoDateTime, OrgRole } from "./common";
import {
  NON_DELEGABLE_PERMISSIONS,
  Permission,
  PermissionPattern,
  permissionMatches,
  RuleEffect,
  RuleSubjectKind,
  UnitKind,
  UnitRole,
} from "./permissions";

export const MemberStatus = z.enum(["active", "deactivated"]);
export type MemberStatus = z.infer<typeof MemberStatus>;

/** Projection of an org member (maintained by identity in `app.org_members`). */
export const Member = z.object({
  userId: Id,
  displayName: z.string(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: OrgRole,
  /** `deactivated` members cannot sign in and every permission is denied to them. */
  status: MemberStatus,
  statusEmoji: z.string().nullable(),
  statusText: z.string().nullable(),
  joinedAt: IsoDateTime,
});
export type Member = z.infer<typeof Member>;

export const MemberList = z.object({ members: z.array(Member) });
export type MemberList = z.infer<typeof MemberList>;

export const UserIdParams = z.object({ userId: Id });
export type UserIdParams = z.infer<typeof UserIdParams>;

export const UpdateMemberRoleRequest = z.object({ role: OrgRole });
export type UpdateMemberRoleRequest = z.infer<typeof UpdateMemberRoleRequest>;

// ---------------------------------------------------------------- hierarchy (ORG-01, ORG-02)

/** A unit chip on a member row. */
export const MemberUnitRef = z.object({ unitId: Id, name: z.string(), kind: UnitKind, role: UnitRole });
export type MemberUnitRef = z.infer<typeof MemberUnitRef>;

export const MemberDetail = Member.extend({ units: z.array(MemberUnitRef) });
export type MemberDetail = z.infer<typeof MemberDetail>;

export const MemberDetailList = z.object({ members: z.array(MemberDetail) });
export type MemberDetailList = z.infer<typeof MemberDetailList>;

export const UnitName = z.string().trim().min(1).max(80);
export type UnitName = z.infer<typeof UnitName>;

/** A department, team or project (hierarchy projects; not `app.projects`, Pitfall 12). */
export const OrgUnit = z.object({
  id: Id,
  /** null = top level. */
  parentId: Id.nullable(),
  kind: UnitKind,
  name: z.string(),
  /** Ancestor ids root → self (self last). */
  path: z.array(Id),
  memberCount: z.number().int().nonnegative(),
  leadCount: z.number().int().nonnegative(),
  /** What the viewer may do on this unit (resolver output; the web never re-implements policy). */
  viewerCan: z.array(Permission),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrgUnit = z.infer<typeof OrgUnit>;

export const OrgUnitList = z.object({ units: z.array(OrgUnit), lastSeq: z.number().int().nonnegative() });
export type OrgUnitList = z.infer<typeof OrgUnitList>;

export const CreateUnitRequest = z.object({ kind: UnitKind, name: UnitName, parentId: Id.nullable() });
export type CreateUnitRequest = z.infer<typeof CreateUnitRequest>;

export const RenameUnitRequest = z.object({ name: UnitName });
export type RenameUnitRequest = z.infer<typeof RenameUnitRequest>;

/** `parentId: null` moves the unit to the top level. */
export const MoveUnitRequest = z.object({ parentId: Id.nullable() });
export type MoveUnitRequest = z.infer<typeof MoveUnitRequest>;

export const UnitMember = z.object({
  userId: Id,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  orgRole: OrgRole,
  role: UnitRole,
  status: MemberStatus,
  addedAt: IsoDateTime,
});
export type UnitMember = z.infer<typeof UnitMember>;

export const UnitMemberList = z.object({ members: z.array(UnitMember) });
export type UnitMemberList = z.infer<typeof UnitMemberList>;

export const AddUnitMemberRequest = z.object({ userId: Id, role: UnitRole.default("member") });
export type AddUnitMemberRequest = z.infer<typeof AddUnitMemberRequest>;

export const UpdateUnitMemberRequest = z.object({ role: UnitRole });
export type UpdateUnitMemberRequest = z.infer<typeof UpdateUnitMemberRequest>;

export const UnitMemberParams = z.object({ id: Id, userId: Id });
export type UnitMemberParams = z.infer<typeof UnitMemberParams>;

// ---------------------------------------------------------------- explicit rules (ORG-03, D-02)

export const PermissionRule = z.object({
  id: Id,
  /** null = the whole organization; otherwise the unit subtree. */
  scopeUnitId: Id.nullable(),
  subjectKind: RuleSubjectKind,
  /** Role name, user id or agent id; null for `everyone`. */
  subjectId: z.string().nullable(),
  /** Exact permission or `prefix.*`. */
  permission: z.string(),
  tool: z.string().nullable(),
  effect: RuleEffect,
  createdBy: Id.nullable(),
  createdAt: IsoDateTime,
});
export type PermissionRule = z.infer<typeof PermissionRule>;

export const PermissionRuleList = z.object({ rules: z.array(PermissionRule) });
export type PermissionRuleList = z.infer<typeof PermissionRuleList>;

/**
 * Tool-layer name: a Work Zone tool such as `Bash` or `mcp__github:create_pr`, or a bot tool (an MCP tool
 * `<safeServerName>__<tool>` or a plugin tool) for `bot.tool.use`.
 */
export const RuleTool = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/);

/**
 * The permissions a tool-layer rule refines: Work Zone approvals and bot tool use (Phase 3.1, so an admin can
 * deny one MCP or plugin tool to a role, unit or user).
 */
const TOOL_PERMISSIONS: readonly Permission[] = ["work_session.approve", "bot.tool.use"];

export const CreatePermissionRuleRequest = z
  .object({
    scopeUnitId: Id.nullable().default(null),
    subjectKind: RuleSubjectKind,
    subjectId: z.string().max(64).nullable().default(null),
    permission: PermissionPattern,
    tool: RuleTool.nullable().default(null),
    effect: RuleEffect,
  })
  .superRefine((r, ctx) => {
    const subjectOk =
      r.subjectKind === "everyone"
        ? r.subjectId === null
        : r.subjectKind === "role"
          ? OrgRole.safeParse(r.subjectId).success
          : Id.safeParse(r.subjectId).success;
    if (!subjectOk) {
      const expected = { everyone: "null", role: "a role", user: "a user id", agent: "an agent id" };
      ctx.addIssue({
        code: "custom",
        path: ["subjectId"],
        message: `must be ${expected[r.subjectKind]} for subject kind ${r.subjectKind}`,
      });
    }
    // Admin- and runtime-surface permissions are never granted by an allow rule (deny is always fine).
    if (r.effect === "allow" && NON_DELEGABLE_PERMISSIONS.some((p) => permissionMatches(r.permission, p))) {
      ctx.addIssue({
        code: "custom",
        path: ["permission"],
        message: "this permission cannot be granted by an allow rule",
      });
    }
    if (r.tool !== null && !TOOL_PERMISSIONS.some((p) => permissionMatches(r.permission, p))) {
      ctx.addIssue({
        code: "custom",
        path: ["tool"],
        message: `a tool applies only to ${TOOL_PERMISSIONS.join(" or ")}`,
      });
    }
  });
export type CreatePermissionRuleRequest = z.infer<typeof CreatePermissionRuleRequest>;
