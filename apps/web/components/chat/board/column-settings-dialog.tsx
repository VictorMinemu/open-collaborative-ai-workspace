"use client";

import {
  BOARD_COLUMN_NAME_MAX,
  BOARD_MAX_COLUMNS,
  type BoardColumn,
  type BoardColumnCategory,
  type BoardSnapshot,
  type WaitingOn,
} from "@ocw/contracts";
import { ArrowLeft, ArrowRight, Check, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { type FormEvent, type Ref, useEffect, useRef, useState } from "react";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  COLUMN_COPY,
  type ColumnChange,
  columnErrorMessage,
  columnNameError,
  useCreateBoardColumn,
  useDeleteBoardColumn,
  useUpdateBoardColumn,
} from "@/lib/board-manage-queries";
import { cn } from "@/lib/utils";
import { CATEGORY, CATEGORY_MEANING, CategoryIcon } from "./column-header";
import { WaitingDot } from "./waiting-on-badge";

/**
 * Column settings (07.1-11; BOARD-01, D-07, P-09, 07.1-UI-SPEC "Column settings dialog", Interaction Contract ›
 * Column settings, Copywriting › Column settings): the add / edit dialog (Name → Category → When a card enters), the
 * column `⋯` menu (Edit column…, Move left, Move right, Delete column…) and the delete confirmation, which asks where
 * a non-empty column's cards go. Offered only to viewers whose channel `viewerCan` includes `channel.update` (the
 * board view decides); the API re-decides every request. Column names are untrusted text and render as React text.
 */

/** "When a card enters": the column's default waiting state, five choices in UI-SPEC order; null = "Keep as is". */
export const COLUMN_WAITING_CHOICES: ReadonlyArray<{ value: WaitingOn | null; label: string }> = [
  { value: null, label: "Keep as is" },
  { value: "none", label: "Waiting on nobody" },
  { value: "us", label: "Waiting on us" },
  { value: "customer", label: "Waiting on customer" },
  { value: "both", label: "Waiting on both" },
];

const KEEP = "keep";
const CATEGORIES: readonly BoardColumnCategory[] = ["backlog", "started", "done", "cancelled"];

/** Dialogs with fields are full screen below 640 px (07.1-UI-SPEC Board channel at 390 › Dialogs). */
const FULL_SCREEN =
  "max-sm:inset-0 max-sm:max-h-dvh max-sm:rounded-none max-sm:pb-[max(env(safe-area-inset-bottom),20px)]";

// ---------------------------------------------------------------- add / edit

