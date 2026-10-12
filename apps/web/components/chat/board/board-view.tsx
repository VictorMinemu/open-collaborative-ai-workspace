"use client";

import { move } from "@dnd-kit/helpers";
import {
  DragDropProvider,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  useDroppable,
} from "@dnd-kit/react";
import { isSortable } from "@dnd-kit/react/sortable";
import type { BoardCard, BoardColumn as BoardColumnModel, BoardSnapshot } from "@ocw/contracts";
import { Plus, SquareKanban } from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsDesktop, useMediaQuery } from "@/hooks/use-media-query";
import { errorMessage } from "@/lib/api";
import { useBoardColumnPage, usePendingCardIds, useUpdateBoardCard } from "@/lib/board-queries";
import { cn } from "@/lib/utils";
import { BoardColumn, EmptyLane } from "./board-column";
import { CardMenu, type CardMoveIntent, menuColumns } from "./card-menu";
import { type CardAuthor, CardTile } from "./card-tile";
import { CATEGORY, CategoryIcon, columnCountLabel } from "./column-header";
import { defaultColumnOf } from "./new-card-dialog";
import { SortableCard } from "./sortable-card";

/**
 * The board of a board channel (07.1-UI-SPEC Layout and Interaction Contracts; BOARD-02, BOARD-03, D-04, D-05, P-05).
 * At 1440: 272 px lanes side by side in a horizontal scroller (snap, right fade while more lanes exist). Below 768:
 * underline column tabs with counts and one column's cards. Cards move by pointer, keyboard (dnd-kit, desktop), touch
 * long-press (reorder within the column at 390) and the card menu; every move is one intent the server places
 * (`useUpdateBoardCard`, no rank in the browser), optimistic, rolled back and announced by the 07.1-04 cache. The
 * board's own outcomes (menu moves, waiting changes, rollbacks, conflicts) go to its one polite live region; drag
 * pick-up, position and drop go to dnd-kit's live region with the UI-SPEC copy. With `@dnd-kit/react/sortable`, this
 * file and `sortable-card.tsx` are the only dnd-kit importers.
 */

export interface BoardViewProps {
  channel: { id: string; name: string };
  snapshot: BoardSnapshot | undefined;
  loading: boolean;
  /** The snapshot request failed (null otherwise). */
  error: unknown;
  onRetry: () => void;
  /** Member of an active channel: moves, adds, waiting state. False = read-only (non-member preview, archived). */
  canPost: boolean;
  /** `channel.update` (column actions, 07.1-11). */
  canManage?: boolean;
  /** The card author's display, from the channel member directory; null = "Former member". */
  authorOf: (kind: BoardCard["authorKind"], id: string) => CardAuthor;
  onOpenCard: (messageId: string) => void;
  /** The card whose thread is open (`?thread=`). */
  selectedCardId: string | null;
  /** "+" of a lane (its column) or the empty board's New card (the default column). */
  onAddCard: (columnId: string | null) => void;
  /** The column tab shown below 768 px (`?col=`); null = the default column. */
  activeColumnId: string | null;
  onActiveColumnChange: (columnId: string) => void;
}

type Items = Record<string, string[]>;
type Focus = { id: string; part: "grip" | "menu" | "open" | "tabs" };

const INSTRUCTIONS =
  "Press Space or Enter to pick up the card. Use the arrow keys to move it up, down or to another column. Press Space or Enter to drop it, or Escape to cancel.";

function itemsOf(s: BoardSnapshot): Items {
  const out: Items = {};
  for (const col of s.columns) out[col.id] = [];
  for (const col of s.cards) {
    if (out[col.columnId]) out[col.columnId] = col.cards.map((c) => c.messageId);
  }
  return out;
}

function locate(items: Items | null, id: string): { col: string; at: number } | null {
  if (!items) return null;
  for (const [col, ids] of Object.entries(items)) {
    const at = ids.indexOf(id);
    if (at !== -1) return { col, at };
  }
  return null;
}

const cardSelector = (id: string) => `[data-testid="board-card"][data-card-id="${CSS.escape(id)}"]`;

type ProviderProps = ComponentProps<typeof DragDropProvider>;
type PluginsFn = Extract<NonNullable<ProviderProps["plugins"]>, (...args: never[]) => unknown>;
type PluginList = Parameters<PluginsFn>[0];

interface Labels {
  title: (id: string) => string;
  column: (id: string) => string;
  items: () => Items | null;
  /** The column a card was in when the drag started (dnd-kit's own `initialGroup` changes when a card is remounted in another lane mid-drag). */
  origin: (id: string) => string | null;
}

