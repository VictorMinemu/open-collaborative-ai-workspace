"use client";

import type { AiChatShare, Permission } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Link2, Link2Off, Lock } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { useCopy } from "@/hooks/use-copy";
import { createAiShare, revokeAiShare, shareUrl, useAiChatShares } from "@/lib/ai-share-queries";
import { errorMessage } from "@/lib/api";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { SharePeople } from "./share-people";

/**
 * Share an AI chat (D-03, D-08, P-13). Two ways, one dialog — a centered dialog on a desktop, a bottom sheet at 390
 * (the dialog primitive does both):
 * - "People and teams" (06-03, 06-12; MULTI-01): give a colleague, a department, a team, a project or the whole
 *   organization access to this very chat, to write ("Can chat") or to read ("Can view"); change a level or remove
 *   access. The dialog says exactly what they will see before anything is shared (`SharePeople`). Owner only
 *   (`ai_chat.share`, decided by the server).
 * - "Read-only link (frozen copy)" (05-13, AICHAT-09): a snapshot link for colleagues signed in to the same
 *   organization, never public. "Create link" freezes the chat as it is now; the chat's existing links are listed.
 */
export function ShareDialog({
  chatId,
  open,
  onOpenChange,
  viewerCan,
}: {
  chatId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The server's decisions for the viewer on this chat (`AiChatDetail.viewerCan`). */
  viewerCan: readonly Permission[];
}) {
  const [resetKey, setResetKey] = useState(0);
  const me = useMe();
  const canShare = viewerCan.includes("ai_chat.share");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setResetKey((k) => k + 1);
      }}
    >
      <DialogContent data-testid="ai-share-dialog" className="gap-5 sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Share this chat</DialogTitle>
          <DialogDescription className="text-[13.5px] leading-snug">
            Bring colleagues into this conversation, or send a read-only copy.
          </DialogDescription>
        </DialogHeader>
        {canShare ? (
          <SharePeople
            key={`people-${resetKey}`}
            chatId={chatId}
            orgName={me.data?.organization.name ?? "your organization"}
          />
        ) : null}
        {canShare ? <Separator /> : null}
        <LinkSection key={`link-${resetKey}`} chatId={chatId} open={open} />
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- read-only link (05-13)

/** The Phase 5 snapshot-link flow, unchanged, under its Phase 6 name. */
function LinkSection({ chatId, open }: { chatId: string; open: boolean }) {
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

  // The link just made, kept current from the list (a revoke updates it there).
  const current = fresh ? (shares.data?.shares.find((s) => s.id === fresh.id) ?? fresh) : null;
  const others = (shares.data?.shares ?? []).filter((s) => s.id !== fresh?.id);

  return (
    <section data-testid="ai-share-links" aria-labelledby="ai-share-links-heading" className="grid gap-3">
      <div className="grid gap-1">
        <h3 id="ai-share-links-heading" className="font-semibold text-[14px] tracking-tight">
          Read-only link (frozen copy)
        </h3>
        <p data-testid="ai-share-audience" className="text-[13px] text-muted-foreground leading-snug">
          Anyone signed in to {orgName} with the link can read this snapshot. It is never public.
        </p>
      </div>

      <div className="flex items-start gap-2.5 rounded-xl border bg-muted/30 px-3.5 py-3 text-[13px] text-muted-foreground leading-snug">
        <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <p>
          The link shows the chat as it is now, read-only. Messages sent later are not included, and the link
          gives no access to the chat itself.
        </p>
      </div>

      {current ? (
        <LinkRow chatId={chatId} share={current} highlight />
      ) : (
        <Button
          variant="outline"
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
          <h4 className="font-medium text-[12.5px] text-muted-foreground">
            {current ? "Earlier links" : "Links to this chat"}
          </h4>
          <ul className="grid gap-1.5">
            {others.map((s) => (
              <li key={s.id}>
                <LinkRow chatId={chatId} share={s} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * One link: its URL (read-only, selectable), when it was taken and how many messages it holds, Copy and Revoke.
 * Revoke asks once, in place; a revoked link stays listed, struck through, with nothing left to copy.
 */
function LinkRow({
  chatId,
  share,
  highlight = false,
}: {
  chatId: string;
  share: AiChatShare;
  highlight?: boolean;
}) {
  const qc = useQueryClient();
  const { copy, copied } = useCopy();
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const url = shareUrl(share.path);
  const revoked = share.revokedAt !== null;

  async function revoke() {
    if (revoking) return;
    setRevoking(true);
    try {
      await revokeAiShare(qc, chatId, share.id);
      setConfirming(false);
      toast.success("Link revoked");
    } catch (err) {
      toast.error("Couldn't revoke the link", { description: errorMessage(err) });
    } finally {
      setRevoking(false);
    }
  }

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
      {confirming && !revoked ? (
        <div
          data-testid="ai-share-revoke-confirmation"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-destructive/[0.06] px-2.5 py-2"
        >
          <p className="min-w-0 flex-1 text-[12.5px] leading-snug">
            Revoke this link? Anyone who opens it will see that it isn't available.
          </p>
          <div className="flex shrink-0 gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={revoking}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              data-testid="ai-share-revoke-confirm"
              onClick={() => void revoke()}
              disabled={revoking}
            >
              {revoking ? <Spinner /> : null}
              Revoke link
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-7 items-center gap-2">
          <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 text-[12px] text-muted-foreground">
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
          {revoked ? null : (
            <button
              type="button"
              data-testid="ai-share-revoke"
              onClick={() => setConfirming(true)}
              className="-mr-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/30"
            >
              <Link2Off className="size-3.5" />
              Revoke
            </button>
          )}
        </div>
      )}
    </div>
  );
}
