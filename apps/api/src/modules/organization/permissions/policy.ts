import {
  type AuthzDenial,
  INVITABLE_ROLES,
  type OrgRole,
  type Permission,
  type PermissionMode,
  ROLE_RANK,
} from "@ocw/contracts";
import type { PrincipalFacts, Relation, ResourceFacts, ResourceState, ResourceType } from "./resolve";

/**
 * Per-resource policy (PURE): which relations grant what, which resource states deny what, and the pure
 * builders that turn row data into ResourceFacts. Routes build a resource here and ask the service.
 */

/** Relation grants per resource type. For users they are filtered by the role's surfaces (resolve.ts). */
export const RELATION_PERMISSIONS: Record<ResourceType, Partial<Record<Relation, readonly Permission[]>>> = {
  organization: {},
  unit: {},
  user: { self: ["account.manage"] },
  member: {},
  // CHAT-02: the owner moves the channel between units and edits its topic (`channel.update`).
  channel: { owner: ["channel.archive", "channel.members.remove", "channel.update"] },
  channel_member: { owner: ["channel.members.remove"], self: ["channel.members.remove"] },
  // P-06: `device.full_access` is relation-only — the owner, or a member whose cap on the device is Full access.
  device: {
    owner: ["device.use", "device.update", "device.revoke", "device.full_access"],
    grantee: ["device.use"],
    full_access_grantee: ["device.use", "device.full_access"],
  },
  work_session: {
    creator: ["work_session.approve", "work_session.archive"],
    device_owner: ["work_session.approve", "work_session.archive"],
  },
  invitation: { inviter: ["invitation.revoke"] },
  // D-01: the owner of a (personal) bot sees, uses and configures it; the surface filter keeps it to
  // members whose role has the `bots` surface (every role).
  agent: { owner: ["bot.read", "bot.configure"] },
  // Phase 07.2 (D-08): the owner of a personal scope, of a personal bot's notebook or of a shared bot reads, writes and
  // promotes its memory; the surface filter still applies (`memory.promote` sits on `team`).
  memory: { owner: ["memory.read", "memory.write", "memory.promote"] },
  agent_template: {},
  // 07.8-16: watching and controlling come from the role (`browser.watch`, `browser.control`); the browser-context
  // preconditions below decide who among the holders may (reader, owner, requester, member session).
  browser_context: {},
};

/** Reason reported when a permission is simply not granted (default `missing_permission`). */
export const MISSING_REASON: Partial<Record<Permission, string>> = {
  "device.use": "device_not_shared",
};

type Denial = Omit<AuthzDenial, "permission">;

/** A resource-state precondition: an explicit deny evaluated before any rule. */
export interface Precondition {
  applies(permission: Permission): boolean;
  check(p: PrincipalFacts, r: ResourceFacts, permission: Permission): Denial | null;
}

/** The memory grains (Phase 07.2); preconditions judge them on memory resources only. */
const MEMORY_GRAINS = new Set<Permission>(["memory.read", "memory.write", "memory.promote"]);
/** Permissions that use or configure one bot: owner-only on a personal bot (D-01). */
const PERSONAL_BOT_GATED = new Set<Permission>(["bot.read", "bot.configure", "bot.internet", "bot.tool.use"]);
/** Membership of a direct conversation is fixed at creation (D-03). */
const DM_FIXED = new Set<Permission>([
  "channel.members.add",
  "channel.members.remove",
  "channel.archive",
  // Direct conversations never belong to a unit (CHAT-02).
  "channel.update",
]);

/**
 * An AI chat (P-03) is private to its owner: nobody adds or removes members, archives, moves, moderates or
 * broadcasts through the channel permissions, and the generic chat routes never post into it (the ai-chat module
 * decides `ai_chat.use` instead).
 */
const AI_CHAT_FIXED = new Set<Permission>([
  "channel.members.add",
  "channel.members.remove",
  "channel.archive",
  "channel.update",
  "message.delete_any",
  "channel.mention_all",
  "channel.post",
]);
/**
 * Writing in one AI chat (P-04): the owner or a `chat` grantee (relation `member`); a `view` grantee (relation
 * `grantee`) is told `ai_chat_view_only`.
 */
