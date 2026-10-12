"use client";

import {
  BOARD_CARD_DESCRIPTION_MAX,
  BOARD_CARD_TITLE_MAX,
  type Board,
  type BoardCard,
  type FieldValue,
  renderCardTitle,
} from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
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
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  applyCard,
  CARD_EDIT_COPY,
  type CardDraft,
  type CardEditFailure,
  cardEditFailure,
  cardEditRequest,
  draftOf,
  useEditBoardCard,
} from "@/lib/board-manage-queries";
import { cn } from "@/lib/utils";
import { CardFields, cleanFieldValues, fieldErrors } from "./card-fields";

/**
 * Edit card (07.1-11; BOARD-06, P-02, 07.1-UI-SPEC "Card dialogs", Copywriting › New card / Edit card): the card's
 * human author changes its title, description and fields. Only what changed is sent, with `expectedVersion`; an
 * automatic title stays automatic unless a title is typed, and a typed title is never replaced (the hint under Title
 * says which one the card has). A 409 shows the conflict with `Reload card`; nobody else is offered this dialog and the
 * API refuses them anyway (`not_author`). Full screen below 640 px, like New card.
 */

/** The Title hint: what happens to this card's title (07.1-UI-SPEC). */
export function titleHint(titleSource: BoardCard["titleSource"]): string {
  return titleSource === "user" ? CARD_EDIT_COPY.hintTyped : CARD_EDIT_COPY.hintAutomatic;
}

/** The placeholder of an automatic title: the title the server will compute from the draft. */
export function automaticTitlePreview(
  board: Pick<Board, "prefix" | "namingRule" | "fields">,
  card: Pick<BoardCard, "number">,
  draft: CardDraft,
): string {
  return `Automatic: ${renderCardTitle(board.namingRule, {
    prefix: board.prefix,
    number: card.number,
    description: draft.description,
    fields: cleanFieldValues(board.fields, draft.values),
  })}`;
}

/** Title, description and field values of two cards are the same (a move or waiting change only bumps the version). */
function sameText(a: BoardCard, b: BoardCard): boolean {
  return (
    a.title === b.title &&
    a.titleSource === b.titleSource &&
    a.description === b.description &&
    JSON.stringify(a.fields) === JSON.stringify(b.fields)
  );
}

