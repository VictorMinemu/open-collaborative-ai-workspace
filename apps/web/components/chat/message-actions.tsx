"use client";

import type { Message } from "@ocw/contracts";
import { MessageSquareReply, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The one place message actions live (P-09): a hover toolbar on pointer devices and a long-press bottom sheet on
 * touch. Later plans (reactions, pins, saves, permalinks) add their actions to `MessageActionSet` and both
 * surfaces render them. Absent handlers mean "not offered": the caller decides what this viewer may do.
 */
export interface MessageActionSet {
  onReply?: (() => void) | undefined;
  onEdit?: (() => void) | undefined;
  /** Own messages, or anyone's when the channel's `viewerCan` has `message.delete_any` (never in DMs). */
  onDelete?: (() => void) | undefined;
}

export const hasMessageActions = (a: MessageActionSet) => !!(a.onReply || a.onEdit || a.onDelete);

const toolbarButton =
  "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 data-[popup-open]:bg-accent data-[popup-open]:text-foreground";

/** Hover toolbar (top-right of a message row). Stays visible while its menu is open. */
export function MessageActions({ actions }: { actions: MessageActionSet }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const more: Array<{ key: string; node: ReactNode }> = [];
  if (actions.onEdit) {
    more.push({
      key: "edit",
      node: (
        <DropdownMenuItem key="edit" onClick={actions.onEdit}>
          <Pencil /> Edit message
        </DropdownMenuItem>
      ),
    });
  }
  if (actions.onDelete) {
    more.push({
      key: "delete",
      node: (
        <DropdownMenuItem
          key="delete"
          variant="destructive"
          onClick={actions.onDelete}
          data-testid="delete-message"
        >
          <Trash2 /> Delete message
        </DropdownMenuItem>
      ),
    });
  }
  return (
    <div
      data-testid="message-toolbar"
      className={cn(
        "pointer-events-none absolute -top-3.5 right-4 z-10 flex gap-px rounded-lg border bg-background p-0.5 opacity-0 shadow-sm transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 sm:right-5",
        menuOpen && "pointer-events-auto opacity-100",
      )}
    >
      {actions.onReply ? (
        <Tooltip content="Reply in thread">
          <button
            type="button"
            aria-label="Reply in thread"
            data-testid="reply-in-thread"
            onClick={actions.onReply}
            className={toolbarButton}
          >
            <MessageSquareReply className="size-4" />
          </button>
        </Tooltip>
      ) : null}
      {actions.onEdit ? (
        <Tooltip content="Edit message">
          <button
            type="button"
            aria-label="Edit message"
            data-testid="edit-message"
            onClick={actions.onEdit}
            className={toolbarButton}
          >
            <Pencil className="size-[15px]" />
          </button>
        </Tooltip>
      ) : null}
      {more.length > 0 ? (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger aria-label="More actions" data-testid="message-more" className={toolbarButton}>
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" data-testid="message-menu">
            {more.map((m) => m.node)}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

function SheetRow({
  icon,
  label,
  testId,
  onClick,
  destructive,
}: {
  icon: ReactNode;
  label: string;
  testId: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "flex min-h-12 w-full items-center gap-3.5 rounded-xl px-3.5 text-left font-medium text-[15px] outline-none transition-colors active:bg-accent focus-visible:bg-accent [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        destructive && "text-destructive [&_svg]:text-destructive",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/** Touch: the same actions as large rows in a bottom sheet, opened by a long press on the message. */
export function MessageActionSheet({
  message,
  actions,
  open,
  onOpenChange,
}: {
  message: Message;
  actions: MessageActionSet;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Close first, then act, so the sheet's focus return never fights the action (e.g. the inline editor).
  const run = (fn: (() => void) | undefined) => () => {
    onOpenChange(false);
    if (fn) window.setTimeout(fn, 0);
  };
  const preview = message.body.replace(/\s+/g, " ").trim();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showClose={false}
        data-testid="message-sheet"
        className="h-auto max-h-[85dvh] gap-1 px-3 pt-2 pb-[max(env(safe-area-inset-bottom),14px)]"
      >
        <div aria-hidden className="mx-auto mb-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/25" />
        <div className="px-3.5 pb-2">
          <SheetTitle className="font-semibold text-sm">
            {message.author?.displayName ?? "Message"}
          </SheetTitle>
          <SheetDescription className="mt-0.5 line-clamp-2 text-muted-foreground text-sm">
            {preview || "Attachment"}
          </SheetDescription>
        </div>
        <div className="grid gap-0.5 border-t pt-2">
          {actions.onReply ? (
            <SheetRow
              icon={<MessageSquareReply />}
              label="Reply in thread"
              testId="reply-in-thread"
              onClick={run(actions.onReply)}
            />
          ) : null}
          {actions.onEdit ? (
            <SheetRow
              icon={<Pencil />}
              label="Edit message"
              testId="edit-message"
              onClick={run(actions.onEdit)}
            />
          ) : null}
          {actions.onDelete ? (
            <SheetRow
              icon={<Trash2 />}
              label="Delete message"
              testId="delete-message"
              onClick={run(actions.onDelete)}
              destructive
            />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Confirms a delete with a preview of the message; `moderated` = someone else's message (admin). */
export function DeleteMessageDialog({
  message,
  moderated,
  open,
  onOpenChange,
  onConfirm,
}: {
  message: Message;
  moderated: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const preview = message.body.trim();
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent data-testid="confirm-delete">
        <DialogHeader>
          <DialogTitle>Delete message?</DialogTitle>
          <DialogDescription>
            {moderated
              ? `This removes ${message.author?.displayName ?? "this person"}'s message for everyone. The deletion is recorded in the audit log.`
              : "This removes the message for everyone in the conversation. It can't be undone."}
          </DialogDescription>
        </DialogHeader>
        <blockquote className="line-clamp-4 whitespace-pre-wrap break-words rounded-lg border bg-muted/40 px-3.5 py-2.5 text-[14px] text-foreground/90">
          {preview || "Attachment"}
        </blockquote>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            data-testid="confirm-delete-submit"
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner /> : <Trash2 />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
