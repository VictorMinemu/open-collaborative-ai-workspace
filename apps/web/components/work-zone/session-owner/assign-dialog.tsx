"use client";

import {
  ASSIGN_REFUSAL_TEXT,
  type AssignPreview,
  type AssignRefusal,
  type WorkSession,
  type WorkSessionAssign,
} from "@ocw/contracts";
import { TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";
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
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { useAssignPreview, useAssignSession } from "@/lib/workzone-queries";

/**
 * Assign to me (07.13.1.1, D-03, D-04, D-13, D-15, PD-02, PD-14): a member takes over a session that runs on a server.
 * The session header's menu and the people view's row menu (plan 07) open this confirm. Everything it shows comes
 * from the API: whether the item is offered (`detail.assign`), and what the take-over changes (`GET …/assign`). The
 * client never decides who may take a session over (C-01); the POST is refused by the API anyway.
 */

export const ASSIGN_DIALOG_COPY = {
  menuItem: "Assign to me…",
  title: (title: string) => `Take over “${title}”?`,
  becomesYours: "It becomes yours: you control it, it is shared as your session and it moves to your list.",
  history: (previous: string) => `${previous} stays in its history as the previous owner.`,
  previousLosesAccess: (previous: string) => `${previous} will lose access to this session.`,
  othersLoseAccess: (n: number) =>
    n === 1 ? "1 other person will lose access." : `${n} other people will lose access.`,
  cancelledPrompts: (n: number) =>
    n === 1 ? "Their 1 queued prompt will be cancelled." : `Their ${n} queued prompts will be cancelled.`,
  turnRunning: "The running turn finishes first; your next turns run as you.",
  loading: "Checking what changes…",
  confirm: "Assign to me",
  cancel: "Cancel",
  close: "Close",
  done: "This session is yours now",
  /** The owner's name is unknown (they left the organization). */
  formerMember: "a former member",
} as const;

/** The refusals the menu explains in one muted line; the rest (owner, archived, no prompt right) show nothing. */
const EXPLAINED: ReadonlySet<AssignRefusal> = new Set([
  "not_on_server",
  "bot_session",
  "device_not_shared",
  "device_revoked",
]);

export type AssignMenuState = { kind: "item" } | { kind: "reason"; text: string } | { kind: "none" };

/**
 * What the session's menu shows for Assign to me, from the API's per-viewer `assign` only (PD-14): the item when it is
 * allowed; the fixed sentence for a server-side reason the viewer can understand; nothing for the owner (the API checks
 * the server first, so a desktop session's owner would otherwise read "Only sessions on a server…"), an archived
 * session, a viewer who may not prompt or an older API without the field.
 */
export function assignMenuState(
  detail: {
    assign?: WorkSessionAssign | undefined;
    session: Pick<WorkSession, "createdBy" | "status">;
  },
  viewerId: string | null | undefined,
): AssignMenuState {
  const a = detail.assign;
  if (!a || detail.session.status === "archived" || detail.session.createdBy === viewerId) {
    return { kind: "none" };
  }
  if (a.allowed) return { kind: "item" };
  if (a.reason && EXPLAINED.has(a.reason)) return { kind: "reason", text: ASSIGN_REFUSAL_TEXT[a.reason] };
  return { kind: "none" };
}

/** The consequences the preview reports, as fixed sentences (D-13, D-15). */
export function assignWarnings(preview: AssignPreview, previousOwnerName: string): string[] {
  const out: string[] = [];
  if (preview.previousOwnerLosesAccess) out.push(ASSIGN_DIALOG_COPY.previousLosesAccess(previousOwnerName));
  if (preview.othersLosingAccess > 0)
    out.push(ASSIGN_DIALOG_COPY.othersLoseAccess(preview.othersLosingAccess));
  if (preview.cancelledPrompts > 0) out.push(ASSIGN_DIALOG_COPY.cancelledPrompts(preview.cancelledPrompts));
  if (preview.turnRunning) out.push(ASSIGN_DIALOG_COPY.turnRunning);
  return out;
}

const footerClass = "flex-col sm:flex-row";
const buttonClass = "max-md:h-11 max-sm:w-full";

/**
 * The confirm's body and footer for a loaded preview (pure, so every sentence is unit-tested). Allowed: what changes,
 * the warnings, Cancel and Assign to me (primary last, also when stacked on a phone). Refused: the reason and Close.
 */
export function AssignPreviewBody({
  preview,
  previousOwnerName,
  title,
  pending,
  error,
  onConfirm,
  onClose,
}: {
  preview: AssignPreview;
  previousOwnerName: string;
  title: string;
  pending: boolean;
  /** The POST's error, as the API worded it. */
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  // The body replaces the loading state: the safe choice (Cancel, or Close) takes the focus again.
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => safe.current?.focus(), []);
  if (!preview.allowed) {
    return (
      <>
        <DialogDescription data-testid="assign-refused">
          {ASSIGN_REFUSAL_TEXT[preview.reason ?? "not_allowed"]}
        </DialogDescription>
        <DialogFooter className={footerClass}>
          <Button ref={safe} variant="outline" className={buttonClass} onClick={onClose}>
            {ASSIGN_DIALOG_COPY.close}
          </Button>
        </DialogFooter>
      </>
    );
  }
  const warnings = assignWarnings(preview, previousOwnerName);
  return (
    <>
      <DialogDescription render={<div />} className="grid gap-3">
        <p>
          <span className="sr-only">{title}. </span>
          {ASSIGN_DIALOG_COPY.becomesYours} {ASSIGN_DIALOG_COPY.history(previousOwnerName)}
        </p>
        {warnings.length > 0 ? (
          <ul className="grid gap-2 rounded-lg border bg-muted/40 px-3 py-2.5 text-foreground">
            {warnings.map((w) => (
              <li key={w} data-testid="assign-warning" className="flex gap-2 text-[13px] leading-relaxed">
                <TriangleAlert
                  aria-hidden
                  className="mt-[3px] size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                />
                <span>{w}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </DialogDescription>
      {error ? (
        <p role="alert" data-testid="assign-error" className="-mt-2 text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter className={footerClass}>
        <Button ref={safe} variant="ghost" className={buttonClass} disabled={pending} onClick={onClose}>
          {ASSIGN_DIALOG_COPY.cancel}
        </Button>
        <Button data-testid="assign-confirm" className={buttonClass} disabled={pending} onClick={onConfirm}>
          {pending ? <Spinner /> : null}
          {ASSIGN_DIALOG_COPY.confirm}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * The Assign to me confirm (D-03): loads the preview only while open, POSTs once on confirm and closes with a toast.
 * Focus starts on Cancel; below 640 it is the bottom sheet the plain Dialog becomes, with full-width 44 px buttons.
 */
export function AssignSessionDialog({
  session,
  open,
  onOpenChange,
}: {
  session: Pick<WorkSession, "id" | "title" | "createdByName">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const preview = useAssignPreview(session.id, open);
  const assign = useAssignSession(session.id);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const previous = session.createdByName ?? ASSIGN_DIALOG_COPY.formerMember;
  const close = () => {
    if (assign.isPending) return;
    assign.reset();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent data-testid="assign-dialog" initialFocus={cancelRef}>
        <DialogHeader>
          <DialogTitle className="break-words">{ASSIGN_DIALOG_COPY.title(session.title)}</DialogTitle>
        </DialogHeader>
        {preview.data ? (
          <AssignPreviewBody
            preview={preview.data}
            previousOwnerName={previous}
            title={session.title}
            pending={assign.isPending}
            error={assign.error ? errorMessage(assign.error) : null}
            onClose={close}
            onConfirm={() =>
              assign.mutate(undefined, {
                onSuccess: () => {
                  toast.success(ASSIGN_DIALOG_COPY.done);
                  assign.reset();
                  onOpenChange(false);
                },
              })
            }
          />
        ) : preview.isError ? (
          <>
            <p role="alert" data-testid="assign-error" className="text-[13px] text-destructive">
              {errorMessage(preview.error)}
            </p>
            <DialogFooter className={footerClass}>
              <Button ref={cancelRef} variant="outline" className={buttonClass} onClick={close}>
                {ASSIGN_DIALOG_COPY.close}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <p
              data-testid="assign-loading"
              className="flex min-h-16 items-center gap-2 text-muted-foreground text-sm"
            >
              <Spinner /> {ASSIGN_DIALOG_COPY.loading}
            </p>
            <DialogFooter className={footerClass}>
              <Button ref={cancelRef} variant="ghost" className={buttonClass} onClick={close}>
                {ASSIGN_DIALOG_COPY.cancel}
              </Button>
              <Button className={buttonClass} disabled>
                {ASSIGN_DIALOG_COPY.confirm}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
