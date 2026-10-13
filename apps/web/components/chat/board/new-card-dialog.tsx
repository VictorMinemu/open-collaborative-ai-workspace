"use client";

import {
  BOARD_CARD_DESCRIPTION_MAX,
  BOARD_CARD_TITLE_MAX,
  type BoardCard,
  type BoardSnapshot,
  type FieldValue,
  renderCardTitle,
  type WaitingOn,
} from "@ocw/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage, isApiError } from "@/lib/api";
import { useCreateBoardCard } from "@/lib/board-queries";
import { CardFields, type CardFieldValues, cleanFieldValues, fieldErrors } from "./card-fields";
import { CategoryIcon } from "./column-header";
import { WAITING_OPTIONS, WaitingDot } from "./waiting-on-badge";

/**
 * New card (07.1-UI-SPEC "Card dialogs", BOARD-02): Title (optional; the placeholder previews the board's naming rule),
 * Description, Column, Waiting on, then the board's typed fields. Validated in place (title or description, the
 * board's `fieldValuesSchema`) before any request; full screen below 640 px. Card text is untrusted and goes to the API
 * as typed; nothing here renders it as HTML (T-07.1-08-01).
 */

/** The column a new card lands in by default: the first backlog column, else the first column (P-07). */
export function defaultColumnOf(s: Pick<BoardSnapshot, "columns">): string | null {
  return (s.columns.find((c) => c.category === "backlog") ?? s.columns[0])?.id ?? null;
}

/** The highest loaded card number + 1: a preview only (the server allocates the real number). */
function nextNumber(s: BoardSnapshot): number | null {
  if (!s.board.prefix) return null;
  let max = 0;
  for (const col of s.cards) for (const c of col.cards) max = Math.max(max, c.number ?? 0);
  return max + 1;
}

/** `Automatic: {preview}` on a board with a naming rule, `First line of the description` without one. */
export function newCardTitlePlaceholder(
  s: BoardSnapshot,
  description: string,
  fields: Readonly<Record<string, unknown>>,
): string {
  if (!s.board.namingRule) return "First line of the description";
  const preview = renderCardTitle(s.board.namingRule, {
    prefix: s.board.prefix,
    number: nextNumber(s),
    description: description.trim() ? description : "…",
    fields,
  });
  return `Automatic: ${preview}`;
}

