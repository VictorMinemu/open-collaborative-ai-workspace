import type {
  SessionAudienceInput,
  SessionVisibilityKind,
  ViewerReason,
  WorkSession,
  WorkSessionVisibilitySummary,
  WorkSessionVisibilityView,
} from "@ocw/contracts";

/**
 * Every word the UI uses for who can see a Work Zone session (Phase 07.9, D-07, UI-SPEC Copywriting Contract). Pure:
 * no React, no fetching and no access logic. The API decides who can see a session and sends `kind`, `activeCount` and
 * `differsFromDefault`; this module only words them. Plain words only (N4): "Only me", "Project", "2 teams",
 * "3 people", "can see".
 */

/** The display name's first word ("Ana Ruiz" → "Ana"). */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/u)[0] ?? "";
}

/** "1 person" / "3 people", "1 repository" / "2 repositories". */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const people = (n: number) => plural(n, "person", "people");

/** Teams or people with nobody active read as the owner case (UI-SPEC §1.5). */
function effectiveKind(kind: SessionVisibilityKind, activeCount: number): SessionVisibilityKind {
  return (kind === "teams" || kind === "people") && activeCount === 0 ? "owner" : kind;
}

/** Who the session is about: its owner and whether the viewer is that owner. */
export type OwnerContext = {
  /** The owner's display name; null when the API has none (e.g. a removed account). */
  ownerName: string | null;
  viewerIsOwner: boolean;
};

/** Where the session runs: its team project, or the device of a personal repository. */
export type PlaceContext = {
  /** The team project's name (or the repository's name for a personal project); empty when `hidden`. */
  projectName: string;
  deviceName: string;
  /** A personal repository (no team project): "Project" means everyone who can use the device. */
  personal: boolean;
  /**
   * A team project the viewer can't open (Phase 07.10-07, HI-01, ME-01: the API sends no name). Never "personal": the
   * audience is that project's people, so every label says "a project you can't open" and names no project.
   */
  hidden?: boolean | undefined;
};

/** The one phrase for a project the viewer can't open, inside an audience label (07.9 D-14 wording). */
export const HIDDEN_PROJECT_PLACE = "a project you can't open";
/** The read-only panel's note for such a session (§1.4). */
export const HIDDEN_PROJECT_NOTE = "Linked to a project you can't open.";

/** "Everyone in {project}" · "Everyone in a project you can't open" · "Everyone who can use {device}". */
function everyoneIn(p: PlaceContext): string {
  if (p.hidden) return `Everyone in ${HIDDEN_PROJECT_PLACE}`;
  return p.personal ? `Everyone who can use ${p.deviceName}` : `Everyone in ${p.projectName}`;
}

export type ShortLabelInput = OwnerContext & {
  kind: SessionVisibilityKind;
  activeCount: number;
  firstTeamName: string | null;
};

export type LongLabelInput = OwnerContext &
  PlaceContext & {
    kind: SessionVisibilityKind;
    activeCount: number;
    /** Active team names when known (the panel); a list row only has `firstTeamName`. */
    teamNames?: readonly string[] | undefined;
    firstTeamName?: string | null | undefined;
  };

const ownerFull = (o: OwnerContext) => o.ownerName ?? "the owner";

/** The chip's label (§1.3 "Short label"): Only me · Only {first name} · Project · {team} · {n} teams · {n} people. */
export function shortLabel(s: ShortLabelInput): string {
  const kind = effectiveKind(s.kind, s.activeCount);
  if (kind === "owner") {
    if (s.viewerIsOwner) return "Only me";
    return s.ownerName ? `Only ${firstName(s.ownerName)}` : "Only the owner";
  }
  if (kind === "project") return "Project";
  if (kind === "teams")
    return s.activeCount === 1 && s.firstTeamName ? s.firstTeamName : `${s.activeCount} teams`;
  return people(s.activeCount + 1);
}

/**
 * The long label (§1.3): Only you · Only {owner} · Everyone in {project} · Everyone who can use {device} · {team} ·
 * {A} and {B} · {A}, {B} and {n} more · {n} people.
 */
