"use client";

import type { MeResponse } from "@ocw/contracts";
import { ChevronsUpDown, Settings, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, initials } from "@/lib/utils";

export function OrgAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-indigo-500 to-violet-600 font-semibold text-[13px] text-white shadow-indigo-500/25 shadow-sm ring-1 ring-white/15 ring-inset",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

export function WorkspaceSwitcher({ me, collapsed = false }: { me: MeResponse; collapsed?: boolean }) {
  const router = useRouter();
  const org = me.organization;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="workspace-switcher"
        aria-label={`Workspace: ${org.name}`}
        className={cn(
          "group flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/40 data-popup-open:bg-sidebar-accent",
          collapsed && "justify-center",
        )}
      >
        <OrgAvatar name={org.name} />
        <span className={cn("min-w-0 flex-1", collapsed && "sr-only")}>
          <span
            data-testid="org-name"
            className="block truncate font-semibold text-[14px] text-sidebar-accent-foreground"
          >
            {org.name}
          </span>
          <span className="block truncate text-muted-foreground text-xs capitalize">{org.role}</span>
        </span>
        {collapsed ? null : <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Workspace</DropdownMenuLabel>
          <div className="flex items-center gap-2.5 px-2 pt-0.5 pb-2">
            <OrgAvatar name={org.name} className="size-9" />
            <div className="min-w-0">
              <div className="truncate font-medium text-sm">{org.name}</div>
              <div className="truncate text-muted-foreground text-xs">{org.slug}</div>
            </div>
          </div>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/settings")}>
          <Users /> Members & invitations
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push("/settings")}>
          <Settings /> Workspace settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