export function CardEditDialog({
  convId,
  card,
  board,
  open,
  onOpenChange,
}: {
  convId: string;
  /** The live card from the board cache. */
  card: BoardCard;
  board: Pick<Board, "prefix" | "namingRule" | "fields">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const edit = useEditBoardCard(convId);
  const defs = board.fields;
  /** The card the edit is based on (its version is the `expectedVersion`). */
  const [base, setBase] = useState<BoardCard>(card);
  const [draft, setDraft] = useState<CardDraft>(() => draftOf(card));
  const [errors, setErrors] = useState<{ title?: string; description?: string }>({});
  const [fieldErrs, setFieldErrs] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<CardEditFailure | null>(null);

  // A fresh form from the live card each time the dialog opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on open
  useEffect(() => {
    if (!open) return;
    setBase(card);
    setDraft(draftOf(card));
    setErrors({});
    setFieldErrs({});
    setFailure(null);
    edit.reset();
  }, [open]);

  // Someone moved the card or changed its waiting state while the form is open: same text, newer version. Follow it,
  // so the save does not conflict over a change that is not about the text. A text change keeps the old base: the
  // save then answers 409 and the person decides with Reload card.
  useEffect(() => {
    if (open && card.messageId === base.messageId && card.version > base.version && sameText(card, base)) {
      setBase(card);
    }
  }, [open, card, base]);

  const request = cardEditRequest(base, draft, defs);
  const automatic = base.titleSource !== "user";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next: typeof errors = {};
    const t = draft.title.trim();
    if (t.length > BOARD_CARD_TITLE_MAX) next.title = CARD_EDIT_COPY.titleTooLong;
    else if (!automatic && !t) next.title = CARD_EDIT_COPY.typedTitleRequired;
    if (automatic && !t && !draft.description.trim()) next.description = CARD_EDIT_COPY.needsText;
    const fe = fieldErrors(defs, draft.values);
    setErrors(next);
    setFieldErrs(fe);
    if (Object.keys(next).length > 0 || Object.keys(fe).length > 0 || !request) return;
    setFailure(null);
    edit.mutate(
      { messageId: base.messageId, body: request },
      {
        onSuccess: () => onOpenChange(false),
        onError: (err) => {
          const f = cardEditFailure(err);
          setFailure(f);
          if (f.kind === "conflict" && f.card) applyCard(qc, convId, f.card);
        },
      },
    );
  };

  const reload = () => {
    const current = failure?.kind === "conflict" && failure.card ? failure.card : card;
    setBase(current);
    setDraft(draftOf(current));
    setErrors({});
    setFieldErrs({});
    setFailure(null);
  };

  const failureCopy =
    failure?.kind === "conflict"
      ? CARD_EDIT_COPY.conflict
      : failure?.kind === "notAuthor"
        ? CARD_EDIT_COPY.notAuthor
        : failure?.kind === "invalidFields"
          ? CARD_EDIT_COPY.invalidFields
          : failure?.kind === "other"
            ? failure.message
            : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !edit.isPending && onOpenChange(o)}>
      <DialogContent
        data-testid="card-edit"
        className="sm:max-w-lg max-sm:inset-0 max-sm:max-h-dvh max-sm:rounded-none max-sm:pb-[max(env(safe-area-inset-bottom),20px)]"
      >
        <DialogHeader>
          <DialogTitle>Edit card</DialogTitle>
          <DialogDescription className="sr-only">
            Change this card's title, description and fields.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-1 flex-col gap-5" noValidate>
          {failureCopy ? (
            <div
              role="alert"
              data-testid="card-edit-error"
              data-kind={failure?.kind}
              className={cn(
                "flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm",
                failure?.kind === "conflict"
                  ? "bg-muted/50 text-foreground"
                  : "border-destructive/30 bg-destructive/5 text-destructive",
              )}
            >
              <span>{failureCopy}</span>
              {failure?.kind === "conflict" ? (
                <Button type="button" variant="outline" size="sm" className="max-md:h-11" onClick={reload}>
                  {CARD_EDIT_COPY.reload}
                </Button>
              ) : null}
            </div>
          ) : null}
          <FormField
            id="card-edit-title"
            label="Title"
            hint={titleHint(base.titleSource)}
            error={errors.title}
          >
            <Input
              id="card-edit-title"
              autoFocus
              autoComplete="off"
              placeholder={automatic ? automaticTitlePreview(board, base, draft) : undefined}
              value={draft.title}
              maxLength={BOARD_CARD_TITLE_MAX + 1}
              onChange={(e) => {
                setDraft((d) => ({ ...d, title: e.target.value }));
                setErrors((p) => ({ ...p, title: undefined, description: undefined }));
              }}
              aria-invalid={!!errors.title}
              aria-describedby={describedBy("card-edit-title", errors.title, titleHint(base.titleSource))}
            />
          </FormField>
          <FormField id="card-edit-description" label="Description" error={errors.description}>
            <Textarea
              id="card-edit-description"
              rows={4}
              placeholder="What needs doing? @mention a bot to bring it in."
              value={draft.description}
              maxLength={BOARD_CARD_DESCRIPTION_MAX}
              onChange={(e) => {
                setDraft((d) => ({ ...d, description: e.target.value }));
                setErrors((p) => ({ ...p, description: undefined }));
              }}
              aria-invalid={!!errors.description}
              aria-describedby={describedBy("card-edit-description", errors.description)}
              className="max-h-72 field-sizing-content"
            />
          </FormField>
          <CardFields
            idPrefix="card-edit-field"
            defs={defs}
            values={draft.values}
            errors={fieldErrs}
            onChange={(key: string, value: FieldValue) => {
              setDraft((d) => ({ ...d, values: { ...d.values, [key]: value } }));
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
              disabled={edit.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="max-md:h-11"
              disabled={edit.isPending || request === null}
              data-testid="card-edit-submit"
            >
              {edit.isPending ? <Spinner /> : null}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
