"use client";

import type { Message, MessageAuthor } from "@ocw/contracts";
import { AlertCircle, MessageSquareReply, RotateCw } from "lucide-react";
import { Fragment, memo, type ReactNode } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn, relativeTime } from "@/lib/utils";
import { Markdown } from "./markdown";
import { BotBadge, PrincipalAvatar } from "./principal-avatar";
import { type Typer, TypingDots } from "./typing";

/** A message being sent (optimistic) or that failed to send. */
export interface PendingMessage {
  clientMessageId: string;
  body: string;
  threadRootId: string | null;
  failed: boolean;
  createdAt: string;
}

const GROUP_WINDOW_MS = 5 * 60_000;

const timeFmt = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
const fullFmt = new Intl.DateTimeFormat("en", { dateStyle: "full", timeStyle: "short" });

export function formatTime(iso: string) {
  return timeFmt.format(new Date(iso));
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}

const authorKey = (a: MessageAuthor | undefined, m: { authorKind: string; authorId: string | null }) =>
  `${a?.kind ?? m.authorKind}:${a?.id ?? m.authorId ?? ""}`;

function DayDivider({ label }: { label: string }) {
  return (
    <div className="relative my-3 flex items-center px-4 sm:px-5" role="separator">
      <div className="h-px flex-1 bg-border" />
      <span className="mx-3 rounded-full border bg-background px-3 py-0.5 font-medium text-[11.5px] text-muted-foreground">
        {label}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function ThreadSummary({
  message,
  typers,
  onOpen,
}: {
  message: Message;
  typers: Typer[];
  onOpen: () => void;
}) {
  const replying = typers.filter((t) => t.threadRootId === message.id);
  if (message.replyCount === 0 && replying.length === 0) return null;
  const participants = message.replyParticipants ?? [];
  return (
    <button
      type="button"
      data-testid="thread-summary"
      onClick={onOpen}
      className="group/thread -ml-1.5 mt-1 flex max-w-full items-center gap-2 rounded-lg border border-transparent px-1.5 py-1 text-left text-[13px] outline-none transition-colors hover:border-border hover:bg-background focus-visible:ring-[3px] focus-visible:ring-ring/40"
    >
      {participants.length > 0 ? (
        <span className="flex -space-x-1">
          {participants.slice(0, 4).map((p) => (
            <PrincipalAvatar
              key={`${p.kind}:${p.id}`}
              kind={p.kind}
              name={p.displayName}
              avatarUrl={p.avatarUrl}
              seed={p.id}
              compact
              className="size-5 text-[9px] ring-2 ring-background"
            />
          ))}
        </span>
      ) : null}
      {message.replyCount > 0 ? (
        <span className="font-semibold text-primary">
          {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
        </span>
      ) : null}
      {replying.length > 0 ? (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <TypingDots className="text-primary" />
          {replying[0]?.name} is replying
        </span>
      ) : message.lastReplyAt ? (
        <span className="truncate text-muted-foreground">
          <span className="group-hover/thread:hidden">Last reply {relativeTime(message.lastReplyAt)}</span>
          <span className="hidden group-hover/thread:inline">View thread</span>
        </span>
      ) : null}
    </button>
  );
}

interface RowProps {
  message: Message;
  continuation: boolean;
  typers: Typer[];
  onOpenThread?: ((id: string) => void) | undefined;
  highlighted: boolean;
  showThreadSummary: boolean;
}

const MessageRow = memo(function MessageRow({
  message,
  continuation,
  typers,
  onOpenThread,
  highlighted,
  showThreadSummary,
}: RowProps) {
  const author = message.author ?? {
    kind: message.authorKind,
    id: message.authorId,
    displayName: "Unknown",
    avatarUrl: null,
  };
  const isBot = author.kind === "agent";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: touch-only shortcut; keyboard users get the "Reply in thread" button
    <div
      data-testid="message"
      data-message-id={message.id}
      data-author-kind={author.kind}
      onClick={(e) => {
        // Touch screens have no hover toolbar: tapping a message opens its thread (like Slack mobile).
        if (!onOpenThread || !window.matchMedia("(hover: none)").matches) return;
        if ((e.target as HTMLElement).closest("a, button, pre, code")) return;
        if (window.getSelection()?.toString()) return;
        onOpenThread(message.id);
      }}
      className={cn(
        "group relative flex gap-3 px-4 py-1 transition-colors hover:bg-muted/45 sm:px-5 dark:hover:bg-white/[0.025]",
        continuation ? "py-0.5" : "mt-2 pt-1.5",
        highlighted && "chat-flash",
      )}
    >
      <div className="w-9 shrink-0">
        {continuation ? (
          <Tooltip content={fullFmt.format(new Date(message.createdAt))}>
            <time
              dateTime={message.createdAt}
              className="mt-[3px] block text-right text-[10.5px] text-muted-foreground/0 tabular-nums leading-5 group-hover:text-muted-foreground"
            >
              {formatTime(message.createdAt).replace(/\s?[AP]M$/i, "")}
            </time>
          </Tooltip>
        ) : (
          <PrincipalAvatar
            kind={author.kind}
            name={author.displayName}
            avatarUrl={author.avatarUrl}
            seed={author.id}
            className="mt-0.5 size-9"
          />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {continuation ? null : (
          <div className="flex items-baseline gap-1.5">
            <span className="truncate font-semibold text-[14.5px] leading-6" data-testid="message-author">
              {author.displayName}
            </span>
            {isBot ? <BotBadge className="relative -top-px self-center" /> : null}
            <Tooltip content={fullFmt.format(new Date(message.createdAt))}>
              <time
                dateTime={message.createdAt}
                className="shrink-0 text-muted-foreground text-xs tabular-nums"
              >
                {formatTime(message.createdAt)}
              </time>
            </Tooltip>
          </div>
        )}
        <Markdown body={message.body} />
        {showThreadSummary && onOpenThread ? (
          <ThreadSummary message={message} typers={typers} onOpen={() => onOpenThread(message.id)} />
        ) : null}
      </div>
      {onOpenThread ? (
        <div className="pointer-events-none absolute -top-3.5 right-4 flex rounded-lg border bg-background p-0.5 opacity-0 shadow-sm transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 sm:right-5">
          <Tooltip content="Reply in thread">
            <button
              type="button"
              aria-label="Reply in thread"
              data-testid="reply-in-thread"
              onClick={() => onOpenThread(message.id)}
              className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
            >
              <MessageSquareReply className="size-4" />
            </button>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
});

function PendingRow({
  pending,
  me,
  continuation,
  onRetry,
}: {
  pending: PendingMessage;
  me: { id: string; name: string };
  continuation: boolean;
  onRetry: (p: PendingMessage) => void;
}) {
  return (
    <div
      data-testid="message-pending"
      className={cn(
        "flex gap-3 px-4 py-0.5 sm:px-5",
        continuation ? "" : "mt-2 pt-1.5",
        !pending.failed && "opacity-60",
      )}
    >
      <div className="w-9 shrink-0">
        {continuation ? null : (
          <PrincipalAvatar kind="user" name={me.name} seed={me.id} className="mt-0.5 size-9" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        {continuation ? null : (
          <div className="flex items-baseline gap-1.5">
            <span className="font-semibold text-[14.5px] leading-6">{me.name}</span>
            <span className="text-muted-foreground text-xs">Sending…</span>
          </div>
        )}
        <Markdown body={pending.body} />
        {pending.failed ? (
          <button
            type="button"
            onClick={() => onRetry(pending)}
            className="mt-1 inline-flex items-center gap-1.5 text-destructive text-xs hover:underline"
          >
            <AlertCircle className="size-3.5" /> Not sent. <RotateCw className="size-3" /> Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Slack-style list: day dividers, consecutive messages from the same author within 5 minutes collapse
 * under one avatar/name, bots carry a BOT badge, roots show their thread summary.
 */
export function MessageList({
  messages,
  pending,
  me,
  typers,
  onOpenThread,
  onRetry,
  highlightId,
  intro,
  showThreadSummary = true,
  startDay,
}: {
  messages: Message[];
  pending: PendingMessage[];
  me: { id: string; name: string };
  typers: Typer[];
  onOpenThread?: (id: string) => void;
  onRetry: (p: PendingMessage) => void;
  highlightId?: string | null;
  intro?: ReactNode;
  showThreadSummary?: boolean;
  /** ISO date already shown above the list (thread root): no divider for messages of that same day. */
  startDay?: string;
}) {
  let prev: { key: string; at: number; day: string } | null = startDay
    ? { key: "", at: 0, day: new Date(startDay).toDateString() }
    : null;
  const rows: ReactNode[] = [];
  for (const m of messages) {
    const key = authorKey(m.author, m);
    const at = new Date(m.createdAt).getTime();
    const day = new Date(m.createdAt).toDateString();
    if (!prev || prev.day !== day)
      rows.push(<DayDivider key={`day-${m.id}`} label={dayLabel(m.createdAt)} />);
    const continuation = !!prev && prev.day === day && prev.key === key && at - prev.at < GROUP_WINDOW_MS;
    rows.push(
      <MessageRow
        key={m.id}
        message={m}
        continuation={continuation}
        typers={typers}
        onOpenThread={onOpenThread}
        highlighted={m.id === highlightId}
        showThreadSummary={showThreadSummary}
      />,
    );
    // A message with a thread breaks the group so the next one shows its author again.
    prev = { key: m.replyCount > 0 ? `${key}:thread` : key, at, day };
  }
  const meKey = `user:${me.id}`;
  for (const p of pending) {
    const at = new Date(p.createdAt).getTime();
    const continuation = !!prev && prev.key === meKey && at - prev.at < GROUP_WINDOW_MS;
    rows.push(
      <Fragment key={p.clientMessageId}>
        <PendingRow pending={p} me={me} continuation={continuation} onRetry={onRetry} />
      </Fragment>,
    );
    prev = { key: meKey, at, day: new Date(p.createdAt).toDateString() };
  }
  return (
    <div className="flex flex-col pb-2" data-testid="message-list">
      {intro}
      {rows}
    </div>
  );
}
