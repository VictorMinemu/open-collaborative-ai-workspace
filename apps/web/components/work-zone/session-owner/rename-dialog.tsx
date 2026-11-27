"use client";

import type { Permission, WorkSession } from "@ocw/contracts";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useRenameSession } from "@/lib/workzone-queries";

/**
 * Rename a session (07.13.1.1, D-06, D-14, PD-07): people who control the session give it a title. A typed title is
 * stored as the person's own (`titleSource = 'user'`) and never replaced automatically. The session header's menu and
 * the people view's row menu (plan 07) open this dialog. The hints here only help the typing; the API checks the title
 * and the right, and its refusal is shown as it was worded.
 */

export const RENAME_TITLE_MAX = 200;

export const RENAME_COPY = {
  menuItem: "Rename…",
  title: "Rename session",
  label: "Title",
  save: "Save",
  cancel: "Cancel",
  done: "Session renamed",
  empty: "Enter a title.",
  tooLong: `Use at most ${RENAME_TITLE_MAX} characters.`,
  oneLine: "Use one line.",
} as const;

/** Rename is offered with the API's `work_session.configure` on a session that is not archived. */
export function renameAllowed(viewerCan: readonly Permission[], status: WorkSession["status"]): boolean {
  return status !== "archived" && viewerCan.includes("work_session.configure");
}

/** The client-side hint for a typed title, or null when it can be sent. */
export function renameError(value: string): string | null {
  const title = value.trim();
  if (title.length === 0) return RENAME_COPY.empty;
  if (/[\r\n\u2028\u2029]/.test(title)) return RENAME_COPY.oneLine;
  if (title.length > RENAME_TITLE_MAX) return RENAME_COPY.tooLong;
  return null;
}

/** The form: one field with its label and counter, then Cancel and Save (pure, so it is unit-tested). */
export function RenameForm({
  id,
  value,
  initial,
  pending,
  serverError,
  inputRef,
  onChange,
  onSubmit,
  onCancel,
}: {
  id: string;
  value: string;
  /** The current title: Save stays off until the value differs from it. */
  initial: string;
  pending: boolean;
  /** The API's refusal, as it was worded. */
  serverError: string | null;
  inputRef?: React.Ref<HTMLInputElement>;
  onChange: (value: string) => void;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}) {
  const title = value.trim();
  const unchanged = title === initial.trim();
  // No hint while the title is still the current one (the field opens on it).
  const hint = unchanged ? null : renameError(value);
  const error = hint ?? serverError ?? undefined;
  const count = title.length;
  const canSave = !pending && !unchanged && hint === null;
  return (
    <form
      className="grid gap-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) onSubmit(title);
      }}
    >
      <FormField
        id={id}
        label={RENAME_COPY.label}
        error={error}
        action={
          <span
            aria-hidden
            data-testid="rename-count"
            className={cn(
              "text-[12px] text-muted-foreground tabular-nums",
              count > RENAME_TITLE_MAX && "text-destructive",
            )}
          >
            {count}/{RENAME_TITLE_MAX}
          </span>
        }
      >
        <Input
          id={id}
          ref={inputRef}
          value={value}
          autoComplete="off"
          spellCheck
          disabled={pending}
          aria-invalid={!!error}
          aria-describedby={describedBy(id, error)}
          data-testid="rename-input"
          className="max-md:h-11 max-md:text-base"
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      </FormField>
      <DialogFooter className="flex-col sm:flex-row">
        <Button
          type="button"
          variant="ghost"
          className="max-md:h-11 max-sm:w-full"
          disabled={pending}
          onClick={onCancel}
        >
          {RENAME_COPY.cancel}
        </Button>
        <Button
          type="submit"
          data-testid="rename-save"
          className="max-md:h-11 max-sm:w-full"
          disabled={!canSave}
        >
          {pending ? <Spinner /> : null}
          {RENAME_COPY.save}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The rename dialog: prefilled with the title, the text selected; Enter saves, Esc cancels. `onRenamed` gets the API's
 * answer, so the opener can show the new title before the live stream brings it.
 */
export function RenameSessionDialog({
  session,
  open,
  onOpenChange,
  onRenamed,
}: {
  session: Pick<WorkSession, "id" | "title">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRenamed?: (session: WorkSession) => void;
}) {
  const rename = useRenameSession(session.id);
  const [value, setValue] = useState(session.title);
  const inputRef = useRef<HTMLInputElement>(null);
  // Each opening starts from the current title, with no earlier refusal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens
  useEffect(() => {
    if (!open) return;
    setValue(session.title);
    rename.reset();
  }, [open]);
  const close = () => {
    if (rename.isPending) return;
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent
        data-testid="rename-dialog"
        initialFocus={() => {
          const el = inputRef.current;
          el?.select();
          return el ?? true;
        }}
      >
        <DialogHeader>
          <DialogTitle>{RENAME_COPY.title}</DialogTitle>
        </DialogHeader>
        <RenameForm
          id={`rename-${session.id}`}
          value={value}
          initial={session.title}
          pending={rename.isPending}
          serverError={rename.error ? errorMessage(rename.error) : null}
          inputRef={inputRef}
          onChange={(v) => {
            setValue(v);
            if (rename.error) rename.reset();
          }}
          onCancel={close}
          onSubmit={(title) =>
            rename.mutate(title, {
              onSuccess: (renamed) => {
                onRenamed?.(renamed);
                toast.success(RENAME_COPY.done);
                onOpenChange(false);
              },
            })
          }
        />
      </DialogContent>
    </Dialog>
  );
}
