import type { WorkSession } from "@ocw/contracts";

/**
 * Sessions by person (07.13.1.1, D-01): who owns each Work Zone session the viewer can see. Pure grouping of the list
 * the API already returned (`useWorkSessions()`, the resolver's readable set, PD-07 as in `sidebar/model.ts`): the
 * client never decides who can see what, never adds a session and filters only by the three filters the viewer picks
 * (T-07.13.1.1-07-01).
 */

/** The three filters, kept in the URL as `?person=&project=&device=` (stable ids, principle 11). */
export type PeopleFilters = { person: string | null; project: string | null; device: string | null };

export const NO_FILTERS: PeopleFilters = { person: null, project: null, device: null };

const FILTER_KEYS = ["person", "project", "device"] as const satisfies readonly (keyof PeopleFilters)[];

/** An owner the directory no longer knows (they left the organization), as in the session header. */
export const FORMER_MEMBER = "a former member";
const FORMER_MEMBER_LABEL = "A former member";
const YOU = "You";

export type FilterOption = { id: string; label: string };

export type PeopleGroup = {
  ownerId: string;
  /** The owner's name (`createdByName`), "a former member" when they left. */
  name: string;
  /** What the group header shows: "You" for the viewer, else the name (capitalised for a former member). */
  label: string;
  isViewer: boolean;
  /** The owner left the organization (no name). */
  former: boolean;
  count: number;
  /** Newest activity first. */
  sessions: WorkSession[];
};

export type PeopleModel = {
  groups: PeopleGroup[];
  /** Built from every listed session (not the filtered ones), so a filter never hides its own alternatives. */
  options: { people: FilterOption[]; projects: FilterOption[]; devices: FilterOption[] };
  /** Sessions in the list, and how many the filters keep. */
  total: number;
  shown: number;
};

const byLabel = (a: FilterOption, b: FilterOption) =>
  a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** Group rank: the viewer, then named people by name, then former members. */
function compareGroups(a: PeopleGroup, b: PeopleGroup): number {
  if (a.isViewer !== b.isViewer) return a.isViewer ? -1 : 1;
  if (a.former !== b.former) return a.former ? 1 : -1;
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.ownerId.localeCompare(b.ownerId)
  );
}

function matches(s: WorkSession, f: PeopleFilters): boolean {
  return (
    (f.person === null || s.createdBy === f.person) &&
    (f.project === null || s.projectId === f.project) &&
    (f.device === null || s.deviceId === f.device)
  );
}

function options(sessions: readonly WorkSession[], viewerId: string | null): PeopleModel["options"] {
  const people = new Map<string, string | null>();
  const projects = new Map<string, WorkSession>();
  const devices = new Map<string, string>();
  for (const s of sessions) {
    if (!people.has(s.createdBy)) people.set(s.createdBy, s.createdByName);
    if (!projects.has(s.projectId)) projects.set(s.projectId, s);
    if (!devices.has(s.deviceId)) devices.set(s.deviceId, s.deviceName);
  }

  const viewer: FilterOption[] = [];
  const named: FilterOption[] = [];
  const gone: FilterOption[] = [];
  for (const [id, name] of people) {
    if (id === viewerId) viewer.push({ id, label: YOU });
    else if (name === null) gone.push({ id, label: FORMER_MEMBER_LABEL });
    else named.push({ id, label: name });
  }

  // Two repositories with the same name (on two devices) read "web-app · <device>" so the viewer can tell them apart.
  const nameCount = new Map<string, number>();
  for (const s of projects.values()) nameCount.set(s.projectName, (nameCount.get(s.projectName) ?? 0) + 1);
  const projectOptions = [...projects.values()].map((s) => ({
    id: s.projectId,
    label: (nameCount.get(s.projectName) ?? 0) > 1 ? `${s.projectName} · ${s.deviceName}` : s.projectName,
  }));

  return {
    people: [...viewer, ...named.sort(byLabel), ...gone.sort(byLabel)],
    projects: projectOptions.sort(byLabel),
    devices: [...devices].map(([id, label]) => ({ id, label })).sort(byLabel),
  };
}

/** The groups (viewer first as "You", then by name; newest activity first inside each) and the filter options. */
export function peopleModel(
  sessions: readonly WorkSession[],
  viewerId: string | null,
  filters: PeopleFilters,
): PeopleModel {
  const groups = new Map<string, PeopleGroup>();
  let shown = 0;
  for (const s of sessions) {
    if (!matches(s, filters)) continue;
    shown += 1;
    let g = groups.get(s.createdBy);
    if (!g) {
      const isViewer = s.createdBy === viewerId;
      const name = s.createdByName ?? FORMER_MEMBER;
      g = {
        ownerId: s.createdBy,
        name,
        label: isViewer ? YOU : (s.createdByName ?? FORMER_MEMBER_LABEL),
        isViewer,
        former: s.createdByName === null,
        count: 0,
        sessions: [],
      };
      groups.set(s.createdBy, g);
    }
    g.sessions.push(s);
    g.count += 1;
  }
  for (const g of groups.values()) g.sessions.sort((a, b) => time(b.updatedAt) - time(a.updatedAt));
  return {
    groups: [...groups.values()].sort(compareGroups),
    options: options(sessions, viewerId),
    total: sessions.length,
    shown,
  };
}

/** The filters in the URL; a missing or blank key is no filter. */
export function filtersFrom(params: { get(name: string): string | null }): PeopleFilters {
  const read = (key: keyof PeopleFilters) => {
    const v = params.get(key)?.trim();
    return v ? v : null;
  };
  return { person: read("person"), project: read("project"), device: read("device") };
}

/** The query string for the filters that are set (`""` for none), always in the order person, project, device. */
export function filtersQuery(filters: PeopleFilters): string {
  const params = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const v = filters[key];
    if (v) params.set(key, v);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const hasFilters = (f: PeopleFilters) => FILTER_KEYS.some((k) => f[k] !== null);
