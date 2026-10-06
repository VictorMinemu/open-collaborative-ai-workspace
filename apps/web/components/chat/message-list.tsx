"use client";

import type { Message, MessageAuthor } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, RotateCw, Trash2 } from "lucide-react";
import { Fragment, memo, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip } from "@/components/ui/tooltip";
import { useCopy } from "@/hooks/use-copy";
import { errorMessage } from "@/lib/api";
import { applyMessageDeleted, applyMessageUpdate, deleteMessage, editMessage } from "@/lib/chat-queries";
import { cn, relativeTime } from "@/lib/utils";
import { Markdown } from "./markdown";
import {
  DeleteMessageDialog,
  hasMessageActions,
  type MessageActionSet,
  MessageActionSheet,
  MessageActions,
} from "./message-actions";
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

/** Inline editor that replaces a message body (Enter saves, Shift+Enter is a newline, Escape cancels). */
function MessageEditor({ message, onDone }: { message: Message; onDone: () => void }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(message.body);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // After a touch sheet closes it hands focus back to the row: take it on the next frame.
    const raf = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  const save = async () => {
    const body = value.trim();
    if (body === message.body.trim()) return onDone();
    if (!body) {
      toast.error("A message can't be empty. Delete it instead.");
      return;
    }
    setSaving(true);
    try {
      applyMessageUpdate(qc, await editMessage(message.id, body));
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-1 grid gap-2" data-testid="message-editor">
      <Textarea
        ref={ref}
        value={value}
        aria-label="Edit message"
        data-testid="edit-input"
        disabled={saving}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onDone();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          }
        }}
        className="max-h-72 min-h-11 resize-none bg-background text-[14.5px] [field-sizing:content]"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={onDone} disabled={saving} data-testid="edit-cancel">
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={saving} data-testid="edit-save">
          {saving ? <Spinner /> : null}
          Save
        </Button>
        <span className="hidden text-muted-foreground text-xs sm:inline">
          Escape to cancel · Enter to save
        </span>
      </div>
    </div>
  );
}

/** "(edited)" after the body, with the edit time on hover. */
function EditedMarker({ editedAt }: { editedAt: string }) {
  return (
    <Tooltip content={`Edited ${fullFmt.format(new Date(editedAt))}`}>
      <span
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users can read the edit time
        tabIndex={0}
        data-testid="edited-marker"
        className="ml-1 select-none rounded-sm text-[11.5px] text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        (edited)
      </span>
    </Tooltip>
  );
}

const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP_PX = 10;

interface RowProps {
  message: Message;
  continuation: boolean;
  typers: Typer[];
  onOpenThread?: ((id: string) => void) | undefined;
  highlighted: boolean;
  /** The permalink target (CHAT-14): flashes, then keeps a steady tint while the link is open. */
  anchored: boolean;
  showThreadSummary: boolean;
  meId: string;
  readOnly: boolean;
  canDeleteAny: boolean;
  linkFor?: ((m: Message) => string) | undefined;
}

