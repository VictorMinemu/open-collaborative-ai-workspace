"use client";

import type { PinnedMessage } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Pin, PinOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useIsDesktop } from "@/hooks/use-media-query";
import { errorMessage } from "@/lib/api";
import { applyPinUpdate, unpinMessage, usePins } from "@/lib/chat-queries";
import { permalinkPath } from "@/lib/permalink";
import { useMe } from "@/lib/queries";
import { cn, relativeTime } from "@/lib/utils";
import { MessageCard } from "./message-card";

type Conversation = { id: string; kind: "channel" | "dm" | "group"; name: string | null };

/** The header button: "Pinned N" (count only on narrow screens); nothing while there are no pins. */
export function PinnedButton({ count, onClick }: { count: number; onClick(): void }) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="pinned-button"
      aria-label={`${count} pinned ${count === 1 ? "message" : "messages"}`}
      className="flex h-8 items-center gap-1.5 rounded-lg border px-2 text-muted-foreground text-sm outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 sm:px-2.5"
    >
      <Pin className="size-3.5 -rotate-45" />
      <span className="hidden sm:inline">Pinned</span>
      <span className="font-medium tabular-nums" data-testid="pinned-count">
        {count}
      </span>
    </button>
  );
}

function PinRow({
  pin,
  conversation,
  canUnpin,
  onJump,
}: {
  pin: PinnedMessage;
  conversation: Conversation;
  canUnpin: boolean;
  onJump(): void;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const unpin = async () => {
    setBusy(true);
    try {
      await unpinMessage(conversation.id, pin.message.id);
      applyPinUpdate(qc, { conversationId: conversation.id, messageId: pin.message.id, pinned: false });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <MessageCard
      testId="pinned-item"
      message={pin.message}
      context={
        <span className="inline-flex items-center gap-1">
          <Pin className="size-3 -rotate-45" />
          Pinned by {pin.pinnedBy.displayName} · {relativeTime(pin.pinnedAt)}
        </span>
      }
      actions={
        <>
          {canUnpin ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void unpin()}
              data-testid="pinned-unpin"
            >
              <PinOff /> Unpin
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onClick={onJump} data-testid="pinned-jump">
            Jump <ArrowUpRight />
          </Button>
        </>
      }
    />
  );
}

/**
 * The pinned messages of a conversation (CHAT-13): a right sheet on desktop, a bottom sheet on phones. Each pin
 * jumps to its message through the permalink path (Plan 03) and can be unpinned by its pinner, a channel moderator
 * (`canModerate`: owner or admin) or any participant of a direct conversation.
 */
export function PinnedSheet({
  conversation,
  open,
  onOpenChange,
  canModerate = false,
}: {
  conversation: Conversation;
  open: boolean;
  onOpenChange(o: boolean): void;
  canModerate?: boolean;
}) {
  const isDesktop = useIsDesktop();
  const router = useRouter();
  const me = useMe({ enabled: false });
  const pins = usePins(conversation.id, open);
  const list = pins.data?.pins ?? [];
  const meId = me.data?.user.id ?? "";
  const anyone = conversation.kind !== "channel" || canModerate;
  const where = conversation.kind === "channel" ? `#${conversation.name ?? "channel"}` : "this conversation";
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isDesktop ? "right" : "bottom"}
        data-testid="pinned-sheet"
        className={cn("gap-0 p-0", isDesktop ? "w-[26rem]" : "h-[80dvh]")}
      >
        {isDesktop ? null : (
          <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/25" />
        )}
        <div className="border-b px-4 pt-3.5 pb-3 pr-12">
          <SheetTitle className="flex items-center gap-2">
            <Pin className="size-4 -rotate-45 text-muted-foreground" />
            Pinned messages
            {list.length > 0 ? (
              <span className="rounded-full bg-muted px-1.5 font-medium text-muted-foreground text-xs tabular-nums">
                {list.length}
              </span>
            ) : null}
          </SheetTitle>
          <SheetDescription className="mt-0.5 text-xs">Shared with everyone in {where}.</SheetDescription>
        </div>
        <div className="scrollbar-thin grid min-h-0 flex-1 content-start gap-2.5 overflow-y-auto p-3 pb-[max(env(safe-area-inset-bottom),12px)]">
          {pins.isPending ? (
            [0, 1].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)
          ) : pins.isError ? (
            <p className="px-2 py-8 text-center text-muted-foreground text-sm">{errorMessage(pins.error)}</p>
          ) : list.length === 0 ? (
            <div className="px-4 py-12 text-center" data-testid="pinned-empty">
              <Pin className="mx-auto mb-3 size-6 -rotate-45 text-muted-foreground/60" />
              <p className="font-medium text-sm">Nothing pinned yet</p>
              <p className="mt-1 text-muted-foreground text-xs">
                Pin a message from its actions to keep it here for everyone.
              </p>
            </div>
          ) : (
            list.map((p) => (
              <PinRow
                key={p.message.id}
                pin={p}
                conversation={conversation}
                canUnpin={anyone || (p.pinnedBy.kind === "user" && p.pinnedBy.id === meId)}
                onJump={() => {
                  onOpenChange(false);
                  router.push(permalinkPath(conversation, p.message.id, p.message.threadId));
                }}
              />
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
