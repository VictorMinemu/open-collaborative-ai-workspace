"use client";

import type { WorkSession } from "@ocw/contracts";
import { Hand } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { sectionItemClass } from "@/components/shell/section-sidebar";
import { SidebarSectionHeader } from "@/components/shell/sidebar-section-header";
import { sessionLabels } from "@/lib/session-visibility";
import { cn } from "@/lib/utils";
import { VisibilityMarker, VisibilitySrSuffix } from "../visibility/visibility-marker";
import type { NeedsReason, NeedsYouModel } from "./model";
import { ProjectBadge } from "./session-rows";

/**
 * Needs you (Phase 07.10-04, D-05, UI-SPEC § 3): the Work Zone's mentions. On top of the sidebar, the sessions in the
 * viewer's scope with an approval the viewer may decide or the viewer's own finished turn not yet opened. Absent when
 * empty; a row leaves live with no toast and no animation. The reasons come from the API's per-viewer `attention`
 * and this browser's seen map; nothing here decides access.
 */

/** The right slot of a one-line row with a badge: the text, its tone and an optional 12 px icon. */
export interface RowRight {
  text: string;
  /** The full words when `text` is a short form: the link's name and the reason's tooltip read them (07.10-07). */
  label?: string;
  tone: "primary" | "warning" | "muted" | "foreground";
  icon?: ReactNode;
}

const TONE: Record<RowRight["tone"], string> = {
  primary: "text-primary",
  warning: "font-medium text-amber-700 dark:text-amber-400",
  muted: "text-muted-foreground",
  foreground: "text-foreground",
};

/**
 * A one-line session row with its project badge (the Needs-you look, UI-SPEC § 3; search results reuse it for active
 * sessions, § 11): badge, title, the 07.9 marker, the right slot. The project or repository is named only to screen
 * readers (`row-project`, sr-only) and in the hover `title`; the link's name is "{title}, {right}, in {place}".
 */
export function BadgeSessionRow({
  s,
  place,
  right,
  active,
  viewerId,
  testId,
}: {
  s: WorkSession;
  place: string;
  right: RowRight;
  active: boolean;
  viewerId: string | null;
  testId: string;
}) {
  const { srSuffix } = sessionLabels(s, viewerId);
  return (
    <Link
      href={`/work-zone/${s.id}`}
      data-testid={testId}
      data-status={s.status}
      aria-current={active ? "page" : undefined}
      aria-label={`${s.title}, ${right.label ?? right.text}, in ${place}${srSuffix}`}
      title={`${s.title} · ${place}`}
      className={cn(sectionItemClass(active), "gap-2 max-md:h-11")}
    >
      <ProjectBadge name={place} />
      <span data-testid="row-title" className="min-w-0 flex-1 truncate">
        {s.title}
      </span>
      <VisibilityMarker session={s} viewerId={viewerId} />
      <VisibilitySrSuffix session={s} viewerId={viewerId} />
      <span data-testid="row-project" className="sr-only">
        {place}
      </span>
      <span
        data-testid="row-status"
        data-tone={right.tone}
        title={right.label}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 font-normal text-[12px] tabular-nums",
          TONE[right.tone],
        )}
      >
        {right.icon}
        {right.text}
      </span>
    </Link>
  );
}

const REASON: Record<NeedsReason, RowRight> = {
  // The icon and "Approval" fit beside the title at 240 px; "Needs approval" stays in the name and the tooltip
  // (07.10-07, UI review fix 2; UI-SPEC § 3 and the Copywriting Contract).
  approval: {
    text: "Approval",
    label: "Needs approval",
    tone: "warning",
    icon: <Hand aria-hidden className="size-3" />,
  },
  // An invitation, not an alarm: no colour, no icon (UI-SPEC § 3).
  turn: { text: "Your turn", tone: "foreground" },
};

export function NeedsYouRow({
  s,
  reason,
  place,
  active,
  viewerId,
}: {
  s: WorkSession;
  reason: NeedsReason;
  place: string;
  active: boolean;
  viewerId: string | null;
}) {
  return (
    <BadgeSessionRow
      s={s}
      place={place}
      right={REASON[reason]}
      active={active}
      viewerId={viewerId}
      testId="needs-you-row"
    />
  );
}

/** "Show {n} more" / "Show fewer": an inline expansion (a button with `aria-expanded`, never a navigation). */
export function InlineMore({
  testId,
  expanded,
  label,
  controls,
  onToggle,
}: {
  testId: string;
  expanded: boolean;
  /** The collapsed label ("Show 3 more", "Show all 12"). */
  label: string;
  controls?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
      className="flex h-7 w-full items-center rounded-md px-2.5 text-left text-[12px] text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/60 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 max-md:h-11"
    >
      {expanded ? "Show fewer" : label}
    </button>
  );
}

/**
 * The `<section>` of a sidebar section drawn outside `sections.tsx` (Needs you, Settled): the shared header whose
 * toggle controls the section's list, then that list (always rendered, so `aria-controls` points at an element).
 */
export function SectionShell({
  sectionKey,
  title,
  collapsed,
  hidden,
  onToggle,
  testId,
  toggleTestId,
  children,
}: {
  sectionKey: string;
  title: string;
  collapsed: boolean;
  hidden: number;
  onToggle: (key: string) => void;
  testId: string;
  toggleTestId?: string;
  children: ReactNode;
}) {
  const headingId = `wz-section-${sectionKey}`;
  const listId = `wz-list-${sectionKey}`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      data-section={sectionKey}
      data-collapsed={collapsed ? "true" : undefined}
      className="grid grid-cols-1 gap-px"
    >
      <SidebarSectionHeader
        id={headingId}
        title={title}
        expanded={!collapsed}
        hidden={hidden}
        onToggle={() => onToggle(sectionKey)}
        controls={listId}
        touch
        announceHidden
        countAtEnd
        testId={toggleTestId}
      />
      {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics under `list-style: none` (UI-SPEC). */}
      <ul id={listId} role="list" className="grid grid-cols-1 gap-px">
        {children}
      </ul>
    </section>
  );
}

export function NeedsYouSection({
  model,
  viewerId,
  openSessionId,
  onToggle,
  onExpand,
}: {
  model: NeedsYouModel | null;
  now: number;
  viewerId: string | null;
  openSessionId: string | null;
  onToggle: (key: string) => void;
  onExpand: (key: string) => void;
}) {
  if (!model) return null;
  return (
    <SectionShell
      sectionKey="needs"
      title="Needs you"
      collapsed={model.collapsed}
      hidden={model.hidden}
      onToggle={onToggle}
      testId="needs-you"
    >
      {model.rows.map((r) => (
        <li key={r.session.id}>
          <NeedsYouRow
            s={r.session}
            reason={r.reason}
            place={r.place}
            active={r.session.id === openSessionId}
            viewerId={viewerId}
          />
        </li>
      ))}
      {model.more > 0 || model.expanded ? (
        <li>
          <InlineMore
            testId="needs-more"
            expanded={model.expanded}
            label={`Show ${model.more} more`}
            controls="wz-list-needs"
            onToggle={() => onExpand("needs")}
          />
        </li>
      ) : null}
    </SectionShell>
  );
}
