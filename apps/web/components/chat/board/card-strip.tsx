"use client";

import type { Board, BoardCard, BoardFieldDef, Message, WaitingOn } from "@ocw/contracts";
import { ChevronDown, Clock, Pencil } from "lucide-react";
import { useCallback, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUpdateBoardCard } from "@/lib/board-queries";
import { cn } from "@/lib/utils";
import { type BoardMenuColumn, cardMenuModel } from "./card-menu";
import { cardNumberLabel, shownTitle } from "./card-tile";
import { CategoryIcon } from "./column-header";
import { WAITING, WAITING_OPTIONS, WaitingDot, WaitingOnBadge } from "./waiting-on-badge";

/**
 * The card strip at the top of a card's thread (07.1-11; BOARD-02, 07.1-UI-SPEC "Thread panel: card strip"): the card's
 * structured data under the thread header, above the root message. Number and title; the column as a button opening
 * the same "Move to…" radio menu as the card menu; the waiting chip as a button opening "Waiting on…"; `Edit card` for
 * the card's human author; then the field values as a `dl`. Viewers who cannot post see the same items as static text.
 * The title is shown here only when it was typed: an automatic title is built from the number, the fields and the
 * description's first line, all of which the thread already shows.
 * Changes go through the 07.1-04 `useUpdateBoardCard` (optimistic, rollback, announced in the strip's own live region).
 *
 * The root message under the strip shows only the card's description (`cardRootView`): a typed title and the field
 * values are here, so the thread never says anything twice. The stored message body (title, description, fields as plain text)
 * is unchanged: chat search and the Messages view read it.
 */

/** The thread root as the panel renders it under a card strip: the description is the message, nothing repeated. */
export function cardRootView(root: Message, card: Pick<BoardCard, "description">): Message {
  return { ...root, body: card.description };
}

/** Field values as the strip lists them: in definition order, only the ones with a value. */
export function stripFields(
  defs: readonly BoardFieldDef[],
  values: BoardCard["fields"],
): Array<{ key: string; label: string; value: string }> {
  return defs.flatMap((d) => {
    const v = values[d.key];
    if (v === null || v === undefined || v === "" || Number.isNaN(v)) return [];
    return [{ key: d.key, label: d.label, value: String(v) }];
  });
}

/** Strip buttons: 32 px on desktop, 44 px below 768 px. */
const CONTROL = "max-md:h-11";

