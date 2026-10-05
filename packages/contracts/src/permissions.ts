import { z } from "zod";
import { ClientKind, Id, OrgRole } from "./common";

/**
 * Permission vocabulary (ORG-03, PRD §7). One resolver in the API decides every route with these names;
 * the web only renders the decisions (`MyPermissions`, per-resource `viewerCan`). Plans 02-02 … 02-15
 * consume the names verbatim: never rename a value, only add.
 */
export const Permission = z.enum([
  "org.read",
  "member.read",
  "member.manage",
  "invitation.read",
  "invitation.create",
  "invitation.revoke",
  "unit.read",
  "unit.manage",
  "unit.members.manage",
  "rule.read",
  "rule.manage",
  "account.manage",
  "channel.create",
  "channel.read",
  "channel.post",
  "channel.members.add",
  "channel.members.remove",
  "channel.archive",
  "bot.read",
  "bot.manage",
  "provider.manage",
  "cell.manage",
  "cell.sync",
  "device.read",
  "device.pair",
  "device.use",
  "device.update",
  "device.revoke",
  "device.link",
  "work_session.read",
  "work_session.create",
  "work_session.prompt",
  "work_session.interrupt",
  "work_session.approve",
  "work_session.archive",
  // Phase 3.1 (D-02): personal bots and bot capabilities.
  "bot.create_personal",
  "bot.configure",
  "bot.internet",
  "bot.tool.use",
  "plugin.manage",
  "mcp.manage",
  // Phase 03.2 (P-06): Work Zone session controls, full access (ADR-0012) and the org policy.
  "work_session.configure",
  "device.full_access",
  "work_zone.manage",
]);
export type Permission = z.infer<typeof Permission>;

/** Product surface a permission belongs to; roles unlock whole surfaces (PRD §7 role table). */
export const PermissionSurface = z.enum(["account", "chat", "bots", "workzone", "team", "admin", "runtime"]);
export type PermissionSurface = z.infer<typeof PermissionSurface>;

export const PERMISSION_SURFACE: Record<Permission, PermissionSurface> = {
  "org.read": "account",
  "member.read": "account",
  "member.manage": "admin",
  "invitation.read": "team",
  "invitation.create": "team",
  "invitation.revoke": "team",
  "unit.read": "account",
  "unit.manage": "admin",
  "unit.members.manage": "team",
  "rule.read": "admin",
  "rule.manage": "admin",
  "account.manage": "account",
  "channel.create": "chat",
  "channel.read": "chat",
  "channel.post": "chat",
  "channel.members.add": "chat",
  "channel.members.remove": "chat",
  "channel.archive": "chat",
  "bot.read": "bots",
  "bot.manage": "admin",
  "provider.manage": "admin",
  "cell.manage": "admin",
  "cell.sync": "runtime",
  "device.read": "workzone",
  "device.pair": "workzone",
  "device.use": "workzone",
  "device.update": "workzone",
  "device.revoke": "workzone",
  "device.link": "runtime",
  "work_session.read": "workzone",
  "work_session.create": "workzone",
  "work_session.prompt": "workzone",
  "work_session.interrupt": "workzone",
  "work_session.approve": "workzone",
  "work_session.archive": "workzone",
  "bot.create_personal": "bots",
  "bot.configure": "bots",
  "bot.internet": "bots",
  "bot.tool.use": "bots",
  "plugin.manage": "admin",
  "mcp.manage": "admin",
  "work_session.configure": "workzone",
  "device.full_access": "workzone",
  "work_zone.manage": "admin",
};

export const ROLE_SURFACES: Record<OrgRole, PermissionSurface[]> = {
  standard: ["account", "chat", "bots"],
  developer: ["account", "chat", "bots", "workzone"],
  lead: ["account", "chat", "bots", "workzone", "team"],
  admin: ["account", "chat", "bots", "workzone", "team", "admin"],
};

