import {
  WORK_SESSION_TURN_WINDOW_MS,
  type WorkProjectIndex,
  type WorkProjectMembership,
  type WorkSession,
} from "@ocw/contracts";

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
/** Rows Needs you shows before "Show {n} more" (D-05, UI-SPEC § 3). */
export const NEEDS_YOU_CAP = 5;
/** "Your turn" lasts this long after the viewer's turn ended (UI-SPEC § 3); the API reads no older turn. */
export const YOUR_TURN_MS = WORK_SESSION_TURN_WINDOW_MS;
/** Settled rows shown before "Show {n} more" (UI-SPEC § 8, ref-4). */
export const SETTLED_PAGE = 10;
/** Search results per group before "Show all {n}" (UI-SPEC § 11). */
export const SEARCH_CAPS = { projects: 5, sessions: 10, repos: 5 } as const;

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

// ---------------------------------------------------------------- Needs you

/** Why a session waits on the viewer (UI-SPEC § 3): an approval they may decide, or their turn to answer. */
export type NeedsReason = "approval" | "turn";

/**
 * When this browser last opened each session (`ocw.workzone.seen.v1`, `useSeenSessions`): session ids and ISO times
 * only, never a title, never sent anywhere (R10, PD-09).
 */
export type SeenMap = Readonly<Record<string, string>>;

/**
 * Whether a session waits on the viewer (D-05, UI-SPEC § 3), from the per-viewer `attention` the API decided (07.10-02):
 * - `approval`: a pending approval the resolver lets the viewer decide (even while the session is open);
 * - `turn`: the session is idle with an empty queue, its last finished turn ran the viewer's prompt within 24 h, after
 *   the viewer last opened it in this browser, and it is not the open one.
 * No attention (a `ws:` snapshot, an older API) means nothing: the browser never infers it.
 */
export function needsViewer(
  s: WorkSession,
  seen: SeenMap,
  now: number,
  openSessionId: string | null,
): NeedsReason | null {
  const attention = s.attention;
  if (!attention) return null;
  if (attention.approval) return "approval";
  const ended = attention.lastTurnEndedAt;
  if (!ended || s.id === openSessionId || s.status !== "idle" || s.queuedCount > 0) return null;
  const endedAt = time(ended);
  if (!(now - endedAt < YOUR_TURN_MS)) return null;
  const last = seen[s.id];
  return last !== undefined && time(last) >= endedAt ? null : "turn";
}

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
  /** Sessions a collapsed section keeps besides the ones Needs you lists (the model adds those itself). */
  needs?: ReadonlySet<string>;
  /** When this browser last opened each session ("Your turn"); empty means never. */
  seen?: SeenMap;
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

export interface NeedsYouItem {
  session: WorkSession;
  reason: NeedsReason;
  /** The session's project, or its repository when personal or hidden (never a hidden project's name). */
  place: string;
}

export interface NeedsYouModel {
  key: "needs";
  collapsed: boolean;
  /** The rows to draw: approvals first, then turns, each most recent first; capped unless expanded. */
  rows: NeedsYouItem[];
  /** Rows behind "Show {n} more". */
  more: number;
  /** "Show fewer" is showing. */
  expanded: boolean;
  /** Collapsed: rows not shown (the header's count pill). */
  hidden: number;
}

export interface SettledModel {
  key: "settled";
  /** Collapsed by default (`useSidebarCollapse`): no row is drawn and no count shows (history is not news). */
  collapsed: boolean;
  /** The rows to draw, most recent first: 10 unless expanded. */
  rows: WorkSession[];
  /** Settled sessions in the viewer's scope. */
  total: number;
  /** Rows behind "Show {n} more". */
  more: number;
  expanded: boolean;
}

