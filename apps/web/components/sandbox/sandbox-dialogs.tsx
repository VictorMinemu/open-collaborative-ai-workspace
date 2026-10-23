"use client";

import { RotateCw, Square, Trash2 } from "lucide-react";
import { type ReactNode, useRef } from "react";
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

/**
 * The Sandbox tab's confirmations (07.8-15, UI-SPEC §3.4, §3.5): delete a file or a folder, stop and restart the
 * sandbox, and leave while files are uploading. Destructive ones open with focus on Cancel; a refusal from the API shows
 * its sentence inline, and the dialog stays open.
 */

const TOUCH = "max-md:h-11";

function Confirm({
  open,
  testId,
  icon,
  tone,
  title,
  body,
  confirm,
  confirmTestId,
  pending,
  error,
  focusCancel,
  onCancel,
  onConfirm,
  cancelLabel = "Cancel",
}: {
  open: boolean;
  testId: string;
  icon: ReactNode;
  tone: "destructive" | "primary";
  title: string;
  body?: string;
  confirm: string;
  confirmTestId: string;
  pending?: boolean;
  error?: string | null;
  focusCancel: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  cancelLabel?: string;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !pending && onCancel()}>
      <DialogContent data-testid={testId} initialFocus={focusCancel ? cancelRef : undefined}>
        <DialogHeader>
          <span
            aria-hidden
            className={
              tone === "destructive"
                ? "mb-1 flex size-10 items-center justify-center rounded-xl border border-destructive/25 bg-destructive/10 text-destructive shadow-xs"
                : "mb-1 flex size-10 items-center justify-center rounded-xl border bg-muted text-muted-foreground shadow-xs"
            }
          >
            {icon}
          </span>
          <DialogTitle className="break-words">{title}</DialogTitle>
          {body ? <DialogDescription>{body}</DialogDescription> : null}
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-destructive text-sm" data-testid={`${testId}-error`}>
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button ref={cancelRef} variant="outline" onClick={onCancel} disabled={pending} className={TOUCH}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "destructive" ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={pending}
            className={TOUCH}
            data-testid={confirmTestId}
          >
            {pending ? <Spinner /> : null}
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface DeleteTarget {
  path: string;
  name: string;
  folder: boolean;
  /** Files under a folder (counted before asking). */
  files?: number;
}

export function DeleteDialog({
  target,
  bot,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  target: DeleteTarget | null;
  bot: string;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const n = target?.files ?? 0;
  return (
    <Confirm
      open={target !== null}
      testId="sandbox-delete-dialog"
      icon={<Trash2 className="size-5" strokeWidth={1.75} />}
      tone="destructive"
      title={
        target
          ? target.folder
            ? `Delete ${target.name} and everything in it?`
            : `Delete ${target.name}?`
          : ""
      }
      body={
        target?.folder
          ? `${n === 1 ? "1 file is" : `${n} files are`} removed from ${bot}'s sandbox. This can't be undone.`
          : `It's removed from ${bot}'s sandbox. This can't be undone.`
      }
      confirm={target?.folder ? "Delete folder" : "Delete"}
      confirmTestId="sandbox-delete-confirm"
      pending={pending}
      error={error}
      focusCancel
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export function LifecycleDialog({
  action,
  bot,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  action: "stop" | "restart" | null;
  bot: string;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const stop = action === "stop";
  return (
    <Confirm
      open={action !== null}
      testId={stop ? "sandbox-stop-dialog" : "sandbox-restart-dialog"}
      icon={
        stop ? (
          <Square className="size-5" strokeWidth={1.75} />
        ) : (
          <RotateCw className="size-5" strokeWidth={1.75} />
        )
      }
      tone={stop ? "destructive" : "primary"}
      title={stop ? `Stop ${bot}'s sandbox?` : `Restart ${bot}'s sandbox?`}
      body={
        stop
          ? `Running commands end now. Files in /workspace stay. It starts again the next time ${bot} needs it.`
          : "Running commands end and the sandbox starts fresh. Files in /workspace stay."
      }
      confirm={stop ? "Stop sandbox" : "Restart"}
      confirmTestId={stop ? "sandbox-stop-confirm" : "sandbox-restart-confirm"}
      pending={pending}
      error={error}
      // Restart is not destructive to files, but it ends running commands: Cancel first for both (UI-SPEC Focus).
      focusCancel
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/** Leaving (closing the dialog, Escape) while files are still uploading. */
export function LeaveUploadDialog({
  open,
  onStay,
  onLeave,
}: {
  open: boolean;
  onStay: () => void;
  onLeave: () => void;
}) {
  return (
    <Confirm
      open={open}
      testId="sandbox-leave-upload-dialog"
      icon={<Square className="size-5" strokeWidth={1.75} />}
      tone="destructive"
      title="Leave while uploading?"
      confirm="Leave"
      confirmTestId="sandbox-leave-upload-confirm"
      cancelLabel="Stay"
      focusCancel
      onCancel={onStay}
      onConfirm={onLeave}
    />
  );
}