export function CardStrip({
  convId,
  card,
  board,
  columns,
  canPost,
  isAuthor,
  onEdit,
}: {
  convId: string;
  card: BoardCard;
  board: Pick<Board, "prefix" | "namingRule" | "fields">;
  columns: readonly BoardMenuColumn[];
  /** Member of an active channel (moves, waiting state). False = static text. */
  canPost: boolean;
  /** The card's human author (`Edit card`, P-02). */
  isAuthor: boolean;
  onEdit: () => void;
}) {
  const [live, setLive] = useState("");
  const announce = useCallback((text: string) => setLive((prev) => (prev === text ? `${text} ` : text)), []);
  const update = useUpdateBoardCard(convId, { announce });
  const model = cardMenuModel(card, columns, { canPost: canPost && !update.isPending });
  const label = cardNumberLabel(board, card.number);
  const column = columns.find((c) => c.id === card.columnId);
  const fields = stripFields(board.fields, card.fields);
  // A typed title is the card's own data; an automatic one is made of what the thread already shows (the number,
  // the fields, the description's first line), so it is not repeated here.
  const typedTitle = card.titleSource === "user" ? shownTitle(card.title, label) : null;
  const editable = isAuthor && canPost;

  return (
    <section
      data-testid="card-strip"
      data-card-id={card.messageId}
      aria-label="Card"
      className="grid shrink-0 gap-2 border-b bg-muted/30 px-4 py-3 dark:bg-white/[0.02]"
    >
      <div aria-live="polite" className="sr-only">
        {live}
      </div>
      {label || typedTitle || editable ? (
        <div className="flex min-w-0 items-start gap-2">
          <h3
            className="min-w-0 flex-1 break-words py-1.5 font-semibold text-sm leading-5 max-md:py-3"
            data-testid="card-strip-title"
          >
            {label ? (
              <span className="mr-2 font-mono font-normal text-muted-foreground text-xs tabular-nums">
                {label}
              </span>
            ) : null}
            {typedTitle}
          </h3>
          {editable ? (
            <Button
              variant="ghost"
              size="sm"
              className={cn(CONTROL, "-mr-2 shrink-0")}
              onClick={onEdit}
              data-testid="card-strip-edit"
            >
              <Pencil />
              Edit card
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {model.moveTo && column ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              data-testid="card-strip-column"
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), CONTROL, "max-w-full")}
            >
              <span className="sr-only">Column </span>
              <CategoryIcon category={column.category} decorative />
              <span className="min-w-0 truncate">{column.name}</span>
              <ChevronDown aria-hidden className="text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" data-testid="card-strip-column-menu">
              <DropdownMenuRadioGroup
                value={card.columnId}
                onValueChange={(value: string) => {
                  const intent = model.moveTo?.find((c) => c.columnId === value)?.intent;
                  if (intent)
                    update.mutate({ messageId: card.messageId, move: intent.move, via: intent.via });
                }}
              >
                {model.moveTo.map((c) => (
                  <DropdownMenuRadioItem
                    key={c.columnId}
                    value={c.columnId}
                    closeOnClick
                    className="max-md:min-h-11"
                  >
                    <CategoryIcon category={c.category} decorative />
                    <span className="min-w-0 truncate">{c.name}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : column ? (
          <span className="inline-flex min-w-0 items-center gap-1.5 text-sm" data-testid="card-strip-column">
            <span className="sr-only">Column </span>
            <CategoryIcon category={column.category} decorative />
            <span className="min-w-0 truncate">{column.name}</span>
          </span>
        ) : null}
        {model.waitingOn ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              data-testid="card-strip-waiting"
              data-state={card.waitingOn}
              className={cn(waitingButton(card.waitingOn), CONTROL)}
            >
              {card.waitingOn === "none" ? (
                <Clock aria-hidden className="size-3.5" />
              ) : (
                <WaitingDot state={card.waitingOn} />
              )}
              {card.waitingOn === "none" ? "Waiting on nobody" : WAITING[card.waitingOn].label}
              <ChevronDown aria-hidden className="size-3.5 opacity-70" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" data-testid="card-strip-waiting-menu">
              <DropdownMenuRadioGroup
                value={card.waitingOn}
                onValueChange={(value: WaitingOn) => {
                  if (value !== card.waitingOn)
                    update.mutate({ messageId: card.messageId, waitingOn: value });
                }}
              >
                {WAITING_OPTIONS.map((o) => (
                  <DropdownMenuRadioItem
                    key={o.value}
                    value={o.value}
                    closeOnClick
                    className="max-md:min-h-11"
                  >
                    <span aria-hidden className="flex size-4 items-center justify-center">
                      <WaitingDot state={o.value} />
                    </span>
                    {o.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <WaitingOnBadge state={card.waitingOn} />
        )}
      </div>
      {fields.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2" data-testid="card-strip-fields">
          {fields.map((f) => (
            <div key={f.key} className="grid min-w-0 gap-0.5">
              <dt className="text-muted-foreground text-xs">{f.label}</dt>
              <dd className="break-words text-sm">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

/** The waiting chip as a button: the chip's own tint, or a neutral outline when nobody is waited on. */
function waitingButton(state: WaitingOn): string {
  const base =
    "inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-xs font-semibold outline-none transition-[filter,background-color] focus-visible:ring-[3px] focus-visible:ring-ring/40 data-popup-open:brightness-95";
  return state === "none"
    ? cn(base, "border bg-background text-muted-foreground hover:bg-accent hover:text-foreground")
    : cn(base, WAITING[state].tone, "hover:brightness-95");
}
