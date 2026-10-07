"use client";

import type { AiChatShare } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, Lock } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useCopy } from "@/hooks/use-copy";
import { createAiShare, shareUrl, useAiChatShares } from "@/lib/ai-share-queries";
import { errorMessage } from "@/lib/api";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * Share an AI chat (05-13, AICHAT-09): a read-only snapshot link for colleagues signed in to the same organization,
 * never public. "Create link" freezes the chat as it is now and shows the link to copy; the chat's existing links are
 * listed below. A centered dialog on a desktop, a bottom sheet at 390 (the dialog primitive does both).
 */
export function ShareDialog({
  chatId,
  open,
  onOpenChange,
}: {
  chatId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const me = useMe();
  const shares = useAiChatShares(chatId, open);
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<AiChatShare | null>(null);
  const orgName = me.data?.organization.name ?? "your organization";

  async function create() {
    if (creating) return;
    setCreating(true);
    try {
      setFresh(await createAiShare(qc, chatId));
    } catch (err) {
      toast.error("Couldn't create the link", { description: errorMessage(err) });
    } finally {
      setCreating(false);
    }
  }

  const others = (shares.data?.shares ?? []).filter((s) => s.id !== fresh?.id);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setFresh(null);
      }}
    >
      <DialogContent data-testid="ai-share-dialog" className="gap-4 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share a snapshot</DialogTitle>
          <DialogDescription data-testid="ai-share-audience" className="text-[13.5px] leading-snug">
            Anyone signed in to {orgName} with the link can read this snapshot. It is never public.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-2.5 rounded-xl border bg-muted/30 px-3.5 py-3 text-[13px] text-muted-foreground leading-snug">
          <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <p>
            The link shows the chat as it is now, read-only. Messages you send later are not included, and the
            chat itself stays private to you.
          </p>
        </div>

        {fresh ? (
          <LinkRow share={fresh} highlight />
        ) : (
          <Button
            data-testid="ai-share-create"
            onClick={() => void create()}
            disabled={creating}
            className="h-10 w-full sm:h-9 sm:w-fit"
          >
            {creating ? <Spinner /> : <Link2 />}
            Create link
          </Button>
        )}

        {others.length > 0 ? (
          <section className="grid gap-1.5" data-testid="ai-share-list">
            <h3 className="font-medium text-[12.5px] text-muted-foreground">Earlier links</h3>
            <ul className="grid gap-1.5">
              {others.map((s) => (
                <li key={s.id}>
                  <LinkRow share={s} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** One link: its URL (read-only, selectable), when it was taken and how many messages it holds, and Copy. */
function LinkRow({ share, highlight = false }: { share: AiChatShare; highlight?: boolean }) {
  const { copy, copied } = useCopy();
  const url = shareUrl(share.path);
  const revoked = share.revokedAt !== null;
  return (
    <div
      data-testid="ai-share-link"
      data-share-id={share.id}
      data-revoked={revoked || undefined}
      className={cn(
        "grid gap-2 rounded-xl border px-3 py-2.5",
        highlight && "border-primary/30 bg-primary/[0.04]",
        revoked && "bg-muted/30",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <input
          readOnly
          value={url}
          aria-label="Share link"
          data-testid="ai-share-url"
          onFocus={(e) => e.currentTarget.select()}
          className={cn(
            "h-9 min-w-0 flex-1 truncate rounded-md border bg-background px-2.5 font-mono text-[12.5px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 dark:bg-input/25",
            revoked && "text-muted-foreground line-through",
          )}
        />
        {revoked ? null : (
          <Button
            variant={highlight ? "default" : "outline"}
            data-testid="ai-share-copy"
            onClick={() =>
              void copy(url).then(
                () => toast.success("Link copied"),
                () => toast.error("Couldn't copy the link"),
              )
            }
            className="h-9 shrink-0"
          >
            {copied === url ? <Check /> : <Copy />}
            {copied === url ? "Copied" : "Copy"}
          </Button>
        )}
      </div>
      <p className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-muted-foreground">
        <span>{when(share.createdAt)}</span>
        <span aria-hidden>·</span>
        <span>
          {share.messageCount} {share.messageCount === 1 ? "message" : "messages"}
        </span>
        {revoked ? (
          <>
            <span aria-hidden>·</span>
            <span data-testid="ai-share-revoked" className="font-medium text-foreground/70">
              Revoked
            </span>
          </>
        ) : null}
      </p>
    </div>
  );
}
