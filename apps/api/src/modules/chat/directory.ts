import { type MessageAuthor, userHandle } from "@ocw/contracts";
import { agents, orgMembers, type Tx } from "@ocw/db";

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
  role?: "owner" | "admin" | "member";
}

export interface Directory {
  users: Map<string, DirectoryEntry>;
  agents: Map<string, DirectoryEntry>;
  /** handle → entry (agents win over users on a clash; agents are what mentions trigger). */
  byHandle: Map<string, DirectoryEntry>;
}

/** Loads the org directory inside the caller's tenant transaction (RLS scopes it to the org). */
export async function loadDirectory(tx: Tx): Promise<Directory> {
  const [userRows, agentRows] = await Promise.all([
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
      })
      .from(agents),
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
    };
    agentMap.set(e.id, e);
    byHandle.set(e.handle, e);
  }
  return { users, agents: agentMap, byHandle };
}

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
