"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Bell, CheckCheck, CircleDot } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { errorMessage } from "@/lib/api";
import { markConversationRead, markConversationUnread, setReadHold } from "@/lib/chat-queries";

/**
 * The conversation header's read-state menu (CHAT-09): "Mark as read" (also releases a "marked unread" hold) and
 * "Mark as unread" from the latest message. Plan 11 adds notification levels and mute to the same menu.
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Read and notification options"
        data-testid="conversation-notify-menu"
        className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 data-[popup-open]:bg-accent data-[popup-open]:text-foreground"
      >
        <Bell className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
