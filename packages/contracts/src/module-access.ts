import { z } from "zod";
import { Id } from "./common";
import type { Permission } from "./permissions";

/**
 * Module access (Phase 07.3, ADR-0024). A module is not a feature flag: turning one off for the organization, a unit or
 * a person writes one ordinary explicit deny rule per catalog pattern, and the one resolver decides it (deny beats every
 * role, unit rules reach the unit's subtree). The web hides what the API already refuses.
 */

export const ModuleId = z.enum(["work_zone", "ai_chats", "bots", "memory"]);
export type ModuleId = z.infer<typeof ModuleId>;

export interface ModuleDefinition {
  label: string;
  description: string;
  /** The grain the web checks to show the module at all. */
  entry: Permission;
  /** Each a valid `PermissionPattern`; one deny row per pattern turns the module off. */
  patterns: readonly string[];
}

/**
 * Exact grains per module. Work Zone keeps device hygiene (`device.read`, `.update`, `.revoke`) out, so a member whose
 * Work Zone is off can still see, unshare and revoke their devices. Bots lists grains instead of `bot.*`, which would
 * reach governance (`bot.manage`, `bot.manage_unit`). New Work Zone session grains must keep the `work_session.`
 * prefix (the contract test refuses an unclassified Work Zone, Bots or `ai_chat.` grain).
 */
export const MODULE_CATALOG: Record<ModuleId, ModuleDefinition> = {
  work_zone: {
    label: "Work Zone",
    description: "Coding sessions on paired devices",
    entry: "work_session.read",
    patterns: ["work_session.*", "device.pair", "device.use", "device.full_access"],
  },
  ai_chats: {
    label: "AI chats",
    description: "Private and shared chats with AI models",
    entry: "ai_chat.read",
    patterns: ["ai_chat.*"],
  },
  bots: {
    label: "Bots",
    description: "Team and personal bots: mention, message and create them",
    entry: "bot.read",
    patterns: ["bot.read", "bot.create_personal", "bot.configure", "bot.internet", "bot.tool.use"],
  },
  // Phase 07.2 (07.2-01): every memory grain (read, write, promote); new memory grains keep the `memory.` prefix.
  memory: {
    label: "Memory",
    description: "Memory files that bots and people keep in folders",
    entry: "memory.read",
    patterns: ["memory.*"],
  },
};

/** Module-surface grains that are deliberately never module grains (device hygiene, governance, card decisions). */
export const MODULE_EXCLUDED: readonly Permission[] = [
  "device.read",
  "device.update",
  "device.revoke",
  "device.link",
  "bot.manage",
  "bot.manage_unit",
  "agent_card.approve",
];

/** The module an exact catalog pattern belongs to (a rule row's `permission`), or null. */
export function modulePatternOf(pattern: string): ModuleId | null {
  return ModuleId.options.find((m) => MODULE_CATALOG[m].patterns.includes(pattern)) ?? null;
}

// ---------------------------------------------------------------- module-access API (07.3-02 implements, 07.3-04 renders)

/** `on` = no catalog row at the exact scope and subject, `off` = every pattern, `custom` = some. */
export const ModuleState = z.enum(["on", "off", "custom"]);
export type ModuleState = z.infer<typeof ModuleState>;

/** A scope: `scopeUnitId` null = the organization. */
export const ModuleScopeRef = z.object({ scopeUnitId: Id.nullable(), name: z.string() });
export type ModuleScopeRef = z.infer<typeof ModuleScopeRef>;

/** The nearest strict ancestor scope (or the organization) where the module is not `on`. */
export const ModuleInherited = ModuleScopeRef.extend({ state: z.enum(["off", "custom"]) });
export type ModuleInherited = z.infer<typeof ModuleInherited>;

/** `GET /api/v1/module-access`: `unitId` omitted = the organization. */
export const ModuleAccessQuery = z.object({ unitId: Id.optional() });
export type ModuleAccessQuery = z.infer<typeof ModuleAccessQuery>;

export const ModuleSubject = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("everyone") }),
  z.strictObject({ kind: z.literal("user"), userId: Id }),
]);
export type ModuleSubject = z.infer<typeof ModuleSubject>;

/** `PUT /api/v1/module-access`: writes or deletes the exact-scope catalog deny rows of one module and subject. */
export const SetModuleAccessRequest = z.object({
  module: ModuleId,
  scopeUnitId: Id.nullable(),
  subject: ModuleSubject,
  enabled: z.boolean(),
});
export type SetModuleAccessRequest = z.infer<typeof SetModuleAccessRequest>;

export const ModuleAccessModuleState = z.object({
  module: ModuleId,
  state: ModuleState,
  inherited: ModuleInherited.nullable(),
});
export type ModuleAccessModuleState = z.infer<typeof ModuleAccessModuleState>;

export const ModuleAccessPerson = z.object({
  userId: Id,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  /** The resolver's decision (a lead never targets an admin), never a role check in the client. */
  canEdit: z.boolean(),
  /** The state of this person's rows at this exact scope. */
  modules: z.array(ModuleAccessModuleState),
});
export type ModuleAccessPerson = z.infer<typeof ModuleAccessPerson>;

export const ModuleAccessView = z.object({
  scope: ModuleScopeRef,
  /** `everyone` rows at this exact scope, in catalog order. */
  modules: z.array(ModuleAccessModuleState),
  /** A unit: the active members of its subtree; the organization: every active member. */
  people: z.array(ModuleAccessPerson),
  /** Units strictly inside the scope whose `everyone` rows are not all `on`. */
  overrides: z.array(z.object({ unitId: Id, name: z.string(), modules: z.array(ModuleAccessModuleState) })),
  /** Personas of the scope unit's subtree (0 for the organization): Bots off there silences them for everyone. */
  unitBotCount: z.number().int().nonnegative(),
});
export type ModuleAccessView = z.infer<typeof ModuleAccessView>;