export function longLabel(s: LongLabelInput): string {
  const kind = effectiveKind(s.kind, s.activeCount);
  if (kind === "owner") return s.viewerIsOwner ? "Only you" : `Only ${ownerFull(s)}`;
  if (kind === "project") return everyoneIn(s);
  if (kind === "people") return people(s.activeCount + 1);
  const names = s.teamNames ?? (s.firstTeamName ? [s.firstTeamName] : []);
  const [a, b] = names;
  if (s.activeCount === 1 && a) return a;
  if (a && b && names.length >= s.activeCount) {
    return s.activeCount === 2 ? `${a} and ${b}` : `${a}, ${b} and ${s.activeCount - 2} more`;
  }
  return `${s.activeCount} teams`;
}

export type MarkerKind = "none" | "lock" | "users" | "project";

/**
 * The sidebar marker's icon (UI-SPEC Surface 2). Nothing unless the server says the session differs from its project's
 * default; then the owner case → lock, project (under a default-off project) → project, teams / people → users.
 */
export function markerKind(v: WorkSessionVisibilitySummary | undefined): MarkerKind {
  if (!v?.differsFromDefault) return "none";
  const kind = effectiveKind(v.kind, v.activeCount);
  if (kind === "owner") return "lock";
  if (kind === "project") return "project";
  return "users";
}

/** "everyone in {project}" inside a sentence; any other long label as it is. */
function inSentence(s: LongLabelInput): string {
  const label = longLabel(s);
  return effectiveKind(s.kind, s.activeCount) === "project" ? label.replace(/^Everyone/u, "everyone") : label;
}

/** The marker's tooltip: Only visible to you · Only visible to {owner} · Visible to {long label}. */
export function markerTooltip(s: LongLabelInput): string {
  if (effectiveKind(s.kind, s.activeCount) === "owner")
    return s.viewerIsOwner ? "Only visible to you" : `Only visible to ${ownerFull(s)}`;
  return `Visible to ${inSentence(s)}`;
}

/** The row link's screen-reader suffix: ", only visible to you" · ", visible to {long label}". */
export function markerSrSuffix(s: LongLabelInput): string {
  const tooltip = markerTooltip(s);
  return `, ${tooltip.charAt(0).toLowerCase()}${tooltip.slice(1)}`;
}

/** A list row's labels for its viewer, from the session DTO alone (the marker never waits for a request). */
export function sessionLabels(
  s: Pick<
    WorkSession,
    "visibility" | "teamProject" | "projectName" | "deviceName" | "createdBy" | "createdByName"
  >,
  viewerId: string | null | undefined,
): { marker: MarkerKind; tooltip: string | null; srSuffix: string } {
  const marker = markerKind(s.visibility);
  if (marker === "none" || !s.visibility) return { marker: "none", tooltip: null, srSuffix: "" };
  const input: LongLabelInput = {
    kind: s.visibility.kind,
    activeCount: s.visibility.activeCount,
    firstTeamName: s.visibility.firstTeamName,
    ownerName: s.createdByName,
    viewerIsOwner: viewerId === s.createdBy,
    projectName: s.teamProject?.name ?? s.projectName,
    deviceName: s.deviceName,
    personal: !s.teamProject,
  };
  return { marker, tooltip: markerTooltip(input), srSuffix: markerSrSuffix(input) };
}

/** The chip's accessible name: "Visible to {long label}. Change who can see this session" (editors) or "See …". */
export function chipName(label: string, editable: boolean): string {
  return `Visible to ${label}. ${editable ? "Change" : "See"} who can see this session`;
}

/** Footer line 1: "{n} people can see this", or "Only you / Only {owner} can see this" when only the owner can. */
export function footerCount(n: number, ctx: OwnerContext & { ownerOnly: boolean }): string {
  if (ctx.ownerOnly && n <= 1)
    return ctx.viewerIsOwner ? "Only you can see this" : `Only ${ownerFull(ctx)} can see this`;
  return `${people(n)} can see this`;
}

/** Footer line 2: admins always, and the device owner when the session runs on someone else's device (D-11). */
export function footerAlwaysLine(ctx: {
  deviceOwner: { firstName: string; deviceName: string; isViewer: boolean } | null;
}): string {
  const d = ctx.deviceOwner;
  if (!d) return "Admins can always see it.";
  return `Admins and ${d.isViewer ? "you" : d.firstName} can always see it: it runs on ${d.deviceName}.`;
}

