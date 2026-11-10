"use client";

import { ALLOWED_PARENT_KINDS, UnitKind } from "@ocw/contracts";
import { ChevronRight, Users } from "lucide-react";
import { type KeyboardEvent, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { UnitActionsMenu } from "./unit-dialogs";
import { KIND_META, KindIcon, UnitHandle, type UnitNode } from "./unit-meta";

const INDENT = 16;

/**
 * The kinds that may be created directly inside a unit of `kind` (null = the organization root), from the
 * same ALLOWED_PARENT_KINDS table the API enforces.
 */
export function childKinds(kind: UnitKind | null): UnitKind[] {
  return UnitKind.options.filter((k) => ALLOWED_PARENT_KINDS[k].includes(kind));
}

/** Rows currently visible: depth-first, skipping the children of collapsed units. */
function visibleRows(roots: UnitNode[], collapsed: ReadonlySet<string>): UnitNode[] {
  const out: UnitNode[] = [];
  const walk = (nodes: UnitNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.children.length > 0 && !collapsed.has(n.id)) walk(n.children);
    }
  };
  walk(roots);
  return out;
}

/**
 * Accessible tree (WAI-ARIA tree pattern): one tab stop, ↑/↓ move, → expands or enters, ← collapses or goes
 * to the parent, Enter/Space selects, Home/End jump. The create items of each row's menu follow
 * ALLOWED_PARENT_KINDS and only render when the unit's viewerCan includes unit.manage (UnitActionsMenu).
 */
export function UnitTree({
  roots,
  selectedId,
  collapsed,
  onSelect,
  onToggle,
  label = "Departments, teams and projects",
}: {
  roots: UnitNode[];
  selectedId: string | null;
  collapsed: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string, expand?: boolean) => void;
  label?: string;
}) {
  const rows = visibleRows(roots, collapsed);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const tabStop = rows.some((r) => r.id === focusedId)
    ? focusedId
    : rows.some((r) => r.id === selectedId)
      ? selectedId
      : (rows[0]?.id ?? null);

  const focus = (id: string | undefined) => {
    if (!id) return;
    setFocusedId(id);
    refs.current.get(id)?.focus();
  };

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>, id: string) {
    // Keys typed inside a row's menu button are the menu's business.
    if (e.target !== e.currentTarget) return;
    const index = rows.findIndex((r) => r.id === id);
    const row = rows[index];
    if (!row) return;
    const expanded = row.children.length > 0 && !collapsed.has(row.id);
    switch (e.key) {
      case "ArrowDown":
        focus(rows[index + 1]?.id);
        break;
      case "ArrowUp":
        focus(rows[index - 1]?.id);
        break;
      case "Home":
        focus(rows[0]?.id);
        break;
      case "End":
        focus(rows[rows.length - 1]?.id);
        break;
      case "ArrowRight":
        if (row.children.length === 0) return;
        if (expanded) focus(row.children[0]?.id);
        else onToggle(row.id, true);
        break;
      case "ArrowLeft":
        if (expanded) onToggle(row.id, false);
        else focus(row.parentId ?? undefined);
        break;
      case "Enter":
      case " ":
        onSelect(row.id);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  return (
    <div role="tree" aria-label={label} className="grid gap-px">
      {rows.map((u) => {
        const hasChildren = u.children.length > 0;
        const isCollapsed = collapsed.has(u.id);
        const selected = u.id === selectedId;
        return (
          <div
            key={u.id}
            ref={(el) => {
              if (el) refs.current.set(u.id, el);
              else refs.current.delete(u.id);
            }}
            role="treeitem"
            aria-level={u.depth + 1}
            aria-expanded={hasChildren ? !isCollapsed : undefined}
            aria-selected={selected}
            aria-label={`${u.name}, ${KIND_META[u.kind].label}, ${u.memberCount} ${u.memberCount === 1 ? "member" : "members"}`}
            tabIndex={u.id === tabStop ? 0 : -1}
            data-testid="unit-row"
            data-kind={u.kind}
            data-unit-id={u.id}
            data-selected={selected || undefined}
            onClick={() => {
              setFocusedId(u.id);
              onSelect(u.id);
            }}
            onKeyDown={(e) => onKeyDown(e, u.id)}
            onFocus={(e) => {
              if (e.target === e.currentTarget) setFocusedId(u.id);
            }}
            className={cn(
              "group relative flex h-11 cursor-pointer select-none items-center gap-1.5 rounded-lg pr-1 text-[14px] outline-none transition-colors lg:h-9 lg:text-[13.5px]",
              "focus-visible:ring-[3px] focus-visible:ring-ring/40",
              selected
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-foreground/90 hover:bg-sidebar-accent/60",
            )}
            style={{ paddingLeft: 4 + u.depth * INDENT }}
          >
            {/* Indentation guides, one per ancestor level. */}
            {Array.from({ length: u.depth }, (_, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: one static guide per level
                key={i}
                aria-hidden
                className="pointer-events-none absolute inset-y-0 w-px bg-border"
                style={{ left: 4 + i * INDENT + 11 }}
              />
            ))}
            {hasChildren ? (
              <button
                type="button"
                tabIndex={-1}
                aria-label={isCollapsed ? `Expand ${u.name}` : `Collapse ${u.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(u.id);
                }}
                className="relative flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground before:absolute before:-inset-2 before:content-[''] hover:bg-accent hover:text-foreground lg:before:-inset-1"
              >
                <ChevronRight className={cn("size-3.5 transition-transform", !isCollapsed && "rotate-90")} />
              </button>
            ) : (
              <span aria-hidden className="size-6 shrink-0" />
            )}
            <KindIcon kind={u.kind} />
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5 pl-1">
              <span className="min-w-0 truncate" title={u.name}>
                {u.name}
              </span>
              {/* 07.17 (D-14): the mention handle gives way to the name when the row is narrow. */}
              <UnitHandle unit={u} className="shrink-[3]" />
            </span>
            <span
              aria-hidden
              title={`${u.memberCount} ${u.memberCount === 1 ? "member" : "members"}`}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-normal text-[11px] text-muted-foreground tabular-nums",
                u.memberCount === 0 && "opacity-60",
              )}
            >
              <Users className="size-3" />
              {u.memberCount}
            </span>
            <UnitActionsMenu
              unit={u}
              createKinds={childKinds(u.kind)}
              className={cn(
                "size-10 lg:size-7",
                "lg:opacity-0 lg:focus-visible:opacity-100 lg:group-hover:opacity-100 lg:data-popup-open:opacity-100",
                selected && "lg:opacity-100",
              )}
            />
          </div>
        );
      })}
    </div>
  );
}