const STANDARD: readonly Permission[] = [
  "org.read",
  "member.read",
  "unit.read",
  "channel.create",
  "channel.read",
  "channel.post",
  "channel.members.add",
  "bot.read",
  "bot.create_personal",
  "bot.internet",
  "bot.tool.use",
];
const DEVELOPER: readonly Permission[] = [
  ...STANDARD,
  "device.read",
  "device.pair",
  "work_session.read",
  "work_session.create",
  "work_session.prompt",
  "work_session.interrupt",
  "work_session.configure",
];
const LEAD: readonly Permission[] = [...DEVELOPER, "invitation.read", "invitation.create"];
const ADMIN: readonly Permission[] = [
  ...LEAD,
  "member.manage",
  "invitation.revoke",
  "unit.manage",
  "unit.members.manage",
  "rule.read",
  "rule.manage",
  "channel.archive",
  "channel.members.remove",
  "bot.manage",
  "provider.manage",
  "cell.manage",
  "device.revoke",
  "work_session.approve",
  "work_session.archive",
  "bot.configure",
  "plugin.manage",
  "mcp.manage",
  "work_zone.manage",
];

/**
 * Unconditional, organization-wide grants per role (cumulative). `account.manage`, `device.use`,
 * `device.update` and `device.full_access` come only from relations (self, device owner/shared/grantee);
 * `cell.sync` and `device.link` only from non-human principals.
 */
export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  standard: STANDARD,
  developer: DEVELOPER,
  lead: LEAD,
  admin: ADMIN,
};

/** Granted to a unit lead on the lead's unit subtree. */
export const LEAD_PERMISSIONS: readonly Permission[] = ["unit.members.manage"];
/** Upper bound for an agent principal (intersected with the triggering human). */
export const AGENT_PERMISSIONS: readonly Permission[] = [
  "channel.read",
  "channel.post",
  "bot.internet",
  "bot.tool.use",
];
/** The OpenClaw cell principal. */
export const CELL_PERMISSIONS: readonly Permission[] = ["cell.sync"];
/** A paired device principal (Device Link). */
export const DEVICE_PERMISSIONS: readonly Permission[] = ["device.link"];

/** Admin- and runtime-surface permissions: explicit allow rules can never grant these. */
export const NON_DELEGABLE_PERMISSIONS: readonly Permission[] = Permission.options.filter(
  (p) => PERMISSION_SURFACE[p] === "admin" || PERMISSION_SURFACE[p] === "runtime",
);

export const ROLE_RANK: Record<OrgRole, number> = { standard: 0, developer: 1, lead: 2, admin: 3 };

/** Role ceiling for invitations: an inviter never grants a role above their own; only admins grant lead/admin. */
export const INVITABLE_ROLES: Record<OrgRole, OrgRole[]> = {
  standard: [],
  developer: [],
  lead: ["standard", "developer"],
  admin: ["standard", "developer", "lead", "admin"],
};

// ---------------------------------------------------------------- hierarchy (D-07)

export const UnitKind = z.enum(["department", "team", "project"]);
export type UnitKind = z.infer<typeof UnitKind>;

/** Allowed parent kinds per unit kind; `null` = top level (child of the organization root). */
export const ALLOWED_PARENT_KINDS: Record<UnitKind, Array<UnitKind | null>> = {
  department: [null, "department"],
  team: ["department", "team"],
  project: ["team", "department"],
};

export const UnitRole = z.enum(["member", "lead"]);
export type UnitRole = z.infer<typeof UnitRole>;

// ---------------------------------------------------------------- explicit rules (D-02)

export const RuleEffect = z.enum(["allow", "deny"]);
export type RuleEffect = z.infer<typeof RuleEffect>;

export const RuleSubjectKind = z.enum(["everyone", "role", "user", "agent"]);
export type RuleSubjectKind = z.infer<typeof RuleSubjectKind>;

/** `pattern` is an exact permission or `prefix.*`, which matches every permission under `prefix.`. */
export function permissionMatches(pattern: string, permission: Permission): boolean {
  if (pattern === permission) return true;
  if (!pattern.endsWith(".*")) return false;
  const prefix = pattern.slice(0, -1); // keep the trailing dot
  return prefix.length > 1 && permission.startsWith(prefix);
}

export const PermissionPattern = z
  .string()
  .max(64)
  .refine(
    (p) =>
      (Permission.options as readonly string[]).includes(p) ||
      (p.endsWith(".*") && Permission.options.some((perm) => permissionMatches(p, perm))),
    { message: "must be a permission or a prefix.* matching at least one permission" },
  );
export type PermissionPattern = z.infer<typeof PermissionPattern>;

// ---------------------------------------------------------------- decisions

/** Layer that denied a permission. `role` = no grant from role, relation, lead or allow rule. */
export const DenyLayer = z.enum(["role", "org", "unit", "user", "agent", "tool", "device", "resource"]);
export type DenyLayer = z.infer<typeof DenyLayer>;

