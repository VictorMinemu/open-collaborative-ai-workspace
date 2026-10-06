"use client";

import type { ConversationNotifyLevel, UpdateConversationNotificationSettingsRequest } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Bell, BellOff, BellRing, CheckCheck, CircleDot } from "lucide-react";
import { toast } from "sonner";
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
import { errorMessage } from "@/lib/api";
import {
  markConversationRead,
  markConversationUnread,
  setReadHold,
  updateConversationSettings,
  useConversationSettings,
} from "@/lib/chat-queries";
import { useNotificationPrefs } from "@/lib/notification-queries";
import { cn } from "@/lib/utils";

const LEVEL_LABEL: Record<Exclude<ConversationNotifyLevel, "default">, string> = {
  all: "All new messages",
  mentions: "Mentions only",
  nothing: "Nothing",
};

/**
 * The conversation header's read and notification menu: "Mark as read" (also releases a "marked unread" hold),
 * "Mark as unread" from the latest message (CHAT-09), what notifies the member here (default, all new messages,
 * mentions only, nothing) and mute (CHAT-10). Level and mute change pop-ups and the unread badge only: mentions
 * still reach the inbox and the mention badge. Only members have settings, so the menu shows them to members only.
 */
export function ConversationNotifyMenu(p: {
  conversation: { id: string; kind: "channel" | "dm" | "group" };
  /** Newest top-level seq of the live tail. */
  lastSeq: number;
  /** The newest top-level message, for "Mark as unread" (none in an empty conversation). */
  latestMessageId?: string | null;
}) {
  const qc = useQueryClient();
  const id = p.conversation.id;
  const current = useConversationSettings(id);
  const prefs = useNotificationPrefs();
  // DMs and groups notify about everything by default; channels follow the member's default level.
  const defaultLevel = p.conversation.kind === "channel" ? (prefs.data?.defaultLevel ?? "mentions") : "all";
  const change = (patch: UpdateConversationNotificationSettingsRequest) =>
    void updateConversationSettings(qc, id, patch, current).catch((err) => toast.error(errorMessage(err)));
  const Icon = current.muted ? BellOff : current.level === "all" ? BellRing : Bell;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={current.muted ? "Read and notification options (muted)" : "Read and notification options"}
        data-testid="conversation-notify-menu"
        data-muted={current.muted || undefined}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 data-[popup-open]:bg-accent data-[popup-open]:text-foreground"
      >
        <Icon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60" data-testid="conversation-notify-content">
        <DropdownMenuItem
          data-testid="mark-read"
          onClick={() => {
            setReadHold(id, null);
            markConversationRead(qc, id, p.lastSeq, { force: true });
          }}
        >
          <CheckCheck /> Mark as read
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="mark-unread-latest"
          disabled={!p.latestMessageId}
          onClick={() => {
            if (!p.latestMessageId) return;
            void markConversationUnread(qc, id, p.latestMessageId).catch((err) =>
              toast.error(errorMessage(err)),
            );
          }}
        >
          <CircleDot /> Mark as unread
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Notify me about</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            data-testid="notify-level"
            data-value={current.level}
            value={current.level}
            onValueChange={(v: ConversationNotifyLevel) => {
              if (v !== current.level) change({ level: v });
            }}
          >
            <DropdownMenuRadioItem value="default" data-testid="notify-level-default" closeOnClick>
              <span className="flex min-w-0 flex-col">
                <span>Default</span>
                <span className="truncate text-muted-foreground text-xs">{LEVEL_LABEL[defaultLevel]}</span>
              </span>
            </DropdownMenuRadioItem>
            {(["all", "mentions", "nothing"] as const).map((l) => (
              <DropdownMenuRadioItem key={l} value={l} data-testid={`notify-level-${l}`} closeOnClick>
                {LEVEL_LABEL[l]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="mute-conversation"
          data-muted={current.muted || undefined}
          onClick={() => change({ muted: !current.muted })}
        >
          {current.muted ? <Bell /> : <BellOff />}
          <span className="flex min-w-0 flex-col">
            <span>{current.muted ? "Unmute conversation" : "Mute conversation"}</span>
            <span className={cn("text-muted-foreground text-xs", current.muted && "sr-only")}>
              Mentions still reach your inbox
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
