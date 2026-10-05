"use client";

import { userHandle } from "@ocw/contracts";
import { useMemo } from "react";
import { useAgents } from "@/lib/chat-queries";
import { useMembers } from "@/lib/queries";
import type { MentionTarget } from "./markdown";

export interface DirEntry {
  kind: "user" | "agent";
  id: string;
  displayName: string;
  handle: string;
  avatarUrl: string | null;
  /** Agents: description; users: email. */
  subtitle: string | null;
}

export interface OrgDirectory {
  entries: DirEntry[];
  byKey: Map<string, DirEntry>;
  handles: Map<string, MentionTarget>;
}

export const dirKey = (kind: string, id: string | null | undefined) => `${kind}:${id ?? ""}`;

/** Everyone you can @mention in the org: members (GET /members) + team bots (GET /agents, optional). */
export function useOrgDirectory(): OrgDirectory {
  const members = useMembers();
  const agents = useAgents();
  return useMemo(() => {
    const entries: DirEntry[] = [];
    for (const m of members.data?.members ?? []) {
      entries.push({
        kind: "user",
        id: m.userId,
        displayName: m.displayName,
        handle: userHandle(m),
        avatarUrl: m.avatarUrl,
        subtitle: m.email,
      });
    }
    for (const a of agents.data?.agents ?? []) {
      // Disabled bots and personal bots (DM-only, D-01) are never offered as @mentions.
      if (a.status === "disabled" || a.scope === "personal") continue;
      entries.push({
        kind: "agent",
        id: a.id,
        displayName: a.name,
        handle: a.username.toLowerCase(),
        avatarUrl: a.avatarUrl,
        subtitle: a.description,
      });
    }
    const byKey = new Map(entries.map((e) => [dirKey(e.kind, e.id), e]));
    const handles = new Map<string, MentionTarget>();
    for (const e of entries) {
      if (e.kind === "user" && handles.has(e.handle)) continue;
      handles.set(e.handle, { kind: e.kind, displayName: e.displayName });
    }
    return { entries, byKey, handles };
  }, [members.data, agents.data]);
}
