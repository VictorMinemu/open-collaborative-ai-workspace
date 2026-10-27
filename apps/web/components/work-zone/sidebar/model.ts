import type { WorkProjectIndex, WorkProjectMembership, WorkSession } from "@ocw/contracts";

/**
 * The Work Zone sidebar model (Phase 07.10, UI-SPEC § 4-§ 7, PD-07): a pure function from what `GET /work-sessions` and
 * `GET /work-projects` returned to the rows the sidebar draws. It groups; it never decides access (C-01): a session or
 * a project the API did not return cannot appear, and a project the viewer may not see named (`teamProjectHidden`) is
 * never named here, because its name never reaches the browser.
 */

/** Active sessions shown under a project or repository before "+N more" (D-04). */
export const SUB_ROW_CAP = 3;
/** Projects a department section shows before "{n} more projects" (D-09, UI-SPEC § 4). */
export const SECTION_PROJECT_CAP = 15;
/** Repositories Personal shows before "{n} more repositories" (UI-SPEC § 7). */
export const PERSONAL_REPO_CAP = 5;

// ---------------------------------------------------------------- helpers (moved from session-sidebar.tsx)

/** Idle sessions touched within this window stay active (D-17); older ones settle. */
const ACTIVE_IDLE_MS = 24 * 60 * 60 * 1000;

const ACTIVE: ReadonlyArray<WorkSession["status"]> = [
  "provisioning",
  "running",
  "waiting_approval",
  "host_offline",
];

export function isActiveSession(s: WorkSession, now: number): boolean {
  if (ACTIVE.includes(s.status) || s.pendingApprovals > 0 || s.queuedCount > 0) return true;
  return s.status === "idle" && now - new Date(s.updatedAt).getTime() < ACTIVE_IDLE_MS;
}

/** Two-letter project badge (ref-4 "OW", "HE"): first letters of the first two words, or of the only word. */
export function projectInitials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+|(?<=\p{Ll})(?=\p{Lu})/u).filter((w) => /^\p{L}/u.test(w));
  if (words.length === 0) return name.slice(0, 2).toUpperCase() || "?";
  const [a = "", b = ""] = words;
  return (b ? a.charAt(0) + b.charAt(0) : a.slice(0, 2)).toUpperCase();
}