const AI_CHAT_WRITE = new Set<Permission>(["ai_chat.use", "ai_chat.web"]);
/** Managing one AI chat (rename, archive, settings) and sharing it (grants, snapshot links): the owner only (P-04). */
const AI_CHAT_OWNER_ONLY = new Set<Permission>(["ai_chat.manage", "ai_chat.share"]);

const DEVICE_GATED = new Set<Permission>([
  "work_session.create",
  "work_session.prompt",
  "work_session.approve",
  "work_session.configure",
]);
/** Channel preconditions only judge a concrete channel; organization-scope answers stay role-based. */
const isChannel = (r: ResourceFacts) => r.type === "channel" || r.type === "channel_member";
const notMember = (p: PrincipalFacts): Denial => ({
  layer: "resource",
  reason: p.kind === "agent" ? "agent_not_member" : "not_a_member",
});

/**
 * The audience of something that belongs to a unit (AGENT-01, P-04; Phase 07.2 D-08; Phase 07.4 N5): a member of the
 * unit or of any unit below it, or a lead of any unit on its path (root → unit). Unit personas, unit memory, unit keys
 * and unit templates use it, and this is its only copy: modules ask the resolver, never re-implement it.
 */
function inUnitAudience(p: PrincipalFacts, unitPath: readonly string[]): boolean {
  const unitId = unitPath[unitPath.length - 1];
  if (unitId !== undefined && p.memberUnitPaths.some((path) => path.includes(unitId))) return true;
  return unitPath.some((u) => p.leadOfUnitIds.has(u));
}

/**
 * Things a unit owns that only its audience may use or see (Phase 07.4, ADR-0025 §6, #191, N5), judged for people only
 * (an agent is judged as itself; the person it acts for by the on-behalf-of pass, so an agent never exceeds them):
 * - `vault.use` on a unit resource is using one of that unit's keychain keys. Organization keys are decided on the
 *   organization resource and stay with the role (every member);
 * - `unit.read` on a unit template is seeing it. Organization templates carry no unit and stay with the role.
 * The audience is the unit's (as for personas and unit memory) plus admins. Grants come from the role and allow rules;
 * this only takes away, and an explicit deny still removes the grant from anyone in the audience.
 */
const UNIT_OWNED: Partial<Record<Permission, { type: ResourceType; reason: string }>> = {
  "vault.use": { type: "unit", reason: "unit_key" },
  "unit.read": { type: "agent_template", reason: "unit_template" },
};

function unitOwnedPrecondition(p: PrincipalFacts, r: ResourceFacts, perm: Permission): Denial | null {
  const owned = UNIT_OWNED[perm];
  if (!owned || r.type !== owned.type || r.unitPath.length === 0 || p.kind !== "user") return null;
  if (p.orgRole === "admin" || inUnitAudience(p, r.unitPath)) return null;
  return { layer: "resource", reason: owned.reason };
}

/**
 * Memory (Phase 07.2, MEM-04, MEM-07, D-08), judged on a memory resource only:
 * - agents never promote (they propose); on a personal-like scope (`memory_personal`) only that scope's own bot
 *   (`scope_agent`) reads or writes, and the human it acts for is judged as the owner by the on-behalf-of pass; an agent
 *   writes nothing else (`agent_shared_write`);
 * - people: a personal-like scope is its owner's alone, admins included; a unit scope and a unit bot's notebook are
 *   open (every grain) only to the unit audience, admins and (for the notebook) the bot's owner. Grants come from the
 *   role, unit leads, the owner relation and allow rules; this only takes away.
 */
function memoryPrecondition(p: PrincipalFacts, r: ResourceFacts, perm: Permission): Denial | null {
  if (r.type !== "memory") return null;
  const personal = r.state.has("memory_personal");
  if (p.kind === "agent") {
    if (perm === "memory.promote") return { layer: "resource", reason: "agent_memory" };
    if (personal)
      return r.relations.has("scope_agent") ? null : { layer: "resource", reason: "agent_memory" };
    return perm === "memory.write" ? { layer: "resource", reason: "agent_shared_write" } : null;
  }
  if (p.kind !== "user") return null;
  if (personal) return r.relations.has("owner") ? null : { layer: "resource", reason: "personal_memory" };
  const unitBound = r.state.has("memory_unit") || (r.state.has("memory_agent") && r.state.has("unit_scoped"));
  if (!unitBound || p.orgRole === "admin" || r.relations.has("owner") || inUnitAudience(p, r.unitPath))
    return null;
  return { layer: "resource", reason: "unit_memory" };
}

