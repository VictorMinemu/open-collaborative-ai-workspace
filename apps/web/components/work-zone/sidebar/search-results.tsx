"use client";

import type { WorkSession } from "@ocw/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { isActiveSession, rowProject, rowStatusText, type SearchGroup, type SearchModel } from "./model";
import { BadgeSessionRow, InlineMore } from "./needs-you-section";
import { ProjectRow, RepoRow } from "./rows";
import type { RowContext } from "./sections";
import { SettledRow } from "./session-rows";

/**
 * The sidebar's grouped search results (Phase 07.10-04, D-08, UI-SPEC § 11): while a query is typed they replace the
 * tree (Needs you to Settled); the header, the search field and the foot links stay. Up to three groups, each with a
 * plain heading: Projects (member and managed, a managed one muted, no "+", X5), Sessions (active ones in the
 * needs-you look with their status, settled ones as the Settled row) and Repositories (no "+"). A polite live region
 * says how many results there are, 300 ms after typing stops.
 */

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "{n} results", debounced so a screen reader is not interrupted at every keystroke. */
function useDebouncedText(text: string, ms: number): string {
  const [shown, setShown] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => setShown(text), ms);
    return () => clearTimeout(t);
  }, [text, ms]);
  return shown;
}

function Group<T>({
  id,
  title,
  group,
  more,
  children,
}: {
  id: "projects" | "sessions" | "repos";
  title: string;
  group: SearchGroup<T>;
  more: ReactNode;
  children: (row: T) => ReactNode;
}) {
  if (group.total === 0) return null;
  const listId = `wz-search-${id}`;
  return (
    <div data-testid={`search-group-${id}`} className="grid grid-cols-1 gap-px">
      <h3 className="flex h-7 items-center px-1 font-semibold text-[11.5px] text-muted-foreground uppercase tracking-wider max-md:h-11">
        {title}
      </h3>
      {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics under `list-style: none` (UI-SPEC). */}
      <ul id={listId} role="list" className="grid grid-cols-1 gap-px">
        {group.rows.map((row) => children(row))}
        {more ? <li>{more}</li> : null}
      </ul>
    </div>
  );
}

/** A group shows "Show all {n}" when it is capped, and "Show fewer" once opened. */
const capped = (group: SearchGroup<unknown>) => group.expanded || group.total > group.rows.length;

function ShowAll({
  id,
  group,
  onExpand,
}: {
  id: "projects" | "sessions" | "repos";
  group: SearchGroup<unknown>;
  onExpand: (key: string) => void;
}) {
  return (
    <InlineMore
      testId={`search-more-${id}`}
      expanded={group.expanded}
      label={`Show all ${group.total}`}
      controls={`wz-search-${id}`}
      onToggle={() => onExpand(`search:${id}`)}
    />
  );
}

function SessionResult({ s, ctx }: { s: WorkSession; ctx: RowContext }) {
  const active = s.id === ctx.openSessionId;
  if (!isActiveSession(s, ctx.now))
    return <SettledRow s={s} now={ctx.now} active={active} viewerId={ctx.viewerId} />;
  const status = rowStatusText(s, ctx.now);
  return (
    <BadgeSessionRow
      s={s}
      place={rowProject(s).name}
      right={{ text: status.text, tone: status.tone }}
      active={active}
      viewerId={ctx.viewerId}
      testId="session-row"
    />
  );
}

export function SidebarSearchResults({
  query,
  result,
  ...ctx
}: { query: string; result: SearchModel } & RowContext) {
  const announced = useDebouncedText(plural(result.count, "result", "results"), 300);
  return (
    <section
      aria-label="Search results"
      data-testid="sidebar-search-results"
      className="grid grid-cols-1 gap-3"
    >
      <p role="status" aria-live="polite" className="sr-only">
        {announced}
      </p>
      {result.count === 0 ? (
        <p className="px-2.5 text-[12px] text-muted-foreground">Nothing matches “{query.trim()}”.</p>
      ) : null}
      <Group
        id="projects"
        title="Projects"
        group={result.projects}
        more={
          capped(result.projects) ? (
            <ShowAll id="projects" group={result.projects} onExpand={ctx.onExpand} />
          ) : null
        }
      >
        {({ row, muted }) => (
          <li key={row.id}>
            <ProjectRow project={row} muted={muted} />
          </li>
        )}
      </Group>
      <Group
        id="sessions"
        title="Sessions"
        group={result.sessions}
        more={
          capped(result.sessions) ? (
            <ShowAll id="sessions" group={result.sessions} onExpand={ctx.onExpand} />
          ) : null
        }
      >
        {(s) => (
          <li key={s.id}>
            <SessionResult s={s} ctx={ctx} />
          </li>
        )}
      </Group>
      <Group
        id="repos"
        title="Repositories"
        group={result.repos}
        more={
          capped(result.repos) ? <ShowAll id="repos" group={result.repos} onExpand={ctx.onExpand} /> : null
        }
      >
        {(r) => (
          <li key={r.projectId}>
            <RepoRow repo={r} />
          </li>
        )}
      </Group>
    </section>
  );
}
