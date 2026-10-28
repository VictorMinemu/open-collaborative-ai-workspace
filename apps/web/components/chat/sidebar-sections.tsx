"use client";

import { badgeStyle, type ChannelSummary, type ChannelUnit } from "@ocw/contracts";
import { BellOff, Plus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { sectionItemClass } from "@/components/shell/section-sidebar";
import { SidebarSectionHeader } from "@/components/shell/sidebar-section-header";
import { Tooltip } from "@/components/ui/tooltip";
import { useReadHold } from "@/lib/chat-queries";
import { cn } from "@/lib/utils";
import { ChannelIcon, isUnread } from "./channel-icon";
import { ConversationBadge } from "./conversation-badge";

/** The badge inputs of a row (CHAT-09); the open conversation shows none unless the member marked it unread. */
export function rowBadge(
  c: Pick<ChannelSummary, "notifyLevel" | "muted" | "unreadCount" | "mentionCount">,
  show: boolean,
) {
  const input = {
    level: c.notifyLevel ?? "default",
    muted: c.muted ?? false,
    unreadCount: show ? (c.unreadCount ?? 0) : 0,
    mentionCount: show ? (c.mentionCount ?? 0) : 0,
  };
  return { input, style: badgeStyle(input) };
}

/** The bell-off mark of a muted row (CHAT-10); it sits before the badge, so a mention badge still shows. */
export function MutedIcon() {
  return (
    <span data-testid="muted-icon" className="ml-auto flex shrink-0 text-muted-foreground/80">
      <BellOff aria-hidden className="size-3.5" />
      <span className="sr-only">(muted)</span>
    </span>
  );
}

/**
 * The channel part of the chat sidebar (CHAT-02, D-08): an Organization section, then one collapsible section per
 * department (the member's own first), team and project channels nested inside their department with a sub-label.
 * Never deeper than two levels (PRD §13: no infinite visual hierarchies). Collapse state lives in localStorage.
 */

export const SECTIONS_STORAGE_KEY = "ocw.chat.sections.collapsed";
const ORG_KEY = "org";

export type SidebarChannel = ChannelSummary & { subLabel: string | null };

export interface ChannelSection {
  /** `org` or the department id. */
  key: string;
  title: string;
  /** The department (root of the channels' unit paths); null for Organization. */
  unit: ChannelUnit | null;
  channels: SidebarChannel[];
}

const byName = (a: ChannelSummary, b: ChannelSummary) => (a.name ?? "").localeCompare(b.name ?? "");

/**
 * Groups channels by the top-level unit of their path (or Organization). Sections: Organization first, then the
 * departments in `myUnitIds`, then the others, each alphabetically. Inside a section: joined channels before
 * suggestions, #general first, then by name; a channel deeper than its department carries its own unit's name as
 * `subLabel`.
 */
export function groupChannelsByUnit(
  channels: ChannelSummary[],
  myUnitIds: ReadonlySet<string>,
): ChannelSection[] {
  const sections = new Map<string, ChannelSection>();
  for (const c of channels) {
    const unit = c.unit ?? null;
    const top = unit?.path[0];
    const key = unit && top ? top : ORG_KEY;
    let section = sections.get(key);
    if (!section) {
      const title =
        unit && top
          ? (unit.pathNames?.[0] ?? (unit.path.length === 1 ? unit.name : "Department"))
          : "Organization";
      section = {
        key,
        title,
        unit:
          unit && top ? { id: top, name: title, kind: "department", path: [top], pathNames: [title] } : null,
        channels: [],
      };
      sections.set(key, section);
    }
    section.channels.push({ ...c, subLabel: unit && unit.path.length > 1 ? unit.name : null });
  }
  for (const s of sections.values()) {
    s.channels.sort(
      (a, b) =>
        Number(b.isMember) - Number(a.isMember) || Number(b.isDefault) - Number(a.isDefault) || byName(a, b),
    );
  }
  const org = sections.get(ORG_KEY);
  const units = [...sections.values()].filter((s) => s.key !== ORG_KEY);
  units.sort(
    (a, b) => Number(myUnitIds.has(b.key)) - Number(myUnitIds.has(a.key)) || a.title.localeCompare(b.title),
  );
  return org ? [org, ...units] : units;
}

/** Collapsed section keys, persisted in localStorage (survives reloads, per browser). */
export function useCollapsedSections(): [ReadonlySet<string>, (key: string) => void] {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    try {
      const raw = JSON.parse(window.localStorage.getItem(SECTIONS_STORAGE_KEY) ?? "[]");
      if (Array.isArray(raw)) setCollapsed(new Set(raw.filter((k): k is string => typeof k === "string")));
    } catch {
      // A corrupt value just means nothing is collapsed.
    }
  }, []);
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        window.localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // Private mode / quota: the state still applies for this page.
      }
      return next;
    });
  }, []);
  return [collapsed, toggle];
}