const MessageRow = memo(function MessageRow({
  message,
  continuation,
  typers,
  onOpenThread,
  highlighted,
  anchored,
  showThreadSummary,
  meId,
  readOnly,
  canDeleteAny,
  linkFor,
}: RowProps) {
  const author = message.author ?? {
    kind: message.authorKind,
    id: message.authorId,
    displayName: "Unknown",
    avatarUrl: null,
  };
  const isBot = author.kind === "agent";
  const [editing, setEditing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Mounted on the first long press only: one dialog root per row would be wasted on long lists.
  const [sheetUsed, setSheetUsed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmUsed, setConfirmUsed] = useState(false);
  const qc = useQueryClient();
  const { copy } = useCopy();
  const deleted = !!message.deletedAt;
  const own = message.authorKind === "user" && !!meId && message.authorId === meId;
  const mutable = !readOnly && !deleted;
  const actions: MessageActionSet = {
    onReply: onOpenThread ? () => onOpenThread(message.id) : undefined,
    onEdit: own && mutable ? () => setEditing(true) : undefined,
    onDelete:
      mutable && (own || canDeleteAny)
        ? () => {
            setConfirmUsed(true);
            setConfirmOpen(true);
          }
        : undefined,
    onCopyLink:
      linkFor && !deleted
        ? () =>
            copy(`${window.location.origin}${linkFor(message)}`).then(
              () => toast.success("Link copied"),
              () => toast.error("Couldn't copy the link"),
            )
        : undefined,
  };
  const confirmDelete = async () => {
    try {
      await deleteMessage(message.id);
      setConfirmOpen(false);
      applyMessageDeleted(qc, {
        messageId: message.id,
        conversationId: message.conversationId,
        threadId: message.threadId,
        deletedAt: new Date().toISOString(),
        replyCount: message.replyCount,
      });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const actionable = hasMessageActions(actions) && !editing;

  // Touch: a long press opens the action sheet; a short tap keeps opening the thread.
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const longPressed = useRef(false);
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(
    () => () => {
      if (press.current) window.clearTimeout(press.current.timer);
    },
    [],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: touch-only shortcuts; keyboard users get the toolbar buttons
    <div
      data-testid="message"
      data-message-id={message.id}
      data-author-kind={author.kind}
      data-highlighted={anchored ? "true" : undefined}
      onPointerDown={(e) => {
        if (e.pointerType !== "touch" || !actionable) return;
        cancelPress();
        longPressed.current = false;
        press.current = {
          x: e.clientX,
          y: e.clientY,
          timer: window.setTimeout(() => {
            press.current = null;
            longPressed.current = true;
            setSheetUsed(true);
            setSheetOpen(true);
          }, LONG_PRESS_MS),
        };
      }}
      onPointerMove={(e) => {
        const p = press.current;
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > LONG_PRESS_SLOP_PX) cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onContextMenu={(e) => {
        // The long press owns the gesture on touch screens (no native callout over the sheet).
        if (actionable && window.matchMedia("(hover: none)").matches) e.preventDefault();
      }}
      onClick={(e) => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        if (editing) return;
        // Touch screens have no hover toolbar: tapping a message opens its thread (like Slack mobile).
        if (!onOpenThread || !window.matchMedia("(hover: none)").matches) return;
        if ((e.target as HTMLElement).closest("a, button, pre, code")) return;
        if (window.getSelection()?.toString()) return;
        onOpenThread(message.id);
      }}
      className={cn(
        "group relative flex gap-3 px-4 py-1 transition-colors hover:bg-muted/45 sm:px-5 dark:hover:bg-white/[0.025] [-webkit-touch-callout:none]",
        continuation ? "py-0.5" : "mt-2 pt-1.5",
        highlighted && "chat-flash",
        anchored && "chat-anchor",
        (editing || sheetOpen) && "bg-muted/45 dark:bg-white/[0.025]",
      )}
    >
      <div className="w-9 shrink-0">
        {deleted ? (
          <div className="mt-0.5 flex size-9 items-center justify-center rounded-full border border-dashed text-muted-foreground/70">
            <Trash2 className="size-4" />
          </div>
        ) : continuation ? (
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
        {continuation || deleted ? null : (
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
        {deleted ? (
          <p
            data-testid="message-tombstone"
            className="py-2 text-[14px] text-muted-foreground italic leading-5"
          >
            This message was deleted.
          </p>
        ) : editing ? (
          <MessageEditor message={message} onDone={() => setEditing(false)} />
        ) : message.editedAt ? (
          // The marker flows after the last paragraph ("…text (edited)") instead of on a line of its own.
          <div className="[&>:first-child>p:last-child]:inline [&>:first-child]:inline">
            <Markdown body={message.body} />
            <EditedMarker editedAt={message.editedAt} />
          </div>
        ) : (
          <Markdown body={message.body} />
        )}
        {showThreadSummary && onOpenThread ? (
          <ThreadSummary message={message} typers={typers} onOpen={() => onOpenThread(message.id)} />
        ) : null}
      </div>
      {actionable ? <MessageActions actions={actions} /> : null}
      {sheetUsed && hasMessageActions(actions) ? (
        <MessageActionSheet
          message={message}
          actions={actions}
          open={sheetOpen}
          onOpenChange={setSheetOpen}
        />
      ) : null}
      {confirmUsed ? (
        <DeleteMessageDialog
          message={message}
          moderated={!own}
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          onConfirm={confirmDelete}
        />
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
  readOnly = false,
  canDeleteAny = false,
  showTombstones = false,
  anchorId,
  linkFor,
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
  /** Archived conversations: no edit or delete (the API answers 410 anyway). */
  readOnly?: boolean;
  /** The channel's `viewerCan` has `message.delete_any` (admins in channels; never in DMs). */
  canDeleteAny?: boolean;
  /** Show a deleted message as a tombstone even without replies (the thread panel's root). */
  showTombstones?: boolean;
  /** The permalink target to highlight (`data-highlighted`, CHAT-14). */
  anchorId?: string | null;
  /** Builds a message's permalink path; absent = no "Copy link" (e.g. optimistic rows). Must be stable. */
  linkFor?: (m: Message) => string;
}) {
  let prev: { key: string; at: number; day: string } | null = startDay
    ? { key: "", at: 0, day: new Date(startDay).toDateString() }
    : null;
  const rows: ReactNode[] = [];
  for (const m of messages) {
    // P-05: a deleted message disappears, unless its thread keeps it as a tombstone.
    if (m.deletedAt && m.replyCount === 0 && !showTombstones) continue;
    const key = m.deletedAt ? `deleted:${m.id}` : authorKey(m.author, m);
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
        anchored={!!anchorId && m.id === anchorId}
        showThreadSummary={showThreadSummary}
        meId={me.id}
        readOnly={readOnly}
        canDeleteAny={canDeleteAny}
        linkFor={linkFor}
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
