"use client";

import type { BoardCard, BoardCardMove, BoardColumn, BoardSnapshot, WaitingOn } from "@ocw/contracts";
import {
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpToLine,
  Clock,
  MessageSquare,
  MoreHorizontal,
} from "lucide-react";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { CategoryIcon } from "./column-header";
import { WAITING_OPTIONS, WaitingDot } from "./waiting-on-badge";

/**
 * The card menu on every tile (07.1-UI-SPEC Interaction Contract › "Move to…", BOARD-03, D-04): Open thread · Move to…
 * (columns with their category, current checked; lands at the bottom, P-07) · Move to top · Move to bottom · Waiting
 * on… (Nobody / Us / Customer / Both). Viewers who cannot post see only Open thread. The menu only reports intents
 * (`onMove`, `onWaitingOn`); it never fetches, and the API re-decides every move (T-07.1-04-03).
 */

/** A column as the menu needs it: identity, label, category and the ids of its loaded cards in order. */
export type BoardMenuColumn = Pick<BoardColumn, "id" | "name" | "category"> & { cardIds: readonly string[] };

/** The menu's view of a snapshot: every column in order with its loaded card ids. */
export function menuColumns(s: Pick<BoardSnapshot, "columns" | "cards">): BoardMenuColumn[] {
  return s.columns.map((c) => ({
    id: c.id,
    name: c.name,
    category: c.category,
    cardIds: s.cards.find((k) => k.columnId === c.id)?.cards.map((k) => k.messageId) ?? [],
  }));
}

/** A move chosen in the menu: where it lands (the server computes the rank) and which item chose it (announcement). */
export type CardMoveIntent = { move: BoardCardMove; via: "menu" | "top" | "bottom" };

export interface CardMenuModel {
  /** Always offered. */
  openThread: true;
  /** null = the viewer cannot post. `intent` null on the current column. */
  moveTo: Array<{
    columnId: string;
    name: string;
    category: BoardColumn["category"];
    checked: boolean;
    intent: CardMoveIntent | null;
  }> | null;
  moveTop: { disabled: boolean; intent: CardMoveIntent } | null;
  moveBottom: { disabled: boolean; intent: CardMoveIntent } | null;
  waitingOn: Array<{ value: WaitingOn; label: string; checked: boolean }> | null;
}

/** The menu's items and the intents behind them (exported for tests; the component renders exactly this). */
export function cardMenuModel(
  card: Pick<BoardCard, "messageId" | "columnId" | "waitingOn">,
  columns: readonly BoardMenuColumn[],
  { canPost }: { canPost: boolean },
): CardMenuModel {
  if (!canPost) return { openThread: true, moveTo: null, moveTop: null, moveBottom: null, waitingOn: null };
  const others = (c: BoardMenuColumn) => c.cardIds.filter((id) => id !== card.messageId);
  const bottomOf = (c: BoardMenuColumn) => others(c).at(-1) ?? null;
  const own = columns.find((c) => c.id === card.columnId);
  const at = own ? own.cardIds.indexOf(card.messageId) : -1;
  const last = own ? own.cardIds.length - 1 : -1;
  return {
    openThread: true,
    moveTo: columns.map((c) => ({
      columnId: c.id,
      name: c.name,
      category: c.category,
      checked: c.id === card.columnId,
      intent:
        c.id === card.columnId ? null : { move: { columnId: c.id, afterCardId: bottomOf(c) }, via: "menu" },
    })),
    moveTop: {
      disabled: at <= 0,
      intent: { move: { columnId: card.columnId, afterCardId: null }, via: "top" },
    },
    moveBottom: {
      disabled: at === -1 || at === last,
      intent: { move: { columnId: card.columnId, afterCardId: own ? bottomOf(own) : null }, via: "bottom" },
    },
    waitingOn: WAITING_OPTIONS.map((o) => ({ ...o, checked: o.value === card.waitingOn })),
  };
}

/** Menu items are 44 px tall below 768 px. */
const ITEM = "max-md:min-h-11";

export function CardMenu({
  card,
  columns,
  canPost,
  onOpen,
  onMove,
  onWaitingOn,
  extraItems,
  className,
}: {
  card: Pick<BoardCard, "messageId" | "columnId" | "waitingOn">;
  columns: readonly BoardMenuColumn[];
  canPost: boolean;
  onOpen: () => void;
  onMove: (intent: CardMoveIntent) => void;
  onWaitingOn: (state: WaitingOn) => void;
  /** Edit card… / Delete card… (07.1-11), after a separator. */
  extraItems?: ReactNode;
  className?: string;
}) {
  const model = cardMenuModel(card, columns, { canPost });
  const { moveTo, moveTop, moveBottom, waitingOn } = model;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Card actions"
        data-testid="card-menu"
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon-xs" }),
          "text-muted-foreground data-popup-open:bg-accent data-popup-open:text-foreground max-md:size-11",
          className,
        )}
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="card-menu-content">
        <DropdownMenuItem className={ITEM} onClick={onOpen}>
          <MessageSquare />
          Open thread
        </DropdownMenuItem>
        {moveTo && moveTop && moveBottom && waitingOn ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM}>
                <ArrowRightLeft />
                Move to…
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={card.columnId}
                  onValueChange={(value: string) => {
                    const intent = moveTo.find((c) => c.columnId === value)?.intent;
                    if (intent) onMove(intent);
                  }}
                >
                  {moveTo.map((c) => (
                    <DropdownMenuRadioItem key={c.columnId} value={c.columnId} closeOnClick className={ITEM}>
                      <CategoryIcon category={c.category} decorative />
                      <span className="min-w-0 truncate">{c.name}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem
              className={ITEM}
              disabled={moveTop.disabled}
              onClick={() => onMove(moveTop.intent)}
            >
              <ArrowUpToLine />
              Move to top
            </DropdownMenuItem>
            <DropdownMenuItem
              className={ITEM}
              disabled={moveBottom.disabled}
              onClick={() => onMove(moveBottom.intent)}
            >
              <ArrowDownToLine />
              Move to bottom
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={ITEM}>
                <Clock />
                Waiting on…
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={card.waitingOn}
                  onValueChange={(value: WaitingOn) => {
                    if (value !== card.waitingOn) onWaitingOn(value);
                  }}
                >
                  {waitingOn.map((o) => (
                    <DropdownMenuRadioItem key={o.value} value={o.value} closeOnClick className={ITEM}>
                      <span aria-hidden className="flex size-4 items-center justify-center">
                        <WaitingDot state={o.value} />
                      </span>
                      {o.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        ) : null}
        {extraItems ? (
          <>
            <DropdownMenuSeparator />
            {extraItems}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
