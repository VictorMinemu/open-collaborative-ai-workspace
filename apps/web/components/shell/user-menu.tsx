"use client";

import type { MeResponse } from "@ocw/contracts";
import { LogOut, Monitor, Moon, Settings, ShieldCheck, Sun, UserRound } from "lucide-react";
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
import { useProfile } from "@/lib/account-queries";
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
        <MenuStatus />
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
        <DropdownMenuItem data-testid="user-menu-profile" onClick={() => router.push("/settings/profile")}>
          <UserRound /> Profile
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="user-menu-security" onClick={() => router.push("/settings/security")}>
          <ShieldCheck /> Security
        </DropdownMenuItem>
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

/** The member's status (fetched only while the menu is open: the content mounts on open). */
function MenuStatus() {
  const profile = useProfile();
  const p = profile.data;
  if (!p || (!p.statusEmoji && !p.statusText)) return null;
  return (
    <div
      data-testid="user-menu-status"
      className="mx-2 mb-1.5 flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs"
    >
      {p.statusEmoji ? <span className="text-sm leading-none">{p.statusEmoji}</span> : null}
      <span className="truncate text-muted-foreground">{p.statusText ?? ""}</span>
    </div>
  );
}