/** See all: why a person can see it. `via` names the team or device, `project` the project the owner left. */
export function reasonLabel(
  reason: ViewerReason,
  ctx: { via?: string | null | undefined; project?: string | undefined } = {},
): string {
  switch (reason) {
    case "owner":
      return "Owner";
    case "owner_left":
      return ctx.project ? `Owner · left ${ctx.project}` : "Owner";
    case "device_owner":
      return "Device owner";
    case "lead":
      return "Lead";
    case "member":
      return "Member";
    case "team":
      return ctx.via ? `Through ${ctx.via}` : "Through a team";
    case "device":
      return ctx.via ? `Can use ${ctx.via}` : "Can use the device";
  }
}

/** The read-only panel's note (§1.4); `leftProject` names the project a creator left (D-12). */
export function readOnlyNote(ctx: { ownerName: string | null; leftProject: string | null }): string {
  if (ctx.leftProject) return `You left ${ctx.leftProject}, so you can't change this.`;
  return `Only ${ctx.ownerName ?? "the owner"}, project leads and admins can change this.`;
}

/** The narrowing toast: "{name} can't see this session anymore." · "{n} people can't see this session anymore." */
export function narrowToast(removedCount: number, removedNames: readonly string[]): string {
  const [name] = removedNames;
  const who = removedCount === 1 && name ? name : people(removedCount);
  return `${who} can't see this session anymore.`;
}

/** The polite announcement after an applied change. */
export function announcement(label: string, n: number): string {
  return `Visible to ${label}. ${people(n)} can see it.`;
}

/** An entry that no longer gives access (§1.5). */
export function inactiveLine(entry: "person" | "team", projectName: string): string {
  return entry === "person" ? `Left ${projectName}` : `No longer assigned to ${projectName}`;
}

export type ChoiceLine = { label: string; line: string };

/** The four choices of the panel with their one-line explanations (§1.2 table). */
export function choiceLines(
  ctx: OwnerContext &
    PlaceContext & {
      /** People with project access (the Project line's count); null while unknown. */
      projectCount: number | null;
      /** The team project has assigned teams. */
      hasTeams: boolean;
    },
): {
  owner: ChoiceLine;
  project: ChoiceLine;
  teams: ChoiceLine & { disabled: boolean };
  people: ChoiceLine;
} {
  const owner = ctx.viewerIsOwner
    ? { label: "Only me", line: "Just you." }
    : { label: `Only ${ownerFull(ctx)}`, line: `Just ${ownerFull(ctx)}.` };
  const everyone = everyoneIn(ctx);
  const teams = ctx.hidden
    ? { label: "Teams", line: `Teams of ${HIDDEN_PROJECT_PLACE}`, disabled: true }
    : ctx.personal
      ? { label: "Teams", line: "Personal projects have no teams", disabled: true }
      : ctx.hasTeams
        ? { label: "Teams", line: `Choose from ${ctx.projectName}'s teams`, disabled: false }
        : { label: "Teams", line: `${ctx.projectName} has no teams yet`, disabled: true };
  return {
    owner,
    project: {
      label: "Project",
      line: ctx.projectCount === null ? everyone : `${everyone} · ${people(ctx.projectCount)}`,
    },
    teams,
    people: {
      label: "People",
      line: ctx.hidden
        ? `People in ${HIDDEN_PROJECT_PLACE}`
        : ctx.personal
          ? `Choose people who can use ${ctx.deviceName}`
          : `Choose people in ${ctx.projectName}`,
    },
  };
}

// ---------------------------------------------------------------- the panel (07.9-10, UI-SPEC Surface 1)

/** The panel's title and the one sentence under it (§1.2). */
export const PANEL_TITLE = "Who can see this session";
export const PANEL_SUBLINE = "People who can see it follow it live and, if their role allows, add prompts.";
/** Load and change failures (§States, rule 6). */
export const LOAD_FAILED = "Couldn't load who can see this session.";
export const CHANGE_FAILED = "Couldn't change who can see this session. Try again.";
/** The pickers' hints while nothing is picked (rule 2: nothing is saved yet). */
export const PICK_TEAM_HINT = "Pick at least one team.";
export const PICK_PERSON_HINT = "Pick at least one person.";

/** The people search field: "Add people in {project}" · "Add people who can use {device}". */
export function addPeopleLabel(place: PlaceContext): string {
  return place.personal ? `Add people who can use ${place.deviceName}` : `Add people in ${place.projectName}`;
}