export function NewCardDialog({
  channel,
  snapshot,
  open,
  onOpenChange,
  defaultColumnId,
  onCreated,
}: {
  channel: { id: string; name: string };
  snapshot: BoardSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The lane whose `+` opened the dialog; null = the board's default column. */
  defaultColumnId: string | null;
  onCreated?: (card: BoardCard) => void;
}) {
  const create = useCreateBoardCard(channel.id);
  const defs = snapshot.board.fields;
  const fallbackColumn = defaultColumnOf(snapshot);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [columnId, setColumnId] = useState<string | null>(defaultColumnId ?? fallbackColumn);
  const [waitingOn, setWaitingOn] = useState<WaitingOn>("none");
  const [values, setValues] = useState<CardFieldValues>({});
  const [errors, setErrors] = useState<{ title?: string; description?: string; form?: string }>({});
  const [fieldErrs, setFieldErrs] = useState<Record<string, string>>({});

  // A fresh form every time it opens, in the lane that opened it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on open
  useEffect(() => {
    if (!open) return;
    const col = defaultColumnId ?? fallbackColumn;
    setTitle("");
    setDescription("");
    setColumnId(col);
    setWaitingOn(snapshot.columns.find((c) => c.id === col)?.defaultWaitingOn ?? "none");
    setValues({});
    setErrors({});
    setFieldErrs({});
    create.reset();
  }, [open, defaultColumnId]);

  const hasRule = snapshot.board.namingRule !== null;
  const columnItems = snapshot.columns.map((c) => ({ value: c.id, label: c.name }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    const t = title.trim();
    if (t.length > BOARD_CARD_TITLE_MAX) next.title = "Keep the title under 200 characters";
    if (!t && !description.trim()) next.description = "Add a title or a description";
    const fe = fieldErrors(defs, values);
    setErrors(next);
    setFieldErrs(fe);
    if (Object.keys(next).length > 0 || Object.keys(fe).length > 0) return;
    create.mutate(
      {
        ...(t ? { title: t } : {}),
        description: description.trim(),
        ...(columnId ? { columnId } : {}),
        waitingOn,
        ...(defs.length > 0 ? { fields: cleanFieldValues(defs, values) } : {}),
      },
      {
        onSuccess: (card) => {
          onOpenChange(false);
          onCreated?.(card);
        },
        onError: (err) =>
          setErrors({
            form:
              isApiError(err, 400) && err.code === "invalid_field_values"
                ? "Check the highlighted fields."
                : errorMessage(err),
          }),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="new-card"
        className="sm:max-w-lg max-sm:inset-0 max-sm:max-h-dvh max-sm:rounded-none max-sm:pb-[max(env(safe-area-inset-bottom),20px)]"
      >
        <DialogHeader>
          <DialogTitle>New card</DialogTitle>
          <DialogDescription>It opens as a thread in #{channel.name}.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-1 flex-col gap-5" noValidate>
          {errors.form ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
            >
              {errors.form}
            </p>
          ) : null}
          <FormField
            id="card-title"
            label={
              <>
                Title <span className="font-normal text-muted-foreground">(optional)</span>
              </>
            }
            error={errors.title}
          >
            <Input
              id="card-title"
              autoFocus={!hasRule}
              autoComplete="off"
              placeholder={newCardTitlePlaceholder(snapshot, description, cleanFieldValues(defs, values))}
              value={title}
              maxLength={BOARD_CARD_TITLE_MAX + 1}
              onChange={(e) => {
                setTitle(e.target.value);
                setErrors((p) => ({ ...p, title: undefined, description: undefined }));
              }}
              aria-invalid={!!errors.title}
              aria-describedby={describedBy("card-title", errors.title)}
            />
          </FormField>
          <FormField id="card-description" label="Description" error={errors.description}>
            <Textarea
              id="card-description"
              autoFocus={hasRule}
              rows={4}
              placeholder="What needs doing? @mention a bot to bring it in."
              value={description}
              maxLength={BOARD_CARD_DESCRIPTION_MAX}
              onChange={(e) => {
                setDescription(e.target.value);
                setErrors((p) => ({ ...p, description: undefined }));
              }}
              aria-invalid={!!errors.description}
              aria-describedby={describedBy("card-description", errors.description)}
              className="max-h-72 field-sizing-content"
            />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField id="card-column" label="Column">
              <Select
                items={columnItems}
                value={columnId}
                onValueChange={(v) => {
                  const col = v ? String(v) : null;
                  setColumnId(col);
                  const def = snapshot.columns.find((c) => c.id === col)?.defaultWaitingOn;
                  if (def != null) setWaitingOn(def);
                }}
              >
                <SelectTrigger id="card-column" data-testid="new-card-column" placeholder="Choose…" />
                <SelectContent>
                  {snapshot.columns.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      <span className="flex items-center gap-2">
                        <CategoryIcon category={c.category} decorative />
                        {c.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
            <FormField id="card-waiting" label="Waiting on">
              <Select
                items={WAITING_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
                value={waitingOn}
                onValueChange={(v) => setWaitingOn((v as WaitingOn | null) ?? "none")}
              >
                <SelectTrigger id="card-waiting" data-testid="new-card-waiting" />
                <SelectContent>
                  {WAITING_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      <span className="flex items-center gap-2">
                        <span aria-hidden className="flex size-4 items-center justify-center">
                          <WaitingDot state={o.value} />
                        </span>
                        {o.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          </div>
          <CardFields
            defs={defs}
            values={values}
            errors={fieldErrs}
            onChange={(key: string, value: FieldValue) => {
              setValues((p) => ({ ...p, [key]: value }));
              setFieldErrs((p) => {
                const { [key]: _gone, ...rest } = p;
                return rest;
              });
            }}
          />
          <DialogFooter className="max-sm:mt-auto">
            <Button
              type="button"
              variant="outline"
              className="max-md:h-11"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="max-md:h-11"
              disabled={create.isPending}
              data-testid="new-card-submit"
            >
              {create.isPending ? <Spinner /> : null}
              Add card
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