function ChannelRow({ c, active }: { c: SidebarChannel; active: boolean }) {
  const held = useReadHold(c.id) !== null;
  const { input, style } = rowBadge(c, (!active || held) && isUnread(c));
  const unread = style !== "none";
  return (
    <Link
      href={`/chat/${c.id}`}
      data-testid="channel-link"
      data-channel-name={c.name}
      data-joined={c.isMember ? undefined : "false"}
      data-unread={unread || undefined}
      data-muted={c.muted || undefined}
      aria-current={active ? "page" : undefined}
      className={cn(
        sectionItemClass(active),
        unread && "font-semibold text-foreground",
        !c.isMember && !active && "text-muted-foreground",
        c.muted && !active && style !== "mention" && "opacity-60",
      )}
    >
      <ChannelIcon channel={c} className={active ? "" : "text-muted-foreground"} />
      <span className="min-w-0 flex-1 truncate">{c.name}</span>
      {c.subLabel ? (
        <span
          data-testid="channel-sublabel"
          className="max-w-[45%] shrink-0 truncate rounded-[4px] bg-muted/80 px-1 py-px font-medium text-[10.5px] text-muted-foreground leading-tight"
        >
          {c.subLabel}
        </span>
      ) : null}
      {c.muted ? <MutedIcon /> : null}
      <ConversationBadge {...input} className={c.muted ? "ml-1" : undefined} />
    </Link>
  );
}

/**
 * Collapsible channel sections. A collapsed section still shows its active and unread channels (like Slack) and
 * counts the rest. `onCreate` adds a hover "+" that opens the create dialog in that unit when `canPlace` allows it.
 */
export function SidebarSections({
  channels,
  activeId,
  memberUnitIds = new Set<string>(),
  onCreate,
  canPlace,
}: {
  channels: ChannelSummary[];
  activeId: string | null;
  memberUnitIds?: ReadonlySet<string>;
  onCreate?: (unitId: string | null) => void;
  canPlace?: (unitId: string | null) => boolean;
}) {
  const [collapsed, toggle] = useCollapsedSections();
  const sections = groupChannelsByUnit(channels, memberUnitIds);
  return (
    <div className="grid grid-cols-1 gap-3">
      {sections.map((s) => {
        const isCollapsed = collapsed.has(s.key);
        // A collapsed section keeps what has a badge (a muted channel only with a mention, CHAT-10).
        const shown = isCollapsed
          ? s.channels.filter((c) => c.id === activeId || rowBadge(c, isUnread(c)).style !== "none")
          : s.channels;
        const hidden = s.channels.length - shown.length;
        const unitId = s.unit?.id ?? null;
        const headingId = `section-${s.key}`;
        return (
          <section
            key={s.key}
            aria-labelledby={headingId}
            data-testid="sidebar-section"
            data-unit-id={s.unit?.id ?? ORG_KEY}
            data-collapsed={isCollapsed ? "true" : undefined}
            className="grid grid-cols-1 gap-px"
          >
            <SidebarSectionHeader
              id={headingId}
              title={s.title}
              expanded={!isCollapsed}
              hidden={hidden}
              onToggle={() => toggle(s.key)}
              action={
                onCreate && (canPlace?.(unitId) ?? true) ? (
                  <Tooltip content={s.unit ? `Create a channel in ${s.title}` : "Create a channel"}>
                    <button
                      type="button"
                      aria-label={s.unit ? `Create a channel in ${s.title}` : "Create a channel"}
                      data-testid="section-create"
                      onClick={() => onCreate(unitId)}
                      className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/40 group-hover/section:opacity-100 [@media(hover:none)]:hidden"
                    >
                      <Plus className="size-3.5" />
                    </button>
                  </Tooltip>
                ) : null
              }
            />
            {shown.map((c) => (
              <ChannelRow key={c.id} c={c} active={c.id === activeId} />
            ))}
          </section>
        );
      })}
    </div>
  );
}
