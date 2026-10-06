"use client";

import {
  SearchChannelsResult,
  SearchMessagesResult,
  SearchOverview,
  SearchPeopleResult,
  type SearchQuery,
} from "@ocw/contracts";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, isApiError } from "./api";

/** Typing debounce for every search box (D-04, T-04-06-05). */
export const SEARCH_DEBOUNCE_MS = 250;

export const searchKeys = {
  all: ["search"] as const,
  overview: (q: string) => ["search", "overview", q] as const,
  messages: (f: SearchFilters) => ["search", "messages", f] as const,
  people: (q: string) => ["search", "people", q] as const,
  channels: (q: string) => ["search", "channels", q] as const,
};

/** The results page's filters (everything of SearchQuery except paging). */
export type SearchFilters = Omit<SearchQuery, "cursor" | "limit">;

function retry(failureCount: number, err: unknown): boolean {
  // 4xx (validation, 429 rate limit) never improves by retrying immediately.
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

const qs = (params: Record<string, string | number | undefined | null>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]): [string, string] => [k, String(v)]),
  ).toString();

/** `value` once it stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms = SEARCH_DEBOUNCE_MS): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** ⌘K: top messages, people and channels for `q` (≤ 5 each). */
export function useSearchOverview(q: string) {
  const query = q.trim();
  return useQuery({
    queryKey: searchKeys.overview(query),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/search?${qs({ q: query })}`, { schema: SearchOverview, signal }),
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry,
  });
}

/** The results page: message hits for the filters, paged with the opaque cursor ("Load more"). */
export function useSearchMessages(filters: SearchFilters) {
  const q = filters.q.trim();
  const f: SearchFilters = { ...filters, q };
  return useInfiniteQuery({
    queryKey: searchKeys.messages(f),
    queryFn: ({ pageParam, signal }) =>
      api.get(`/api/v1/search/messages?${qs({ ...f, cursor: pageParam ?? undefined })}`, {
        schema: SearchMessagesResult,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: q.length > 0,
    staleTime: 15_000,
    retry,
  });
}

export function useSearchPeople(q: string) {
  const query = q.trim();
  return useQuery({
    queryKey: searchKeys.people(query),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/search/people?${qs({ q: query })}`, { schema: SearchPeopleResult, signal }),
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry,
  });
}

export function useSearchChannels(q: string) {
  const query = q.trim();
  return useQuery({
    queryKey: searchKeys.channels(query),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/search/channels?${qs({ q: query })}`, { schema: SearchChannelsResult, signal }),
    enabled: query.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry,
  });
}

// ---------------------------------------------------------------- recent queries (this browser only)

const RECENT_KEY = "ocw.search.recent";
const RECENT_MAX = 5;

export function readRecentSearches(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(raw)
      ? raw.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX)
      : [];
  } catch {
    return [];
  }
}

export function rememberSearch(q: string): string[] {
  const query = q.trim();
  if (!query || typeof window === "undefined") return readRecentSearches();
  const next = [query, ...readRecentSearches().filter((r) => r.toLowerCase() !== query.toLowerCase())].slice(
    0,
    RECENT_MAX,
  );
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage full or disabled: recent searches are a convenience only.
  }
  return next;
}

export function forgetRecentSearches(): void {
  try {
    window.localStorage.removeItem(RECENT_KEY);
  } catch {
    // ignore
  }
}

/** Search API error text for the UI (429 gets its own wording). */
export function searchErrorMessage(err: unknown): string {
  if (isApiError(err, 429)) return "Too many searches in a short time. Wait a moment and try again.";
  if (isApiError(err) && err.isNetwork) return "Can't reach the server.";
  return "Search failed. Try again.";
}
