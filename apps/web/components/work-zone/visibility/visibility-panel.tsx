"use client";

import {
  type AudiencePreview,
  EventTypes,
  type SessionAudienceInput,
  type SessionVisibilityKind,
  type WorkProjectPerson,
  type WorkProjectTeam,
  type WorkSessionViewer,
  type WorkSessionVisibilityView,
} from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { UserAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { PopoverTitle } from "@/components/ui/popover";
import { SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { isApiError } from "@/lib/api";
import { useMe } from "@/lib/queries";
import { useTopic } from "@/lib/realtime";
import {
  announcement,
  CHANGE_FAILED,
  choiceLines,
  type DraftAudience,
  draftInput,
  footerAlwaysLine,
  footerCount,
  HIDDEN_PROJECT_NOTE,
  LOAD_FAILED,
  narrowToast,
  PANEL_SUBLINE,
  PANEL_TITLE,
  type PlaceContext,
  readOnlyNote,
  SELF_REMOVAL_CONFIRM,
  SELF_REMOVAL_WARNING,
  viewInput,
  viewLongLabel,
  viewPlace,
} from "@/lib/session-visibility";
import { cn } from "@/lib/utils";
import {
  useAudiencePeople,
  useAudiencePreview,
  useProjectTeams,
  useSessionVisibility,
  useUpdateSessionVisibility,
  useVisibilityPeople,
  visKeys,
} from "@/lib/visibility-queries";
import { AudienceRows, type ChoiceLines, CurrentChoice } from "./audience-rows";
import { PeoplePicker, type PeopleSearch, type PickerPerson } from "./people-picker";
import { type PickerTeam, TeamPicker } from "./team-picker";
import { WhoCanSee, WhoCanSeeList } from "./who-can-see";

/** Where the panel renders: the header's popover (≥ 640), the bottom sheet (< 640) or plainly (tests, dialogs). */
export type PanelSurface = "popover" | "sheet" | "inline";

/** Undo after a narrowing stays for 8 s (UI-SPEC rule 4). */
const UNDO_MS = 8_000;
/** An arrow-key choice saves only after focus rests on it this long (UI-SPEC Interaction, keyboard backstop). */
const ARROW_REST_MS = 400;

/** Everything the panel shows, from the API's view (edit) or from the draft and its preview (draft). */
export interface PanelModel {
  mode: "edit" | "draft";
  /** The viewer may change it (`viewerCan.change`); a draft is always editable. */
  editable: boolean;
  kind: SessionVisibilityKind;
  defaultKind: SessionVisibilityKind;
  place: PlaceContext;
  /** The team project, for the Assign teams link; null for a personal repository. */
  unitId: string | null;
  owner: { userId: string; name: string | null; viewerIsOwner: boolean };
  /** The signed-in viewer ("(you)" in See all). */
  viewerId: string | null;
  teams: ReadonlyArray<PickerTeam & { selected: boolean }>;
  people: readonly PickerPerson[];
  lines: ChoiceLines;
  /** The project a creator left (D-12): read-only with its own note. */
  leftProject: string | null;
  /** A team project the viewer can't open (07.10-07, HI-01): read-only, its own note, no project named anywhere. */
  hiddenProject?: boolean;
  footer: {
    count: number | null;
    loading: boolean;
    countText: string;
    stack: readonly WorkProjectPerson[];
    alwaysLine: string | null;
    /** See all's rows; null in draft mode (no list). */
    viewers: readonly WorkSessionViewer[] | null;
    more: number;
  };
}

/** Active selected entries: teams for `teams`, people for `people`, 0 otherwise (UI-SPEC §1.5). */
function activeCountOf(
  kind: SessionVisibilityKind,
  teams: PanelModel["teams"],
  people: PanelModel["people"],
) {
  if (kind === "teams") return teams.filter((t) => t.selected && t.active).length;
  if (kind === "people") return people.filter((p) => p.active).length;
  return 0;
}

/**
 * The model of an existing session's panel from `GET /work-sessions/:id/visibility`. `projectCount` is the last count
 * seen while the session was visible to the whole project (the view only counts the current choice), so the Project
 * line keeps its number after a narrowing; null words the line without one.
 */
export function modelFromView(
  v: WorkSessionVisibilityView,
  viewerId: string | null | undefined,
  projectCount: number | null,
): PanelModel {
  const owner = { userId: v.owner.userId, name: v.owner.name, viewerIsOwner: viewerId === v.owner.userId };
  const ownerCtx = { ownerName: owner.name, viewerIsOwner: owner.viewerIsOwner };
  const place = viewPlace(v);
  // 07.10-07 (HI-01): a project the viewer can't open comes without its teams and people, so the panel only reads.
  const hidden = v.project.kind === "hidden";
  const people = v.people.map((p) => ({ ...p }));
  const active = activeCountOf(v.kind, v.teams, people);
  // Nobody but the owner: "Only you can see this", whatever the choice (a personal repository nobody shares). In the
  // hidden form the stored teams and people are not sent: only the viewer count says it.
  const ownerOnly =
    v.kind === "owner" ||
    (!hidden && (v.kind === "teams" || v.kind === "people") && active === 0) ||
    v.viewers.count <= 1;
  return {
    mode: "edit",
    editable: v.viewerCan.change && !hidden,
    hiddenProject: hidden,
    kind: v.kind,
    defaultKind: v.projectDefault ?? "project",
    place,
    unitId: v.project.kind === "team" ? v.project.id : null,
    owner,
    viewerId: viewerId ?? null,
    teams: v.teams,
    people,
    lines: choiceLines({
      ...ownerCtx,
      ...place,
      projectCount: v.kind === "project" ? v.viewers.count : projectCount,
      hasTeams: v.teams.some((t) => t.active),
    }),
    leftProject: v.viewerState === "left_project" && v.project.kind === "team" ? v.project.name : null,
    footer: {
      count: v.viewers.count,
      loading: false,
      countText: footerCount(v.viewers.count, { ...ownerCtx, ownerOnly }),
      stack: v.viewers.people,
      alwaysLine: footerAlwaysLine({ deviceOwner: v.alwaysVisible.deviceOwner }),
      viewers: v.viewers.people,
      more: v.viewers.more,
    },
  };
}

/** Where a session that is not started yet would run (the new-session dialog knows the repository). */
export type DraftPlace =
  | { kind: "team"; unitId: string; name: string; defaultVisibility: "project" | "owner" }
  | { kind: "personal"; deviceName: string };

/** The model of the draft panel: the dialog's local choice, the project's teams and the API's preview. */
export function modelFromDraft(d: {
  value: DraftAudience;
  place: DraftPlace;
  teams: ReadonlyArray<Pick<WorkProjectTeam, "id" | "name" | "kind" | "memberCount">>;
  preview: AudiencePreview | undefined;
  previewFailed: boolean;
  viewer: { userId: string; name: string | null };
}): PanelModel {
  const place: PlaceContext =
    d.place.kind === "team"
      ? { projectName: d.place.name, deviceName: "", personal: false }
      : { projectName: d.place.deviceName, deviceName: d.place.deviceName, personal: true };
  const picked = new Set(d.value.kind === "teams" ? d.value.teams.map((t) => t.id) : []);
  const teams = [
    ...d.teams.map((t) => ({ ...t, selected: picked.has(t.id), active: true })),
    // A picked team the project no longer has (unassigned while the dialog was open) stays visible, inactive.
    ...(d.value.kind === "teams"
      ? d.value.teams
          .filter((t) => !d.teams.some((x) => x.id === t.id))
          .map((t) => ({
            id: t.id,
            name: t.name,
            kind: "team" as const,
            memberCount: 0,
            selected: true,
            active: false,
          }))
      : []),
  ];
  const people = d.value.kind === "people" ? d.value.people.map((p) => ({ ...p, active: true })) : [];
  const ownerCtx = { ownerName: d.viewer.name, viewerIsOwner: true };
  const count = d.previewFailed ? null : (d.preview?.count ?? null);
  const active = activeCountOf(d.value.kind, teams, people);
  const ownerOnly =
    d.value.kind === "owner" ||
    ((d.value.kind === "teams" || d.value.kind === "people") && active === 0) ||
    (count !== null && count <= 1);
  return {
    mode: "draft",
    editable: true,
    kind: d.value.kind,
    defaultKind: d.place.kind === "team" ? d.place.defaultVisibility : "project",
    place,
    unitId: d.place.kind === "team" ? d.place.unitId : null,
    owner: { userId: d.viewer.userId, name: d.viewer.name, viewerIsOwner: true },
    viewerId: d.viewer.userId,
    teams,
    people,
    lines: choiceLines({
      ...ownerCtx,
      ...place,
      projectCount: d.value.kind === "project" && count !== null ? count : null,
      hasTeams: d.teams.length > 0,
    }),
    leftProject: null,
    footer: {
      count,
      loading: !d.preview && !d.previewFailed,
      countText: count === null ? "" : footerCount(count, { ...ownerCtx, ownerOnly }),
      stack: d.preview?.people ?? [],
      alwaysLine: d.preview ? footerAlwaysLine({ deviceOwner: d.preview.alwaysVisible.deviceOwner }) : null,
      viewers: null,
      more: 0,
    },
  };
}

/**
 * The change would take the session away from the editor making it (07.9-06 broken-window 4), so the panel asks first.
 * The web decides no access: it reads the API's list of who sees the session and why. Only someone listed through
 * the project (lead, member or team), never its owner or device owner (they always see it), is asked, and only when
 * they choose Only {owner} or people without themselves. Someone the API does not list sees it as an admin and keeps
 * it; whether the editor is in a chosen team is not in the view, so Teams is left to the API's answer.
 */
export function loseAccessOnChange(
  v: WorkSessionVisibilityView,
  viewerId: string | null,
  input: SessionAudienceInput,
): boolean {
  if (!viewerId) return false;
  const listed = v.viewers.people.find((p) => p.userId === viewerId);
  if (
    !listed ||
    listed.reason === "owner" ||
    listed.reason === "owner_left" ||
    listed.reason === "device_owner"
  )
    return false;
  if (input.kind === "owner") return true;
  if (input.kind === "people") return !input.userIds.includes(viewerId);
  return false;
}

export interface PanelBodyProps {
  model: PanelModel;
  surface: PanelSurface;
  /** Saves (edit) or keeps (draft) a choice; resolves false when it failed (the panel shows the server's state). */
  apply: (input: SessionAudienceInput) => Promise<boolean>;
  /** The change would take the session away from the viewer too (07.9-06 broken-window 4): ask first. */
  wouldLoseAccess?: ((input: SessionAudienceInput) => boolean) | undefined;
  search: PeopleSearch & { onOpen?: (() => void) | undefined };
  /** The last applied change, for the polite live region (rule 5). */
  announce: string;
  /** Tests: See all open, the people options shown. */
  initialSeeAll?: boolean;
  initialSearchOpen?: boolean;
}

type Local = { kind: SessionVisibilityKind; ids: string[] | null };

/**
 * The panel's body (UI-SPEC §1.2–1.6), shared by the popover, the bottom sheet and the new-session dialog: title,
 * the four choices (or the read-only current choice), the open picker, and the footer saying who can see it now. It
 * holds only the choice being made; the model is the API's (or the draft's).
 *
 * Apply rules (§1.3): Only me and Project apply at once (an arrow-key choice after 400 ms of rest); Teams and People
 * only open their picker, and nothing is saved until the first team or person is picked; every later check, pick or
 * remove applies at once; the changed control shows a spinner; a failure returns to the server's state.
 */
export function PanelBody({
  model,
  surface,
  apply,
  wouldLoseAccess,
  search,
  announce,
  initialSeeAll = false,
  initialSearchOpen = false,
}: PanelBodyProps) {
  const sheet = surface === "sheet";
  const listId = useId();
  const [local, setLocal] = useState<Local | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [seeAll, setSeeAll] = useState(initialSeeAll);
  const [confirm, setConfirm] = useState<{ input: SessionAudienceInput; key: string; local: Local } | null>(
    null,
  );
  const [known, setKnown] = useState<ReadonlyMap<string, WorkProjectPerson>>(new Map());
  const seq = useRef(0);
  const timer = useRef<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // Opening the popover focuses the chosen radio (§Focus). The first open waits for the API's answer, so when the
  // radios arrive and focus still rests on the popup or its title, it moves to the checked one (never in a sheet,
  // which keeps it on its title, nor away from a control the person already reached).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when the radios first render
  useEffect(() => {
    if (surface !== "popover" || !model.editable) return;
    const el = root.current;
    const active = document.activeElement;
    const resting =
      !active ||
      active === document.body ||
      active.hasAttribute("data-visibility-title") ||
      active.getAttribute("data-slot") === "popover-content";
    if (el && resting) el.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.focus();
  }, []);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  // Closing the panel before 400 ms of rest saves nothing (focus did not rest on that choice).
  useEffect(() => clearTimer, [clearTimer]);

  const choice = local?.kind ?? model.kind;
  const serverTeams = model.kind === "teams" ? model.teams.filter((t) => t.selected).map((t) => t.id) : [];
  const serverPeople = model.kind === "people" ? model.people.map((p) => p.userId) : [];
  const teamIds = choice === "teams" ? (local?.ids ?? serverTeams) : [];
  const peopleIds = choice === "people" ? (local?.ids ?? serverPeople) : [];

  const onOpenPeople = search.onOpen;
  useEffect(() => {
    if (choice === "people" && model.editable) onOpenPeople?.();
  }, [choice, model.editable, onOpenPeople]);

  const run = async (input: SessionAudienceInput, key: string, next: Local, confirmed = false) => {
    if (!confirmed && wouldLoseAccess?.(input)) {
      setLocal(next);
      setConfirm({ input, key, local: next });
      return;
    }
    setConfirm(null);
    const mine = ++seq.current;
    setLocal(next);
    setBusy(key);
    await apply(input);
    // A newer change is on its way: keep showing it until its own answer arrives (the last state wins).
    if (mine !== seq.current) return;
    setLocal(null);
    setBusy(null);
  };

  const onChoose = (kind: SessionVisibilityKind, viaArrow: boolean) => {
    clearTimer();
    setConfirm(null);
    if (kind === "teams" || kind === "people") {
      setLocal(kind === model.kind ? null : { kind, ids: [] });
      return;
    }
    const next = { kind, ids: null };
    const save = () => {
      if (kind === model.kind) setLocal(null);
      else void run({ kind }, `kind:${kind}`, next);
    };
    if (viaArrow) {
      setLocal(next);
      timer.current = window.setTimeout(save, ARROW_REST_MS);
    } else save();
  };

  const toggleTeam = (id: string) => {
    const activeIds = new Set(model.teams.filter((t) => t.active).map((t) => t.id));
    const current = teamIds.filter((t) => activeIds.has(t));
    const next = current.includes(id) ? current.filter((t) => t !== id) : [...current, id];
    if (next.length === 0) {
      // Nothing picked: nothing is saved, the previous choice holds until a team is picked (rule 2).
      setLocal({ kind: "teams", ids: [] });
      return;
    }
    void run({ kind: "teams", teamIds: next }, `team:${id}`, { kind: "teams", ids: next });
  };

  const activePeople = new Set(model.people.filter((p) => p.active).map((p) => p.userId));
  const pickPerson = (p: WorkProjectPerson) => {
    setKnown((m) => new Map(m).set(p.userId, p));
    const current = peopleIds.filter((id) => activePeople.has(id) || known.has(id));
    if (current.includes(p.userId)) return;
    const next = [...current, p.userId];
    void run({ kind: "people", userIds: next }, `person:${p.userId}`, { kind: "people", ids: next });
  };
  const removePerson = (userId: string) => {
    const next = peopleIds.filter((id) => id !== userId && (activePeople.has(id) || known.has(id)));
    if (next.length === 0) {
      setLocal({ kind: "people", ids: [] });
      return;
    }
    void run({ kind: "people", userIds: next }, `person:${userId}`, { kind: "people", ids: next });
  };

  const byId = new Map(model.people.map((p) => [p.userId, p]));
  const chosen: PickerPerson[] = peopleIds.flatMap((id) => {
    const p = byId.get(id) ?? known.get(id);
    return p ? [{ ...p, active: byId.get(id)?.active ?? true }] : [];
  });
  const busyOf = (prefix: string) => (busy?.startsWith(prefix) ? busy.slice(prefix.length) : null);
  const busyKind = busyOf("kind:") as SessionVisibilityKind | null;

  const title = (
    <PanelTitle surface={surface} className={cn("font-semibold text-sm", sheet && "text-sm")}>
      {PANEL_TITLE}
    </PanelTitle>
  );

  const body = model.editable ? (
    <>
      {confirm ? (
        <div
          role="alert"
          data-testid="visibility-self-warning"
          className="mx-3 mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-muted px-3 py-2"
        >
          <p className="min-w-0 flex-1 text-xs leading-snug">{SELF_REMOVAL_WARNING}</p>
          <div className="flex shrink-0 gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="max-md:h-11"
              onClick={() => {
                setConfirm(null);
                setLocal(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-md:h-11"
              onClick={() => void run(confirm.input, confirm.key, confirm.local, true)}
            >
              {SELF_REMOVAL_CONFIRM}
            </Button>
          </div>
        </div>
      ) : null}
      <AudienceRows
        choice={choice}
        lines={model.lines}
        defaultKind={model.defaultKind}
        busy={busyKind}
        sheet={sheet}
        onChoose={onChoose}
        assignTeamsHref={
          model.mode === "edit" && model.unitId && !model.place.personal
            ? `/work-zone/projects/${model.unitId}?tab=settings`
            : null
        }
        pickers={{
          teams: (
            <TeamPicker
              teams={model.teams}
              checked={new Set(teamIds)}
              projectName={model.place.projectName}
              busy={busyOf("team:")}
              sheet={sheet}
              onToggle={toggleTeam}
            />
          ),
          people: (
            <PeoplePicker
              owner={model.owner}
              chosen={chosen}
              place={model.place}
              search={search}
              busy={busyOf("person:")}
              sheet={sheet}
              onPick={pickPerson}
              onRemove={removePerson}
              initialOpen={initialSearchOpen}
            />
          ),
        }}
      />
    </>
  ) : (
    <CurrentChoice
      kind={model.kind}
      line={model.lines[model.kind]}
      names={<CurrentNames model={model} />}
      note={
        model.hiddenProject
          ? HIDDEN_PROJECT_NOTE
          : readOnlyNote({ ownerName: model.owner.name, leftProject: model.leftProject })
      }
    />
  );

  return (
    <div
      ref={root}
      data-testid="visibility-panel"
      data-editable={model.editable}
      data-mode={model.mode}
      className={cn("flex min-h-0 min-w-0 flex-col", sheet && "flex-1")}
    >
      <div className={cn("shrink-0 px-4 pb-2", sheet ? "pt-3 pr-12" : "pt-4")}>
        {title}
        <p className="mt-0.5 text-muted-foreground text-xs leading-4">{PANEL_SUBLINE}</p>
      </div>
      <div
        className={cn(
          "scrollbar-thin min-h-0 overflow-y-auto border-t",
          surface === "popover" && "max-h-[min(32rem,75dvh)]",
          sheet && "flex-1",
        )}
      >
        {body}
        {seeAll && model.footer.viewers ? (
          <WhoCanSeeList
            id={listId}
            viewers={model.footer.viewers}
            more={model.footer.more}
            viewerId={model.viewerId}
            projectName={model.place.personal || model.place.hidden ? undefined : model.place.projectName}
          />
        ) : null}
      </div>
      {model.footer.loading ? (
        <FooterSkeleton />
      ) : (
        <WhoCanSee
          count={model.footer.count}
          countText={model.footer.countText}
          stack={model.footer.stack}
          alwaysLine={model.footer.alwaysLine}
          seeAll={model.footer.viewers ? seeAll : undefined}
          onSeeAll={model.footer.viewers ? () => setSeeAll((o) => !o) : undefined}
          listId={listId}
          sheet={sheet}
        />
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {announce}
      </p>
    </div>
  );
}

/** The read-only row's names: the teams as plain text, the people as faces and names (§1.4). */
function CurrentNames({ model }: { model: PanelModel }) {
  if (model.kind === "teams") {
    const names = model.teams.filter((t) => t.selected && t.active).map((t) => t.name);
    return names.length > 0 ? (
      <span className="block truncate text-sm" title={names.join(", ")}>
        {names.join(", ")}
      </span>
    ) : null;
  }
  if (model.kind === "people") {
    const people = model.people.filter((p) => p.active);
    if (people.length === 0) return null;
    return (
      <span className="flex min-w-0 items-center gap-2">
        <span className="flex shrink-0 -space-x-0.5">
          {people.slice(0, 5).map((p, i, shown) => (
            // As in the footer: the first face on top, opaque, never over the next face's initials.
            <span key={p.userId} className="relative inline-flex" style={{ zIndex: shown.length - i }}>
              <UserAvatar
                name={p.name}
                src={p.avatarUrl}
                seed={p.userId}
                className="size-6 bg-popover text-[10px] ring-2 ring-popover"
              />
            </span>
          ))}
        </span>
        <span className="min-w-0 truncate text-sm" title={people.map((p) => p.name).join(", ")}>
          {people.map((p) => p.name).join(", ")}
        </span>
      </span>
    );
  }
  return null;
}

function PanelTitle({
  surface,
  className,
  children,
}: {
  surface: PanelSurface;
  className?: string;
  children: ReactNode;
}) {
  if (surface === "popover") {
    return (
      <PopoverTitle data-visibility-title tabIndex={-1} className={cn("outline-none", className)}>
        {children}
      </PopoverTitle>
    );
  }
  if (surface === "sheet") {
    return (
      <SheetTitle data-visibility-title tabIndex={-1} className={cn("outline-none", className)}>
        {children}
      </SheetTitle>
    );
  }
  return (
    <h2 data-visibility-title tabIndex={-1} className={cn("outline-none", className)}>
      {children}
    </h2>
  );
}

function FooterSkeleton() {
  return (
    <div data-testid="who-can-see-loading" className="shrink-0 border-t px-4 pb-3">
      <div className="flex h-12 items-center gap-2">
        <Skeleton className="size-6 rounded-full" />
        <Skeleton className="h-4 w-36" />
      </div>
      <Skeleton className="h-3 w-48" />
    </div>
  );
}

/** Loading (§States): the title, four skeleton rows and the footer's. */
export function PanelSkeleton({ surface }: { surface: PanelSurface }) {
  return (
    <div
      data-testid="visibility-panel"
      data-loading="true"
      aria-busy="true"
      className={cn("flex min-h-0 flex-col", surface === "sheet" && "flex-1")}
    >
      <div className={cn("px-4 pb-2", surface === "sheet" ? "pt-3 pr-12" : "pt-4")}>
        <PanelTitle surface={surface} className="font-semibold text-sm">
          {PANEL_TITLE}
        </PanelTitle>
        <p className="mt-0.5 text-muted-foreground text-xs leading-4">{PANEL_SUBLINE}</p>
      </div>
      <div className="grid gap-px border-t py-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex h-11 items-center gap-2 px-4">
            <Skeleton className="size-4 rounded-full" />
            <Skeleton className="h-4 w-40" />
          </div>
        ))}
      </div>
      <FooterSkeleton />
    </div>
  );
}

/** A failed load (§States): one sentence and Try again; never a stale panel. */
export function PanelError({
  surface,
  onRetry,
  retrying,
}: {
  surface: PanelSurface;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <div data-testid="visibility-panel" data-error="true" className="flex min-h-0 flex-col">
      <div className={cn("px-4 pb-2", surface === "sheet" ? "pt-3 pr-12" : "pt-4")}>
        <PanelTitle surface={surface} className="font-semibold text-sm">
          {PANEL_TITLE}
        </PanelTitle>
      </div>
      <div role="alert" className="flex flex-col items-start gap-3 border-t px-4 py-4">
        <p className="text-muted-foreground text-sm">{LOAD_FAILED}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="max-md:h-11"
          onClick={onRetry}
          disabled={retrying}
        >
          <RefreshCw className={cn(retrying && "animate-spin")} />
          Try again
        </Button>
      </div>
    </div>
  );
}

export type VisibilityPanelProps =
  | { mode: "edit"; sessionId: string; surface: PanelSurface }
  | {
      mode: "draft";
      /** The repository the session would start on (`/projects/:projectId/audience/*`). */
      projectId: string;
      place: DraftPlace;
      value: DraftAudience;
      onChange: (value: DraftAudience) => void;
      surface: PanelSurface;
    };

/**
 * Who can see a Work Zone session, and changing it (UI-SPEC Surface 1): `edit` for an existing session (the header
 * chip's popover and sheet), `draft` for a session not started yet (the new-session dialog: the choice stays local,
 * the footer shows the API's preview, nothing is saved and nothing toasts).
 */
export function VisibilityPanel(props: VisibilityPanelProps) {
  return props.mode === "edit" ? (
    <EditPanel sessionId={props.sessionId} surface={props.surface} />
  ) : (
    <DraftPanel {...props} />
  );
}

function EditPanel({ sessionId, surface }: { sessionId: string; surface: PanelSurface }) {
  const qc = useQueryClient();
  const me = useMe({ enabled: false }).data;
  const viewerId = me?.user.id ?? null;
  const view = useSessionVisibility(sessionId);
  const { update } = useUpdateSessionVisibility(sessionId);
  const [announce, setAnnounce] = useState("");
  const [q, setQ] = useState("");
  const [peopleOpen, setPeopleOpen] = useState(false);
  const people = useVisibilityPeople(sessionId, q, peopleOpen && view.data?.viewerCan.change === true);
  const projectCount = useRef<number | null>(null);
  if (view.data?.kind === "project") projectCount.current = view.data.viewers.count;

  const refresh = useCallback(
    () => void qc.invalidateQueries({ queryKey: visKeys.view(sessionId) }),
    [qc, sessionId],
  );
  // Another editor's change (or a session update) refreshes the open panel in place (§Interaction, live updates).
  useTopic(`ws:${sessionId}`, (frame) => {
    if (
      frame.type === EventTypes.workSessionVisibilityChanged ||
      frame.type === EventTypes.workSessionUpdated
    )
      refresh();
  });

  const announceView = useCallback(
    (v: WorkSessionVisibilityView) => setAnnounce(announcement(viewLongLabel(v, viewerId), v.viewers.count)),
    [viewerId],
  );
  const failed = useCallback(
    (err: unknown) => {
      toast.error(CHANGE_FAILED);
      // The panel shows the server's state again; a lost right (403) turns it read-only in place.
      if (isApiError(err, 403)) void qc.invalidateQueries({ queryKey: ["wz", "session", sessionId] });
      refresh();
      return false;
    },
    [refresh, qc, sessionId],
  );

  const apply = useCallback(
    async (input: SessionAudienceInput) => {
      const before = view.data;
      try {
        const r = await update(input);
        if (!r) return true;
        announceView(r.visibility);
        if (r.removedCount > 0 && before) {
          const previous = viewInput(before);
          toast(narrowToast(r.removedCount, r.removedNames), {
            duration: UNDO_MS,
            action: {
              label: "Undo",
              onClick: () => {
                update(previous)
                  .then((u) => {
                    if (u) announceView(u.visibility);
                  })
                  .catch(failed);
              },
            },
          });
        }
        return true;
      } catch (err) {
        return failed(err);
      }
    },
    [view.data, update, announceView, failed],
  );

  const wouldLoseAccess = useCallback(
    (input: SessionAudienceInput) => (view.data ? loseAccessOnChange(view.data, viewerId, input) : false),
    [view.data, viewerId],
  );

  const onOpen = useCallback(() => setPeopleOpen(true), []);
  const model = useMemo(
    () => (view.data ? modelFromView(view.data, viewerId, projectCount.current) : null),
    [view.data, viewerId],
  );

  if (!model) {
    if (view.isError)
      return <PanelError surface={surface} onRetry={() => void view.refetch()} retrying={view.isFetching} />;
    return <PanelSkeleton surface={surface} />;
  }
  return (
    <PanelBody
      model={model}
      surface={surface}
      apply={apply}
      wouldLoseAccess={wouldLoseAccess}
      search={{
        q,
        onQuery: setQ,
        results: people.data?.people,
        searching: people.isFetching,
        onOpen,
      }}
      announce={announce}
    />
  );
}

function DraftPanel({
  projectId,
  place,
  value,
  onChange,
  surface,
}: {
  projectId: string;
  place: DraftPlace;
  value: DraftAudience;
  onChange: (value: DraftAudience) => void;
  surface: PanelSurface;
}) {
  const me = useMe({ enabled: false }).data;
  const teams = useProjectTeams(place.kind === "team" ? place.unitId : null);
  const input = draftInput(value) ?? { kind: "project" };
  const preview = useAudiencePreview(projectId, input);
  const [q, setQ] = useState("");
  const [peopleOpen, setPeopleOpen] = useState(false);
  const people = useAudiencePeople(projectId, q, peopleOpen);

  const known = useMemo(() => {
    const m = new Map<string, WorkProjectPerson>();
    if (value.kind === "people") for (const p of value.people) m.set(p.userId, p);
    for (const p of people.data?.people ?? []) m.set(p.userId, p);
    return m;
  }, [value, people.data]);
  const teamNames = useMemo(() => {
    const m = new Map<string, string>();
    if (value.kind === "teams") for (const t of value.teams) m.set(t.id, t.name);
    for (const t of teams.data ?? []) m.set(t.id, t.name);
    return m;
  }, [value, teams.data]);

  const apply = useCallback(
    async (next: SessionAudienceInput) => {
      if (next.kind === "teams") {
        onChange({ kind: "teams", teams: next.teamIds.map((id) => ({ id, name: teamNames.get(id) ?? "" })) });
      } else if (next.kind === "people") {
        onChange({
          kind: "people",
          people: next.userIds.flatMap((id) => {
            const p = known.get(id);
            return p ? [p] : [];
          }),
        });
      } else {
        onChange({ kind: next.kind });
      }
      return true;
    },
    [onChange, teamNames, known],
  );

  const onOpen = useCallback(() => setPeopleOpen(true), []);
  const model = modelFromDraft({
    value,
    place,
    teams: teams.data ?? [],
    preview: preview.data,
    previewFailed: preview.isError,
    viewer: { userId: me?.user.id ?? "", name: me?.user.name ?? null },
  });
  return (
    <PanelBody
      model={model}
      surface={surface}
      apply={apply}
      search={{ q, onQuery: setQ, results: people.data?.people, searching: people.isFetching, onOpen }}
      announce=""
    />
  );
}
