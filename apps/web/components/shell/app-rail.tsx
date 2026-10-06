"use client";

import type { MeResponse } from "@ocw/contracts";
import { PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useSearchPalette } from "@/components/search/search-palette";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { NavList } from "./nav-list";
import { useShellPrefs } from "./shell-context";
import { UserMenu } from "./user-menu";
import { WorkspaceSwitcher } from "./workspace-switcher";

/** Rail body, shared by the desktop rail and the mobile drawer. */
export function RailContent({
  me,
  collapsed = false,
  onNavigate,
  children,
}: {
  me: MeResponse;
  collapsed?: boolean;
  onNavigate?: () => void;
  /** Extra content under the main nav (the mobile drawer puts the section sidebar here). */
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn("px-2.5 pt-3 pb-2", collapsed && "px-2")}>
        <WorkspaceSwitcher me={me} collapsed={collapsed} />
      </div>
      <div className={cn("grid gap-1.5 px-3 py-2", collapsed && "px-2")}>
        {onNavigate ? null : <RailSearchButton collapsed={collapsed} />}
        <NavList collapsed={collapsed} onNavigate={onNavigate} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      <div className={cn("grid gap-1 border-sidebar-border border-t px-3 pt-2 pb-3", collapsed && "px-2")}>
        <NavList collapsed={collapsed} secondary onNavigate={onNavigate} />
        <UserMenu me={me} collapsed={collapsed} />
      </div>
    </div>
  );
}

/** Opens the ⌘K palette from the desktop rail (the mobile top bar has its own button). */
function RailSearchButton({ collapsed }: { collapsed: boolean }) {
  const palette = useSearchPalette();
  return (
    <Tooltip content="Search ⌘K" side="right">
      <button
        type="button"
        data-testid="open-search"
        aria-label="Search"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => palette.open()}
        className={cn(
          "flex h-9 items-center gap-2.5 rounded-lg border border-sidebar-border bg-background/60 px-2.5 text-[13px] text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/40 dark:bg-transparent",
          collapsed && "justify-center border-transparent bg-transparent px-0",
        )}
      >
        <Search className="size-[17px] shrink-0" strokeWidth={1.9} />
        {collapsed ? null : (
          <>
            <span className="flex-1 truncate text-left">Search</span>
            <kbd className="rounded border border-sidebar-border bg-sidebar px-1.5 font-mono text-[10.5px]">
              ⌘K
            </kbd>
          </>
        )}
      </button>
    </Tooltip>
  );
}

export function AppRail({ me }: { me: MeResponse }) {
  const collapsed = useShellPrefs((s) => s.railCollapsed);
  const toggle = useShellPrefs((s) => s.toggleRail);
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <aside
      aria-label="Workspace navigation"
      className={cn(
        "group/rail relative flex h-dvh shrink-0 flex-col border-sidebar-border border-r bg-sidebar transition-[width] duration-200 ease-out",
        collapsed ? "w-[60px]" : "w-60",
      )}
    >
      <RailContent me={me} collapsed={collapsed} />
      <Tooltip content={collapsed ? "Expand sidebar" : "Collapse sidebar"} side="right">
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="absolute top-1/2 -right-3 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-sm outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/40 group-hover/rail:opacity-100"
        >
          <ToggleIcon className="size-3.5" />
        </button>
      </Tooltip>
    </aside>
  );
}
