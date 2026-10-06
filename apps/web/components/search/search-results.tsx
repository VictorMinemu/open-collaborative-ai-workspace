"use client";

import type { SearchMessageHit } from "@ocw/contracts";
import { Hash, Lock, MessageCircle, Search, SearchX, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { permalinkPath } from "@/lib/permalink";
import {
  rememberSearch,
  type SearchFilters,
  searchErrorMessage,
  useDebounced,
  useSearchMessages,
} from "@/lib/search-queries";
import { cn, formatDate, relativeTime } from "@/lib/utils";
import { type FilterValues, SearchFilterBar } from "./search-filters";
import { Snippet } from "./snippet";

const FILTER_KEYS = ["in", "from", "after", "before"] as const;

/** Reads the results page state from the URL (`q`, `in`, `from`, `after`, `before`). */
function filtersFrom(params: Pick<URLSearchParams, "get">): SearchFilters {
  const v = (k: string) => params.get(k)?.trim() || undefined;
  return { q: v("q") ?? "", in: v("in"), from: v("from"), after: v("after"), before: v("before") };
}

function hrefFor(f: SearchFilters): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set("q", f.q.trim());
  for (const k of FILTER_KEYS) if (f[k]) p.set(k, f[k] as string);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** `/search`: the full results page, query and filters in the URL so results can be shared and revisited. */
export function SearchPageView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const urlFilters = filtersFrom(params);
  const [q, setQ] = useState(urlFilters.q);
  const debounced = useDebounced(q);
  const inputRef = useRef<HTMLInputElement>(null);

  // Typing replaces the URL's q (debounced); filters are written immediately.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only the debounced text drives this
  useEffect(() => {
    if (debounced.trim() === urlFilters.q) return;
    router.replace(`${pathname}${hrefFor({ ...urlFilters, q: debounced })}`, { scroll: false });
  }, [debounced]);

  // Back/forward or a palette "See all" while on the page: the input follows the URL.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the URL only
  useEffect(() => {
    if (urlFilters.q !== debounced.trim()) setQ(urlFilters.q);
  }, [urlFilters.q]);

  const setFilters = (next: FilterValues) =>
    router.replace(`${pathname}${hrefFor({ ...urlFilters, ...next, q: urlFilters.q })}`, { scroll: false });

  useEffect(() => {
    if (urlFilters.q) rememberSearch(urlFilters.q);
  }, [urlFilters.q]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <PageHeader title="Search" icon={<Search />} description="Messages in the conversations you can open" />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 pt-4 pb-10 sm:px-6">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-[18px] -translate-y-1/2 text-muted-foreground" />
            <input
              ref={inputRef}
              data-testid="search-page-input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search messages"
              aria-label="Search messages"
              maxLength={200}
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
              className="h-11 w-full rounded-lg border border-input bg-background pr-10 pl-10 text-base shadow-xs outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 sm:text-[15px] dark:bg-input/25"
            />
            {q ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQ("");
                  inputRef.current?.focus();
                }}
                className="absolute top-1/2 right-1.5 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </div>
          <div className="mt-3">
            <SearchFilterBar
              value={{
                in: urlFilters.in,
                from: urlFilters.from,
                after: urlFilters.after,
                before: urlFilters.before,
              }}
              onChange={setFilters}
            />
          </div>
          <div className="mt-5">
            {urlFilters.q ? (
              <SearchResults filters={urlFilters} />
            ) : (
              <Empty
                icon={<Search className="size-5" />}
                title="Search your workspace"
                body="Type a few words. Accents are optional, in Spanish or English; narrow down with In, From and Date."
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Consecutive hits of the same conversation share one header (results stay newest first). */
function groupByConversation(hits: SearchMessageHit[]) {
  const groups: Array<{
    key: string;
    conversation: SearchMessageHit["conversation"];
    hits: SearchMessageHit[];
  }> = [];
  for (const h of hits) {
    const last = groups[groups.length - 1];
    if (last && last.conversation.id === h.conversation.id) last.hits.push(h);
    else groups.push({ key: `${h.conversation.id}:${h.messageId}`, conversation: h.conversation, hits: [h] });
  }
  return groups;
}

function linkFor(hit: SearchMessageHit): string | null {
  const c = hit.conversation;
  // The member's own AI chat (05-10): its page (no message anchor there yet).
  if (c.kind === "ai_chat") return `/chat/ai/${c.id}`;
  const kind = c.kind === "channel" || c.kind === "dm" || c.kind === "group" ? c.kind : null;
  return kind ? permalinkPath({ id: c.id, kind }, hit.messageId, hit.threadRootId) : null;
}

/** Message hits for the filters, grouped by conversation, with "Load more" on the opaque cursor. */
export function SearchResults({ filters }: { filters: SearchFilters }) {
  const res = useSearchMessages(filters);
  const hits = useMemo(() => res.data?.pages.flatMap((p) => p.hits) ?? [], [res.data]);
  const groups = useMemo(() => groupByConversation(hits), [hits]);

  if (res.isPending) {
    return (
      <div className="grid gap-3" aria-busy>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (res.isError) {
    return (
      <Empty
        icon={<SearchX className="size-5" />}
        title="Search failed"
        body={searchErrorMessage(res.error)}
        action={
          <Button size="sm" variant="outline" onClick={() => res.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  if (hits.length === 0) {
    return (
      <div data-testid="search-results-empty">
        <Empty
          icon={<SearchX className="size-5" />}
          title={`No messages match “${filters.q}”`}
          body="Try other words, or remove a filter."
        />
      </div>
    );
  }

  return (
    <div data-testid="search-results">
      <p data-testid="search-count" className="mb-3 text-muted-foreground text-xs">
        {hits.length}
        {res.hasNextPage ? "+" : ""} {hits.length === 1 && !res.hasNextPage ? "message" : "messages"}
      </p>
      <div className="grid gap-3">
        {groups.map((g) => {
          const Icon =
            g.conversation.kind === "channel"
              ? g.conversation.visibility === "private"
                ? Lock
                : Hash
              : g.conversation.kind === "ai_chat"
                ? Sparkles
                : MessageCircle;
          return (
            <section
              key={g.key}
              data-testid="search-page-group"
              data-kind={g.conversation.kind}
              className="overflow-hidden rounded-xl border bg-card"
            >
              <header className="flex items-center gap-1.5 border-b bg-muted/40 px-3.5 py-2 font-medium text-[13px]">
                <Icon className="size-3.5 text-muted-foreground" aria-hidden />
                <span className="truncate">
                  {g.conversation.kind === "channel"
                    ? g.conversation.label.replace(/^#/, "")
                    : g.conversation.label}
                </span>
                {g.conversation.kind === "ai_chat" ? (
                  <span className="rounded bg-brand-soft px-1 font-normal text-[10px] text-brand-soft-foreground">
                    AI chat
                  </span>
                ) : null}
                {g.conversation.archived ? (
                  <span className="rounded bg-muted px-1 font-normal text-[10px] text-muted-foreground">
                    archived
                  </span>
                ) : null}
              </header>
              <ul className="divide-y">
                {g.hits.map((hit) => {
                  const href = linkFor(hit);
                  const body = (
                    <>
                      <PrincipalAvatar
                        kind={hit.author.kind}
                        name={hit.author.displayName}
                        avatarUrl={hit.author.avatarUrl}
                        seed={hit.author.id}
                        className="mt-0.5 size-8"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="font-semibold text-sm">{hit.author.displayName}</span>
                          <time
                            dateTime={hit.createdAt}
                            title={formatDate(hit.createdAt)}
                            className="text-muted-foreground text-xs tabular-nums"
                          >
                            {relativeTime(hit.createdAt)}
                          </time>
                          {hit.threadRootId ? (
                            <span className="text-muted-foreground text-xs">in a thread</span>
                          ) : null}
                        </span>
                        <Snippet text={hit.snippet} className="mt-0.5 block text-sm leading-relaxed" />
                      </span>
                    </>
                  );
                  return (
                    <li key={hit.messageId}>
                      {href ? (
                        <Link
                          href={href}
                          data-testid="search-page-hit"
                          data-message-id={hit.messageId}
                          className="flex gap-3 px-3.5 py-3 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/60"
                        >
                          {body}
                        </Link>
                      ) : (
                        <div className="flex gap-3 px-3.5 py-3">{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
      {res.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            data-testid="search-load-more"
            disabled={res.isFetchingNextPage}
            onClick={() => res.fetchNextPage()}
            className={cn("min-w-36")}
          >
            {res.isFetchingNextPage ? <Spinner /> : null}
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Empty({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        {icon}
      </span>
      <p className="font-medium text-sm">{title}</p>
      <p className="max-w-sm text-muted-foreground text-sm">{body}</p>
      {action}
    </div>
  );
}
