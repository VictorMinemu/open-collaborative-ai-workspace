"use client";

import { type Board, type BoardCard, namingRuleTokens } from "@ocw/contracts";
import { MessageSquare } from "lucide-react";
import { type ComponentProps, type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { Tooltip } from "@/components/ui/tooltip";
import { useWatchSentence, WatchedIndicator } from "@/components/watched/watched-indicator";
import { shortAgo } from "@/components/work-zone/session-sidebar";
import { cn, relativeTime } from "@/lib/utils";
import { WAITING, WaitingOnBadge } from "./waiting-on-badge";

/**
 * A board card tile (07.1-UI-SPEC "Card tile", BOARD-02). Presentational only: no drag and drop and no fetching; the
 * board view (07.1-08) passes the grip and the menu as slots. Structure, with no nested buttons: `<li>` → `div.relative`
 * holding, in DOM and focus order, the grip slot (z-10, only for viewers who can post), the open button stretched over
 * the whole tile (`after:absolute`) that carries the title and footer, and the menu slot (z-10). Titles are untrusted
 * user or agent text and render as React text nodes only, never Markdown (T-07.1-04-02).
 */

/** Separators after which a title that repeats the card number is shown without it. */
const NUMBER_SEPARATORS = [" · ", " - ", " — "] as const;

/**
 * The card number shown on the badge, e.g. `EXP-0007`: zero-padded to the board rule's `{seq:0…}` width, unpadded
 * without one; null when the board has no prefix (cards are numbered only on prefixed boards) or the card no number.
 */
export function cardNumberLabel(
  board: Pick<Board, "prefix" | "namingRule">,
  number: number | null,
): string | null {
  if (!board.prefix || number === null) return null;
  const seq = board.namingRule ? namingRuleTokens(board.namingRule).find((t) => t.kind === "seq") : undefined;
  const pad = seq?.kind === "seq" ? seq.pad : 0;
  return `${board.prefix}-${String(number).padStart(pad, "0")}`;
}

/** The title as the tile shows it: without a leading copy of the badge's number (the number is shown once). */
export function shownTitle(title: string, label: string | null): string {
  if (!label) return title;
  for (const sep of NUMBER_SEPARATORS) {
    const head = label + sep;
    if (title.startsWith(head) && title.length > head.length) return title.slice(head.length);
  }
  return title;
}

/** The latest of last reply, last move and creation: the tile's "last activity". */
export function lastActivityOf(card: Pick<BoardCard, "lastReplyAt" | "movedAt" | "createdAt">): string {
  return [card.lastReplyAt, card.movedAt, card.createdAt]
    .filter((t): t is string => t !== null)
    .reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

const replies = (n: number) => (n === 1 ? "1 reply" : `${n} replies`);

const fullDate = (iso: string) =>
  new Date(iso).toLocaleString("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export type CardAuthor = { name: string; avatarUrl?: string | null } | null;

export type CardTileProps = Omit<ComponentProps<"li">, "children"> & {
  card: BoardCard;
  board: Pick<Board, "prefix" | "namingRule">;
  /** Resolved from the channel member directory; null = unknown ("Former member"). */
  author: CardAuthor;
  /** The card whose thread is open: `aria-current` and the primary ring. */
  selected?: boolean;
  /** A move or waiting change is in flight: `aria-busy`, no visual change (optimistic). */
  pending?: boolean;
  /** Members of an active channel; false = no grip slot (non-members, archived boards). */
  canPost: boolean;
  grip?: ReactNode;
  menu?: ReactNode;
  onOpen: () => void;
  /** Ref of the open button, so focus can return to it when the thread closes. */
  openRef?: Ref<HTMLButtonElement>;
  /** Drag states (07.1-08): the source placeholder or the overlay tile following the pointer. */
  appearance?: "default" | "placeholder" | "overlay";
  /** Clock for "last activity" (tests); defaults to the render time. */
  now?: number;
};

export function CardTile({
  card,
  board,
  author,
  selected = false,
  pending = false,
  canPost,
  grip,
  menu,
  onOpen,
  openRef,
  appearance = "default",
  now,
  className,
  ...li
}: CardTileProps) {
  const descriptionId = useId();
  const titleRef = useRef<HTMLSpanElement>(null);
  const [clamped, setClamped] = useState(false);

  // The full title goes in a tooltip only when the 2-line clamp actually cut it (pointer devices; Base UI tooltips
  // do not open on touch).
  useEffect(() => {
    const el = titleRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const label = cardNumberLabel(board, card.number);
  const title = shownTitle(card.title, label);
  const accessibleName = !label || title !== card.title ? card.title : `${label} ${card.title}`;
  const at = lastActivityOf(card);
  const clock = now ?? Date.now();
  // 07.6-17: a tile on a board (it has a menu) shows its watched record; the template preview has none.
  const onBoard = menu !== undefined;
  const watchSentence = useWatchSentence(
    { messageId: card.messageId, conversationId: onBoard ? card.conversationId : "" },
    now,
  );
  const description = [
    card.waitingOn === "none" ? null : `${WAITING[card.waitingOn].label}.`,
    watchSentence,
    card.replyCount === 0 ? "No replies." : `${replies(card.replyCount)}.`,
    `Last activity ${relativeTime(at, clock)}.`,
  ]
    .filter(Boolean)
    .join(" ");
  const showGrip = canPost && grip !== undefined;
  const authorName = author?.name ?? "Former member";
  // The first visible row leaves room for the grip (left) and the menu (right), which sit over it.
  const firstRow = cn(showGrip && "pl-6", menu !== undefined && "pr-7");

  return (
    <li data-testid="board-card" data-card-id={card.messageId} className={cn("list-none", className)} {...li}>
      <div
        className={cn(
          "group/tile relative grid min-h-19 grid-cols-[auto_minmax(0,1fr)_auto] rounded-lg border bg-card p-3 shadow-xs transition-colors hover:border-foreground/15 dark:shadow-none",
          selected && "ring-2 ring-primary/60",
          appearance === "placeholder" &&
            "border-dashed border-primary/40 bg-primary/5 shadow-none *:invisible",
          appearance === "overlay" && "shadow-lg motion-safe:rotate-1",
        )}
      >
        {showGrip ? (
          <div
            data-slot="card-grip"
            className="relative z-10 col-start-1 row-start-1 flex h-5 items-center self-start"
          >
            {grip}
          </div>
        ) : null}

        <Tooltip content={card.title} disabled={!clamped} className="max-w-72 whitespace-normal break-words">
          <button
            ref={openRef}
            type="button"
            data-slot="card-open"
            aria-label={accessibleName}
            aria-describedby={descriptionId}
            aria-current={selected ? "true" : undefined}
            aria-busy={pending ? "true" : undefined}
            onClick={onOpen}
            className="col-span-3 col-start-1 row-start-1 grid min-w-0 cursor-pointer gap-2 text-left outline-none after:absolute after:-inset-px after:rounded-lg focus-visible:after:ring-[3px] focus-visible:after:ring-ring/40"
          >
            {label ? (
              <span className={cn("flex h-5 items-center", firstRow)}>
                <span className="font-mono text-muted-foreground text-xs tabular-nums">{label}</span>
              </span>
            ) : null}
            <span
              ref={titleRef}
              className={cn("line-clamp-2 break-words font-semibold text-sm leading-5", !label && firstRow)}
            >
              {title}
            </span>
            <WaitingOnBadge state={card.waitingOn} />
            <span className="flex h-5 items-center justify-between gap-2 text-muted-foreground text-xs tabular-nums">
              <span title={authorName} className="inline-flex">
                <PrincipalAvatar
                  kind={card.authorKind}
                  name={authorName}
                  avatarUrl={author?.avatarUrl}
                  seed={card.authorId}
                  compact
                  className="size-5 text-[10px]"
                />
              </span>
              <span className="inline-flex items-center gap-1">
                {onBoard ? <WatchedIndicator card={card} now={now} /> : null}
                {card.replyCount > 0 ? (
                  <>
                    <span data-testid="card-replies" className="inline-flex items-center gap-1">
                      <MessageSquare className="size-3.5" aria-hidden />
                      {card.replyCount}
                    </span>
                    <span aria-hidden>·</span>
                  </>
                ) : null}
                <time dateTime={at} title={`Last activity ${fullDate(at)}`}>
                  {shortAgo(at, clock)}
                </time>
              </span>
            </span>
          </button>
        </Tooltip>

        {menu !== undefined ? (
          <div
            data-slot="card-menu"
            className="z-10 col-start-3 row-start-1 -my-1 -mr-1 self-start max-md:-my-3 max-md:-mr-3"
          >
            {menu}
          </div>
        ) : null}

        <span id={descriptionId} hidden>
          {description}
        </span>
      </div>
    </li>
  );
}
