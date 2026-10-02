"use client";

import type { MeResponse } from "@ocw/contracts";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { ReactNode } from "react";
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
      <div className={cn("px-3 py-2", collapsed && "px-2")}>
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