/**
 * A bot's browser page (Phase 07.8-16; D-06, D-07, D-11 F-5, D-12 U-2; P-08), judged on a browser-context resource only;
 * at organization scope the role and the 07.3 module rules decide alone (the module gate):
 * - `browser.watch`: people only; a reader of the conversation where the bot acts (`reader`, decided by the resolver's
 *   own `channel.read`) or the bot's owner (`owner`). While a member's sealed session is loaded (`member_session`), only
 *   that member (`requester`) watches: everyone else is told `member_session` and the live view shows them "Private
 *   browsing for {member}" with no frame;
 * - `browser.control`: only the member the bot browses for (`requester`), and only while they may watch (the
 *   prerequisite below). The takeover lease itself (one controller at a time) is runtime state in `browser/takeover.ts`.
 * This is the only copy of the rule (07.4 N5): the live view asks the resolver, never re-implements it.
 */
function browserContextPrecondition(p: PrincipalFacts, r: ResourceFacts, perm: Permission): Denial | null {
  if (r.type !== "browser_context") return null;
  if (p.kind !== "user") return { layer: "resource", reason: "browser_people_only" };
  if (perm === "browser.control") {
    return r.relations.has("requester") ? null : { layer: "resource", reason: "not_browser_requester" };
  }
  if (!r.relations.has("reader") && !r.relations.has("owner")) {
    return { layer: "resource", reason: "not_conversation_reader" };
  }
  if (r.state.has("member_session") && !r.relations.has("requester")) {
    return { layer: "resource", reason: "member_session" };
  }
  return null;
}

