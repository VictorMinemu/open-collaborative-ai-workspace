"use client";

import type { MemberDetail, PasswordResetLink } from "@ocw/contracts";
import { Check, Copy, KeyRound, RefreshCw, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useCopy } from "@/hooks/use-copy";
import { errorMessage } from "@/lib/api";
import { useCreateResetLink } from "@/lib/member-queries";

function hoursUntil(iso: string): number {
  return Math.max(1, Math.round((new Date(iso).getTime() - Date.now()) / 3_600_000));
}

/**
 * Admin-issued one-time password reset link (02-09). Opening the dialog creates a link; the link lives only in
 * this component's state and is dropped on close, so reopening issues a new one (and the server invalidates
 * the previous). It never reaches the query cache, the URL or a log (T-02-12-02).
 */
export function ResetLinkDialog({
  member,
  open,
  onOpenChange,
}: {
  member: MemberDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateResetLink();
  const { reset, mutate } = create;
  const { copy, copied } = useCopy();
  const [result, setResult] = useState<PasswordResetLink | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const started = useRef(false);
  // Bumped on every close: a link that arrives after the dialog closed is never shown.
  const generation = useRef(0);

  const issue = () => {
    const gen = generation.current;
    setFailed(null);
    mutate(member.userId, {
      onSuccess: (link) => {
        if (gen === generation.current) setResult(link);
        reset(); // drop the link from the mutation state; only this component keeps it
      },
      onError: (err) => {
        if (gen === generation.current) setFailed(errorMessage(err));
      },
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: issue once per opening, not on every render
  useEffect(() => {
    if (open && !started.current) {
      started.current = true;
      issue();
    }
    if (!open) {
      started.current = false;
      generation.current += 1;
      setResult(null);
      setFailed(null);
      reset();
    }
  }, [open]);

  async function onCopy(link: string) {
    try {
      await copy(link);
      toast.success("Reset link copied");
    } catch {
      toast.error("Could not copy. Select the link and copy it manually.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="reset-link-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <span className="mb-1 flex size-10 items-center justify-center rounded-xl border bg-card text-primary shadow-xs">
            <KeyRound className="size-5" strokeWidth={1.75} />
          </span>
          <DialogTitle>Password reset link for {member.displayName}</DialogTitle>
          <DialogDescription>
            Send it to them directly. It works once, and creating a new link cancels this one.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="grid gap-3">
            <div className="flex gap-2">
              <Input
                readOnly
                value={result.link}
                data-testid="reset-link"
                aria-label="Password reset link"
                onFocus={(e) => e.currentTarget.select()}
                className="h-10 font-mono text-xs sm:h-9"
              />
              <Button
                variant="outline"
                onClick={() => onCopy(result.link)}
                data-testid="copy-reset-link"
                className="h-10 shrink-0 sm:h-9"
              >
                {copied === result.link ? <Check className="text-success" /> : <Copy />}
                {copied === result.link ? "Copied" : "Copy"}
              </Button>
            </div>
            <p
              className="text-muted-foreground text-xs"
              title={new Date(result.expiresAt).toLocaleString()}
              data-testid="reset-link-expiry"
            >
              Expires in {hoursUntil(result.expiresAt)} hours.
            </p>
            <div className="flex gap-2.5 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              <p>
                Anyone with this link can set a new password for{" "}
                <span className="font-medium">{member.displayName}</span>. Share it privately.
              </p>
            </div>
          </div>
        ) : failed ? (
          <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-sm">
            <p className="font-medium text-destructive">Could not create the link</p>
            <p className="mt-0.5 text-muted-foreground">{failed}</p>
          </div>
        ) : (
          <div className="grid gap-3" aria-busy>
            <Skeleton className="h-10 sm:h-9" />
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-14" />
          </div>
        )}

        <DialogFooter>
          {failed ? (
            <Button variant="outline" onClick={issue} disabled={create.isPending} className="h-10 sm:h-9">
              <RefreshCw /> Try again
            </Button>
          ) : null}
          <Button onClick={() => onOpenChange(false)} className="h-10 sm:h-9" data-testid="reset-link-done">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
