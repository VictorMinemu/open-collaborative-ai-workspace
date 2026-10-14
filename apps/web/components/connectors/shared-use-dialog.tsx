"use client";

import type { ReadersPreview } from "@ocw/contracts";
import { Users } from "lucide-react";
import { useRef } from "react";
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
import { readersLine } from "@/lib/connections-format";

/** 44 px touch targets below `md` (UI-SPEC: every control at 390). */
const TOUCH = "max-md:h-11";

/** What the member is about to allow in a conversation (from `?share=` with `connector=` or `key=`, UI-SPEC R7). */
export interface ShareRequest {
  conversationId: string;
  resourceKind: "connector" | "vault_item";
  resourceId: string;
  resourceName: string;
  /** Connectors only: whether the member has connected it (a key is always set). */
  connected: boolean;
}

/**
 * "Use your {resource} account in {conversation}?" (UI-SPEC § 2 "Shared-use dialog", D-03). The reader count is part of
 * the description, so it is announced with the title, and the Allow button stays disabled until it has loaded: the
 * member knows who will see what bots find before allowing it (T-07.4-13-03). Nothing is recorded on Cancel.
 */
export function SharedUseDialog({
  request,
  conversation,
  preview,
  pending,
  onCancel,
  onConfirm,
  onConnect,
}: {
  request: ShareRequest | null;
  /** How the conversation reads (`#ops`, an AI chat title, "your private chat with Sam Lee"). */
  conversation: string;
  /** Undefined while loading. */
  preview: ReadersPreview | undefined;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onConnect: () => void;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const key = request?.resourceKind === "vault_item";
  const needsConnect = request !== null && !key && !request.connected;
  return (
    <Dialog open={request !== null} onOpenChange={(o) => !o && !pending && onCancel()}>
      <DialogContent data-testid="shared-use-dialog" className="sm:max-w-md" initialFocus={titleRef}>
        {request ? (
          <>
            <DialogHeader>
              <DialogTitle ref={titleRef} tabIndex={-1} className="outline-none">
                {key
                  ? `Use your ${request.resourceName} key in ${conversation}?`
                  : `Use your ${request.resourceName} account in ${conversation}?`}
              </DialogTitle>
            </DialogHeader>
            {/* Outside the header (which leaves room for the close button) so the readers box spans the dialog. */}
            <DialogDescription render={<div />} className="grid gap-3">
              {needsConnect ? (
                <p>Connect {request.resourceName} first, then allow it here.</p>
              ) : (
                <>
                  <p>
                    Bots in {conversation} can act with your account when you ask them, and everyone who can
                    read {conversation} sees what they find.
                  </p>
                  <p
                    className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 font-semibold text-foreground text-sm"
                    data-testid="shared-use-readers"
                    aria-busy={preview === undefined}
                  >
                    {preview ? (
                      <>
                        <Users className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        {readersLine(preview, null)}
                      </>
                    ) : (
                      <>
                        <Spinner className="size-3.5" />
                        <span className="sr-only">Loading who can read it</span>
                      </>
                    )}
                  </p>
                  {preview?.unbounded ? (
                    <p
                      className="text-amber-700 text-xs dark:text-amber-300"
                      data-testid="shared-use-unbounded"
                    >
                      Anyone added later will see new results too.
                    </p>
                  ) : null}
                  <p className="text-xs">You can revoke this any time in Settings › Connections.</p>
                </>
              )}
            </DialogDescription>
            <DialogFooter>
              <Button variant="outline" onClick={onCancel} disabled={pending} className={TOUCH}>
                Cancel
              </Button>
              {needsConnect ? (
                <Button
                  onClick={onConnect}
                  disabled={pending}
                  className={TOUCH}
                  data-testid="shared-use-connect"
                >
                  {pending ? <Spinner /> : null}
                  Connect
                </Button>
              ) : (
                <Button
                  onClick={onConfirm}
                  disabled={pending || preview === undefined}
                  className={TOUCH}
                  data-testid="shared-use-confirm"
                >
                  {pending ? <Spinner /> : null}
                  Allow in {conversation}
                </Button>
              )}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