export const PRECONDITIONS: readonly Precondition[] = [
  {
    // Private channels (and, for agents, every channel) are readable by members only.
    applies: (perm) => perm === "channel.read",
    check: (p, r) => {
      if (!isChannel(r) || r.relations.has("member")) return null;
      // A `view` grant reads an AI chat without taking part in it (P-04).
      if (r.state.has("ai_chat") && r.relations.has("grantee")) return null;
      if (p.kind === "agent") return notMember(p);
      return r.state.has("private") ? { layer: "resource", reason: "private_channel" } : null;
    },
  },
  {
    applies: (perm) => AI_CHAT_FIXED.has(perm),
    check: (p, r, perm) => {
      if (!isChannel(r) || !r.state.has("ai_chat")) return null;
      // P-10: a persona the owner added (an agent principal with the `member` relation) posts its replies through the
      // Agent Channel API; humans keep writing only through the ai-chat routes (`ai_chat.use`).
      if (perm === "channel.post" && p.kind === "agent" && r.relations.has("member")) return null;
      return { layer: "resource", reason: "ai_chat_private" };
    },
  },
  {
    // On a concrete conversation, writing needs an AI chat the principal owns or holds a `chat` grant on; at
    // organization scope (a new chat) the role decides.
    applies: (perm) => AI_CHAT_WRITE.has(perm),
    check: (_p, r) => {
      if (!isChannel(r) || (r.state.has("ai_chat") && r.relations.has("member"))) return null;
      return r.state.has("ai_chat") && r.relations.has("grantee")
        ? { layer: "resource", reason: "ai_chat_view_only" }
        : { layer: "resource", reason: "not_ai_chat_owner" };
    },
  },
  {
    // Deciding an Agent Card is a write (P-11): in an AI chat it needs the owner or a `chat` grant, as sending does.
    // A `view` grantee reads and follows only. Channels, DMs and organization scope stay role-based.
    applies: (perm) => perm === "agent_card.approve",
    check: (_p, r) => {
      if (!isChannel(r) || !r.state.has("ai_chat") || r.relations.has("member")) return null;
      return r.relations.has("grantee")
        ? { layer: "resource", reason: "ai_chat_view_only" }
        : { layer: "resource", reason: "not_ai_chat_owner" };
    },
  },
  {
    // Managing and sharing a concrete AI chat stay with its owner, whatever grant anyone else holds.
    applies: (perm) => AI_CHAT_OWNER_ONLY.has(perm),
    check: (_p, r) =>
      isChannel(r) && !(r.state.has("ai_chat") && r.relations.has("owner"))
        ? { layer: "resource", reason: "not_ai_chat_owner" }
        : null,
  },
  {
    applies: (perm) => perm === "channel.post" || perm === "channel.members.add",
    check: (p, r) => {
      if (!isChannel(r)) return null;
      if (r.state.has("archived")) return { layer: "resource", reason: "archived" };
      return r.relations.has("member") ? null : notMember(p);
    },
  },
  {
    // Device layer: nothing runs on, or is changed through, a revoked device.
    applies: (perm) => perm.startsWith("device.") || DEVICE_GATED.has(perm),
    check: (_p, r) =>
      r.state.has("revoked") || r.state.has("device_revoked")
        ? { layer: "device", reason: "device_revoked" }
        : null,
  },
  {
    // Personal bots (D-01): nobody but the owner (admins included) sees, uses or configures one. Agent
    // principals are judged as themselves; the human they act for is judged by the on-behalf-of pass.
    applies: (perm) => PERSONAL_BOT_GATED.has(perm),
    check: (p, r) => {
      if (r.type !== "agent" || p.kind !== "user") return null;
      return r.state.has("personal") && !r.relations.has("owner")
        ? { layer: "resource", reason: "personal_bot" }
        : null;
    },
  },
  {
    // Unit personas (AGENT-01, P-04): seen and mentioned by the members of the persona's unit subtree, the leads of
    // any unit on its path, its owner and admins. Nobody else learns it exists, whatever rule allows `bot.read`.
    applies: (perm) => perm === "bot.read",
    check: (p, r) => {
      if (r.type !== "agent" || p.kind !== "user" || !r.state.has("unit_scoped")) return null;
      if (r.relations.has("owner") || p.orgRole === "admin") return null;
      return inUnitAudience(p, r.unitPath) ? null : { layer: "resource", reason: "unit_agent" };
    },
  },
  {
    applies: (perm) => MEMORY_GRAINS.has(perm),
    check: memoryPrecondition,
  },
  {
    applies: (perm) => perm === "browser.watch" || perm === "browser.control",
    check: browserContextPrecondition,
  },
  {
    applies: (perm) => UNIT_OWNED[perm] !== undefined,
    check: unitOwnedPrecondition,
  },
  {
    // Direct conversations (D-03): two fixed members; nobody adds, removes or archives.
    applies: (perm) => DM_FIXED.has(perm),
    check: (_p, r) =>
      isChannel(r) && r.state.has("dm") ? { layer: "resource", reason: "direct_conversation" } : null,
  },
  {
    // D-01: moderation never reaches a direct conversation (DMs and group DMs): no admin delete path there.
    applies: (perm) => perm === "message.delete_any",
    check: (_p, r) =>
      isChannel(r) && r.state.has("dm") ? { layer: "resource", reason: "direct_conversation" } : null,
  },
  {
    // Role ceiling: an inviter never grants a role above what their own role may invite.
    applies: (perm) => perm === "invitation.create",
    check: (p, r) => {
      if (r.invitedRole === undefined) return null;
      const allowed = p.orgRole ? INVITABLE_ROLES[p.orgRole] : [];
      return allowed.includes(r.invitedRole) ? null : { layer: "resource", reason: "role_ceiling" };
    },
  },
  {
    // Module access (ADR-0024, D-05 (1)): a rule never targets a person whose role outranks the actor's, so a lead
    // never turns modules off for an admin. Unit-wide rules (no target) are not judged here.
    applies: (perm) => perm === "unit.modules.manage",
    check: (p, r) => {
      if (r.targetRole === undefined) return null;
      return p.orgRole !== null && ROLE_RANK[r.targetRole] <= ROLE_RANK[p.orgRole]
        ? null
        : { layer: "resource", reason: "role_ceiling" };
    },
  },
];

/**
 * A grain that needs another grain on the same resource, judged after every grant, precondition and deny (Phase 07.8,
 * D-04, P-04): the required grain keeps all of its own semantics (roles, unit leads, relations, allow and deny rules,
 * the personal-bot precondition), so no module copies them.
 */
