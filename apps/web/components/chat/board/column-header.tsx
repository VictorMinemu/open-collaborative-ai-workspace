import type { BoardColumn, BoardColumnCategory } from "@ocw/contracts";
import { CircleCheck, CircleDashed, CircleDot, CircleX, type LucideIcon, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Column categories (07.1-UI-SPEC Color › Column category): the shape carries the meaning, colour only reinforces it.
 * This map is the only place these palette classes live. Never the accent colour.
 */
export const CATEGORY: Record<BoardColumnCategory, { icon: LucideIcon; tone: string; label: string }> = {
  backlog: { icon: CircleDashed, tone: "text-muted-foreground", label: "Backlog" },
  started: { icon: CircleDot, tone: "text-blue-600 dark:text-blue-400", label: "Started" },
  done: { icon: CircleCheck, tone: "text-success", label: "Done" },
  cancelled: { icon: CircleX, tone: "text-muted-foreground/70", label: "Cancelled" },
};

/** One-line meaning of each category (07.1-UI-SPEC Copywriting › Column settings; the 390 active-column row). */
export const CATEGORY_MEANING: Record<BoardColumnCategory, string> = {
  backlog: "Not started yet",
  started: "Being worked on",
  done: "Finished",
  cancelled: "Won't be done",
};

/**
 * The category icon, 16 px. Alone (headers, tabs row) it is an image named by its category; next to a column name
 * that already says it (menu items) pass `decorative` so the item's name stays the column name.
 */
export function CategoryIcon({
  category,
  decorative = false,
  className,
}: {
  category: BoardColumnCategory;
  decorative?: boolean;
  className?: string;
}) {
  const { icon: Icon, tone, label } = CATEGORY[category];
  const a11y = decorative ? { "aria-hidden": true as const } : { role: "img", "aria-label": label };
  return <Icon data-category={category} className={cn("size-4 shrink-0", tone, className)} {...a11y} />;
}

/** The count shown next to a column name: the cards in the snapshot, `100+` when more pages exist (P-11). */
export function columnCountLabel(count: number, hasMore: boolean): string {
  return hasMore ? "100+" : String(count);
}

/**
 * A lane header (07.1-UI-SPEC "Column (lane) header"): category icon, name (the lane's `<h2>`, referenced by the
 * lane's `aria-labelledby`), count, then `+` for viewers who can post and the column menu slot for managers
 * (`channel.update`). 40 px tall, sticky at the top of its lane.
 */
export function ColumnHeader({
  column,
  count,
  hasMore,
  canPost,
  canManage,
  onAdd,
  menu,
  className,
}: {
  column: Pick<BoardColumn, "id" | "name" | "category">;
  count: number;
  hasMore: boolean;
  canPost: boolean;
  canManage: boolean;
  onAdd: () => void;
  /** The column menu (07.1-11); rendered only when `canManage`. */
  menu?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="column-header"
      className={cn("sticky top-0 z-10 flex h-10 shrink-0 items-center gap-2 px-2", className)}
    >
      <CategoryIcon category={column.category} />
      <h2 id={`col-${column.id}-name`} className="min-w-0 truncate font-semibold text-sm">
        {column.name}
      </h2>
      <span data-slot="column-count" className="shrink-0 text-muted-foreground text-xs tabular-nums">
        {columnCountLabel(count, hasMore)}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5">
        {canPost ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Add card to ${column.name}`}
            onClick={onAdd}
            className="max-md:size-11"
          >
            <Plus />
          </Button>
        ) : null}
        {canManage && menu !== undefined ? <span data-slot="column-menu">{menu}</span> : null}
      </span>
    </div>
  );
}