/**
 * dnd-kit's Accessibility plugin with the UI-SPEC instructions and announcements. `@dnd-kit/react` does not re-export
 * the plugin class, so it is found among the defaults (by name, else the first entry, as in `@dnd-kit/dom` 0.5.0's
 * preset) and replaced by a descriptor carrying the options. The e2e asserts the copy, so a change upstream fails.
 */
function withBoardAnnouncements(defaults: PluginList, labels: { current: Labels }): PluginList {
  const named = defaults.findIndex((p) => typeof p === "function" && p.name === "Accessibility");
  const at = named === -1 ? 0 : named;
  const where = (id: string) => {
    const pos = locate(labels.current.items(), id);
    if (!pos) return null;
    const n = labels.current.items()?.[pos.col]?.length ?? 0;
    return { column: labels.current.column(pos.col), i: pos.at + 1, n };
  };
  const title = (id: string) => `“${labels.current.title(id)}”`;
  const options = {
    id: "board",
    screenReaderInstructions: { draggable: INSTRUCTIONS },
    announcements: {
      dragstart: ({ operation: { source } }: DragStartEvent) => {
        if (!source) return undefined;
        const p = where(String(source.id));
        return p
          ? `Picked up ${title(String(source.id))}. ${p.column}, position ${p.i} of ${p.n}.`
          : undefined;
      },
      dragover: ({ operation: { source, target } }: DragOverEvent) => {
        // Announced once the card has settled in its new slot (the sortable re-targets itself after each shift).
        if (!source || !target || target.id !== source.id) return undefined;
        const p = where(String(source.id));
        return p ? `${title(String(source.id))} is in ${p.column}, position ${p.i} of ${p.n}.` : undefined;
      },
      dragend: ({ operation: { source, target }, canceled }: DragEndEvent) => {
        if (!source) return undefined;
        const id = String(source.id);
        if (canceled || !target) {
          const from =
            labels.current.origin(id) ?? (isSortable(source) ? String(source.sortable.initialGroup) : "");
          return `Move cancelled. ${title(id)} is back in ${labels.current.column(from)}.`;
        }
        const p = where(id);
        return p ? `${title(id)} dropped in ${p.column}, position ${p.i} of ${p.n}.` : undefined;
      },
    },
  };
  return defaults.map((p, k) => {
    if (k !== at) return p;
    const plugin = typeof p === "function" ? p : p.plugin;
    return { plugin, options } as unknown as PluginList[number];
  });
}