/** The `details` body of every authorization 403. */
export const AuthzDenial = z.object({
  permission: Permission,
  layer: DenyLayer,
  reason: z.string(),
  ruleId: Id.optional(),
  unitId: Id.optional(),
});
export type AuthzDenial = z.infer<typeof AuthzDenial>;

/** `GET /api/v1/me/permissions`: the caller's organization-scope effective set. */
export const MyPermissions = z.object({ role: OrgRole, permissions: z.array(Permission) });
export type MyPermissions = z.infer<typeof MyPermissions>;

/** One short user-facing sentence per permission ("What can each role do?"). */
export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  "org.read": "See the organization and its settings",
  "member.read": "See who is in the organization",
  "member.manage": "Change roles, deactivate and reactivate members",
  "invitation.read": "See pending invitations",
  "invitation.create": "Invite people to the organization",
  "invitation.revoke": "Revoke any pending invitation",
  "unit.read": "See departments, teams and projects",
  "unit.manage": "Create, rename, move and delete departments, teams and projects",
  "unit.members.manage": "Add and remove people in departments, teams and projects",
  "rule.read": "See explicit allow and deny rules",
  "rule.manage": "Create and delete explicit allow and deny rules",
  "account.manage": "Edit your own profile, password and sessions",
  "channel.create": "Create channels",
  "channel.read": "Read channels you can see",
  "channel.post": "Post messages in channels you belong to",
  "channel.members.add": "Add people and bots to channels",
  "channel.members.remove": "Remove anyone from a channel",
  "channel.archive": "Archive any channel",
  "bot.read": "See and mention the organization's bots",
  "bot.manage": "Create, edit and delete bots",
  "provider.manage": "Connect and configure model providers",
  "cell.manage": "Manage the agent cell connection",
  "cell.sync": "Sync the agent cell with the workspace",
  "device.read": "See paired devices",
  "device.pair": "Pair your own devices",
  "device.use": "Run work on a device you own or that is shared with you",
  "device.update": "Rename and share your own devices",
  "device.revoke": "Revoke any device",
  "device.link": "Connect a paired device to the workspace",
  "work_session.read": "See Work Zone sessions",
  "work_session.create": "Start Work Zone sessions on a usable device",
  "work_session.prompt": "Send prompts to Work Zone sessions",
  "work_session.interrupt": "Interrupt running Work Zone sessions",
  "work_session.approve": "Approve or deny any Work Zone tool request",
  "work_session.archive": "Archive any Work Zone session",
  "bot.create_personal": "Create your own private personal bots",
  "bot.configure": "Configure a bot's instructions, model and capabilities",
  "bot.internet": "Let bots search and read the web when they answer you",
  "bot.tool.use": "Let bots use connected tools (MCP servers and plugins) when they answer you",
  "plugin.manage": "Review, install, update and remove OpenClaw Marketplace plugins",
  "mcp.manage": "Register and configure MCP servers for the organization's bots",
  "work_session.configure": "Change a Work Zone session's model, reasoning and permission mode",
  "device.full_access": "Run Work Zone sessions in Full access on a device that allows it",
  "work_zone.manage": "Set the organization's Work Zone policy (modes, models, full access, fast mode)",
};

// ---------------------------------------------------------------- tokens (AUTH-06)

export const DEVICE_TOKEN_AUDIENCE = "ocw:device-link";
/** WebSocket application subprotocol the server echoes. */
export const WS_PROTOCOL = "ocw.v1";
/** The browser offers its access JWT as a `Sec-WebSocket-Protocol` entry with this prefix (never echoed). */
export const WS_AUTH_PROTOCOL_PREFIX = "ocw.auth.";

/** Minimal user access-token claims (no e-mail, name or image). Strict: unexpected claims are visible. */
export const AccessTokenClaims = z.strictObject({
  sub: Id,
  sid: Id,
  org: Id,
  ck: ClientKind,
  iat: z.number().int(),
  exp: z.number().int(),
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
});
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;

/** Short-lived device JWT the daemon exchanges its device token for before connecting. */
export const DeviceTokenClaims = z.strictObject({
  sub: Id,
  org: Id,
  typ: z.literal("device"),
  iat: z.number().int(),
  exp: z.number().int(),
  iss: z.string(),
  aud: z.literal(DEVICE_TOKEN_AUDIENCE),
});
export type DeviceTokenClaims = z.infer<typeof DeviceTokenClaims>;
