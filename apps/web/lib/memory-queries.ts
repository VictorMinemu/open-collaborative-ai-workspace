"use client";

import {
  type EnsureMemoryScopeRequest,
  EventTypes,
  MemoryChangedEvent,
  MemoryFile,
  MemoryFileList,
  type MemoryFileMeta,
  MemoryRevision,
  MemoryRevisionList,
  MemoryScope,
  MemoryScopeList,
  MemorySearchResult,
  Ok,
  topic,
} from "@ocw/contracts";
import {
  keepPreviousData,
  type QueryClient,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { api, isApiError } from "./api";
import { useMe } from "./queries";
import { useTopic } from "./realtime";

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
  revisions: (fileId: string) => ["memory", "revisions", fileId] as const,
  revision: (fileId: string, version: number) => ["memory", "revision", fileId, version] as const,
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

// ---------------------------------------------------------------- history (07.2-12)

/** A file's history, newest first (MemoryRevisionMeta: op, path, +N −M, author, approval). */
export function useMemoryRevisions(fileId: string | null) {
  return useQuery({
    queryKey: memoryKeys.revisions(fileId ?? ""),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/memory/files/${encodeURIComponent(fileId ?? "")}/revisions`, {
        schema: MemoryRevisionList,
        signal,
      }),
    enabled: !!fileId,
    retry: noRetryOn4xx,
  });
}

/** One revision with its content; `version` 0 or null reads nothing (version 1 compares against empty). Immutable. */
export function useMemoryRevision(fileId: string | null, version: number | null) {
  return useQuery({
    queryKey: memoryKeys.revision(fileId ?? "", version ?? 0),
    queryFn: ({ signal }) =>
      api.get(`/api/v1/memory/files/${encodeURIComponent(fileId ?? "")}/revisions/${version ?? 0}`, {
        schema: MemoryRevision,
        signal,
      }),
    enabled: !!fileId && !!version && version > 0,
    retry: noRetryOn4xx,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

// ---------------------------------------------------------------- writes (07.2-12)

/** After any write: the file by path, the scope's list (tree), the file's history and search hits. */
function afterWrite(
  qc: QueryClient,
  file: { id: string; scopeId: string; path: string } & Partial<MemoryFile>,
) {
  if (file.content !== undefined && file.viewerCan) {
    qc.setQueryData(memoryKeys.file(file.scopeId, file.path), file as MemoryFile);
  }
  void qc.invalidateQueries({ queryKey: memoryKeys.files(file.scopeId) });
  void qc.invalidateQueries({ queryKey: memoryKeys.revisions(file.id) });
  void qc.invalidateQueries({ queryKey: ["memory", "search"] });
}

export function useCreateMemoryFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { scopeId: string; path: string; content: string }) =>
      api.post(`/api/v1/memory/scopes/${encodeURIComponent(v.scopeId)}/files`, {
        body: { path: v.path, content: v.content },
        schema: MemoryFile,
      }),
    onSuccess: (file) => afterWrite(qc, file),
  });
}

/** Saves with the version the edit started from: 409 `memory_version_conflict` instead of a silent overwrite. */
export function useUpdateMemoryFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { fileId: string; content: string; expectedVersion: number }) =>
      api.put(`/api/v1/memory/files/${encodeURIComponent(v.fileId)}`, {
        body: { content: v.content, expectedVersion: v.expectedVersion },
        schema: MemoryFile,
      }),
    onSuccess: (file) => afterWrite(qc, file),
  });
}

export function useRenameMemoryFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { fileId: string; path: string; expectedVersion: number; from: string }) =>
      api.post(`/api/v1/memory/files/${encodeURIComponent(v.fileId)}/rename`, {
        body: { path: v.path, expectedVersion: v.expectedVersion },
        schema: MemoryFile,
      }),
    onSuccess: (file, v) => {
      qc.removeQueries({ queryKey: memoryKeys.file(file.scopeId, v.from) });
      afterWrite(qc, file);
    },
  });
}

export function useDeleteMemoryFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { fileId: string; scopeId: string; path: string; expectedVersion: number }) =>
      api.del(
        `/api/v1/memory/files/${encodeURIComponent(v.fileId)}?expectedVersion=${encodeURIComponent(v.expectedVersion)}`,
        { schema: Ok },
      ),
    onSuccess: (_ok, v) => {
      qc.removeQueries({ queryKey: memoryKeys.file(v.scopeId, v.path) });
      afterWrite(qc, { id: v.fileId, scopeId: v.scopeId, path: v.path });
    },
  });
}

/** Restores an old revision as a new version (op "restore"). */
export function useRestoreMemoryRevision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { fileId: string; version: number; expectedVersion: number }) =>
      api.post(`/api/v1/memory/files/${encodeURIComponent(v.fileId)}/restore`, {
        body: { version: v.version, expectedVersion: v.expectedVersion },
        schema: MemoryFile,
      }),
    onSuccess: (file) => afterWrite(qc, file),
  });
}

// ---------------------------------------------------------------- live (07.2-12)

/**
 * `memory.changed {scopeId, fileId, version}`: ids and a version only. Private memory (and a personal bot's notebook)
 * and shared memory with a restricted reader set arrive on the viewer's own `user:` stream; organization-wide memory
 * everyone may read arrives on the organization's stream (WINDOWS 157). It refreshes that scope's tree, its open files
 * and the file's history; the open file announces the new version itself. Mounted once by the memory shell.
 */
export function useMemoryLiveUpdates() {
  const qc = useQueryClient();
  const me = useMe({ enabled: false });
  const userId = me.data?.user.id ?? null;
  const orgId = me.data?.organization.id ?? null;
  const onFrame = (frame: { op: string; type?: string; data?: unknown }) => {
    if (frame.op !== "ev" || frame.type !== EventTypes.memoryChanged) return;
    const parsed = MemoryChangedEvent.safeParse(frame.data);
    if (!parsed.success) return;
    const { scopeId, fileId } = parsed.data;
    void qc.invalidateQueries({ queryKey: memoryKeys.files(scopeId) });
    void qc.invalidateQueries({ queryKey: ["memory", "file", scopeId] });
    void qc.invalidateQueries({ queryKey: memoryKeys.revisions(fileId) });
  };
  useTopic(userId ? topic("user", userId) : null, onFrame);
  useTopic(orgId ? topic("org", orgId) : null, onFrame);
}