export function BoardView(props: BoardViewProps) {
  const {
    channel,
    snapshot,
    loading,
    error,
    onRetry,
    canPost,
    canManage = false,
    authorOf,
    onOpenCard,
    selectedCardId,
    onAddCard,
    activeColumnId,
    onActiveColumnChange,
  } = props;
  const isDesktop = useIsDesktop();
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const rootRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------- the board's own polite live region
  const [live, setLive] = useState("");
  const announce = useCallback((text: string) => setLive((prev) => (prev === text ? `${text} ` : text)), []);
  const update = useUpdateBoardCard(channel.id, { announce, channelName: channel.name });
  const pendingIds = usePendingCardIds(channel.id);

  // ---------------------------------------------------------------- focus that must land after a re-render
  const focusNext = useRef<Focus | null>(null);
  const focusLanded = useRef(false);
  const tryFocus = useCallback(() => {
    const f = focusNext.current;
    const root = rootRef.current;
    if (!f || !root) return;
    let el: HTMLElement | null = null;
    if (f.part === "tabs")
      el = root.querySelector<HTMLElement>('[data-testid="board-tabs"] [aria-selected="true"]');
    else {
      const tile = root.querySelector(cardSelector(f.id));
      const slot =
        f.part === "grip"
          ? '[data-slot="card-grip-button"]'
          : f.part === "menu"
            ? '[data-testid="card-menu"]'
            : '[data-slot="card-open"]';
      el = tile?.querySelector<HTMLElement>(slot) ?? null;
    }
    if (!el || document.activeElement === el) {
      if (el) focusLanded.current = true;
      return;
    }
    // Once focus has landed, only take it back when it was lost (a closing menu returned it to an unmounted
    // trigger, so it fell to <body>); never from a control the person has moved to since, such as another menu.
    const lost = !document.activeElement || document.activeElement === document.body;
    if (focusLanded.current && !lost) return;
    el.focus({ preventScroll: false });
    if (document.activeElement === el) focusLanded.current = true;
  }, []);
  const requestFocus = useCallback(
    (f: Focus) => {
      focusNext.current = f;
      focusLanded.current = false;
      // After React re-renders the card in its new place, and again after a closing menu has returned focus to its
      // (possibly unmounted) trigger; the request lapses once the menu has closed.
      for (const ms of [0, 60, 200, 350]) window.setTimeout(tryFocus, ms);
      window.setTimeout(() => {
        if (focusNext.current === f) focusNext.current = null;
      }, 400);
    },
    [tryFocus],
  );
  useEffect(() => tryFocus());

  // ---------------------------------------------------------------- the open card (thread)
  const prevSelected = useRef<string | null>(selectedCardId);
  useEffect(() => {
    const prev = prevSelected.current;
    prevSelected.current = selectedCardId;
    if (selectedCardId) {
      rootRef.current?.querySelector(cardSelector(selectedCardId))?.scrollIntoView({
        inline: "nearest",
        block: "nearest",
        behavior: reducedMotion ? "auto" : "smooth",
      });
    } else if (prev) {
      requestFocus({ id: prev, part: "open" });
    }
  }, [selectedCardId, reducedMotion, requestFocus]);

  // ---------------------------------------------------------------- data
  const cardsById = useMemo(() => {
    const map = new Map<string, BoardCard>();
    for (const col of snapshot?.cards ?? []) for (const c of col.cards) map.set(c.messageId, c);
    return map;
  }, [snapshot]);
  const baseItems = useMemo(() => (snapshot ? itemsOf(snapshot) : {}), [snapshot]);
  const menuCols = useMemo(() => (snapshot ? menuColumns(snapshot) : []), [snapshot]);
  const columnName = useCallback(
    (id: string) => snapshot?.columns.find((c) => c.id === id)?.name ?? "",
    [snapshot],
  );

  // ---------------------------------------------------------------- drag and drop
  const [items, setItemsState] = useState<Items | null>(null);
  const itemsRef = useRef<Items | null>(null);
  const startItems = useRef<Items | null>(null);
  const baseRef = useRef(baseItems);
  baseRef.current = baseItems;
  const setItems = (next: Items | null) => {
    itemsRef.current = next;
    setItemsState(next);
  };
  const [dragId, setDragId] = useState<string | null>(null);
  const [keyboardDrag, setKeyboardDrag] = useState(false);

  const labels = useRef<Labels>({ title: () => "", column: () => "", items: () => null, origin: () => null });
  labels.current = {
    title: (id) => cardsById.get(id)?.title ?? "card",
    column: columnName,
    items: () => itemsRef.current ?? startItems.current ?? baseRef.current,
    origin: (id) => locate(startItems.current ?? baseRef.current, id)?.col ?? null,
  };
  const plugins = useMemo<PluginsFn>(() => (defaults) => withBoardAnnouncements(defaults, labels), []);

  const onDragStart = (event: DragStartEvent) => {
    const source = event.operation.source;
    if (!source) return;
    startItems.current = baseRef.current;
    setItems(baseRef.current);
    setDragId(String(source.id));
    setKeyboardDrag(event.operation.activatorEvent instanceof KeyboardEvent);
  };
  const onDragOver = (event: DragOverEvent) => {
    const source = event.operation.source;
    if (source?.type !== "card" || !itemsRef.current) return;
    // Below 768 a card reorders within its column only; cross-column moves go through "Move to…".
    if (!isDesktop && event.operation.target?.type === "column") return;
    const next = move(itemsRef.current, event);
    if (next !== itemsRef.current) setItems(next);
  };
  const onDragEnd = (event: DragEndEvent) => {
    const source = event.operation.source;
    const final = itemsRef.current;
    const before = startItems.current;
    setItems(null);
    setDragId(null);
    if (!source || !final || !before) return;
    const id = String(source.id);
    if (event.operation.activatorEvent instanceof KeyboardEvent) requestFocus({ id, part: "grip" });
    // Escape, or a drop outside every lane: the card stays where it was and nothing is sent.
    if (event.canceled || !event.operation.target) return;
    const to = locate(final, id);
    const from = locate(before, id);
    if (!to || !from) return;
    const afterCardId = to.at > 0 ? (final[to.col]?.[to.at - 1] ?? null) : null;
    const wasAfter = from.at > 0 ? (before[from.col]?.[from.at - 1] ?? null) : null;
    if (to.col === from.col && afterCardId === wasAfter) return;
    update.mutate({ messageId: id, move: { columnId: to.col, afterCardId }, via: "drag" });
  };

  // ---------------------------------------------------------------- menu actions
  const activeColumn = snapshot
    ? (snapshot.columns.find((c) => c.id === activeColumnId) ??
      snapshot.columns.find((c) => c.id === defaultColumnOf(snapshot)))
    : undefined;
  const moveFromMenu = (cardId: string, intent: CardMoveIntent) => {
    update.mutate({ messageId: cardId, move: intent.move, via: intent.via });
    const leftTab = !isDesktop && intent.move.columnId !== activeColumn?.id;
    requestFocus(leftTab ? { id: cardId, part: "tabs" } : { id: cardId, part: "menu" });
  };

  const renderCard = (card: BoardCard, index: number, columnId: string) => {
    const pending = pendingIds.includes(card.messageId);
    const common = {
      card,
      board: snapshot?.board ?? { prefix: null, namingRule: null },
      author: authorOf(card.authorKind, card.authorId),
      selected: selectedCardId === card.messageId,
      pending,
      onOpen: () => onOpenCard(card.messageId),
      menu: (
        <CardMenu
          card={card}
          columns={menuCols}
          // One change per card at a time: a second one would carry a stale expectedVersion (409).
          canPost={canPost && !pending}
          onOpen={() => onOpenCard(card.messageId)}
          onMove={(intent) => moveFromMenu(card.messageId, intent)}
          onWaitingOn={(waitingOn) => update.mutate({ messageId: card.messageId, waitingOn })}
        />
      ),
    };
    return canPost ? (
      <SortableCard
        key={card.messageId}
        index={index}
        columnId={columnId}
        mode={isDesktop ? "desktop" : "touch"}
        reducedMotion={reducedMotion}
        {...common}
      />
    ) : (
      <CardTile key={card.messageId} canPost={false} {...common} />
    );
  };

  const order = items ?? baseItems;
  const idsIn = (columnId: string) => (order[columnId] ?? []).filter((id) => cardsById.has(id));
  const boardEmpty = snapshot ? snapshot.cards.every((c) => c.cards.length === 0) : false;
  const defaultCol = snapshot ? defaultColumnOf(snapshot) : null;

  const emptyBoard = (
    <div data-slot="board-empty" className="grid gap-1 rounded-lg border border-dashed px-4 py-6 text-center">
      <p className="font-semibold text-sm">No cards yet</p>
      <p className="text-muted-foreground text-xs">
        Add one for each case, order or ticket. @mention a bot in a card to get it working.
      </p>
      {canPost ? (
        <Button size="sm" className="mx-auto mt-3 max-md:h-11" onClick={() => onAddCard(defaultCol)}>
          <Plus /> New card
        </Button>
      ) : null}
    </div>
  );
  const emptyFor = (columnId: string): ReactNode =>
    boardEmpty && columnId === defaultCol ? emptyBoard : "No cards";

  // ---------------------------------------------------------------- render
  let body: ReactNode;
  if (!snapshot && error) {
    body = (
      <EmptyState icon={SquareKanban} title="Couldn't load this board" description={errorMessage(error)}>
        <Button variant="outline" onClick={onRetry} className="max-md:h-11">
          Try again
        </Button>
      </EmptyState>
    );
  } else if (!snapshot || loading) {
    body = <BoardSkeleton desktop={isDesktop} />;
  } else if (isDesktop) {
    body = (
      <LaneScroller columnCount={snapshot.columns.length}>
        {snapshot.columns.map((col) => {
          const ids = idsIn(col.id);
          const entry = snapshot.cards.find((c) => c.columnId === col.id);
          return (
            <Lane
              key={col.id}
              convId={channel.id}
              column={col}
              count={entry?.cards.length ?? 0}
              hasMore={entry?.hasMore ?? false}
              lastRank={entry?.cards.at(-1)?.rank ?? null}
              canPost={canPost}
              canManage={canManage}
              onAdd={() => onAddCard(col.id)}
              holdsDrag={dragId !== null && ids.includes(dragId)}
              empty={emptyFor(col.id)}
            >
              {ids.length > 0
                ? ids.map((id, index) => {
                    const card = cardsById.get(id);
                    return card ? renderCard(card, index, col.id) : null;
                  })
                : undefined}
            </Lane>
          );
        })}
      </LaneScroller>
    );
  } else if (activeColumn) {
    body = (
      <ColumnTabs
        snapshot={snapshot}
        active={activeColumn}
        onActiveChange={onActiveColumnChange}
        canPost={canPost}
        canManage={canManage}
        onAdd={() => onAddCard(activeColumn.id)}
        convId={channel.id}
        empty={emptyFor(activeColumn.id)}
      >
        {idsIn(activeColumn.id).map((id, index) => {
          const card = cardsById.get(id);
          return card ? renderCard(card, index, activeColumn.id) : null;
        })}
      </ColumnTabs>
    );
  }

  const dragged = dragId ? cardsById.get(dragId) : undefined;

  return (
    <div
      ref={rootRef}
      role="region"
      aria-label={`#${channel.name} board`}
      data-testid="board-view"
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div aria-live="polite" className="sr-only" data-testid="board-live">
        {live}
      </div>
      <DragDropProvider
        plugins={plugins}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
      >
        {body}
        <DragOverlay tag="ul" className="list-none" dropAnimation={reducedMotion ? null : undefined}>
          {dragged && snapshot ? (
            <CardTile
              card={dragged}
              board={snapshot.board}
              author={authorOf(dragged.authorKind, dragged.authorId)}
              canPost={false}
              appearance="overlay"
              onOpen={() => {}}
              aria-hidden
              className={cn(
                "pointer-events-none",
                keyboardDrag && "[&>div]:outline-2 [&>div]:outline-primary [&>div]:outline-solid",
              )}
            />
          ) : null}
        </DragOverlay>
      </DragDropProvider>
    </div>
  );
}