export interface Prerequisite {
  permission: Permission;
  requires: Permission;
  /** The resource type where the dependency holds; elsewhere the grain is decided on its own. */
  on: ResourceType;
  reason: string;
}

export const PREREQUISITES: readonly Prerequisite[] = [
  // D-04 (07.8-11): a bot's sandbox files are for the people who may configure that bot. The organization-scope answer
  // stays the role's (the web's module gate reads it); agents never hold `bot.configure`, so they never get here.
  { permission: "sandbox.files", requires: "bot.configure", on: "agent", reason: "not_bot_configurer" },
  // 07.8-16 (D-07): taking control of a page needs watching it (reader or owner, the module, the member-session rule).
  {
    permission: "browser.control",
    requires: "browser.watch",
    on: "browser_context",
    reason: "not_browser_watcher",
  },
];

/** The first prerequisite of `permission` that `held` does not satisfy on `r`, or null. */
export function unmetPrerequisite(
  permission: Permission,
  r: ResourceFacts,
  held: ReadonlySet<Permission>,
): Denial | null {
  for (const pre of PREREQUISITES) {
    if (pre.permission !== permission || pre.on !== r.type) continue;
    if (!held.has(pre.requires)) return { layer: "resource", reason: pre.reason };
  }
  return null;
}

/** The first precondition that denies `permission`, or null. */
export function precondition(permission: Permission, p: PrincipalFacts, r: ResourceFacts): Denial | null {
  for (const pre of PRECONDITIONS) {
    if (!pre.applies(permission)) continue;
    const d = pre.check(p, r, permission);
    if (d) return d;
  }
  return null;
}

// ---------------------------------------------------------------- builders (pure, from row data)

function facts(
  type: ResourceType,
  relations: Iterable<Relation> = [],
  state: Iterable<ResourceState> = [],
  unitPath: readonly string[] = [],
): ResourceFacts {
  return { type, unitPath, relations: new Set(relations), state: new Set(state) };
}

const when = <T>(cond: boolean, value: T): T[] => (cond ? [value] : []);

export function orgResource(): ResourceFacts {
  return facts("organization");
}

export function unitResource(u: { id: string; path: readonly string[] }): ResourceFacts {
  return facts("unit", [], [], u.path);
}

/**
 * An agent template as a resource (Phase 07.4, N5): its unit's path with state `unit_scoped`, or the organization when
 * `unit` is null. Who sees it is `unit.read` on this resource (the unit-template precondition).
 */
export function agentTemplateResource(unit: { id: string; path: readonly string[] } | null): ResourceFacts {
  return unit ? facts("agent_template", [], ["unit_scoped"], unit.path) : facts("agent_template");
}

/**
 * Module access (ADR-0024): `unit.modules.manage` is decided on the scope unit (or the organization when null), with
 * the target person's org role when the rule targets one person (the `role_ceiling` precondition).
 */
export function moduleTargetResource(
  unit: { id: string; path: readonly string[] } | null,
  targetRole?: OrgRole,
): ResourceFacts {
  const r = unit ? unitResource(unit) : orgResource();
  return targetRole === undefined ? r : { ...r, targetRole };
}

export function userResource(targetUserId: string, principalUserId: string | null): ResourceFacts {
  return facts("user", when(targetUserId === principalUserId, "self" as const));
}

export function memberResource(targetUserId: string, principalUserId: string | null): ResourceFacts {
  return facts("member", when(targetUserId === principalUserId, "self" as const));
}

export interface ChannelFacts {
  visibility: "public" | "private";
  archived: boolean;
  viewerRole: "owner" | "member" | null;
  /**
   * `dm` = a 1:1 direct conversation, `group` = a group DM (D-06); both carry state `dm` (fixed membership, no
   * moderation). `ai_chat` = a private AI chat (state `ai_chat`, P-03). Omitted = a channel.
   */
  kind?: "channel" | "dm" | "group" | "ai_chat";
  /**
   * AI chats and user principals only (P-03): the viewer's access from `ai_chats.owner_user_id` and active grants
   * (`aiAccessSql`). When set, it alone decides the relations: a human's `conversation_members` row never confers
   * access to an AI chat. Omitted (agents, other kinds, Phase 5 callers) = relations from `viewerRole`.
   */
  aiAccess?: "owner" | "chat" | "view" | null;
  /**
   * The unit the channel belongs to, root → self (CHAT-02): unit-scoped allow and deny rules apply to the channels of
   * that unit (principle 6). Omitted or [] = the organization (and every direct conversation).
   */
  unitPath?: readonly string[];
}

