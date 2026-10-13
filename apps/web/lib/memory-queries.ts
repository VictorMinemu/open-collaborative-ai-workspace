"use client";

import {
  type EnsureMemoryScopeRequest,
  MemoryFile,
  MemoryFileList,
  type MemoryFileMeta,
  MemoryScope,
  MemoryScopeList,
  MemorySearchResult,
} from "@ocw/contracts";
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api, isApiError } from "./api";

/**
 * Memory over REST (Phase 07.2, MEM-02): every response parsed with the contract schemas. The API decides what the
 * viewer may read; these hooks only render what it returns (an unreadable file is the same 404 as a missing one).
 */

export const memoryKeys = {
  all: ["memory"] as const,
  scopes: ["memory", "scopes"] as const,
  files: (scopeId: string) => ["memory", "files", scopeId] as const,
  file: (scopeId: string, path: string) => ["memory", "file", scopeId, path] as const,
  search: (q: string, scopeId: string | null) => ["memory", "search", q, scopeId ?? "all"] as const,
};

/** 4xx answers are decisions (404 = missing or unreadable), never retried. */
function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

export function useMemoryScopes() {
  return useQuery({
    queryKey: memoryKeys.scopes,
    queryFn: ({ signal }) => api.get("/api/v1/memory/scopes", { schema: MemoryScopeList, signal }),
    retry: noRetryOn4xx,
  });
}

const filesQuery = (scopeId: string) => ({
  queryKey: memoryKeys.files(scopeId),
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api.get(`/api/v1/memory/scopes/${encodeURIComponent(scopeId)}/files`, { schema: MemoryFileList, signal }),
  retry: noRetryOn4xx,
});

export function useMemoryFiles(scopeId: string | null) {
  return useQuery({ ...filesQuery(scopeId ?? ""), enabled: !!scopeId });
}

/** Every readable scope's file list (metadata only), for the tree and the phone's "{n} files" line. */
export function useMemoryFilesByScope(scopeIds: readonly string[]) {
  const qc = useQueryClient();
  // `combine` output is structurally shared, so `lists` keeps its identity until a list really changes.
  const { lists, isError } = useQueries({
    queries: scopeIds.map((id) => filesQuery(id)),
    combine: (results) => ({
      lists: results.map((r) => r.data?.files),
      isError: results.some((r) => r.isError),
    }),
  });
  const files = useMemo(() => {
    const m = new Map<string, MemoryFileMeta[]>();
    lists.forEach((list, i) => {
      const id = scopeIds[i];
      if (id && list) m.set(id, list);
    });
    return m;
  }, [lists, scopeIds]);
  const refetch = () => qc.invalidateQueries({ queryKey: ["memory", "files"] });
  return { files, isError, refetch };
}

/** One file by its path in a scope (`GET /memory/scopes/:id/file?path=`). */
export function useMemoryFile(scopeId: string | null, path: string | null) {
  return useQuery({
    queryKey: memoryKeys.file(scopeId ?? "", path ?? ""),
    queryFn: ({ signal }) =>
      api.get(
        `/api/v1/memory/scopes/${encodeURIComponent(scopeId ?? "")}/file?path=${encodeURIComponent(path ?? "")}`,
        { schema: MemoryFile, signal },
      ),
    enabled: !!scopeId && !!path,
    retry: noRetryOn4xx,
  });
}

/** Full-text search over the readable files (≥ 2 characters; the caller debounces). */
export function useMemorySearch(q: string, scopeId: string | null) {
  const query = q.trim();
  return useQuery({
    queryKey: memoryKeys.search(query, scopeId),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ q: query });
      if (scopeId) params.set("scopeId", scopeId);
      return api.get(`/api/v1/memory/search?${params.toString()}`, { schema: MemorySearchResult, signal });
    },
    enabled: query.length >= 2,
    retry: noRetryOn4xx,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
}

/** Opens (creating on first use) the caller's private scope with a bot, or a bot's notebook (used by 07.2-14). */
export function useEnsureMemoryScope() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EnsureMemoryScopeRequest) =>
      api.post("/api/v1/memory/scopes", { body, schema: MemoryScope }),
    onSuccess: () => qc.invalidateQueries({ queryKey: memoryKeys.scopes }),
  });
}
