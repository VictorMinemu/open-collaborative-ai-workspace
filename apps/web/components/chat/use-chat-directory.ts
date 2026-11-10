"use client";

import { type OrgUnit, userHandle } from "@ocw/contracts";
import { useMemo } from "react";
import { useAgents } from "@/lib/chat-queries";
import { useUnits } from "@/lib/org-queries";
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

/** A team or department the viewer can `@mention` in a channel (07.17 D-07, PD-19). */
export interface UnitMentionCandidate {
  id: string;
  kind: "team" | "department";
  name: string;
  handle: string;
  /** Distinct active members of the unit's subtree: who a mention of it can reach. */
  reach: number;
  viewerInReach: boolean;
  /** Root → self (WR-09: a unit inside another named unit adds nothing to a message's reach). */
  path?: readonly string[];
}

export interface OrgDirectory {
  entries: DirEntry[];
  byKey: Map<string, DirEntry>;
  /** People and bots first; unit handles only where no person or bot holds them (the server's precedence). */
  handles: Map<string, MentionTarget>;
  /** Mentionable units, by name (never projects, never a shadowed handle). */
  units: UnitMentionCandidate[];
}

export const dirKey = (kind: string, id: string | null | undefined) => `${kind}:${id ?? ""}`;

/**
 * The units a member can mention: teams and departments with a handle (07.17 servers) that no person or bot in
 * `handles` holds, as the API resolves them (agents, then people, then units). Only what `GET /units` returned to
 * the viewer is ever offered; the API decides who is notified.
 */
export function mentionUnitsOf(
  units: readonly OrgUnit[],
  handles: ReadonlyMap<string, unknown>,
): UnitMentionCandidate[] {
  const out: UnitMentionCandidate[] = [];
  for (const u of units) {
    if (u.kind === "project" || !u.handle || handles.has(u.handle)) continue;
    // WR-09: the server resolves a unit only for an author who may read it (`unit.read`, unit-scoped rules included).
    if (!u.viewerCan.includes("unit.read")) continue;
    out.push({
      id: u.id,
      kind: u.kind,
      name: u.name,
      handle: u.handle,
      reach: u.reach ?? 0,
      viewerInReach: u.viewerInReach ?? false,
      path: u.path,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.handle.localeCompare(b.handle));
}

/**
 * Everyone you can @mention in the org: members (GET /members) + team bots (GET /agents, optional), and the
 * teams and departments of GET /units (07.17) under handles nobody else holds.
 */
export function useOrgDirectory(): OrgDirectory {
  const members = useMembers();
  const agents = useAgents();
  const orgUnits = useUnits();
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
    const units = mentionUnitsOf(orgUnits.data?.units ?? [], handles);
    for (const u of units) {
      handles.set(u.handle, {
        kind: "unit",
        displayName: u.name,
        unitKind: u.kind,
        viewerInReach: u.viewerInReach,
      });
    }
    return { entries, byKey, handles, units };
  }, [members.data, agents.data, orgUnits.data]);
}

/** Teams and departments for the composer's "Teams" group: pass them only in channels and their threads. */
export function useMentionUnits(): UnitMentionCandidate[] {
  return useOrgDirectory().units;
}