// ---------------------------------------------------------------- desktop pieces

/** The horizontal lane scroller: snap, and a 24 px right fade only while more lanes sit to the right. */
function LaneScroller({ columnCount, children }: { columnCount: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [moreRight, setMoreRight] = useState(false);
  const measure = useCallback(() => {
    const el = ref.current;
    if (el) setMoreRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when lanes are added or removed
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, columnCount]);
  const fade = "linear-gradient(to right, black calc(100% - 24px), transparent)";
  return (
    <div
      ref={ref}
      onScroll={measure}
      data-slot="board-scroller"
      data-more-right={moreRight ? "true" : undefined}
      className="scrollbar-thin flex min-h-0 flex-1 snap-x snap-proximity items-start gap-3 overflow-x-auto scroll-px-4 px-4 pt-4 pb-6 sm:scroll-px-6 sm:px-6"
      style={moreRight ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
    >
      {children}
    </div>
  );
}

function Lane({
  convId,
  column,
  count,
  hasMore,
  lastRank,
  canPost,
  canManage,
  onAdd,
  holdsDrag,
  empty,
  children,
}: {
  convId: string;
  column: BoardColumnModel;
  count: number;
  hasMore: boolean;
  lastRank: string | null;
  canPost: boolean;
  canManage: boolean;
  onAdd: () => void;
  holdsDrag: boolean;
  empty: ReactNode;
  children?: ReactNode;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: column.id,
    type: "column",
    accept: "card",
    // Low (CollisionPriority.Low): a card under the pointer wins over its lane.
    collisionPriority: 1,
    disabled: !canPost,
  });
  return (
    <BoardColumn
      column={column}
      count={count}
      hasMore={hasMore}
      canPost={canPost}
      canManage={canManage}
      onAdd={onAdd}
      bodyRef={ref}
      dropTarget={holdsDrag || isDropTarget}
      empty={empty}
      footer={hasMore ? <ShowMore convId={convId} columnId={column.id} lastRank={lastRank} /> : null}
    >
      {children}
    </BoardColumn>
  );
}

/** "Show more cards" for a column with more than one page (P-11); its own error and Try again. */
function ShowMore({
  convId,
  columnId,
  lastRank,
}: {
  convId: string;
  columnId: string;
  lastRank: string | null;
}) {
  const page = useBoardColumnPage(convId, columnId, lastRank);
  return (
    <div className="grid gap-1 pt-1">
      {page.isError ? (
        <p role="alert" className="text-center text-muted-foreground text-xs">
          Couldn't load more cards.
        </p>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        className="w-full max-md:h-11"
        disabled={page.isPending}
        onClick={() => page.load()}
        data-testid="show-more-cards"
      >
        {page.isPending ? <Spinner /> : null}
        {page.isError ? "Try again" : "Show more cards"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- 390 pieces

const CATEGORY_MEANING: Record<BoardColumnModel["category"], string> = {
  backlog: "Not started yet",
  started: "Being worked on",
  done: "Finished",
  cancelled: "Won't be done",
};

function ColumnTabs({
  snapshot,
  active,
  onActiveChange,
  canPost,
  canManage,
  onAdd,
  convId,
  empty,
  children,
}: {
  snapshot: BoardSnapshot;
  active: BoardColumnModel;
  onActiveChange: (columnId: string) => void;
  canPost: boolean;
  canManage: boolean;
  onAdd: () => void;
  convId: string;
  empty: ReactNode;
  children: ReactNode[];
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // The selected tab scrolls into view (a link or a thread round trip may land on a far column).
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-column-id="${CSS.escape(active.id)}"]`)
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [active.id]);
  const entry = (id: string) => snapshot.cards.find((c) => c.columnId === id);
  const activeEntry = entry(active.id);
  const hasCards = children.some(Boolean);
  return (
    <Tabs
      variant="underline"
      value={active.id}
      onValueChange={(v) => onActiveChange(String(v))}
      className="min-h-0 flex-1"
    >
      <TabsList ref={listRef} aria-label="Columns" data-testid="board-tabs" className="shrink-0 px-1">
        {snapshot.columns.map((c) => {
          const e = entry(c.id);
          const count = columnCountLabel(e?.cards.length ?? 0, e?.hasMore ?? false);
          return (
            <TabsTrigger
              key={c.id}
              value={c.id}
              data-column-id={c.id}
              aria-label={`${c.name}, ${count} ${count === "1" ? "card" : "cards"}`}
            >
              <span className="max-w-40 truncate">{c.name}</span>
              <span className="font-normal text-muted-foreground text-xs tabular-nums">{count}</span>
            </TabsTrigger>
          );
        })}
      </TabsList>
      {canPost || canManage ? (
        <div data-slot="active-column" className="flex h-11 shrink-0 items-center gap-2 border-b pr-1 pl-4">
          <CategoryIcon category={active.category} />
          <span className="min-w-0 truncate text-muted-foreground text-xs">
            {CATEGORY[active.category].label} · {CATEGORY_MEANING[active.category]}
          </span>
          {canPost ? (
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto size-11"
              aria-label={`Add card to ${active.name}`}
              onClick={onAdd}
            >
              <Plus />
            </Button>
          ) : null}
        </div>
      ) : null}
      {snapshot.columns.map((c) => (
        <TabsContent
          key={c.id}
          value={c.id}
          className="scrollbar-thin min-h-0 overflow-y-auto overscroll-contain"
          data-testid={c.id === active.id ? "board-column-panel" : undefined}
        >
          {c.id === active.id ? (
            <div className="grid gap-2 px-4 pt-3 pb-[max(env(safe-area-inset-bottom),16px)]">
              {hasCards ? (
                <ol
                  aria-label={`${c.name} cards`}
                  className="grid gap-2"
                  data-testid="board-column"
                  data-column-id={c.id}
                >
                  {children}
                </ol>
              ) : typeof empty === "string" ? (
                <EmptyLane label={empty} />
              ) : (
                empty
              )}
              {activeEntry?.hasMore ? (
                <ShowMore convId={convId} columnId={c.id} lastRank={activeEntry.cards.at(-1)?.rank ?? null} />
              ) : null}
            </div>
          ) : null}
        </TabsContent>
      ))}
    </Tabs>
  );
}

// ---------------------------------------------------------------- loading

function BoardSkeleton({ desktop }: { desktop: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy="true">
      <span className="sr-only">Loading board</span>
      {desktop ? (
        <div className="flex min-h-0 flex-1 items-start gap-3 overflow-hidden px-4 pt-4 pb-6 sm:px-6">
          {[3, 2, 1, 1].map((n, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed placeholder list
              key={i}
              data-testid="board-lane-skeleton"
              className="grid w-68 shrink-0 gap-2 rounded-xl bg-muted/50 p-2 dark:bg-white/[0.03]"
            >
              <Skeleton className="h-6 w-32 motion-reduce:animate-none" />
              {Array.from({ length: n }, (_, k) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a fixed placeholder list
                <Skeleton key={k} className="h-19 rounded-lg motion-reduce:animate-none" />
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-2">
          <div className="flex h-11 items-center gap-4 border-b px-4">
            {[20, 24, 14].map((w) => (
              <Skeleton key={w} className="h-4 motion-reduce:animate-none" style={{ width: `${w * 4}px` }} />
            ))}
          </div>
          <div className="grid gap-2 px-4 pt-1">
            {[0, 1, 2].map((k) => (
              <Skeleton key={k} className="h-19 rounded-lg motion-reduce:animate-none" />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
