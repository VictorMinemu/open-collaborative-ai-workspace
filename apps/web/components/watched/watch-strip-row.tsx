"use client";

import type { BoardCard, WatchedRecord } from "@ocw/contracts";
import { CircleAlert, Eye, EyeOff, MoreHorizontal, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  CHECK_COOLDOWN_MS,
  checkNowState,
  useCardWatch,
  useCheckWatch,
  useDeleteWatch,
  useMayWatch,
  wantsAccessCheck,
  watchLine,
  watchState,
} from "@/lib/watched-queries";
import { WatchRecordDialog } from "./watch-record-dialog";

/**
 * The watch row of the 07.1 card strip (07.6-17, UI-SPEC Surface 7b, P-13): row 3 of the strip. Unwatched: "Watch
 * record" for viewers who may watch here (`record.watch` and post rights). Watched: the line (`Watching ERP · SO-10442 ·
 * checked 5 minutes ago`, `Changed in ERP …` in amber, `Paused: … needs to reconnect …`, `Last check failed …`), then
 * Check now (once a minute; "Checked just now" meanwhile) and the ⋯ menu (Edit watch…, Stop watching…) as the API's
 * `viewerCan` allows; viewers who cannot post see the line only. Opening the thread asks for a check (`access`) when
 * the record was last checked more than a minute ago; the API debounces too, and a 429 just means "checked just now".
 */

const TOUCH = "max-md:h-11";
/** How long "Checking…" waits for the `watched_record.updated` frame before giving up quietly. */
const CHECKING_MAX_MS = 20_000;

export function WatchStripRow({
  card,
  canPost,
}: {
  card: Pick<BoardCard, "messageId" | "conversationId">;
  /** Member of an active board (the 07.1 strip's own flag). */
  canPost: boolean;
}) {
  const watch = useCardWatch(card);
  const mayWatch = useMayWatch();
  const [dialog, setDialog] = useState<"new" | "edit" | "stop" | null>(null);

  if (!watch) {
    if (!canPost || !mayWatch) return null;
    return (
      <div className="flex" data-testid="watch-strip-row" data-state="unwatched">
        <Button
          variant="ghost"
          size="sm"
          className={cn("-ml-2", TOUCH)}
          onClick={() => setDialog("new")}
          data-testid="watch-record-button"
        >
          <Eye aria-hidden />
          Watch record
        </Button>
        <WatchRecordDialog
          open={dialog === "new"}
          onOpenChange={(o) => setDialog(o ? "new" : null)}
          card={card}
          mode="new"
        />
      </div>
    );
  }
  return (
    <WatchedRow
      key={watch.id}
      watch={watch}
      card={card}
      canPost={canPost}
      dialog={dialog}
      setDialog={setDialog}
    />
  );
}