function channelRelations(c: ChannelFacts): Relation[] {
  if (c.kind === "ai_chat" && c.aiAccess !== undefined) {
    switch (c.aiAccess) {
      case "owner":
        return ["member", "owner"];
      case "chat":
        return ["member"];
      case "view":
        return ["grantee"];
      default:
        return [];
    }
  }
  return [
    ...when(c.viewerRole !== null, "member" as const),
    ...when(c.viewerRole === "owner", "owner" as const),
  ];
}

function channelState(c: ChannelFacts): ResourceState[] {
  return [
    ...when(c.visibility === "private", "private" as const),
    ...when(c.archived, "archived" as const),
    ...when(c.kind === "dm" || c.kind === "group", "dm" as const),
    // An AI chat is always private, whatever the row says.
    ...when(c.kind === "ai_chat", "ai_chat" as const),
    ...when(c.kind === "ai_chat" && c.visibility !== "private", "private" as const),
  ];
}

export function channelResource(c: ChannelFacts): ResourceFacts {
  return facts("channel", channelRelations(c), channelState(c), c.unitPath ?? []);
}

export function channelMemberResource(c: ChannelFacts, targetIsViewer: boolean): ResourceFacts {
  return facts(
    "channel_member",
    [...channelRelations(c), ...when(targetIsViewer, "self" as const)],
    channelState(c),
    c.unitPath ?? [],
  );
}

/**
 * A device as a resource. `cap` is the principal's highest mode on the device (device/access.ts, P-06): given, a
 * non-owner is a `grantee` when it is not null and a `full_access_grantee` when it is Full access; omitted, the
 * legacy rule applies (every member is a grantee of a shared device).
 */
export function deviceResource(
  d: { ownerUserId: string; shared: boolean; revoked: boolean; cap?: PermissionMode | null },
  principalUserId: string | null,
): ResourceFacts {
  const owner = principalUserId !== null && d.ownerUserId === principalUserId;
  const grantee = d.cap === undefined ? d.shared : !owner && d.cap !== null;
  return facts(
    "device",
    [
      ...when(owner, "owner" as const),
      ...when(grantee, "grantee" as const),
      ...when(!owner && d.cap === "fullAccess", "full_access_grantee" as const),
    ],
    when(d.revoked, "revoked" as const),
  );
}

export function workSessionResource(
  s: { createdBy: string; deviceOwnerUserId: string | null; deviceRevoked: boolean; tool?: string | null },
  principalUserId: string | null,
): ResourceFacts {
  const r = facts(
    "work_session",
    [
      ...when(principalUserId !== null && s.createdBy === principalUserId, "creator" as const),
      ...when(
        principalUserId !== null && s.deviceOwnerUserId !== null && s.deviceOwnerUserId === principalUserId,
        "device_owner" as const,
      ),
    ],
    when(s.deviceRevoked, "device_revoked" as const),
  );
  return s.tool ? { ...r, tool: s.tool } : r;
}

export function invitationResource(
  i: { inviterId: string | null; role: OrgRole },
  principalUserId: string | null,
): ResourceFacts {
  return {
    ...facts(
      "invitation",
      when(
        principalUserId !== null && i.inviterId !== null && i.inviterId === principalUserId,
        "inviter" as const,
      ),
    ),
    invitedRole: i.role,
  };
}

/** D-01: what the resolver needs about a bot. */
export interface AgentFacts {
  scope: "team" | "personal";
  ownerUserId: string | null;
  disabled: boolean;
  /**
   * AGENT-01: the path (root → self) of the unit a shared persona belongs to; omitted or [] = the organization.
   * Unit-scoped rules and unit leads (`LEAD_PERMISSIONS`) then apply to the persona.
   */
  unitPath?: readonly string[];
}

/**
 * A bot as a resource: `owner` relation for its owner; states `personal`, `disabled` and `unit_scoped` (a
 * department, team or project persona, whose unit path the resource carries).
 */
