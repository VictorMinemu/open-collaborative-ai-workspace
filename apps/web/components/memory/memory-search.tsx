"use client";

import { type MemoryScope, splitSnippet } from "@ocw/contracts";
import { FileText, RotateCcw, Search, X } from "lucide-react";
import Link from "next/link";
import { type ReactNode, type RefObject, useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { Snippet } from "@/components/search/snippet";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useMemorySearch } from "@/lib/memory-queries";
import { memoryHref, pathMarks } from "@/lib/memory-tree";
import { cn } from "@/lib/utils";
import { focusHeadingNext } from "./memory-file";
import { scopeIcon } from "./memory-tree";

/**
 * Memory search (Phase 07.2, MEM-02, MEM-07, UI-SPEC "Search", R10): a field at the top of the tree column (the
 * phone's tree screen), debounced 250 ms from 2 characters; while a query is present the tree is replaced by results
 * grouped by scope, with a scope selector under the field. The API only ever returns hits from files the viewer may
 * read (07.2-16); the selector lists only the scopes the API listed. The query is kept for the session, so coming back
 * from a result is one tap.
 */

interface SearchState {
  q: string;
  scopeId: string | null;
  setQ: (q: string) => void;
  setScopeId: (id: string | null) => void;
}

export const useMemorySearchState = create<SearchState>()((set) => ({
  q: "",
  scopeId: null,
  setQ: (q) => set({ q }),
  setScopeId: (scopeId) => set({ scopeId }),
}));

const MIN_CHARS = 2;
const ALL = "all";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Focus goes back to the tree's tab stop once it is rendered again. */
function focusTree() {
  requestAnimationFrame(() => {
    document
      .querySelector<HTMLElement>('[data-testid="memory-tree"] [role="treeitem"][tabindex="0"]')
      ?.focus();
  });
}

const resultsLabel = (n: number) => (n === 1 ? "1 result" : `${n} results`);

export interface MemorySearchProps {
  scopes: readonly MemoryScope[];
  /** The scope of the open file: offered first in the selector. */
  currentScopeId: string | null;
  /** The open file, shown with the selected style in the results. */
  selected: { scopeId: string; path: string } | null;
  stacked: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  /** The tree, shown while no query is present. */
  children: ReactNode;
}