function WatchedRow({
  watch,
  card,
  canPost,
  dialog,
  setDialog,
}: {
  watch: WatchedRecord;
  card: Pick<BoardCard, "messageId" | "conversationId">;
  canPost: boolean;
  dialog: "new" | "edit" | "stop" | null;
  setDialog: (d: "new" | "edit" | "stop" | null) => void;
}) {
  const check = useCheckWatch();
  const [now, setNow] = useState(() => Date.now());
  /** The `checkedAt` seen when a check was queued: "Checking…" until it moves (the frame refetched the list). */
  const [checkingFrom, setCheckingFrom] = useState<string | null | undefined>(undefined);
  const [cooldownUntil, setCooldownUntil] = useState(0);

  // Relative times and the Check now cooldown move on their own.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const t = setTimeout(() => setNow(Date.now()), cooldownUntil - Date.now() + 50);
    return () => clearTimeout(t);
  }, [cooldownUntil]);

  // The frame arrived (or the wait is over): stop saying Checking….
  useEffect(() => {
    if (checkingFrom === undefined) return;
    if (watch.checkedAt !== checkingFrom) {
      setCheckingFrom(undefined);
      setNow(Date.now());
      return;
    }
    const t = setTimeout(() => setCheckingFrom(undefined), CHECKING_MAX_MS);
    return () => clearTimeout(t);
  }, [checkingFrom, watch.checkedAt]);

  // Opening the thread asks for a check once (P-13), unless the record was checked within the minute.
  const asked = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opened thread and watch
  useEffect(() => {
    if (asked.current || !wantsAccessCheck(watch)) return;
    asked.current = true;
    const from = watch.checkedAt;
    check.mutate(
      { id: watch.id, source: "access" },
      { onSuccess: (r) => r === "queued" && setCheckingFrom(from) },
    );
  }, [watch.id]);

  const checkNow = () => {
    const from = watch.checkedAt;
    check.mutate(
      { id: watch.id, source: "manual" },
      {
        onSuccess: (r) => {
          setCooldownUntil(Date.now() + CHECK_COOLDOWN_MS);
          setNow(Date.now());
          if (r === "queued") setCheckingFrom(from);
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  };

  const state = watchState(watch, now);
  const line = watchLine(watch, now);
  const checking = checkingFrom !== undefined || (watch.checkedAt === null && state === "watching");
  const button = checkNowState({
    now,
    cooldownUntil,
    busy: check.isPending || checkingFrom !== undefined,
  });
  const canCheck = canPost && watch.viewerCan.includes("check");
  const canEdit = canPost && watch.viewerCan.includes("edit");
  const canStop = canPost && watch.viewerCan.includes("unlink");
  const Icon = state === "paused" ? EyeOff : state === "failed" ? CircleAlert : Eye;

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
      data-testid="watch-strip-row"
      data-state={state}
    >
      <p
        className="flex min-w-0 flex-1 basis-72 items-center gap-1.5 text-muted-foreground"
        data-testid="watch-line"
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 break-words">
          {line.lead ? (
            <span className="font-semibold text-amber-800 dark:text-amber-300">{line.lead}</span>
          ) : null}
          {checking && state === "watching" ? (
            <>
              {`Watching ${watch.connector.name} · ${watch.externalRef} · `}
              <span className="inline-flex items-center gap-1 align-middle">
                <Spinner className="size-3" />
                Checking…
              </span>
            </>
          ) : (
            line.rest
          )}
        </span>
      </p>
      {canCheck || canEdit || canStop ? (
        <div className="flex shrink-0 items-center gap-1">
          {canCheck ? (
            <Button
              variant="ghost"
              size="sm"
              className={cn("text-xs", TOUCH)}
              disabled={button.disabled}
              onClick={checkNow}
              data-testid="watch-check-now"
            >
              {check.isPending ? <Spinner className="size-3" /> : <RefreshCw aria-hidden />}
              {button.label}
            </Button>
          ) : null}
          {canEdit || canStop ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Watch actions"
                data-testid="watch-strip-menu"
                className={cn(
                  buttonVariants({ variant: "ghost", size: "icon-xs" }),
                  "text-muted-foreground data-popup-open:bg-accent max-md:size-11",
                )}
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {canEdit ? (
                  <DropdownMenuItem className="max-md:min-h-11" onClick={() => setDialog("edit")}>
                    <Pencil />
                    Edit watch…
                  </DropdownMenuItem>
                ) : null}
                {canStop ? (
                  <DropdownMenuItem
                    className="max-md:min-h-11"
                    variant="destructive"
                    onClick={() => setDialog("stop")}
                  >
                    <Trash2 />
                    Stop watching…
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}
      {canEdit ? (
        <WatchRecordDialog
          open={dialog === "edit"}
          onOpenChange={(o) => setDialog(o ? "edit" : null)}
          card={card}
          mode="edit"
          watch={watch}
          onStopWatching={canStop ? () => setDialog("stop") : undefined}
        />
      ) : null}
      {canStop ? (
        <StopWatchingDialog
          watch={watch}
          open={dialog === "stop"}
          onOpenChange={(o) => setDialog(o ? "stop" : null)}
        />
      ) : null}
    </div>
  );
}

/** "Stop watching SO-10442?" (UI-SPEC 7b): checks stop; past change reports stay in the thread. Focus on Cancel. */
export function StopWatchingDialog({
  watch,
  open,
  onOpenChange,
}: {
  watch: Pick<WatchedRecord, "id" | "externalRef" | "conversationId">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteWatch(watch.conversationId);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = () =>
    remove.mutate(watch.id, {
      onSuccess: () => {
        toast.success(`Stopped watching ${watch.externalRef}.`);
        onOpenChange(false);
      },
      onError: (err) => setError(errorMessage(err)),
    });
  return (
    <Dialog open={open} onOpenChange={(o) => !remove.isPending && onOpenChange(o)}>
      <DialogContent data-testid="watch-stop-dialog" initialFocus={cancelRef}>
        <DialogHeader>
          <DialogTitle>Stop watching {watch.externalRef}?</DialogTitle>
          <DialogDescription>
            OCW stops checking it. Past change reports stay in the thread.
          </DialogDescription>
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
          <Button ref={cancelRef} variant="outline" className={TOUCH} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" className={TOUCH} disabled={remove.isPending} onClick={confirm}>
            {remove.isPending ? <Spinner className="size-3.5" /> : null}
            Stop watching
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
