import { type MessageAuthor, type OrgRole, userHandle } from "@ocw/contracts";
import { agents, orgMembers, orgUnits, type Tx } from "@ocw/db";
import { eq, inArray } from "drizzle-orm";

/** Display info for every principal of the org (humans from org_members, agents from agents). */
export interface DirectoryEntry {
  kind: "user" | "agent";
  id: string;
  displayName: string;
  handle: string;
  avatarUrl: string | null;
  /** Agents only. */
  status?: "provisioning" | "ready" | "error" | "disabled";
  /** Users only. */
  role?: OrgRole;
  /** Agents only (D-01): personal bots belong to `ownerUserId`. */
  scope?: "team" | "personal";
  ownerUserId?: string | null;
  /** Agents only (AGENT-01): the path of a unit persona's unit, root → self ([] = the organization). */
  unitPath?: readonly string[];
  /** Agents only: soft-deleted bots keep resolving as authors. */
  deleted?: boolean;
}

/**
 * Phase 07.17 (D-07, PD-13): a team or department that `@handle` can name. Never a `project` unit (it has a handle but
 * never resolves). The path feeds `unitResource`, so `unit.read` is decided by the resolver like everywhere else.
 */
export interface UnitDirectoryEntry {
  kind: "team" | "department";
  id: string;
  name: string;
  handle: string;
  path: readonly string[];
}

export interface Directory {
  users: Map<string, DirectoryEntry>;
  agents: Map<string, DirectoryEntry>;
  /**
   * handle → entry (agents win over users on a clash; agents are what mentions trigger). Personal bots are
   * excluded: they can never be mentioned (D-01).
   */
  byHandle: Map<string, DirectoryEntry>;
  /**
   * Phase 07.17 (PD-13): handle → team or department. Checked only after `byHandle` (agents → users → units) and only
   * when the caller passes unit options to `resolveMentions`. Absent on display-only directories: no unit resolves.
   */
  unitsByHandle?: Map<string, UnitDirectoryEntry>;
}

/** Loads the org directory inside the caller's tenant transaction (RLS scopes it to the org). */
export async function loadDirectory(tx: Tx): Promise<Directory> {
  const [userRows, agentRows, unitRows] = await Promise.all([
    tx
      .select({
        userId: orgMembers.userId,
        displayName: orgMembers.displayName,
        email: orgMembers.email,
        avatarUrl: orgMembers.avatarUrl,
        role: orgMembers.role,
      })
      .from(orgMembers),
    tx
      .select({
        id: agents.id,
        name: agents.name,
        username: agents.username,
        avatarUrl: agents.avatarUrl,
        status: agents.status,
        deletedAt: agents.deletedAt,
        scope: agents.scope,
        ownerUserId: agents.ownerUserId,
        unitPath: orgUnits.path,
      })
      .from(agents)
      .leftJoin(orgUnits, eq(orgUnits.id, agents.unitId)),
    // Teams and departments only: a `project` unit never resolves as a mention (PD-13).
    tx
      .select({
        id: orgUnits.id,
        kind: orgUnits.kind,
        name: orgUnits.name,
        handle: orgUnits.handle,
        path: orgUnits.path,
      })
      .from(orgUnits)
      .where(inArray(orgUnits.kind, ["team", "department"])),
  ]);
  const users = new Map<string, DirectoryEntry>();
  const agentMap = new Map<string, DirectoryEntry>();
  const byHandle = new Map<string, DirectoryEntry>();
  for (const u of userRows) {
    const e: DirectoryEntry = {
      kind: "user",
      id: u.userId,
      displayName: u.displayName,
      handle: userHandle({ displayName: u.displayName, email: u.email }),
      avatarUrl: u.avatarUrl,
      role: u.role,
    };
    users.set(e.id, e);
    if (!byHandle.has(e.handle)) byHandle.set(e.handle, e);
  }
  for (const a of agentRows) {
    const e: DirectoryEntry = {
      kind: "agent",
      id: a.id,
      displayName: a.name,
      handle: a.username.toLowerCase(),
      avatarUrl: a.avatarUrl,
      status: a.status,
      scope: a.scope,
      ownerUserId: a.ownerUserId,
      unitPath: a.unitPath ?? [],
      deleted: a.deletedAt !== null,
    };
    agentMap.set(e.id, e);
    // Deleted bots keep resolving as authors but free their handle: a new bot may reuse it (B2-6).
    // Personal bots live only in their owner's DM (D-01): never resolved as a text @mention.
    if (!a.deletedAt && a.scope !== "personal") byHandle.set(e.handle, e);
  }
  const unitsByHandle = new Map<string, UnitDirectoryEntry>();
  for (const u of unitRows) {
    if (u.kind === "project") continue;
    unitsByHandle.set(u.handle, { kind: u.kind, id: u.id, name: u.name, handle: u.handle, path: u.path });
  }
  return { users, agents: agentMap, byHandle, unitsByHandle };
}

/** Resolver facts of a directory agent (D-01, AGENT-01). */
export function agentFactsOf(e: DirectoryEntry) {
  return {
    scope: e.scope ?? ("team" as const),
    ownerUserId: e.ownerUserId ?? null,
    disabled: e.status === "disabled",
    unitPath: e.unitPath ?? [],
  };
}

/** A department, team or project persona (AGENT-01): seen and mentioned only by who may `bot.read` it. */
export const isUnitPersona = (e: DirectoryEntry) => e.kind === "agent" && (e.unitPath?.length ?? 0) > 0;

export function authorOf(
  dir: Directory,
  kind: "user" | "agent" | "system",
  id: string | null,
): MessageAuthor {
  if (kind === "system" || !id) return { kind: "system", id: null, displayName: "System", avatarUrl: null };
  const e = kind === "agent" ? dir.agents.get(id) : dir.users.get(id);
  return {
    kind,
    id,
    displayName: e?.displayName ?? (kind === "agent" ? "Deleted bot" : "Former member"),
    avatarUrl: e?.avatarUrl ?? null,
  };
}
