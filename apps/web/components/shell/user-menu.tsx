"use client";

import type { MeResponse, UpdateNotificationPrefsRequest } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  BellOff,
  LogOut,
  Monitor,
  Moon,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  UserRound,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { toast } from "sonner";
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProfile } from "@/lib/account-queries";
import { errorMessage } from "@/lib/api";
import { dndActive, updateNotificationPrefs, useNotificationPrefs } from "@/lib/notification-queries";
import { DND_PRESETS, dndPresetUntil, formatDndUntil } from "@/lib/os-notifications";
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
  const prefs = useNotificationPrefs();
  const paused = !!prefs.data && dndActive(prefs.data);
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
          {paused ? (
            <span
              data-testid="dnd-indicator"
              title="Notifications paused"
              className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-sidebar text-muted-foreground ring-1 ring-border"
            >
              <Moon className="size-2.5" aria-hidden />
              <span className="sr-only">Notifications paused</span>
            </span>
          ) : null}
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
        <PauseNotifications inline={compact} />
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

/**
 * Do not disturb from the user menu (CHAT-10): the paused state with "Resume notifications", and "Pause
 * notifications" with the same presets as Settings › Notifications (custom times live there). A submenu beside the
 * menu on wide screens; inline rows on phones, where a submenu would cover its parent.
 */
function PauseNotifications({ inline = false }: { inline?: boolean }) {
  const qc = useQueryClient();
  const router = useRouter();
  const prefs = useNotificationPrefs();
  const until = prefs.data?.dndUntil ?? null;
  const paused = !!prefs.data && dndActive(prefs.data);
  const save = (patch: UpdateNotificationPrefsRequest) =>
    void updateNotificationPrefs(qc, patch).catch((err) => toast.error(errorMessage(err)));
  const presets = (
    <>
      {DND_PRESETS.map((d) => (
        <DropdownMenuItem
          key={d.id}
          data-testid={`pause-${d.id}`}
          className={cn(inline && "pl-7.5")}
          onClick={() => save({ dndUntil: dndPresetUntil(d.id) })}
        >
          {d.label}
        </DropdownMenuItem>
      ))}
      {inline ? null : <DropdownMenuSeparator />}
      <DropdownMenuItem
        data-testid="pause-custom"
        className={cn(inline && "pl-7.5 text-muted-foreground")}
        onClick={() => router.push("/settings/notifications")}
      >
        {inline ? null : <SlidersHorizontal />} Custom and settings…
      </DropdownMenuItem>
    </>
  );
  return (
    <DropdownMenuGroup>
      {paused && until ? (
        <>
          <div
            data-testid="notifications-paused"
            className="mx-2 mb-1 flex items-center gap-2 rounded-md bg-primary/10 px-2 py-1.5 text-primary text-xs"
          >
            <Moon className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">Notifications paused until {formatDndUntil(until)}</span>
          </div>
          <DropdownMenuItem data-testid="resume-notifications" onClick={() => save({ dndUntil: null })}>
            <Bell /> Resume notifications
          </DropdownMenuItem>
        </>
      ) : null}
      {inline ? (
        <>
          <DropdownMenuLabel data-testid="pause-notifications" className="flex items-center gap-2">
            <BellOff className="size-3.5" aria-hidden /> {paused ? "Pause for longer" : "Pause notifications"}
          </DropdownMenuLabel>
          {presets}
        </>
      ) : (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="pause-notifications">
            <BellOff /> {paused ? "Pause for longer" : "Pause notifications"}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56" data-testid="pause-notifications-menu">
            {presets}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
    </DropdownMenuGroup>
  );
}
