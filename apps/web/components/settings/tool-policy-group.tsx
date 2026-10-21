"use client";

import type { ApprovableGroup, ToolApprovalMode, ToolApprovalPolicyPage } from "@ocw/contracts";
import { strictestMode } from "@ocw/contracts";
import {
  ChevronDown,
  ChevronRight,
  Container,
  Globe,
  Lock,
  MonitorPlay,
  Package,
  Plug,
  UserCheck,
} from "lucide-react";
import { useId } from "react";
import { SideEffectBadge } from "@/components/mcp/mcp-tools-list";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { effectiveRowMode, MODE_LABEL, type RowMode, toolDisplayName } from "@/lib/approval-policy-queries";
import { cn } from "@/lib/utils";
import { inheritedReason, ModeIcon, type PolicyRuleTarget } from "./policy-rule-dialog";

/** Groups with more tools than this show the first few and "… {n} more · Show all" (UI-SPEC Surface 4). */
const COLLAPSE_OVER = 8;
const SHOW_FIRST = 3;

const MODE_TONE: Readonly<Record<ToolApprovalMode, string>> = {
  never: "bg-muted text-muted-foreground",
  when_tainted: "border border-amber-300 text-amber-800 dark:border-amber-400/40 dark:text-amber-300",
  always: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
};

/** The mode chip: Never ask (muted), Ask after outside content (amber outline), Always ask (pending tones). */
export function ModeChip({ mode, className }: { mode: ToolApprovalMode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 font-semibold text-xs",
        MODE_TONE[mode],
        className,
      )}
      data-testid="policy-mode-chip"
      data-mode={mode}
    >
      <ModeIcon mode={mode} />
      {MODE_LABEL[mode]}
    </span>
  );
}

const SOURCE_ICON = {
  mcp: Plug,
  connector: Plug,
  plugin: Package,
  http: Globe,
  sandbox: Container,
  browser: MonitorPlay,
} as const satisfies Record<ApprovableGroup["source"]["kind"], unknown>;

/** "MCP server · 2 tools", "Connector · 12 tools", "Approved plugin tools · 3", "HTTP requests with a Keychain key". */
export function groupMeta(group: ApprovableGroup): string {
  const n = group.tools.length;
  const tools = `${n} ${n === 1 ? "tool" : "tools"}`;
  switch (group.source.kind) {
    case "mcp":
      return `MCP server · ${tools}`;
    case "connector":
      return `Connector · ${tools}`;
    case "plugin":
      return `Approved plugin tools · ${n}`;
    case "sandbox":
      return `Sandbox · ${tools}`;
    case "browser":
      return `Browser · ${tools}`;
    default:
      return "HTTP requests with a Keychain key";
  }
}

/** The stable key of a group (test id, expanded state): the server's safe name, or the source kind. */
export const groupKey = (group: ApprovableGroup) => group.source.safeName ?? group.source.kind;

export interface PolicyRow {
  pattern: string;
  label: string;
  server: boolean;
  sideEffecting: boolean | null;
}

/** The server row first (`<safe>__*`), then one row per tool. */
export function groupRows(group: ApprovableGroup): PolicyRow[] {
  const rows: PolicyRow[] = [];
  if (group.source.safeName) {
    rows.push({
      pattern: `${group.source.safeName}__*`,
      label: `All ${group.source.name} tools`,
      server: true,
      sideEffecting: null,
    });
  }
  for (const t of group.tools) {
    rows.push({
      pattern: t.name,
      label: toolDisplayName(group, t.name),
      server: false,
      sideEffecting: t.sideEffecting,
    });
  }
  return rows;
}

/** Whether any row of the group carries a rule at this scope or above (such groups start expanded). */
export function groupHasRule(page: ToolApprovalPolicyPage, group: ApprovableGroup): boolean {
  return groupRows(group).some((r) => effectiveRowMode(page, r.pattern).source !== "none");
}