export interface SidebarModel {
  /** Sessions in the viewer's scope that wait on them (D-05); null when none (the section is absent). */
  needsYou: NeedsYouModel | null;
  /** The settled sessions of the viewer's scope (D-04); null when none. */
  settled: SettledModel | null;
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

/**
 * A collapsed section keeps only what concerns the viewer now (UI-SPEC § 4): the open session, the sessions in `needs`
 * (07.10-04), and the open project's row even with no session under it. Returns null when the row is not kept.
 */
function keptWhenCollapsed<R extends { sessions: WorkSession[]; more: number }>(
  row: R,
  all: readonly WorkSession[],
  input: SidebarInput,
  open: boolean,
): R | null {
  const keep = all.filter((s) => s.id === input.openSessionId || (input.needs?.has(s.id) ?? false));
  if (keep.length === 0 && !open) return null;
  return { ...row, sessions: keep, more: 0 };
}

/** Over the cap: every row with an active session, the open one, then name order up to the cap (UI-SPEC § 4). */
function capped<R>(rows: readonly R[], cap: number, required: (row: R) => boolean): R[] {
  if (rows.length <= cap) return [...rows];
  const must = new Set(rows.filter(required));
  let room = cap - must.size;
  return rows.filter((r) => {
    if (must.has(r)) return true;
    if (room <= 0) return false;
    room -= 1;
    return true;
  });
}

export function buildWorkZoneSidebar(given: SidebarInput): SidebarModel {
  let input = given;
  const scope = new Set<string>();
  const members = (input.index?.teamProjects ?? []).filter((p) => SIDEBAR_MEMBERSHIPS.has(p.membership));
  const memberIds = new Set(members.map((p) => p.id));
  const personalRepos = input.index?.personalRepos ?? [];
  const personalIds = new Set(personalRepos.map((r) => r.projectId));

  // PD-07: (a) under its project when the project is one of the viewer's; (b) under its repository in Personal when
  // the project is hidden from the viewer, the repository is personal to them, or they created the session; (c)
  // nowhere otherwise (admin- or manager-only sessions: search, the project page and Browse projects reach them).
  const byProject = new Map<string, WorkSession[]>();
  const byRepo = new Map<string, WorkSession[]>();
  const push = (map: Map<string, WorkSession[]>, key: string, s: WorkSession) => {
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  };
  for (const s of input.sessions) {
    const id = s.teamProject?.id;
    if (id && memberIds.has(id)) {
      scope.add(s.id);
      push(byProject, id, s);
    } else if (
      s.teamProjectHidden === true ||
      (!s.teamProject && personalIds.has(s.projectId)) ||
      (input.viewerId !== null && s.createdBy === input.viewerId)
    ) {
      scope.add(s.id);
      push(byRepo, s.projectId, s);
    }
  }
  // ---- Needs you: only from the viewer's scope (PD-07), so an admin's sidebar never fills with the organisation's
  // approvals; a collapsed section keeps every session listed here (D-01).
  const reasonRank: Record<NeedsReason, number> = { approval: 0, turn: 1 };
  const waiting = input.sessions
    .filter((s) => scope.has(s.id))
    .flatMap((s) => {
      const reason = needsViewer(s, input.seen ?? {}, input.now, input.openSessionId);
      return reason ? [{ session: s, reason, place: rowProject(s).name }] : [];
    })
    .sort(
      (a, b) =>
        reasonRank[a.reason] - reasonRank[b.reason] || time(b.session.updatedAt) - time(a.session.updatedAt),
    );
  let needsYou: NeedsYouModel | null = null;
  if (waiting.length > 0) {
    const collapsed = input.collapsed.has("needs");
    const expanded = !collapsed && input.expanded.has("needs") && waiting.length > NEEDS_YOU_CAP;
    const rows = collapsed ? [] : expanded ? waiting : waiting.slice(0, NEEDS_YOU_CAP);
    needsYou = {
      key: "needs",
      collapsed,
      rows,
      more: collapsed ? 0 : waiting.length - rows.length,
      expanded,
      hidden: collapsed ? waiting.length : 0,
    };
  }
  input = { ...input, needs: new Set([...(input.needs ?? []), ...waiting.map((w) => w.session.id)]) };

  const holdsOpen = (sessions: readonly WorkSession[]) => sessions.some((s) => s.id === input.openSessionId);
  const hasActive = (sessions: readonly WorkSession[]) => sessions.some((s) => isActiveSession(s, input.now));

  // ---- department sections
  const groups = new Map<
    string,
    { title: string; viewerIsMember: boolean; rows: Array<{ row: ProjectRowModel; all: WorkSession[] }> }
  >();
  for (const p of members) {
    const all = byProject.get(p.id) ?? [];
    const rows = subRows(all, input, SUB_ROW_CAP);
    const row: ProjectRowModel = {
      id: p.id,
      name: p.name,
      pill: p.parent.id !== p.top.id ? p.parent.name : null,
      live: liveCount(all),
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
    group.rows.push({ row, all });
    groups.set(p.top.id, group);
  }

  const sections: UnitSectionModel[] = [...groups.entries()].map(([key, g]) => {
    const rows = g.rows.sort((a, b) => byName(a.row.name, b.row.name));
    const collapsed = input.collapsed.has(key);
    const base = { key, title: g.title, viewerIsMember: g.viewerIsMember, collapsed };
    if (collapsed) {
      const kept = rows.flatMap(({ row, all }) => keptWhenCollapsed(row, all, input, row.active) ?? []);
      return { ...base, projects: kept, hidden: rows.length - kept.length, moreProjects: 0, expanded: false };
    }
    const expanded = input.expanded.has(`section:${key}`) && rows.length > SECTION_PROJECT_CAP;
    const shown = expanded
      ? rows
      : capped(rows, SECTION_PROJECT_CAP, ({ row, all }) => row.active || hasActive(all) || holdsOpen(all));
    return {
      ...base,
      projects: shown.map(({ row }) => row),
      hidden: 0,
      moreProjects: rows.length - shown.length,
      expanded,
    };
  });
  sections.sort((a, b) => Number(b.viewerIsMember) - Number(a.viewerIsMember) || byName(a.title, b.title));

  // ---- Personal: the index's personal repositories plus the repositories of the sessions placed by (b)
  const repoNames = new Map<string, { name: string; hiddenProject: boolean }>();
  for (const r of personalRepos) repoNames.set(r.projectId, { name: r.name, hiddenProject: false });
  for (const [projectId, sessions] of byRepo) {
    if (repoNames.has(projectId)) continue;
    const first = sessions[0] as WorkSession;
    repoNames.set(projectId, {
      name: first.projectName,
      hiddenProject: sessions.some((s) => s.teamProjectHidden === true),
    });
  }
  const latestActive = (sessions: readonly WorkSession[]) =>
    Math.max(0, ...sessions.filter((s) => isActiveSession(s, input.now)).map((s) => time(s.updatedAt)));
  const repos = [...repoNames.entries()]
    .map(([projectId, meta]) => {
      const all = byRepo.get(projectId) ?? [];
      const overCap = all.filter((s) => isActiveSession(s, input.now)).length > SUB_ROW_CAP;
      const expanded = input.expanded.has(`repo:${projectId}`) && overCap;
      const rows = subRows(all, input, expanded ? Number.POSITIVE_INFINITY : SUB_ROW_CAP);
      const row: RepoRowModel = {
        projectId,
        name: meta.name,
        hiddenProject: meta.hiddenProject,
        live: liveCount(all),
        sessions: rows.sessions,
        more: rows.more,
        expanded,
      };
      return { row, all, recent: latestActive(all) };
    })
    .sort((a, b) => b.recent - a.recent || byName(a.row.name, b.row.name));

  let personal: PersonalModel | null = null;
  if (repos.length > 0) {
    const collapsed = input.collapsed.has("personal");
    if (collapsed) {
      const kept = repos.flatMap(({ row, all }) => keptWhenCollapsed(row, all, input, false) ?? []);
      personal = {
        key: "personal",
        collapsed,
        repos: kept,
        hidden: repos.length - kept.length,
        moreRepos: 0,
        expanded: false,
      };
    } else {
      const expanded = input.expanded.has("personal") && repos.length > PERSONAL_REPO_CAP;
      const shown = expanded ? repos : capped(repos, PERSONAL_REPO_CAP, ({ all }) => holdsOpen(all));
      personal = {
        key: "personal",
        collapsed,
        repos: shown.map(({ row }) => row),
        hidden: 0,
        moreRepos: repos.length - shown.length,
        expanded,
      };
    }
  }

  // ---- Settled: the viewer's scope only (an admin's history lives on each project page and in search)
  const ended = input.sessions
    .filter((s) => scope.has(s.id) && !isActiveSession(s, input.now))
    .sort((a, b) => time(b.updatedAt) - time(a.updatedAt));
  let settled: SettledModel | null = null;
  if (ended.length > 0) {
    const collapsed = input.collapsed.has("settled");
    const expanded = !collapsed && input.expanded.has("settled") && ended.length > SETTLED_PAGE;
    const rows = collapsed ? [] : expanded ? ended : ended.slice(0, SETTLED_PAGE);
    settled = {
      key: "settled",
      collapsed,
      rows,
      total: ended.length,
      more: collapsed ? 0 : ended.length - rows.length,
      expanded,
    };
  }

  return { needsYou, settled, sections, personal, scope };
}

// ---------------------------------------------------------------- search

/** Case- and accent-blind text for matching ("Éclair" → "eclair"). */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export interface SearchGroup<T> {
  /** The rows to draw: capped unless expanded. */
  rows: T[];
  /** Every match ("Show all {n}"). */
  total: number;
  expanded: boolean;
}

export interface SearchModel {
  /** Team projects of the index by name, members' and managed ones (a managed one is `muted`). */
  projects: SearchGroup<{ row: ProjectRowModel; muted: boolean }>;
  /** Every listed session, active or settled, by title, repository or a project the viewer can see named. */
  sessions: SearchGroup<WorkSession>;
  /** Personal repositories by name. */
  repos: SearchGroup<RepoRowModel>;
  /** Matches over every group (the live region's "{n} results"). */
  count: number;
}

export interface SearchInput {
  sessions: readonly WorkSession[];
  index: WorkProjectIndex | null | undefined;
  now: number;
  openProjectId: string | null;
  /** `search:projects`, `search:sessions`, `search:repos`: "Show all {n}" is open. */
  expanded: ReadonlySet<string>;
}

function capGroup<T>(all: T[], cap: number, expanded: boolean): SearchGroup<T> {
  const open = expanded && all.length > cap;
  return { rows: open ? all : all.slice(0, cap), total: all.length, expanded: open };
}

/**
 * The grouped search of the sidebar (D-08, UI-SPEC § 11): a case-insensitive, accent-folded substring over the names
 * the two list responses carry, exact prefixes first, then names in order (projects, repositories) or the most recent
 * (sessions). It only reads what the API sent (C-01): a session whose project the viewer may not see named never
 * matches on a project name (`teamProjectHidden`), and a project outside the index can't match at all.
 */
export function searchSidebar(query: string, input: SearchInput): SearchModel {
  const q = fold(query.trim());
  const starts = (text: string) => fold(text).startsWith(q);
  const has = (text: string) => fold(text).includes(q);
  const prefixFirst = <T>(a: T, b: T, isPrefix: (x: T) => boolean) =>
    Number(isPrefix(b)) - Number(isPrefix(a));

  const live = (match: (s: WorkSession) => boolean) => liveCount(input.sessions.filter(match));
  const projects = (input.index?.teamProjects ?? [])
    .filter((p) => has(p.name))
    .sort((a, b) => prefixFirst(a, b, (p) => starts(p.name)) || byName(a.name, b.name))
    .map((p) => ({
      row: {
        id: p.id,
        name: p.name,
        pill: p.parent.id !== p.top.id ? p.parent.name : null,
        live: live((s) => s.teamProject?.id === p.id),
        sessions: [],
        more: 0,
        active: p.id === input.openProjectId,
        repoCount: p.repoCount,
      },
      muted: !SIDEBAR_MEMBERSHIPS.has(p.membership),
    }));

  const fields = (s: WorkSession) =>
    s.teamProject && s.teamProjectHidden !== true
      ? [s.title, s.projectName, s.teamProject.name]
      : [s.title, s.projectName];
  const sessions = input.sessions
    .filter((s) => fields(s).some(has))
    .sort(
      (a, b) => prefixFirst(a, b, (s) => fields(s).some(starts)) || time(b.updatedAt) - time(a.updatedAt),
    );

  const repoMeta = new Map<string, { name: string; hiddenProject: boolean }>();
  for (const r of input.index?.personalRepos ?? [])
    repoMeta.set(r.projectId, { name: r.name, hiddenProject: false });
  for (const s of input.sessions) {
    if (s.teamProjectHidden === true && !repoMeta.has(s.projectId))
      repoMeta.set(s.projectId, { name: s.projectName, hiddenProject: true });
  }
  const repos = [...repoMeta.entries()]
    .filter(([, meta]) => has(meta.name))
    .sort(([, a], [, b]) => prefixFirst(a, b, (m) => starts(m.name)) || byName(a.name, b.name))
    .map(
      ([projectId, meta]): RepoRowModel => ({
        projectId,
        name: meta.name,
        hiddenProject: meta.hiddenProject,
        live: live((s) => s.projectId === projectId),
        sessions: [],
        more: 0,
        expanded: false,
      }),
    );

  return {
    projects: capGroup(projects, SEARCH_CAPS.projects, input.expanded.has("search:projects")),
    sessions: capGroup(sessions, SEARCH_CAPS.sessions, input.expanded.has("search:sessions")),
    repos: capGroup(repos, SEARCH_CAPS.repos, input.expanded.has("search:repos")),
    count: projects.length + sessions.length + repos.length,
  };
}