export function agentResource(a: AgentFacts, principalUserId: string | null): ResourceFacts {
  const unitPath = a.unitPath ?? [];
  return facts(
    "agent",
    when(
      principalUserId !== null && a.ownerUserId !== null && a.ownerUserId === principalUserId,
      "owner" as const,
    ),
    [
      ...when(a.scope === "personal", "personal" as const),
      ...when(a.disabled, "disabled" as const),
      ...when(unitPath.length > 0, "unit_scoped" as const),
    ],
    unitPath,
  );
}

// ---------------------------------------------------------------- browser contexts (Phase 07.8-16)

/** What the resolver needs about one of a bot's browser pages, for one person. */
export interface BrowserContextFacts {
  /** The person reads the conversation where the bot acts: the resolver's `channel.read` (the readable set, P-03). */
  reader: boolean;
  /** The person owns the bot. */
  botOwner: boolean;
  /** The person is the member the bot browses for (`browser_contexts.requested_for_user_id`). */
  requester: boolean;
  /** A member's sealed session is loaded in the page (`browser_contexts.session_id`, D-12 U-2). */
  memberSession: boolean;
}

/** A bot's browser page as a resource: relations `reader`, `owner`, `requester`; state `member_session`. */
export function browserContextResource(c: BrowserContextFacts): ResourceFacts {
  return facts(
    "browser_context",
    [
      ...when(c.reader, "reader" as const),
      ...when(c.botOwner, "owner" as const),
      ...when(c.requester, "requester" as const),
    ],
    when(c.memberSession, "member_session" as const),
  );
}

// ---------------------------------------------------------------- memory (Phase 07.2)

/** What the resolver needs about one memory scope (D-08). Built from `memory_scopes` + the bot or unit row. */
export interface MemoryScopeFacts {
  kind: "personal" | "agent" | "unit" | "org";
  /** Personal scopes: the human the memory belongs to. */
  ownerUserId: string | null;
  /** Personal scopes: the bot the memory is kept with; notebooks (`agent`): the bot itself. */
  agent: (AgentFacts & { id: string }) | null;
  /** Unit scopes: the unit's path (root → self). Notebooks take the bot's own `unitPath`; personal and org: []. */
  unitPath: readonly string[];
}

/**
 * A memory scope, or one file of it when `path` is given (folder rules need the path), as seen by `principal`:
 * - personal scope, or a personal bot's notebook → `memory_personal`, no unit; `owner` for the owning human,
 *   `scope_agent` for the scope's own bot;
 * - a shared bot's notebook → `memory_agent` (+ `unit_scoped` with the bot's unit path); `owner` for the bot's owner;
 * - unit scope → `memory_unit` with the unit's path; organization scope → no state, no unit.
 */
export function memoryResource(
  scope: MemoryScopeFacts,
  path: string | undefined,
  principal: { kind: "user" | "agent"; id: string } | null,
): ResourceFacts {
  const isUser = (id: string | null | undefined) =>
    principal?.kind === "user" && id !== null && id !== undefined && principal.id === id;
  const isScopeAgent = principal?.kind === "agent" && scope.agent !== null && principal.id === scope.agent.id;
  let r: ResourceFacts;
  switch (scope.kind) {
    case "personal":
      r = facts(
        "memory",
        [...when(isUser(scope.ownerUserId), "owner" as const), ...when(isScopeAgent, "scope_agent" as const)],
        ["memory_personal"],
      );
      break;
    case "agent": {
      const bot = scope.agent;
      const ownerRel = when(isUser(bot?.ownerUserId), "owner" as const);
      const agentRel = when(isScopeAgent, "scope_agent" as const);
      if (bot === null || bot.scope === "personal") {
        // A personal bot's notebook is its owner's private memory; without a bot row nobody owns it.
        r = facts("memory", [...ownerRel, ...agentRel], ["memory_personal"]);
      } else {
        const unitPath = bot.unitPath ?? [];
        r = facts(
          "memory",
          [...ownerRel, ...agentRel],
          ["memory_agent", ...when(unitPath.length > 0, "unit_scoped" as const)],
          unitPath,
        );
      }
      break;
    }
    case "unit":
      r = facts("memory", [], ["memory_unit"], scope.unitPath);
      break;
    case "org":
      r = facts("memory");
      break;
  }
  return path === undefined ? r : { ...r, path };
}
