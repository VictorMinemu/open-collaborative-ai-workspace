"use client";

import { FolderGit2, Laptop, type LucideIcon, SearchX, UserRound, Users, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { PageHeader } from "@/components/shell/page-header";
import { UserAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useMe, useMembers } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { useWorkSessions } from "@/lib/workzone-queries";
import {
  type FilterOption,
  filtersFrom,
  filtersQuery,
  hasFilters,
  NO_FILTERS,
  type PeopleFilters,
  type PeopleGroup,
  type PeopleModel,
  peopleModel,
} from "./model";
import { PeopleRow, ROW_COPY } from "./people-row";

export const PEOPLE_COPY = {
  title: "Sessions by person",
  description: "Who owns each Work Zone session you can see.",
  count: (n: number) => (n === 1 ? "1 session" : `${n} sessions`),
  shownOf: (shown: number, total: number) => `${shown} of ${total} sessions`,
  empty: "No sessions you can see yet.",
  emptyBody: "Sessions you start or that are shared with you appear here, grouped by who owns them.",
  noMatch: "No sessions match these filters.",
  noMatchBody: "Try another person, project or device.",
  clear: "Clear filters",
  person: "Person",
  project: "Project",
  device: "Device",
  everyone: "Everyone",
  allProjects: "All projects",
  allDevices: "All devices",
  /** A filter id from the URL that no listed session has (an old link). */
  notListed: "Not in your list",
  error: "Couldn't load sessions.",
  server: ROW_COPY.server,
} as const;

/** The Select value for "no filter" (Base UI needs a non-null value to show its label). */
const ALL = "all";

/**
 * `/work-zone/people` (07.13.1.1, D-01): every Work Zone session the viewer can see, grouped by its owner. The only
 * data source is `useWorkSessions()` (the resolver's list, T-07.13.1.1-07-01); the filters live in the URL
 * (`?person=&project=&device=`) and change it with `router.replace`, without a scroll jump.
 */
export function PeopleView() {
  const sessions = useWorkSessions();
  const me = useMe();
  const members = useMembers();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const viewerId = me.data?.user.id ?? null;
  const filters = useMemo(() => filtersFrom(params), [params]);
  // Wait for the viewer too: grouping before it would show "You" under the viewer's name, then move it to the top.
  const model = useMemo(
    () => (sessions.data && !me.isPending ? peopleModel(sessions.data, viewerId, filters) : undefined),
    [sessions.data, me.isPending, viewerId, filters],
  );
  const avatars = useMemo(
    () => new Map((members.data?.members ?? []).map((m) => [m.userId, m.avatarUrl] as const)),
    [members.data],
  );
  const onFilters = useCallback(
    (next: PeopleFilters) => router.replace(`${pathname}${filtersQuery(next)}`, { scroll: false }),
    [router, pathname],
  );

  return (
    <div data-testid="people-view" className="flex min-h-0 flex-1 flex-col">
      <PageHeader title={PEOPLE_COPY.title} icon={<Users />} description={PEOPLE_COPY.description} />
      {sessions.isError && !sessions.data ? (
        <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          <ServerUnreachable
            title={PEOPLE_COPY.error}
            onRetry={() => sessions.refetch()}
            retrying={sessions.isFetching}
          />
        </div>
      ) : (
        <PeopleViewBody
          model={model}
          viewerId={viewerId}
          avatars={avatars}
          filters={filters}
          onFilters={onFilters}
        />
      )}
    </div>
  );
}

/**
 * The filter bar and the groups, pure over the model (`undefined` while loading), so every state renders in a unit
 * test. `row` renders one session (the view passes the row with its menu; the default is the plain row).
 */
export function PeopleViewBody({
  model,
  viewerId,
  avatars,
  filters,
  onFilters,
  row,
}: {
  model: PeopleModel | undefined;
  viewerId: string | null;
  /** Avatar URL per member (the org directory); a missing entry shows the initials. */
  avatars: ReadonlyMap<string, string | null>;
  filters: PeopleFilters;
  onFilters: (next: PeopleFilters) => void;
  row?: (session: PeopleGroup["sessions"][number]) => React.ReactNode;
}) {
  const renderRow =
    row ?? ((s: PeopleGroup["sessions"][number]) => <PeopleRow key={s.id} session={s} viewerId={viewerId} />);
  const empty = model !== undefined && model.total === 0;
  return (
    <>
      {empty ? null : <PeopleFilterBar model={model} filters={filters} onFilters={onFilters} />}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {!model ? (
          <PeopleSkeleton />
        ) : empty ? (
          <EmptyState icon={Users} title={PEOPLE_COPY.empty} description={PEOPLE_COPY.emptyBody} />
        ) : model.groups.length === 0 ? (
          <EmptyState icon={SearchX} title={PEOPLE_COPY.noMatch} description={PEOPLE_COPY.noMatchBody}>
            <Button
              variant="outline"
              size="sm"
              className="max-md:h-11"
              data-testid="people-clear-empty"
              onClick={() => onFilters(NO_FILTERS)}
            >
              <X /> {PEOPLE_COPY.clear}
            </Button>
          </EmptyState>
        ) : (
          <div className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-5 sm:px-6 sm:py-6">
            {model.groups.map((g) => (
              <PeopleGroupSection key={g.ownerId} group={g} avatarUrl={avatars.get(g.ownerId) ?? null}>
                {g.sessions.map(renderRow)}
              </PeopleGroupSection>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** A group: `[avatar] Name · n sessions`, then its rows. */
function PeopleGroupSection({
  group: g,
  avatarUrl,
  children,
}: {
  group: PeopleGroup;
  avatarUrl: string | null;
  children: React.ReactNode;
}) {
  const headingId = `people-group-${g.ownerId}`;
  return (
    <section
      data-testid="people-group"
      data-owner={g.ownerId}
      aria-labelledby={headingId}
      className="grid gap-2"
    >
      <h2 id={headingId} className="flex min-w-0 items-center gap-2 px-1 font-medium text-sm">
        <span data-testid="people-group-avatar" className="inline-flex shrink-0">
          <UserAvatar
            name={g.name}
            src={avatarUrl}
            seed={g.ownerId}
            className="size-6 [&_span]:text-[10px]"
          />
        </span>
        <span className="min-w-0 truncate" title={g.isViewer ? g.name : g.label}>
          {g.label}
        </span>
        <span aria-hidden className="text-muted-foreground/60">
          ·
        </span>
        <span className="shrink-0 font-normal text-muted-foreground tabular-nums">
          {PEOPLE_COPY.count(g.count)}
        </span>
      </h2>
      <ul className="grid gap-2">{children}</ul>
    </section>
  );
}

/**
 * The three filters. Below 640 px: Person full width, then Project and Device side by side, then the count line;
 * from 640 px one row. Every control is 44 px on touch screens. The count line always takes its height, so setting a
 * filter never moves the list.
 */
export function PeopleFilterBar({
  model,
  filters,
  onFilters,
}: {
  model: PeopleModel | undefined;
  filters: PeopleFilters;
  onFilters: (next: PeopleFilters) => void;
}) {
  const filtered = hasFilters(filters);
  const opts = model?.options;
  return (
    <div
      data-testid="people-filters"
      className="shrink-0 border-b bg-background/95 px-4 py-3 backdrop-blur sm:px-6"
    >
      <div className="mx-auto grid w-full max-w-4xl grid-cols-2 gap-2 sm:flex sm:items-center">
        <FilterSelect
          label={PEOPLE_COPY.person}
          icon={UserRound}
          all={PEOPLE_COPY.everyone}
          options={opts?.people}
          value={filters.person}
          onChange={(person) => onFilters({ ...filters, person })}
          className="col-span-2 sm:w-52"
        />
        <FilterSelect
          label={PEOPLE_COPY.project}
          icon={FolderGit2}
          all={PEOPLE_COPY.allProjects}
          options={opts?.projects}
          value={filters.project}
          onChange={(project) => onFilters({ ...filters, project })}
          className="sm:w-48"
        />
        <FilterSelect
          label={PEOPLE_COPY.device}
          icon={Laptop}
          all={PEOPLE_COPY.allDevices}
          options={opts?.devices}
          value={filters.device}
          onChange={(device) => onFilters({ ...filters, device })}
          className="sm:w-48"
        />
        <div className="col-span-2 flex min-h-11 items-center justify-between gap-3 sm:ml-auto sm:min-h-9 sm:justify-end">
          <span
            data-testid="people-count"
            aria-live="polite"
            className="text-muted-foreground text-xs tabular-nums"
          >
            {model
              ? filtered
                ? PEOPLE_COPY.shownOf(model.shown, model.total)
                : PEOPLE_COPY.count(model.total)
              : ""}
          </span>
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              data-testid="people-clear"
              className="max-md:h-11"
              onClick={() => onFilters(NO_FILTERS)}
            >
              <X /> {PEOPLE_COPY.clear}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  icon: Icon,
  all,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  icon: LucideIcon;
  all: string;
  options: readonly FilterOption[] | undefined;
  value: string | null;
  onChange: (value: string | null) => void;
  className?: string;
}) {
  const list = options ?? [];
  const items = [
    { value: ALL, label: all },
    ...list.map((o) => ({ value: o.id, label: o.label })),
    // An id from an old link that no listed session has: still named, so the trigger never shows a raw id.
    ...(value !== null && !list.some((o) => o.id === value) && options
      ? [{ value, label: PEOPLE_COPY.notListed }]
      : []),
  ];
  return (
    <div className={cn("relative min-w-0", className)}>
      <Icon
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 z-10 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <Select
        items={items}
        value={value ?? ALL}
        disabled={options === undefined}
        onValueChange={(v) => onChange(v === null || v === ALL ? null : String(v))}
      >
        <SelectTrigger
          aria-label={label}
          data-testid={`people-filter-${label.toLowerCase()}`}
          className={cn("pl-8 max-md:h-11", value !== null && "border-primary/40 bg-brand-soft/30")}
        />
        <SelectContent>
          {items.map((it) => (
            <SelectItem key={it.value} value={it.value} className="max-md:min-h-11">
              {it.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function PeopleSkeleton() {
  return (
    <div
      data-testid="people-loading"
      className="mx-auto grid w-full max-w-4xl gap-6 px-4 py-5 sm:px-6 sm:py-6"
    >
      {[0, 1].map((i) => (
        <div key={i} className="grid gap-2">
          <div className="flex items-center gap-2 px-1">
            <Skeleton className="size-6 rounded-full" />
            <Skeleton className="h-4 w-32" />
          </div>
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
        </div>
      ))}
    </div>
  );
}