export function ColumnSettingsDialog({
  convId,
  snapshot,
  column,
  open,
  onOpenChange,
}: {
  convId: string;
  snapshot: Pick<BoardSnapshot, "columns">;
  /** The column being edited; null = Add column (appended at the end). */
  column: BoardColumn | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const create = useCreateBoardColumn(convId);
  const update = useUpdateBoardColumn(convId);
  const pending = create.isPending || update.isPending;
  const [name, setName] = useState("");
  const [category, setCategory] = useState<BoardColumnCategory>("started");
  const [waiting, setWaiting] = useState<WaitingOn | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // A fresh form each time it opens: the column's values, or an empty Started column.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on open
  useEffect(() => {
    if (!open) return;
    setName(column?.name ?? "");
    setCategory(column?.category ?? "started");
    setWaiting(column?.defaultWaitingOn ?? null);
    setNameError(null);
    setFormError(null);
    create.reset();
    update.reset();
  }, [open, column?.id]);

  const changes: Omit<ColumnChange, "columnId"> = {};
  if (column) {
    if (name.trim() !== column.name) changes.name = name.trim();
    if (category !== column.category) changes.category = category;
    if (waiting !== column.defaultWaitingOn) changes.defaultWaitingOn = waiting;
  }
  const unchanged = column !== null && Object.keys(changes).length === 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const err = columnNameError(name, snapshot.columns, column?.id ?? null);
    setNameError(err);
    if (err) return;
    if (!column && snapshot.columns.length >= BOARD_MAX_COLUMNS) {
      setFormError(COLUMN_COPY.limit);
      return;
    }
    const n = name.trim();
    const done = { onSuccess: () => onOpenChange(false), onError: (x: unknown) => fail(x, n) };
    if (column) {
      if (unchanged) return onOpenChange(false);
      update.mutate({ columnId: column.id, ...changes }, done);
    } else {
      create.mutate({ name: n, category, defaultWaitingOn: waiting }, done);
    }
  };
  const fail = (err: unknown, n: string) => {
    const message = columnErrorMessage(err, n);
    if (message === COLUMN_COPY.exists(n)) setNameError(message);
    else setFormError(message);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent data-testid="column-settings" className={cn("sm:max-w-md", FULL_SCREEN)}>
        <DialogHeader>
          <DialogTitle>{column ? "Edit column" : "Add column"}</DialogTitle>
          <DialogDescription className="sr-only">
            {column ? `Rename or recategorise ${column.name}.` : "A new column at the end of the board."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-1 flex-col gap-5" noValidate>
          {formError ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
            >
              {formError}
            </p>
          ) : null}
          <FormField id="column-name" label="Name" error={nameError ?? undefined}>
            <Input
              id="column-name"
              autoFocus
              autoComplete="off"
              placeholder="e.g. Waiting for parts"
              value={name}
              maxLength={BOARD_COLUMN_NAME_MAX + 1}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
                setFormError(null);
              }}
              aria-invalid={!!nameError}
              aria-describedby={describedBy("column-name", nameError ?? undefined)}
            />
          </FormField>
          <fieldset className="grid gap-2">
            <legend className="mb-2 font-medium text-sm">Category</legend>
            {CATEGORIES.map((c) => {
              const selected = category === c;
              return (
                <label
                  key={c}
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition-colors has-focus-visible:ring-[3px] has-focus-visible:ring-ring/40",
                    selected ? "border-foreground/25 bg-muted/60 dark:bg-white/[0.04]" : "hover:bg-accent/50",
                  )}
                >
                  <input
                    type="radio"
                    name="column-category"
                    value={c}
                    checked={selected}
                    onChange={() => setCategory(c)}
                    className="sr-only"
                    data-testid={`column-category-${c}`}
                  />
                  <CategoryIcon category={c} decorative />
                  <span className="grid min-w-0 flex-1">
                    <span className="font-semibold text-sm">{CATEGORY[c].label}</span>
                    <span className="text-muted-foreground text-xs">{CATEGORY_MEANING[c]}</span>
                  </span>
                  <Check
                    aria-hidden
                    className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")}
                  />
                </label>
              );
            })}
          </fieldset>
          <FormField id="column-waiting" label="When a card enters">
            <Select
              items={COLUMN_WAITING_CHOICES.map((o) => ({ value: o.value ?? KEEP, label: o.label }))}
              value={waiting ?? KEEP}
              onValueChange={(v) => setWaiting(!v || v === KEEP ? null : (v as WaitingOn))}
            >
              <SelectTrigger id="column-waiting" data-testid="column-waiting" />
              <SelectContent>
                {COLUMN_WAITING_CHOICES.map((o) => (
                  <SelectItem key={o.value ?? KEEP} value={o.value ?? KEEP}>
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="flex size-4 items-center justify-center">
                        {o.value ? <WaitingDot state={o.value} /> : null}
                      </span>
                      {o.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <DialogFooter className="max-sm:mt-auto">
            <Button
              type="button"
              variant="outline"
              className="max-md:h-11"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="max-md:h-11"
              disabled={pending || unchanged}
              data-testid="column-settings-submit"
            >
              {pending ? <Spinner /> : null}
              {column ? "Save column" : "Add column"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- the column ⋯ menu

/** Why the last column's Delete column… is disabled (shown as the item's description line). */
export const LAST_COLUMN_REASON = "A board needs at least one column";

export interface ColumnMenuModel {
  moveLeft: { disabled: boolean };
  moveRight: { disabled: boolean };
  /** The last column cannot be deleted; `reason` is shown as the item's description line. */
  deleteColumn: { disabled: boolean; reason: string | null };
}

export function columnMenuModel(columns: ReadonlyArray<{ id: string }>, columnId: string): ColumnMenuModel {
  const at = columns.findIndex((c) => c.id === columnId);
  const last = columns.length <= 1;
  return {
    moveLeft: { disabled: at <= 0 },
    moveRight: { disabled: at === -1 || at === columns.length - 1 },
    deleteColumn: { disabled: last, reason: last ? LAST_COLUMN_REASON : null },
  };
}

/** Items are 44 px tall below 768 px. */
const ITEM = "max-md:min-h-11";

export function ColumnMenu({
  column,
  columns,
  onEdit,
  onMove,
  onDelete,
  className,
}: {
  column: Pick<BoardColumn, "id" | "name">;
  columns: ReadonlyArray<{ id: string }>;
  onEdit: () => void;
  onMove: (direction: "left" | "right") => void;
  onDelete: () => void;
  className?: string;
}) {
  const m = columnMenuModel(columns, column.id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${column.name} column actions`}
        data-testid="column-menu"
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon-xs" }),
          "text-muted-foreground data-popup-open:bg-accent data-popup-open:text-foreground max-md:size-11",
          className,
        )}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="column-menu-content" className="min-w-52">
        <DropdownMenuItem className={ITEM} onClick={onEdit}>
          <Pencil />
          Edit column…
        </DropdownMenuItem>
        <DropdownMenuItem className={ITEM} disabled={m.moveLeft.disabled} onClick={() => onMove("left")}>
          <ArrowLeft />
          Move left
        </DropdownMenuItem>
        <DropdownMenuItem className={ITEM} disabled={m.moveRight.disabled} onClick={() => onMove("right")}>
          <ArrowRight />
          Move right
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className={cn(ITEM, "items-start")}
          variant="destructive"
          disabled={m.deleteColumn.disabled}
          onClick={onDelete}
        >
          <Trash2 className="mt-0.5" />
          <span className="grid">
            <span>Delete column…</span>
            {m.deleteColumn.reason ? (
              <span className="text-muted-foreground text-xs">{m.deleteColumn.reason}</span>
            ) : null}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------- delete with move

export interface DeleteColumnModel {
  name: string;
  /** Cards loaded in the column (`100+` columns say so through `countLabel`). */
  count: number;
  countLabel: string;
  needsTarget: boolean;
  body: string;
  targets: Array<Pick<BoardColumn, "id" | "name" | "category">>;
}

export function deleteColumnModel(
  s: Pick<BoardSnapshot, "columns" | "cards">,
  columnId: string,
): DeleteColumnModel {
  const column = s.columns.find((c) => c.id === columnId);
  const entry = s.cards.find((c) => c.columnId === columnId);
  const count = entry?.cards.length ?? 0;
  const countLabel = entry?.hasMore ? "100+ cards" : count === 1 ? "1 card" : `${count} cards`;
  const needsTarget = count > 0;
  return {
    name: column?.name ?? "",
    count,
    countLabel,
    needsTarget,
    body: needsTarget
      ? `It holds ${countLabel}. Choose where they go; they're added to the bottom of that column.`
      : "It's removed for everyone.",
    targets: s.columns
      .filter((c) => c.id !== columnId)
      .map((c) => ({ id: c.id, name: c.name, category: c.category })),
  };
}

/** The confirmation's move target and footer (no dialog primitives, so it renders on its own in tests). */
export function DeleteColumnForm({
  model,
  target,
  onTarget,
  pending,
  error,
  onCancel,
  onConfirm,
  cancelRef,
}: {
  model: DeleteColumnModel;
  target: string | null;
  onTarget: (columnId: string | null) => void;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  cancelRef?: Ref<HTMLButtonElement>;
}) {
  const blocked = pending || (model.needsTarget && !target);
  return (
    <div className="grid gap-5">
      {model.needsTarget ? (
        <FormField id="column-move-to" label="Move its cards to">
          <Select
            items={model.targets.map((t) => ({ value: t.id, label: t.name }))}
            value={target}
            onValueChange={(v) => onTarget(v ? String(v) : null)}
          >
            <SelectTrigger id="column-move-to" data-testid="column-move-to" placeholder="Choose a column" />
            <SelectContent>
              {model.targets.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  <span className="flex items-center gap-2">
                    <CategoryIcon category={t.category} decorative />
                    {t.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
      ) : null}
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
          disabled={pending}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          className="max-md:h-11"
          disabled={blocked}
          data-testid="delete-column-submit"
          onClick={onConfirm}
        >
          {pending ? <Spinner /> : <Trash2 />}
          Delete column
        </Button>
      </DialogFooter>
    </div>
  );
}

export function DeleteColumnDialog({
  convId,
  snapshot,
  columnId,
  open,
  onOpenChange,
  onDeleted,
}: {
  convId: string;
  snapshot: Pick<BoardSnapshot, "columns" | "cards">;
  columnId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: (columnId: string) => void;
}) {
  const remove = useDeleteBoardColumn(convId);
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on open
  useEffect(() => {
    if (!open) return;
    setTarget(null);
    setError(null);
    remove.reset();
  }, [open, columnId]);
  if (!columnId) return null;
  const model = deleteColumnModel(snapshot, columnId);
  const confirm = () => {
    if (model.needsTarget && !target) return;
    remove.mutate(
      { columnId, ...(model.needsTarget && target ? { moveCardsTo: target } : {}) },
      {
        onSuccess: () => {
          onOpenChange(false);
          onDeleted?.(columnId);
        },
        onError: (err) => setError(columnErrorMessage(err, model.name)),
      },
    );
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !remove.isPending && onOpenChange(o)}>
      <DialogContent data-testid="delete-column" initialFocus={cancelRef}>
        <DialogHeader>
          <DialogTitle>Delete “{model.name}”?</DialogTitle>
          <DialogDescription>{model.body}</DialogDescription>
        </DialogHeader>
        <DeleteColumnForm
          model={model}
          target={target}
          onTarget={(t) => {
            setTarget(t);
            setError(null);
          }}
          pending={remove.isPending}
          error={error}
          onCancel={() => onOpenChange(false)}
          onConfirm={confirm}
          cancelRef={cancelRef}
        />
      </DialogContent>
    </Dialog>
  );
}
