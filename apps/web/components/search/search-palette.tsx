"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { SearchChannel, SearchMessageHit, SearchPerson } from "@ocw/contracts";
import {
  ArrowLeft,
  ArrowRight,
  Clock,
  CornerDownLeft,
  Hash,
  Lock,
  MessageSquareText,
  Search,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { Spinner } from "@/components/ui/spinner";
import { useOpenDm } from "@/lib/bots-queries";
import { permalinkPath } from "@/lib/permalink";
import {
  readRecentSearches,
  rememberSearch,
  searchErrorMessage,
  useDebounced,
  useSearchOverview,
} from "@/lib/search-queries";
import { cn, relativeTime } from "@/lib/utils";
import { Snippet } from "./snippet";

// ---------------------------------------------------------------- context

interface PaletteState {
  open: boolean;
  /** Bumped on every open so the palette starts fresh. */
  session: number;
  initialQuery: string;
}

interface PaletteApi {
  open(q?: string): void;
  toggle(): void;
  close(): void;
}

const PaletteStateContext = createContext<PaletteState | null>(null);
const PaletteApiContext = createContext<PaletteApi | null>(null);

/** Holds the palette's open state for the shell (mount once, around `SearchPalette`). */
export function SearchPaletteProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PaletteState>({ open: false, session: 0, initialQuery: "" });
  const apiValue = useMemo<PaletteApi>(
    () => ({
      open: (q = "") => setState((s) => ({ open: true, session: s.session + 1, initialQuery: q })),
      toggle: () =>
        setState((s) =>
          s.open ? { ...s, open: false } : { open: true, session: s.session + 1, initialQuery: "" },
        ),
      close: () => setState((s) => ({ ...s, open: false })),
    }),
    [],
  );
  return (
    <PaletteApiContext.Provider value={apiValue}>
      <PaletteStateContext.Provider value={state}>{children}</PaletteStateContext.Provider>
    </PaletteApiContext.Provider>
  );
}

/** Opens the ⌘K palette (optionally prefilled). */
export function useSearchPalette(): PaletteApi {
  const ctx = useContext(PaletteApiContext);
  if (!ctx) throw new Error("useSearchPalette must be used inside SearchPaletteProvider");
  return ctx;
}

// ---------------------------------------------------------------- items

type Item =
  | { key: string; type: "recent"; query: string }
  | { key: string; type: "message"; hit: SearchMessageHit }
  | { key: string; type: "person"; person: SearchPerson }
  | { key: string; type: "channel"; channel: SearchChannel };

