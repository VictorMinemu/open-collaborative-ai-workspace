"use client";

import { MENTION_ALL_WARN_AT, mentionAllOf } from "@ocw/contracts";
import { ArrowUp, AtSign, Megaphone } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { BotBadge, PrincipalAvatar } from "./principal-avatar";
import type { DirEntry } from "./use-chat-directory";

export interface MentionCandidate extends DirEntry {
  inChannel: boolean;
}

/** `@channel` / `@here`, offered only where the caller may use them (`channel.mention_all`, CHAT-08). */
export interface SpecialMention {
  handle: "channel" | "here";
  label: string;
  description: string;
}

type Suggestion = { type: "special"; s: SpecialMention } | { type: "member"; c: MentionCandidate };
const keyOf = (x: Suggestion) => (x.type === "special" ? `special:${x.s.handle}` : `${x.c.kind}:${x.c.id}`);

export interface ComposerApi {
  /** Focus and start a mention (`@`) at the caret, opening the suggestions. */
  insertMention(): void;
}

const TOKEN_BEFORE_CARET = /(^|[\s([{,;:!?"'])@([a-zA-Z0-9._-]{0,40})$/;
const MAX_SUGGESTIONS = 8;

function rank(c: MentionCandidate, q: string): number {
  const handle = c.handle.toLowerCase();
  const name = c.displayName.toLowerCase();
  let score = 0;
  if (!q) score = 1;
  else if (handle.startsWith(q)) score = 4;
  else if (name.startsWith(q)) score = 3;
  else if (name.split(/\s+/).some((w) => w.startsWith(q))) score = 2;
  else if (handle.includes(q) || name.includes(q)) score = 1;
  if (score === 0) return 0;
  return score * 10 + (c.inChannel ? 2 : 0) + (c.kind === "agent" ? 1 : 0);
}

/**
 * Message composer: autosizing textarea, Enter to send / Shift+Enter for a newline, `@` autocomplete over
 * channel members and org bots (bots outside the channel are added when mentioned) plus `@channel` / `@here` where
 * allowed, a confirmation before notifying more than MENTION_ALL_WARN_AT members, throttled typing signal.
 */
export function Composer({
  placeholder,
  candidates,
  onSend,
  onTyping,
  disabled,
  autoFocus,
  footer,
  apiRef,
  testId = "composer",
  mentions = true,
  specialMentions,
  memberCount,
}: {
  placeholder: string;
  candidates: MentionCandidate[];
  onSend: (body: string) => void;
  onTyping?: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
  footer?: ReactNode;
  apiRef?: RefObject<ComposerApi | null>;
  testId?: string;
  /** false hides the @ button (e.g. a direct chat with a bot, where nobody else can be mentioned). */
  mentions?: boolean;
  /** `@channel` / `@here` in the autocomplete (only when the caller may use them). */
  specialMentions?: SpecialMention[];
  /** Members of the conversation: above MENTION_ALL_WARN_AT, `@channel` / `@here` asks for confirmation. */
  memberCount?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState("");
  const [query, setQuery] = useState<{ q: string; start: number } | null>(null);
  const [active, setActive] = useState(0);
  const lastTyping = useRef(0);
  /** Caret to restore right after the next value commit (set synchronously, never in a later frame). */
  const pendingCaret = useRef<{ pos: number; detect: boolean } | null>(null);

  const [confirming, setConfirming] = useState<string | null>(null);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!query) return [];
    const q = query.q.toLowerCase();
    const specials = (specialMentions ?? []).filter((s) => s.handle.startsWith(q));
    const people = candidates
      .map((c) => ({ c, s: rank(c, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.c.displayName.localeCompare(b.c.displayName))
      .slice(0, MAX_SUGGESTIONS - specials.length)
      .map((x): Suggestion => ({ type: "member", c: x.c }));
    const special = specials.map((s): Suggestion => ({ type: "special", s }));
    // Typed "@c…" / "@h…": the broadcast first; a bare "@": people first, the broadcasts last.
    return q ? [...special, ...people] : [...people, ...special];
  }, [query, candidates, specialMentions]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlighted option when the query text changes
  useEffect(() => setActive(0), [query?.q]);

  // Autosize.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the value changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    const caret = pendingCaret.current;
    if (caret) {
      pendingCaret.current = null;
      el.focus();
      el.setSelectionRange(caret.pos, caret.pos);
      if (caret.detect) detect(el.value, caret.pos);
    }
  }, [value]);

  useEffect(() => {
    if (autoFocus && !disabled) ref.current?.focus({ preventScroll: true });
  }, [autoFocus, disabled]);

  const detect = useCallback((text: string, caret: number) => {
    const m = TOKEN_BEFORE_CARET.exec(text.slice(0, caret));
    setQuery(m ? { q: m[2] ?? "", start: caret - (m[2]?.length ?? 0) - 1 } : null);
  }, []);

  const pick = (x: Suggestion) => {
    const el = ref.current;
    if (!el || !query) return;
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, query.start);
    const after = value.slice(caret);
    const insert = `@${x.type === "special" ? x.s.handle : x.c.handle} `;
    const next = `${before}${insert}${after.startsWith(" ") ? after.slice(1) : after}`;
    pendingCaret.current = { pos: before.length + insert.length, detect: false };
    setValue(next);
    setQuery(null);
  };

  const commit = (body: string) => {
    onSend(body);
    setValue("");
    setQuery(null);
    lastTyping.current = 0;
  };

  const send = () => {
    const body = value.trim();
    if (!body || disabled) return;
    // Pitfall 6: notifying a whole channel is confirmed above MENTION_ALL_WARN_AT members (like Slack).
    if (specialMentions?.length && (memberCount ?? 0) > MENTION_ALL_WARN_AT && mentionAllOf(body)) {
      setQuery(null);
      setConfirming(body);
      return;
    }
    commit(body);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (query && suggestions.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + d + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const c = suggestions[active];
        if (c) pick(c);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const insertAt = () => {
    const el = ref.current;
    if (!el) return;
    const caret = el.selectionStart ?? value.length;
    const needsSpace = caret > 0 && !/\s$/.test(value.slice(0, caret));
    const next = `${value.slice(0, caret)}${needsSpace ? " " : ""}@${value.slice(caret)}`;
    const pos = caret + (needsSpace ? 2 : 1);
    pendingCaret.current = { pos, detect: true };
    setValue(next);
  };

  if (apiRef) apiRef.current = { insertMention: insertAt };

  const canSend = value.trim().length > 0 && !disabled;

  return (
    <div className="relative">
      {query && suggestions.length > 0 ? (
        <div
          role="listbox"
          data-testid="mention-suggestions"
          className="absolute inset-x-0 bottom-full z-30 mb-2 overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-xl shadow-black/5 dark:shadow-black/40"
        >
          <p className="px-2.5 pt-1.5 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
            Mention someone
          </p>
          {suggestions.map((x, i) =>
            x.type === "special" ? (
              <button
                key={keyOf(x)}
                type="button"
                role="option"
                aria-selected={i === active}
                data-testid="mention-option-special"
                data-handle={x.s.handle}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(x)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm outline-none",
                  i === active ? "bg-accent text-accent-foreground" : "",
                )}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-amber-400/20 text-amber-700 dark:text-amber-300">
                  <Megaphone className="size-3.5" />
                </span>
                <span className="shrink-0 font-medium">@{x.s.handle}</span>
                <span className="min-w-0 truncate text-muted-foreground text-xs">{x.s.description}</span>
              </button>
            ) : (
              <MemberOption
                key={keyOf(x)}
                c={x.c}
                active={i === active}
                onHover={() => setActive(i)}
                onPick={() => pick(x)}
              />
            ),
          )}
        </div>
      ) : null}

      <div
        className={cn(
          "flex items-end gap-1.5 rounded-xl border bg-background p-1.5 pl-3 shadow-xs transition-[border-color,box-shadow] dark:bg-input/20",
          "focus-within:border-ring/60 focus-within:ring-[3px] focus-within:ring-ring/15",
          disabled && "opacity-60",
        )}
      >
        <textarea
          ref={ref}
          data-testid={testId}
          rows={1}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => {
            setValue(e.target.value);
            detect(e.target.value, e.target.selectionStart ?? e.target.value.length);
            const now = Date.now();
            if (onTyping && e.target.value && now - lastTyping.current > 3000) {
              lastTyping.current = now;
              onTyping();
            }
          }}
          onSelect={(e) => detect(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
          onBlur={() => setTimeout(() => setQuery(null), 120)}
          onKeyDown={onKeyDown}
          className="scrollbar-thin max-h-60 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-[14.5px] leading-[1.45] outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
        />
        {mentions ? (
          <button
            type="button"
            aria-label="Mention someone"
            onClick={insertAt}
            disabled={disabled}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50"
          >
            <AtSign className="size-4" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Send message"
          data-testid={`${testId}-send`}
          onClick={send}
          disabled={!canSend}
          className={cn(
            "inline-flex size-8 shrink-0 items-center justify-center rounded-lg outline-none transition-[background-color,color,opacity] focus-visible:ring-[3px] focus-visible:ring-ring/40",
            canSend
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-muted text-muted-foreground",
          )}
        >
          <ArrowUp className="size-4" strokeWidth={2.4} />
        </button>
      </div>
      {footer}

      <Dialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <DialogContent data-testid="mention-all-confirm">
          <DialogHeader>
            <DialogTitle>Notify {memberCount} people?</DialogTitle>
            <DialogDescription>
              {confirming && mentionAllOf(confirming) === "here"
                ? `@here notifies everyone in this channel who is online now, out of ${memberCount} members.`
                : `@channel notifies all ${memberCount} members of this channel, wherever they are.`}
            </DialogDescription>
          </DialogHeader>
          <blockquote className="line-clamp-4 whitespace-pre-wrap break-words rounded-lg border bg-muted/40 px-3.5 py-2.5 text-[14px] text-foreground/90">
            {confirming}
          </blockquote>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(null)} data-testid="mention-all-cancel">
              Cancel
            </Button>
            <Button
              data-testid="mention-all-send"
              onClick={() => {
                const body = confirming;
                setConfirming(null);
                if (body) commit(body);
              }}
            >
              <Megaphone />
              Send and notify
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MemberOption({
  c,
  active,
  onHover,
  onPick,
}: {
  c: MentionCandidate;
  active: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-testid="mention-option"
      onMouseDown={(e) => e.preventDefault()}
      onMouseEnter={onHover}
      onClick={onPick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm outline-none",
        active ? "bg-accent text-accent-foreground" : "",
      )}
    >
      <PrincipalAvatar
        kind={c.kind}
        name={c.displayName}
        avatarUrl={c.avatarUrl}
        seed={c.id}
        className="size-6 text-[10px]"
      />
      <span className="truncate font-medium">{c.displayName}</span>
      {c.kind === "agent" ? <BotBadge /> : null}
      <span className="truncate text-muted-foreground text-xs">@{c.handle}</span>
      {!c.inChannel ? (
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {c.kind === "agent" ? "Joins when mentioned" : "Not in channel"}
        </span>
      ) : null}
    </button>
  );
}

export function ComposerHint() {
  return (
    <p className="mt-1.5 hidden px-1 text-[11px] text-muted-foreground/80 md:block">
      <kbd className="font-sans font-medium">Enter</kbd> to send ·{" "}
      <kbd className="font-sans font-medium">Shift + Enter</kbd> for a new line ·{" "}
      <kbd className="font-sans font-medium">@</kbd> to mention people or bots
    </p>
  );
}