/** No search result: "No one in {project} matches “{q}”." */
export function noMatchLine(place: PlaceContext, q: string): string {
  const where = place.personal ? `who can use ${place.deviceName}` : `in ${place.projectName}`;
  return `No one ${where} matches “${q.trim()}”.`;
}

/** A team's size in the picker: "1 person" · "8 people". */
export function memberCount(n: number): string {
  return people(n);
}

/** See all, beyond the listed rows: "and {n} more". */
export function andMore(n: number): string {
  return `and ${n} more`;
}

/** The owner's fixed row in the People picker: "{name} (you)" or "{name}"; the reason "Owner" sits beside it. */
export function ownerRowName(o: OwnerContext): string {
  return o.viewerIsOwner ? `${ownerFull(o)} (you)` : ownerFull(o);
}

/**
 * Warned before an editor's change would take the session away from them too (07.9-06 broken-window 4): a lead who
 * is not its owner narrowing it to Only {owner} or to people without themselves.
 */
export const SELF_REMOVAL_WARNING = "You won't see this session anymore after this change.";
export const SELF_REMOVAL_CONFIRM = "Change anyway";

/**
 * A choice made in the new-session dialog before the session exists (draft mode, Surface 3). It keeps the names it
 * shows ("Visible to: Web and Design"); `draftInput` turns it into the create request's audience.
 */
export type DraftAudience =
  | { kind: "owner" }
  | { kind: "project" }
  | { kind: "teams"; teams: ReadonlyArray<{ id: string; name: string }> }
  | { kind: "people"; people: ReadonlyArray<{ userId: string; name: string; avatarUrl: string | null }> };

/** The audience a draft sends; null while Teams or People has nothing picked (the previous choice still holds). */
export function draftInput(d: DraftAudience): SessionAudienceInput | null {
  if (d.kind === "teams")
    return d.teams.length > 0 ? { kind: "teams", teamIds: d.teams.map((t) => t.id) } : null;
  if (d.kind === "people")
    return d.people.length > 0 ? { kind: "people", userIds: d.people.map((p) => p.userId) } : null;
  return { kind: d.kind };
}

/** The draft's long label ("Visible to: {long label}"); the starter is its owner. */
export function draftLongLabel(d: DraftAudience, place: PlaceContext): string {
  const count = d.kind === "teams" ? d.teams.length : d.kind === "people" ? d.people.length : 0;
  return longLabel({
    kind: d.kind,
    activeCount: count,
    teamNames: d.kind === "teams" ? d.teams.map((t) => t.name) : undefined,
    ownerName: null,
    viewerIsOwner: true,
    ...place,
  });
}

/** The active entries a view stores, as the request that restores it (Undo); stale entries are left out. */
export function viewInput(v: WorkSessionVisibilityView): SessionAudienceInput {
  if (v.kind === "teams") {
    const teamIds = v.teams.filter((t) => t.selected && t.active).map((t) => t.id);
    return teamIds.length > 0 ? { kind: "teams", teamIds } : { kind: "owner" };
  }
  if (v.kind === "people") {
    const userIds = v.people.filter((p) => p.active).map((p) => p.userId);
    return userIds.length > 0 ? { kind: "people", userIds } : { kind: "owner" };
  }
  return { kind: v.kind };
}

/** Where a view's session runs, for the labels. */
export function viewPlace(v: WorkSessionVisibilityView): PlaceContext {
  const deviceName = v.alwaysVisible.deviceOwner?.deviceName ?? "";
  switch (v.project.kind) {
    case "team":
      return { projectName: v.project.name, deviceName, personal: false };
    case "hidden":
      return { projectName: "", deviceName, personal: false, hidden: true };
    case "personal":
      return { projectName: v.project.deviceName, deviceName: v.project.deviceName, personal: true };
  }
}

/** A view's long label for its viewer (the announcement, the chip's name while the panel is open). */
export function viewLongLabel(v: WorkSessionVisibilityView, viewerId: string | null | undefined): string {
  const teamNames = v.teams.filter((t) => t.selected && t.active).map((t) => t.name);
  const activeCount =
    v.kind === "teams" ? teamNames.length : v.kind === "people" ? v.people.filter((p) => p.active).length : 0;
  return longLabel({
    kind: v.kind,
    activeCount,
    teamNames,
    ownerName: v.owner.name,
    viewerIsOwner: viewerId === v.owner.userId,
    ...viewPlace(v),
  });
}
