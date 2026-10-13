"use client";

import type { BoardColumn as BoardColumnModel } from "@ocw/contracts";
import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";
import { ColumnHeader } from "./column-header";

/**
 * One lane of the board at 1440 (07.1-UI-SPEC "Board channel at 1440", "Column (lane) header"): a 272 px section named
 * by its `<h2>`, a 40 px header, then a body that scrolls on its own and holds the cards in an `<ol>`, the dashed empty
 * box (96 px; "Drop here" while a drag hovers it) and the lane footer ("Show more cards"). Presentational: the board
 * view owns drag and drop and passes the droppable `bodyRef` (no dnd-kit import here, P-05).
 */
export function BoardColumn({
  column,
  count,
  hasMore,
  canPost,
  canManage = false,
  onAdd,
  menu,
  bodyRef,
  dropTarget = false,
  empty,
  footer,
  children,
  className,
}: {
  column: Pick<BoardColumnModel, "id" | "name" | "category">;
  count: number;
  hasMore: boolean;
  canPost: boolean;
  canManage?: boolean;
  onAdd: () => void;
  /** The column menu (07.1-11). */
  menu?: ReactNode;
  /** The lane body: the drop target of an empty lane. */
  bodyRef?: Ref<HTMLDivElement>;
  /** A card is being dragged over this lane. */
  dropTarget?: boolean;
  /** Shown instead of the list when the lane has no cards: a string renders the dashed box, a node is used as is. */
  empty?: ReactNode;
  footer?: ReactNode;
  /** The `<li>` tiles. */
  children?: ReactNode;
  className?: string;
}) {
  const hasCards = count > 0 || children !== undefined;
  return (
    <section
      aria-labelledby={`col-${column.id}-name`}
      data-testid="board-column"
      data-column-id={column.id}
      data-drop-target={dropTarget ? "true" : undefined}
      className={cn(
        "flex max-h-full w-68 shrink-0 snap-start flex-col rounded-xl bg-muted/50 transition-colors dark:bg-white/[0.03]",
        dropTarget && "bg-primary/5 dark:bg-primary/[0.06]",
        className,
      )}
    >
      <ColumnHeader
        column={column}
        count={count}
        hasMore={hasMore}
        canPost={canPost}
        canManage={canManage}
        onAdd={onAdd}
        menu={menu}
        className="rounded-t-xl"
      />
      <div
        ref={bodyRef}
        data-slot="lane-body"
        className="scrollbar-thin grid min-h-0 flex-1 content-start gap-2 overflow-y-auto px-2 pb-2"
      >
        {hasCards ? (
          <ol aria-label={`${column.name} cards`} className="grid gap-2">
            {children}
          </ol>
        ) : typeof empty === "string" ? (
          <EmptyLane label={empty} active={dropTarget} />
        ) : (
          empty
        )}
        {footer}
      </div>
    </section>
  );
}

/** The dashed 96 px box of an empty lane (or of the active column at 390). */
export function EmptyLane({ label, active = false }: { label: string; active?: boolean }) {
  return (
    <div
      data-slot="empty-lane"
      className={cn(
        "grid h-24 place-items-center rounded-lg border border-dashed text-muted-foreground text-xs transition-colors",
        active && "border-primary/50 bg-primary/5 text-foreground",
      )}
    >
      {active ? "Drop here" : label}
    </div>
  );
}
