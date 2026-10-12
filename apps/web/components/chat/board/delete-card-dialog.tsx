"use client";

import type { BoardCard } from "@ocw/contracts";
import { Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { useDeleteBoardCard } from "@/lib/board-manage-queries";

/**
 * Delete card (07.1-11; P-02, 07.1-UI-SPEC Copywriting › Delete card confirmation): offered to the card's author and
 * to viewers with `message.delete_any`; deleting a card is deleting its root message, so the tile leaves the board
 * for everyone. Focus starts on Cancel (T-07.1-11-04).
 */

/** The confirmation's body copy. */
export function deleteCardBody(title: string): string {
  return `“${title}” is removed from the board for everyone. This can't be undone.`;
}

export function DeleteCardDialog({
  convId,
  card,
  open,
  onOpenChange,
  onDeleted,
}: {
  convId: string;
  card: Pick<BoardCard, "messageId" | "title" | "replyCount"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: (messageId: string) => void;
}) {
  const remove = useDeleteBoardCard(convId);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on open
  useEffect(() => {
    if (!open) return;
    setError(null);
    remove.reset();
  }, [open]);
  if (!card) return null;
  const confirm = () =>
    remove.mutate(card, {
      onSuccess: () => {
        onOpenChange(false);
        onDeleted?.(card.messageId);
      },
      onError: (err) => setError(errorMessage(err)),
    });
  return (
    <Dialog open={open} onOpenChange={(o) => !remove.isPending && onOpenChange(o)}>
      <DialogContent data-testid="delete-card" initialFocus={cancelRef}>
        <DialogHeader>
          <DialogTitle>Delete this card?</DialogTitle>
          <DialogDescription>{deleteCardBody(card.title)}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
          >
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            ref={cancelRef}
            variant="outline"
            className="max-md:h-11"
            disabled={remove.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            className="max-md:h-11"
            disabled={remove.isPending}
            data-testid="delete-card-submit"
            onClick={confirm}
          >
            {remove.isPending ? <Spinner /> : <Trash2 />}
            Delete card
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