export function MemorySearch({
  scopes,
  currentScopeId,
  selected,
  stacked,
  inputRef,
  children,
}: MemorySearchProps) {
  const { q, scopeId, setQ, setScopeId } = useMemorySearchState();
  const debounced = useDebounced(q.trim(), 250);
  const active = debounced.length >= MIN_CHARS && q.trim().length >= MIN_CHARS;
  // A scope the viewer can no longer read drops out of the filter.
  const filter = scopeId && scopes.some((s) => s.id === scopeId) ? scopeId : null;
  const search = useMemorySearch(active ? debounced : "", filter);

  const items = useMemo(() => {
    const current = scopes.find((s) => s.id === currentScopeId);
    const rest = scopes.filter((s) => s.id !== currentScopeId);
    return [
      { value: ALL, label: "All memory" },
      ...(current ? [current, ...rest] : rest).map((s) => ({ value: s.id, label: s.label })),
    ];
  }, [scopes, currentScopeId]);

  const groups = useMemo(() => {
    const hits = search.data?.hits ?? [];
    const order = new Map(scopes.map((s, i) => [s.id, i]));
    const by = new Map<string, typeof hits>();
    for (const h of hits) by.set(h.scopeId, [...(by.get(h.scopeId) ?? []), h]);
    return [...by.entries()]
      .map(([id, list]) => ({ scope: scopes.find((s) => s.id === id), list }))
      .filter((g): g is { scope: MemoryScope; list: typeof hits } => !!g.scope)
      .sort((a, b) => (order.get(a.scope.id) ?? 0) - (order.get(b.scope.id) ?? 0));
  }, [search.data, scopes]);
  const count = groups.reduce((n, g) => n + g.list.length, 0);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (q === "") return;
    e.preventDefault();
    setQ("");
    focusTree();
  };

  const busy = active && search.isFetching;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={cn("shrink-0", stacked ? "px-2 pt-2 pb-1" : "px-3 pb-2")}>
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            ref={inputRef}
            type="search"
            aria-label="Search memory"
            placeholder="Search memory"
            data-testid="memory-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            className={cn(
              "w-full rounded-md border border-input bg-background pr-9 pl-8 text-sm shadow-xs outline-none transition-[color,box-shadow,border-color] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 dark:bg-input/25 [&::-webkit-search-cancel-button]:hidden",
              stacked ? "h-11" : "h-8",
            )}
          />
          <div className="absolute inset-y-0 right-0 flex items-center pr-1">
            {busy ? (
              <Spinner className="mr-1.5 size-4 text-muted-foreground" />
            ) : q ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Clear search"
                className={cn(stacked && "size-11")}
                onClick={() => {
                  setQ("");
                  inputRef.current?.focus();
                }}
              >
                <X />
              </Button>
            ) : null}
          </div>
        </div>
        {active ? (
          <div className="mt-2 flex items-center justify-between gap-2">
            <Select
              items={items}
              value={filter ?? ALL}
              onValueChange={(v) => v && setScopeId(v === ALL ? null : v)}
            >
              <SelectTrigger
                aria-label="Search in"
                data-testid="memory-search-scope"
                className={cn("w-auto max-w-[70%] gap-1.5 text-xs", stacked ? "h-11" : "h-8")}
              />
              <SelectContent>
                {items.map((i) => (
                  <SelectItem key={i.value} value={i.value} className="max-lg:min-h-11">
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p
              role="status"
              aria-live="polite"
              data-testid="memory-search-count"
              className="shrink-0 text-muted-foreground text-xs"
            >
              {search.data && !search.isPlaceholderData ? resultsLabel(count) : ""}
            </p>
          </div>
        ) : null}
      </div>
      <div
        className={cn(
          "scrollbar-thin relative min-h-0 flex-1 overflow-y-auto",
          stacked ? "px-2 pb-2" : "px-2 pb-3",
        )}
      >
        {!active ? (
          children
        ) : search.isError ? (
          <div className="grid gap-2 px-2 py-3 text-sm">
            <p className="text-muted-foreground">Search isn't available right now.</p>
            <Button
              variant="outline"
              size="sm"
              className="w-fit max-lg:h-11"
              onClick={() => void search.refetch()}
            >
              <RotateCcw /> Try again
            </Button>
          </div>
        ) : search.data && count === 0 && !search.isPlaceholderData ? (
          <div data-testid="memory-search-empty" className="grid gap-2 px-2 py-3 text-sm">
            <p className="text-muted-foreground">No results for “{debounced}”.</p>
            {filter ? (
              <Button
                variant="outline"
                size="sm"
                className="w-fit max-lg:h-11"
                onClick={() => setScopeId(null)}
              >
                Search all memory
              </Button>
            ) : null}
          </div>
        ) : (
          <ul aria-label="Search results" data-testid="memory-search-results" className="grid gap-2">
            {groups.map(({ scope, list }) => {
              const Icon = scopeIcon(scope);
              return (
                <li key={scope.id}>
                  <div
                    aria-hidden
                    className="sticky top-0 z-10 flex h-7 items-center gap-1.5 bg-sidebar px-2 font-semibold text-muted-foreground text-xs"
                  >
                    <Icon className="size-3.5" />
                    <span className="truncate">{scope.label}</span>
                  </div>
                  <ul aria-label={scope.label} className="grid gap-px">
                    {list.map((h) => (
                      <li key={h.fileId}>
                        <ResultLink
                          hit={h}
                          q={debounced}
                          selected={selected?.scopeId === h.scopeId && selected.path === h.path}
                          stacked={stacked}
                          onKeyDown={onKeyDown}
                        />
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function ResultLink({
  hit,
  q,
  selected,
  stacked,
  onKeyDown,
}: {
  hit: { scopeId: string; path: string; snippet: string };
  q: string;
  selected: boolean;
  stacked: boolean;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  const slash = hit.path.lastIndexOf("/");
  const folder = slash >= 0 ? hit.path.slice(0, slash + 1) : "";
  const name = hit.path.slice(slash + 1);
  // A hit found by path words only has an unmarked snippet: mark the words in the name instead (07.2-16 ledger).
  const snippetMarked = splitSnippet(hit.snippet).some((p) => p.mark);
  // The snippet is plain text from the Markdown source: drop heading markers ("# ") so it reads as prose.
  const snippet = hit.snippet.replace(/(^|\s)#{1,6}\s+/gu, "$1");
  const nameRuns = snippetMarked ? [{ text: name, mark: false }] : pathMarks(name, q);
  return (
    <Link
      href={memoryHref(hit.scopeId, hit.path)}
      data-testid="memory-search-hit"
      data-path={hit.path}
      aria-current={selected ? "page" : undefined}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        // Enter on a link is a click with no pointer detail: the file's <h1> takes focus (UI-SPEC).
        if (e.detail === 0) focusHeadingNext();
      }}
      className={cn(
        "relative flex gap-2 rounded-md px-2 py-2 text-sidebar-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset",
        stacked ? "min-h-11" : "",
        selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "lg:hover:bg-sidebar-accent/60",
      )}
    >
      {selected ? (
        <span aria-hidden className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-r-full bg-primary" />
      ) : null}
      <FileText
        aria-hidden
        className={cn("mt-0.5 size-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")}
      />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-sm">
          {folder ? <span className="text-muted-foreground">{folder}</span> : null}
          <span className="font-semibold">
            {nameRuns.map((r, i) =>
              r.mark ? (
                <mark
                  // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and never reorder
                  key={i}
                  className="rounded-[3px] bg-amber-200/80 px-0.5 text-foreground dark:bg-amber-400/25 dark:text-amber-100"
                >
                  {r.text}
                </mark>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and never reorder
                <span key={i}>{r.text}</span>
              ),
            )}
          </span>
        </span>
        {snippet ? (
          <Snippet text={snippet} className="line-clamp-2 text-muted-foreground text-xs leading-4" />
        ) : null}
      </span>
    </Link>
  );
}