/** One source in the catalog list: the header (expand / collapse) and its rows. */
export function ToolPolicyGroup({
  group,
  page,
  expanded,
  onToggle,
  query,
  showAll,
  onShowAll,
  onEdit,
}: {
  group: ApprovableGroup;
  page: ToolApprovalPolicyPage;
  expanded: boolean;
  onToggle: () => void;
  /** The search (lowercase, trimmed): rows that don't match are hidden; "" shows all. */
  query: string;
  showAll: boolean;
  onShowAll: () => void;
  onEdit: (target: PolicyRuleTarget, opener: HTMLElement) => void;
}) {
  const uid = useId();
  const all = groupRows(group);
  const nameMatches = query !== "" && group.source.name.toLowerCase().includes(query);
  const rows = query === "" || nameMatches ? all : all.filter((r) => r.label.toLowerCase().includes(query));
  const modes = all.map((r) => effectiveRowMode(page, r.pattern));
  const collapsedMode = strictestMode(modes.map((m) => m.mode));
  const toolRows = rows.filter((r) => !r.server);
  const truncate = query === "" && !showAll && toolRows.length > COLLAPSE_OVER;
  const visible = truncate ? [...rows.filter((r) => r.server), ...toolRows.slice(0, SHOW_FIRST)] : rows;
  const Icon = SOURCE_ICON[group.source.kind];
  const key = groupKey(group);
  const listId = `${uid}-rows`;

  return (
    <section
      data-testid={`policy-group-${key}`}
      data-name={group.source.name}
      aria-labelledby={`${uid}-name`}
    >
      <h2 className="m-0">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={onToggle}
          className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset"
        >
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              !expanded && "-rotate-90",
            )}
            aria-hidden
          />
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground"
          >
            <Icon className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span id={`${uid}-name`} className="block truncate font-semibold text-sm">
              {group.source.name}
            </span>
            <span className="block truncate text-muted-foreground text-xs">{groupMeta(group)}</span>
          </span>
          {!expanded ? <ModeChip mode={collapsedMode} className="max-sm:hidden" /> : null}
        </button>
      </h2>
      {expanded ? (
        <ul id={listId} aria-label={`${group.source.name} tools`} className="divide-y border-t">
          {visible.map((r) => (
            <ToolPolicyRow
              key={r.pattern}
              row={r}
              mode={effectiveRowMode(page, r.pattern)}
              onEdit={(opener) =>
                onEdit(
                  {
                    pattern: r.pattern,
                    title: r.server ? `all ${group.source.name} tools` : r.label,
                    sourceName: group.source.name,
                  },
                  opener,
                )
              }
            />
          ))}
          {truncate ? (
            <li className="flex min-h-12 items-center px-4 text-muted-foreground text-xs">
              <span>… {toolRows.length - SHOW_FIRST} more ·</span>
              <Button
                variant="link"
                size="sm"
                onClick={onShowAll}
                className="ml-1 h-auto text-xs max-lg:min-h-11"
                data-testid={`policy-show-all-${key}`}
              >
                Show all
              </Button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * One tool (or the whole server): name, effect, mode chip, approvers or where the mode comes from, Edit. Below 768 the
 * whole row is the Edit button (min-h 56). An upper rule that already asks every time leaves nothing to add: Edit is
 * `aria-disabled`, described by the visible reason (P-04).
 */
export function ToolPolicyRow({
  row,
  mode,
  onEdit,
}: {
  row: PolicyRow;
  mode: RowMode;
  onEdit: (opener: HTMLElement) => void;
}) {
  const uid = useId();
  const reasonId = `${uid}-reason`;
  const editName = `Edit rule for ${row.label}`;
  const upper = mode.source === "organization" || mode.source === "unit";
  return (
    <li
      className="relative grid min-h-12 gap-x-3 gap-y-1 px-4 py-2.5 max-md:min-h-14 md:grid-cols-[minmax(0,1fr)_12.5rem_minmax(0,11rem)_auto] md:items-center"
      data-testid={`policy-row-${row.pattern}`}
      data-mode={mode.mode}
      data-locked={mode.locked ? "true" : undefined}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 max-md:pr-6">
        <span
          className={cn(
            "min-w-0 break-all text-[13px]",
            row.server ? "font-semibold font-sans text-sm" : "font-medium font-mono",
          )}
        >
          {row.label}
        </span>
        {row.sideEffecting !== null ? <SideEffectBadge sideEffecting={row.sideEffecting} /> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 md:contents">
        <span className="md:justify-self-start">
          <ModeChip mode={mode.mode} />
        </span>
        <span className="min-w-0 text-muted-foreground text-xs md:truncate">
          {mode.source === "server" ? (
            <span data-testid="policy-source">{mode.sourceLabel}</span>
          ) : upper ? (
            <Badge variant="outline" className="h-5 text-xs" data-testid="policy-source">
              <Lock aria-hidden /> {mode.sourceLabel}
            </Badge>
          ) : mode.approverLabel ? (
            <span className="inline-flex max-w-full items-center gap-1" title={mode.approverLabel}>
              <UserCheck className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate" data-testid="policy-approvers-label">
                {mode.approverLabel}
              </span>
            </span>
          ) : null}
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        aria-label={editName}
        aria-disabled={mode.locked ? true : undefined}
        aria-describedby={mode.locked ? reasonId : undefined}
        onClick={(e) => {
          if (!mode.locked) onEdit(e.currentTarget);
        }}
        className={cn("max-md:hidden", mode.locked && "cursor-not-allowed opacity-50 hover:bg-transparent")}
        data-testid={`policy-edit-${row.pattern}`}
      >
        Edit
      </Button>
      {mode.locked ? (
        <p
          id={reasonId}
          className="text-muted-foreground text-xs md:col-span-4"
          data-testid="policy-locked-reason"
        >
          {inheritedReason(mode.inheritedMode, mode.inheritedScopeLabel)}
        </p>
      ) : (
        <>
          {/* Phone: the whole row opens the rule dialog (one button, min-h 56). */}
          <button
            type="button"
            aria-label={editName}
            onClick={(e) => onEdit(e.currentTarget)}
            className="absolute inset-0 rounded-none outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset md:hidden"
            data-testid={`policy-edit-${row.pattern}`}
          />
          <ChevronRight
            className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground md:hidden"
            aria-hidden
          />
        </>
      )}
    </li>
  );
}