/** "now", "5m", "3h", "2d", "6w" (ref-4 sidebar times). */
export function shortAgo(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`;
  return `${Math.floor(s / (7 * 86_400))}w`;
}

/** Elapsed time of the running turn: "12s", "5m", "1h 5m". */
export function elapsedLabel(sinceIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(sinceIso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * The group a row sorts under and the name its label and badge show (07.9 UI-SPEC R10): the team project when the
 * repository is linked to one the viewer may see named, the repository otherwise.
 */
export function rowProject(s: Pick<WorkSession, "projectId" | "projectName" | "teamProject">): {
  key: string;
  name: string;
} {
  return s.teamProject
    ? { key: s.teamProject.id, name: s.teamProject.name }
    : { key: s.projectId, name: s.projectName };
}

/** Active rows: by project group (the group with the latest activity first), then by recency. */
export function orderActiveSessions(live: readonly WorkSession[]): WorkSession[] {
  const recency = (s: WorkSession) => new Date(s.updatedAt).getTime();
  const groupRank = new Map<string, number>();
  for (const s of live) {
    const key = rowProject(s).key;
    groupRank.set(key, Math.max(groupRank.get(key) ?? 0, recency(s)));
  }
  return [...live].sort((a, b) => {
    const ka = rowProject(a).key;
    const kb = rowProject(b).key;
    return (
      (groupRank.get(kb) ?? 0) - (groupRank.get(ka) ?? 0) || ka.localeCompare(kb) || recency(b) - recency(a)
    );
  });
}

// ---------------------------------------------------------------- row facts

export type StatusTone = "primary" | "warning" | "muted";

export function needsApproval(s: Pick<WorkSession, "status" | "pendingApprovals">): boolean {
  return s.status === "waiting_approval" || s.pendingApprovals > 0;
}

/** The right-slot status of a session row: the texts and tones of the old `RowStatus`, without its icon. */
export function rowStatusText(s: WorkSession, now: number): { tone: StatusTone; text: string } {
  if (needsApproval(s)) return { tone: "warning", text: "Needs approval" };
  if (s.status === "running")
    return {
      tone: "primary",
      text: s.runningSince ? `Working ${elapsedLabel(s.runningSince, now)}` : "Working",
    };
  if (s.status === "provisioning") return { tone: "muted", text: "Starting" };
  if (s.status === "host_offline") return { tone: "muted", text: "Offline" };
  if (s.queuedCount > 0) return { tone: "muted", text: `${s.queuedCount} queued` };
  return { tone: "muted", text: shortAgo(s.updatedAt, now) };
}

const LIVE_NOW: ReadonlyArray<WorkSession["status"]> = ["provisioning", "running", "waiting_approval"];

/** Sessions live right now (the "● n" count): provisioning, running or waiting for an approval. 0 = no count. */
export function liveCount(sessions: readonly WorkSession[]): number {
  return sessions.filter((s) => LIVE_NOW.includes(s.status)).length;
}

const time = (iso: string) => new Date(iso).getTime();

/** Sub-row order (UI-SPEC § 6): an approval first, then running or starting, then the most recent. */
function bySubRowOrder(a: WorkSession, b: WorkSession): number {
  const rank = (s: WorkSession) =>
    needsApproval(s) ? 0 : s.status === "running" || s.status === "provisioning" ? 1 : 2;
  return rank(a) - rank(b) || time(b.updatedAt) - time(a.updatedAt);
}

/** Name order everywhere in the sidebar: accent- and case-blind, numbers by value ("Ops 9" before "Ops 10"). */
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const byName = (a: string, b: string) => collator.compare(a, b);

// ---------------------------------------------------------------- the model

/** Index rows that are sidebar rows: projects the viewer belongs to (D-02). `manager` rows are Browse only. */
const SIDEBAR_MEMBERSHIPS: ReadonlySet<WorkProjectMembership> = new Set(["member", "team", "lead"]);

export interface SidebarInput {
  sessions: readonly WorkSession[];
  /** `GET /work-projects`; null or undefined while it loads (no section yet). */
  index: WorkProjectIndex | null | undefined;
  viewerId: string | null;
  now: number;
  openSessionId: string | null;
  openProjectId: string | null;
  /** Section keys that are collapsed (defaults already applied by `useSidebarCollapse`). */
  collapsed: ReadonlySet<string>;
  /** Inline expansions: `section:<key>` (more projects), `personal` (more repositories), `repo:<projectId>`. */
  expanded: ReadonlySet<string>;
  /** Sessions waiting on the viewer (07.10-04): a collapsed section keeps them. */
  needs?: ReadonlySet<string>;
}

export interface ProjectRowModel {
  id: string;
  name: string;
  /** The team (or any unit below the department) the project sits under; null directly under the department. */
  pill: string | null;
  /** Live sessions of the project the viewer can see (0 = no count). */
  live: number;
  /** The sub-rows to draw, in order (the open session included even when settled or beyond the cap). */
  sessions: WorkSession[];
  /** Active sessions not drawn ("+N more", to the project page). */
  more: number;
  /** The project page is open (any tab). */
  active: boolean;
  repoCount: number;
}

export interface UnitSectionModel {
  /** The department (top unit) id. */
  key: string;
  title: string;
  viewerIsMember: boolean;
  collapsed: boolean;
  projects: ProjectRowModel[];
  /** Collapsed: projects not shown (the header's count pill). */
  hidden: number;
  /** Over the project cap and not expanded: projects behind "{n} more projects". */
  moreProjects: number;
  /** The cap's inline expansion is open ("Show fewer"). */
  expanded: boolean;
}

export interface RepoRowModel {
  projectId: string;
  name: string;
  /** Linked to a team project the viewer may not see named: the row carries only the fixed hint. */
  hiddenProject: boolean;
  live: number;
  sessions: WorkSession[];
  more: number;
  /** The inline "+N more" is open. */
  expanded: boolean;
}

export interface PersonalModel {
  key: "personal";
  collapsed: boolean;
  repos: RepoRowModel[];
  hidden: number;
  moreRepos: number;
  expanded: boolean;
}

export interface SidebarModel {
  sections: UnitSectionModel[];
  personal: PersonalModel | null;
  /** Session ids placed in the tree (PD-07 (a) ∪ (b)): Needs you and Settled draw only from these (07.10-04). */
  scope: ReadonlySet<string>;
}

/** The sub-rows of one project or repository: the active sessions capped, plus the open one. */
function subRows(
  sessions: readonly WorkSession[],
  input: SidebarInput,
  cap: number,
): { sessions: WorkSession[]; more: number } {
  const active = sessions.filter((s) => isActiveSession(s, input.now)).sort(bySubRowOrder);
  const shown = active.slice(0, cap);
  const open = input.openSessionId ? sessions.find((s) => s.id === input.openSessionId) : undefined;
  if (open && !shown.includes(open)) shown.push(open);
  return { sessions: shown, more: active.filter((s) => !shown.includes(s)).length };
}

export function buildWorkZoneSidebar(input: SidebarInput): SidebarModel {
  const scope = new Set<string>();
  const members = (input.index?.teamProjects ?? []).filter((p) => SIDEBAR_MEMBERSHIPS.has(p.membership));
  const memberIds = new Set(members.map((p) => p.id));

  // PD-07 (a): a session sits under its project when the project is one of the viewer's.
  const byProject = new Map<string, WorkSession[]>();
  for (const s of input.sessions) {
    const id = s.teamProject?.id;
    if (!id || !memberIds.has(id)) continue;
    scope.add(s.id);
    const list = byProject.get(id) ?? [];
    list.push(s);
    byProject.set(id, list);
  }

  const groups = new Map<string, { title: string; viewerIsMember: boolean; rows: ProjectRowModel[] }>();
  for (const p of members) {
    const sessions = byProject.get(p.id) ?? [];
    const rows = subRows(sessions, input, SUB_ROW_CAP);
    const row: ProjectRowModel = {
      id: p.id,
      name: p.name,
      pill: p.parent.id !== p.top.id ? p.parent.name : null,
      live: liveCount(sessions),
      sessions: rows.sessions,
      more: rows.more,
      active: p.id === input.openProjectId,
      repoCount: p.repoCount,
    };
    const group = groups.get(p.top.id) ?? {
      title: p.top.name,
      viewerIsMember: p.top.viewerIsMember,
      rows: [],
    };
    group.rows.push(row);
    groups.set(p.top.id, group);
  }

  const sections: UnitSectionModel[] = [...groups.entries()].map(([key, g]) => {
    const projects = g.rows.sort((a, b) => byName(a.name, b.name));
    return {
      key,
      title: g.title,
      viewerIsMember: g.viewerIsMember,
      collapsed: false,
      projects,
      hidden: 0,
      moreProjects: 0,
      expanded: false,
    };
  });
  sections.sort((a, b) => Number(b.viewerIsMember) - Number(a.viewerIsMember) || byName(a.title, b.title));

  return { sections, personal: null, scope };
}