const optionId = (base: string, key: string) => `${base}-${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

function isDirect(kind: string): kind is "dm" | "group" {
  return kind === "dm" || kind === "group";
}

/** ⌘K command palette: messages, people and channels the caller can read (CHAT-11). Mounted once in AppShell. */
export function SearchPalette() {
  const state = useContext(PaletteStateContext);
  const api = useSearchPalette();
  if (!state) throw new Error("SearchPalette must be used inside SearchPaletteProvider");
  return (
    <DialogPrimitive.Root open={state.open} onOpenChange={(open) => (open ? api.open() : api.close())}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Popup
          data-testid="search-palette"
          aria-label="Search"
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden bg-background shadow-2xl outline-none",
            // 390: a full-screen sheet; md+: a top-centred command palette.
            "inset-0",
            "md:inset-auto md:top-[12vh] md:left-1/2 md:max-h-[min(600px,76vh)] md:w-[min(640px,calc(100vw-2rem))] md:-translate-x-1/2 md:rounded-xl md:border",
            "transition-[transform,opacity] duration-150 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 md:data-starting-style:scale-[0.98] md:data-ending-style:scale-[0.98]",
          )}
        >
          <DialogPrimitive.Title className="sr-only">Search</DialogPrimitive.Title>
          {state.open ? (
            <PaletteBody key={state.session} initialQuery={state.initialQuery} onClose={api.close} />
          ) : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function PaletteBody({ initialQuery, onClose }: { initialQuery: string; onClose: () => void }) {
  const router = useRouter();
  const base = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState(initialQuery);
  const [recent, setRecent] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  /** A person picked from the People section (humans show their card; Plan 07 adds "Message"). */
  const [profile, setProfile] = useState<SearchPerson | null>(null);
  const debounced = useDebounced(q);
  const query = debounced.trim();
  const overview = useSearchOverview(query);
  const openDm = useOpenDm();

  useEffect(() => {
    setRecent(readRecentSearches());
    // Focus after the popup mounted (Base UI focuses the popup itself first).
    const t = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, []);

  const data = query ? overview.data : undefined;
  const items = useMemo<Item[]>(() => {
    if (!q.trim()) return recent.map((r) => ({ key: `recent:${r}`, type: "recent" as const, query: r }));
    if (!data) return [];
    return [
      ...data.messages.map((hit) => ({ key: `m:${hit.messageId}`, type: "message" as const, hit })),
      ...data.people.map((person) => ({
        key: `p:${person.kind}:${person.id}`,
        type: "person" as const,
        person,
      })),
      ...data.channels.map((channel) => ({ key: `c:${channel.id}`, type: "channel" as const, channel })),
    ];
  }, [q, recent, data]);

  // Keep the active row valid and visible as results change.
  useEffect(() => {
    setActive((a) => (items.length === 0 ? 0 : Math.min(a, items.length - 1)));
  }, [items.length]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the active row changes
  useEffect(() => {
    const key = items[active]?.key;
    if (!key) return;
    document.getElementById(optionId(base, key))?.scrollIntoView({ block: "nearest" });
  }, [active, base]);

  const go = useCallback(
    (path: string) => {
      rememberSearch(q);
      onClose();
      router.push(path);
    },
    [q, onClose, router],
  );

  const run = useCallback(
    (item: Item) => {
      switch (item.type) {
        case "recent":
          setQ(item.query);
          inputRef.current?.focus();
          return;
        case "message": {
          const c = item.hit.conversation;
          const kind = c.kind === "channel" ? "channel" : isDirect(c.kind) ? c.kind : null;
          if (!kind) return;
          go(permalinkPath({ id: c.id, kind }, item.hit.messageId, item.hit.threadRootId));
          return;
        }
        case "channel":
          go(`/chat/${item.channel.id}`);
          return;
        case "person":
          if (item.person.kind === "agent") {
            openDm.mutate(item.person.id, { onSuccess: (r) => go(`/chat/dm/${r.dmId}`) });
          } else {
            setProfile(item.person);
          }
          return;
      }
    },
    [go, openDm],
  );

  const seeAll = () => go(`/search?q=${encodeURIComponent(q.trim())}`);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (profile) {
      if (e.key === "Backspace" && !q) setProfile(null);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => (a + step + items.length) % items.length);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      const item = items[active];
      if (item) {
        e.preventDefault();
        run(item);
      }
    }
  };

  const typing = q.trim() !== query;
  const loading = !!q.trim() && (typing || (overview.isFetching && !overview.data));
  const sections: Array<{ title: string; type: Item["type"] }> = q.trim()
    ? [
        { title: "Messages", type: "message" },
        { title: "People", type: "person" },
        { title: "Channels", type: "channel" },
      ]
    : [{ title: "Recent searches", type: "recent" }];
  const activeKey = items[active]?.key;
  const listboxId = `${base}-list`;

  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:h-[52px] md:px-4">
        <Search className="size-[18px] shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={inputRef}
          data-testid="search-input"
          role="combobox"
          aria-expanded
          aria-controls={listboxId}
          aria-activedescendant={activeKey ? optionId(base, activeKey) : undefined}
          aria-label="Search messages, people and channels"
          placeholder="Search messages, people and channels"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setProfile(null);
          }}
          onKeyDown={onKeyDown}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          className="h-full min-w-0 flex-1 bg-transparent text-base outline-none md:text-[15px] placeholder:text-muted-foreground/70"
        />
        {loading ? <Spinner className="text-muted-foreground" /> : null}
        {q ? (
          <button
            type="button"
            data-testid="search-clear"
            aria-label="Clear search"
            onClick={() => {
              setQ("");
              inputRef.current?.focus();
            }}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            <X className="size-4" />
          </button>
        ) : null}
        <DialogPrimitive.Close
          aria-label="Close search"
          className="inline-flex h-8 items-center rounded-md px-2 font-medium text-muted-foreground text-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 md:hidden"
        >
          Cancel
        </DialogPrimitive.Close>
        <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground md:inline">
          Esc
        </kbd>
      </div>

      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label="Search results"
        className={cn(
          "scrollbar-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 transition-opacity",
          overview.isPlaceholderData && "opacity-70",
        )}
      >
        {profile ? (
          <ProfileCard person={profile} onBack={() => setProfile(null)} />
        ) : overview.isError && q.trim() ? (
          <p className="px-3 py-8 text-center text-muted-foreground text-sm">
            {searchErrorMessage(overview.error)}
          </p>
        ) : !q.trim() && recent.length === 0 ? (
          <EmptyHint />
        ) : q.trim() && data && items.length === 0 && !typing ? (
          <p data-testid="search-empty" className="px-3 py-10 text-center text-muted-foreground text-sm">
            No results for “{query}”. Try fewer or different words.
          </p>
        ) : (
          sections.map((s) => {
            const rows = items.filter((i) => i.type === s.type);
            if (rows.length === 0) return null;
            return (
              <div key={s.type} role="group" aria-label={s.title} className="pb-1">
                <div className="px-2.5 pt-2 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                  {s.title}
                </div>
                {rows.map((item) => {
                  const index = items.indexOf(item);
                  return (
                    <Row
                      key={item.key}
                      id={optionId(base, item.key)}
                      item={item}
                      active={index === active}
                      onHover={() => setActive(index)}
                      onSelect={() => run(item)}
                    />
                  );
                })}
              </div>
            );
          })
        )}
      </div>

      {q.trim() && !profile ? (
        <button
          type="button"
          data-testid="search-see-all"
          onClick={seeAll}
          className="flex shrink-0 items-center gap-2 border-t px-4 py-3 text-left font-medium text-primary text-sm outline-none hover:bg-accent/60 focus-visible:bg-accent/60 md:py-2.5"
        >
          <Search className="size-4" aria-hidden />
          <span className="min-w-0 flex-1 truncate">See all results for “{q.trim()}”</span>
          <ArrowRight className="size-4" aria-hidden />
        </button>
      ) : null}
      <div className="hidden shrink-0 items-center gap-4 border-t px-4 py-2 text-[11px] text-muted-foreground md:flex">
        <span className="flex items-center gap-1">
          <kbd className="rounded border bg-muted px-1 font-mono">↑</kbd>
          <kbd className="rounded border bg-muted px-1 font-mono">↓</kbd> to navigate
        </span>
        <span className="flex items-center gap-1">
          <kbd className="inline-flex items-center rounded border bg-muted px-1 font-mono">
            <CornerDownLeft className="size-3" />
          </kbd>
          to open
        </span>
      </div>
    </>
  );
}

/** A member's card inside the palette (no profile page yet; Plan 07 adds "Message"). */
function ProfileCard({ person, onBack }: { person: SearchPerson; onBack: () => void }) {
  return (
    <div data-testid="search-profile" className="px-2 py-2">
      <button
        type="button"
        onClick={onBack}
        className="mb-3 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground text-sm outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
      >
        <ArrowLeft className="size-4" /> Back to results
      </button>
      <div className="flex items-center gap-4 rounded-xl border bg-card p-4">
        <PrincipalAvatar
          kind={person.kind}
          name={person.displayName}
          avatarUrl={person.avatarUrl}
          seed={person.id}
          className="size-14 text-lg"
        />
        <div className="min-w-0">
          <p className="truncate font-semibold text-base">{person.displayName}</p>
          <p className="truncate text-muted-foreground text-sm">@{person.handle}</p>
          {person.subtitle ? <p className="mt-1 truncate text-sm">{person.subtitle}</p> : null}
        </div>
      </div>
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Search className="size-5" />
      </span>
      <p className="font-medium text-sm">Search your workspace</p>
      <p className="max-w-xs text-muted-foreground text-xs">
        Messages, people and channels you can open. Accents are optional, in Spanish or English.
      </p>
    </div>
  );
}

function Row({
  id,
  item,
  active,
  onHover,
  onSelect,
}: {
  id: string;
  item: Item;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const common = {
    id,
    role: "option" as const,
    "aria-selected": active,
    "data-active": active ? "true" : undefined,
    onMouseMove: onHover,
    // Keep focus in the input (keyboard flow); the click still selects.
    onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
    onClick: onSelect,
    className: cn(
      "flex w-full cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2 text-left outline-none",
      active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
    ),
  };
  switch (item.type) {
    case "recent":
      return (
        <div {...common} data-testid="search-recent">
          <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate text-sm">{item.query}</span>
        </div>
      );
    case "message": {
      const { hit } = item;
      const c = hit.conversation;
      return (
        <div {...common} data-testid="search-result" data-kind="message" data-message-id={hit.messageId}>
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <MessageSquareText className="size-4" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
              <span className="truncate font-medium text-foreground/80">{c.label}</span>
              {c.archived ? (
                <span className="shrink-0 rounded bg-muted px-1 text-[10px]">archived</span>
              ) : null}
              <span aria-hidden>·</span>
              <span className="truncate">{hit.author.displayName}</span>
              {hit.threadRootId ? <span className="shrink-0">· in thread</span> : null}
              <span className="ml-auto shrink-0 pl-2 tabular-nums">{relativeTime(hit.createdAt)}</span>
            </span>
            <Snippet text={hit.snippet} className="mt-0.5 line-clamp-2 block text-[13.5px] leading-snug" />
          </span>
        </div>
      );
    }
    case "person": {
      const { person } = item;
      return (
        <div {...common} data-testid="search-result" data-kind="person" data-person-id={person.id}>
          <PrincipalAvatar
            kind={person.kind}
            name={person.displayName}
            avatarUrl={person.avatarUrl}
            seed={person.id}
            className="size-7"
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate font-medium text-sm">{person.displayName}</span>
              <span className="truncate text-muted-foreground text-xs">@{person.handle}</span>
              {person.kind === "agent" ? (
                <span className="shrink-0 rounded bg-brand-soft px-1 font-medium text-[10px] text-brand-soft-foreground">
                  BOT
                </span>
              ) : null}
            </span>
            {person.subtitle ? (
              <span className="block truncate text-muted-foreground text-xs">{person.subtitle}</span>
            ) : null}
          </span>
        </div>
      );
    }
    case "channel": {
      const { channel } = item;
      const Icon = channel.visibility === "private" ? Lock : Hash;
      return (
        <div {...common} data-testid="search-result" data-kind="channel" data-channel-id={channel.id}>
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Icon className="size-4" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate font-medium text-sm">{channel.name}</span>
              {channel.archived ? (
                <span className="shrink-0 rounded bg-muted px-1 text-[10px]">archived</span>
              ) : null}
            </span>
            <span className="block truncate text-muted-foreground text-xs">
              {channel.memberCount} {channel.memberCount === 1 ? "member" : "members"}
              {channel.isMember ? " · joined" : ""}
              {channel.topic ? ` · ${channel.topic}` : ""}
            </span>
          </span>
        </div>
      );
    }
  }
}
