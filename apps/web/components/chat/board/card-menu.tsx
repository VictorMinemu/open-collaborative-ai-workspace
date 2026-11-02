"use client";

import type { BoardCard, BoardCardMove, BoardColumn, BoardSnapshot, WaitingOn } from "@ocw/contracts";
import {
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpToLine,
  Clock,
  Eye,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
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
import { WatchRecordDialog } from "@/components/watched/watch-record-dialog";
import { cn } from "@/lib/utils";
import { useCardWatch, useMayWatch } from "@/lib/watched-queries";
import { CategoryIcon } from "./column-header";
import { WAITING_OPTIONS, WaitingDot } from "./waiting-on-badge";

/**
 * The card menu on every tile (07.1-UI-SPEC Interaction Contract › "Move to…", BOARD-03, D-04): Open thread · Move to…
 * (columns with their category, current checked; lands at the bottom, P-07) · Move to top · Move to bottom · Waiting
 * on… (Nobody / Us / Customer / Both). Viewers who cannot post see only Open thread. After a separator (07.1-11, P-02):
 * Edit card… for the card's human author, Delete card… for the author or a viewer with `message.delete_any`. The menu
 * only reports intents (`onMove`, `onWaitingOn`, `onEdit`, `onDelete`); it never fetches, and the API re-decides every
 * change (T-07.1-04-03, T-07.1-11-02).
 *
 * 07.6-17 (R11): "Watch external record…" after "Waiting on…", for viewers with `record.watch` who can post, on a card
 * that watches nothing yet; it opens the watch dialog owned by this menu instance (the board's one watched-records
 * query says whether the card is watched). The 07.1 items and their order are unchanged.
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
  /** Edit card…: the card's human author, who can post (P-02). */
  editCard: boolean;
  /** Delete card…: the author or `message.delete_any`, on a live board. */
  deleteCard: boolean;
  /** 07.6-17: Watch external record… (present only when offered: `record.watch`, post rights, card not watched). */
  watchRecord?: true;
}

/** Who is looking: their id (authorship), `message.delete_any`, and an archived board (nothing changes). */
export type CardMenuViewer = {
  canPost: boolean;
  viewerId?: string | null;
  canDeleteAny?: boolean;
  readOnly?: boolean;
  /** 07.6-17: `record.watch` here and the card watches nothing yet. */
  canWatch?: boolean;
};

type MenuCard = Pick<BoardCard, "messageId" | "columnId" | "waitingOn"> &
  Partial<Pick<BoardCard, "authorKind" | "authorId" | "conversationId">>;

/** The viewer wrote this card (a human author; agents' cards have no human author). */
export function isCardAuthor(
  card: Partial<Pick<BoardCard, "authorKind" | "authorId">>,
  viewerId?: string | null,
) {
  return !!viewerId && card.authorKind === "user" && card.authorId === viewerId;
}

/** The menu's items and the intents behind them (exported for tests; the component renders exactly this). */
export function cardMenuModel(
  card: MenuCard,
  columns: readonly BoardMenuColumn[],
  { canPost, viewerId = null, canDeleteAny = false, readOnly = false, canWatch = false }: CardMenuViewer,
): CardMenuModel {
  const author = isCardAuthor(card, viewerId);
  const editCard = canPost && author;
  const deleteCard = !readOnly && (author || canDeleteAny);
  if (!canPost) {
    return {
      openThread: true,
      moveTo: null,
      moveTop: null,
      moveBottom: null,
      waitingOn: null,
      editCard,
      deleteCard,
    };
  }
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
    editCard,
    deleteCard,
    ...(canWatch && !readOnly && card.conversationId ? { watchRecord: true as const } : {}),
  };
}

/** Menu items are 44 px tall below 768 px. */
const ITEM = "max-md:min-h-11";

export function CardMenu({
  card,
  columns,
  canPost,
  viewerId = null,
  canDeleteAny = false,
  readOnly = false,
  onOpen,
  onMove,
  onWaitingOn,
  onEdit,
  onDelete,
  extraItems,
  className,
}: CardMenuViewer & {
  card: MenuCard;
  columns: readonly BoardMenuColumn[];
  onOpen: () => void;
  onMove: (intent: CardMoveIntent) => void;
  onWaitingOn: (state: WaitingOn) => void;
  /** Edit card… (shown to the human author when given). */
  onEdit?: () => void;
  /** Delete card… (shown to the author or `message.delete_any` when given). */
  onDelete?: () => void;
  /** More items after the separator. */
  extraItems?: ReactNode;
  className?: string;
}) {
  const mayWatch = useMayWatch();
  const watched = useCardWatch({ messageId: card.messageId, conversationId: card.conversationId }) !== null;
  const [watchOpen, setWatchOpen] = useState(false);
  const model = cardMenuModel(card, columns, {
    canPost,
    viewerId,
    canDeleteAny,
    readOnly,
    canWatch: mayWatch && !watched,
  });
  const { moveTo, moveTop, moveBottom, waitingOn } = model;
  const edit = model.editCard && onEdit ? onEdit : null;
  const remove = model.deleteCard && onDelete ? onDelete : null;
  return (
    <>
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
                      <DropdownMenuRadioItem
                        key={c.columnId}
                        value={c.columnId}
                        closeOnClick
                        className={ITEM}
                      >
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
              {model.watchRecord ? (
                <DropdownMenuItem
                  className={ITEM}
                  onClick={() => setWatchOpen(true)}
                  data-testid="card-menu-watch"
                >
                  <Eye />
                  Watch external record…
                </DropdownMenuItem>
              ) : null}
            </>
          ) : null}
          {edit || remove || extraItems ? (
            <>
              <DropdownMenuSeparator />
              {edit ? (
                <DropdownMenuItem className={ITEM} onClick={edit}>
                  <Pencil />
                  Edit card…
                </DropdownMenuItem>
              ) : null}
              {remove ? (
                <DropdownMenuItem className={ITEM} variant="destructive" onClick={remove}>
                  <Trash2 />
                  Delete card…
                </DropdownMenuItem>
              ) : null}
              {extraItems}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {model.watchRecord && card.conversationId ? (
        <WatchRecordDialog
          open={watchOpen}
          onOpenChange={setWatchOpen}
          card={{ messageId: card.messageId, conversationId: card.conversationId }}
          mode="new"
        />
      ) : null}
    </>
  );
}
