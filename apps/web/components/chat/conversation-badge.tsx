import { badgeStyle, type ConversationNotifyLevel, UNREAD_CAP } from "@ocw/contracts";
import { cn } from "@/lib/utils";

/** "99+" at the cap (the server never counts past `UNREAD_CAP`). */
export function badgeCount(n: number): string {
  return n >= UNREAD_CAP ? "99+" : String(n);
}

/**
 * The badge of one sidebar row (CHAT-09, D-07): a primary pill with the mention count when something addresses the
 * member (even muted), a muted pill with the unread count, a small dot for mention-only levels, or nothing. The
 * caller makes the row bold for any style but "none" and dims muted rows.
 */
export function ConversationBadge(p: {
  level: ConversationNotifyLevel;
  muted: boolean;
  unreadCount: number;
  mentionCount: number;
  className?: string;
}) {
  const style = badgeStyle(p);
  if (style === "none") return null;
  if (style === "dot") {
    return (
      <span data-testid="unread-badge" data-style="dot" className={cn("ml-auto flex shrink-0", p.className)}>
        <span className="sr-only">(unread)</span>
        <span aria-hidden className="size-2 rounded-full bg-foreground/70" />
      </span>
    );
  }
  const mention = style === "mention";
  const n = mention ? p.mentionCount : p.unreadCount;
  return (
    <span
      data-testid="unread-badge"
      data-style={style}
      data-count={badgeCount(n)}
      className={cn(
        "ml-auto inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1.5 font-semibold text-[11px] tabular-nums leading-none",
        mention
          ? "bg-primary text-primary-foreground"
          : "bg-foreground/[0.08] text-foreground/75 dark:bg-foreground/[0.14] dark:text-foreground/85",
        p.className,
      )}
    >
      <span aria-hidden>{badgeCount(n)}</span>
      <span className="sr-only">
        {mention ? ` (${badgeCount(n)} mentions)` : ` (${badgeCount(n)} unread)`}
      </span>
    </span>
  );
}
