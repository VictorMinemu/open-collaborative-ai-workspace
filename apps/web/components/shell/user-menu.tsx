"use client";

import type { MeResponse } from "@ocw/contracts";
import { LogOut, Monitor, Moon, Settings, Sun } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { UserAvatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSignOut } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { ConnectionDot, useConnectionMeta } from "./connection-dot";

export function UserMenu({
  me,
  collapsed = false,
  compact = false,
}: {
  me: MeResponse;
  collapsed?: boolean;
  /** Avatar-only trigger (mobile top bar). */
  compact?: boolean;
}) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const signOut = useSignOut();
  const conn = useConnectionMeta();
  const { user } = me;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="user-menu"
        aria-label={`Account: ${user.name}`}
        className={cn(
          "flex items-center gap-2.5 rounded-lg text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/40 data-popup-open:bg-sidebar-accent",
          compact ? "p-1" : "w-full p-1.5",
          collapsed && "justify-center",
        )}
      >
        <span className="relative">
          <UserAvatar name={user.name} src={user.image} seed={user.id} className="size-8" />
          <ConnectionDot className="absolute -right-0.5 -bottom-0.5" />
        </span>
        {compact || collapsed ? null : (
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium text-[13px] text-sidebar-accent-foreground">
              {user.name}
            </span>
            <span className="block truncate text-muted-foreground text-xs">{user.email}</span>
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={compact ? "bottom" : "top"}
        align={compact ? "end" : "start"}
        className="w-64"
      >
        <div className="flex items-center gap-2.5 px-2 py-2">
          <UserAvatar name={user.name} src={user.image} seed={user.id} className="size-9" />
          <div className="min-w-0">
            <div className="truncate font-medium text-sm">{user.name}</div>
            <div className="truncate text-muted-foreground text-xs">{user.email}</div>
          </div>
        </div>
        <div className="mx-2 mb-1.5 flex items-center gap-2 rounded-md bg-muted/60 px-2 py-1.5 text-muted-foreground text-xs">
          <span className={cn("size-2 rounded-full", conn.className)} />
          Realtime: {conn.label}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={(v: string) => setTheme(v)}>
            <DropdownMenuRadioItem value="light">
              <Sun /> Light
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <Moon /> Dark
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system">
              <Monitor /> System
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/settings")}>
          <Settings /> Settings
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          data-testid="sign-out"
          onClick={() =>
            signOut.mutate(undefined, {
              onSettled: () => router.replace("/login"),
            })
          }
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
