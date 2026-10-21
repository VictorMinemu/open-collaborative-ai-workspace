"use client";

import {
  AgentChannelSandboxDeleteResponse,
  AgentChannelSandboxWriteResponse,
  SANDBOX_LIMITS,
  type SandboxFileEntry,
  SandboxFileList,
  SandboxFilePreview,
  SandboxStatusView,
} from "@ocw/contracts";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiRequestError, api, isApiError } from "./api";
import { getRuntimeConfig } from "./config";

/**
 * A bot's sandbox from its page (07.8-15; SBX-05, D-04, UI-SPEC Surface 3): the status card, folder listings, previews,
 * and the file and lifecycle actions of the people's routes (07.8-11). The API decides who may use them (the resolver's
 * `sandbox.files`: configurers only, a 404 for anyone else); the web renders what it answers. Bytes only ever travel
 * through the API's routes: never a sandbox URL (D-04, T-07.8-15-03).
 */

export const sandboxKeys = {
  all: (agentId: string) => ["sandbox", agentId] as const,
  status: (agentId: string) => ["sandbox", agentId, "status"] as const,
  list: (agentId: string, path: string) => ["sandbox", agentId, "list", path] as const,
  content: (agentId: string, path: string) => ["sandbox", agentId, "content", path] as const,
};

/** The status card refreshes every 30 s while the page is visible (UI-SPEC Interaction › Sandbox tab). */
export const STATUS_REFRESH_MS = 30_000;
/** Expanded folders refresh this often while the tab is visible, so files the bot writes show up. */
export const FILES_REFRESH_MS = 10_000;
export const UPLOAD_MAX_BYTES = SANDBOX_LIMITS.uploadMaxBytes;

const base = (agentId: string) => `/api/v1/agents/${encodeURIComponent(agentId)}/sandbox`;
const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

/**
 * The bot's sandbox status. A 404 means the viewer may not manage this bot's sandbox (or the Sandbox module is off for
 * them): the tab is absent. `poll`: every 30 s while the Sandbox tab is open and the page visible.
 */
export function useSandboxStatus(agentId: string, opts: { enabled: boolean; poll: boolean }) {
  return useQuery({
    enabled: opts.enabled,
    queryKey: sandboxKeys.status(agentId),
    queryFn: ({ signal }) => api.get(base(agentId), { schema: SandboxStatusView, signal }),
    retry: noRetryOn4xx,
    refetchInterval: (query) => (opts.poll && query.state.status === "success" ? STATUS_REFRESH_MS : false),
  });
}

/** One folder (`""` = `/workspace`), fresh from the API. */
export function fetchSandboxFolder(qc: QueryClient, agentId: string, path: string) {
  return qc.fetchQuery({
    queryKey: sandboxKeys.list(agentId, path),
    queryFn: ({ signal }) =>
      api.get(`${base(agentId)}/files?${q({ path })}`, { schema: SandboxFileList, signal }),
    staleTime: 0,
    retry: noRetryOn4xx,
  });
}

/** Folders first, then files; numeric-aware, case-insensitive (UI-SPEC §3.1 Order). */
export function sortEntries(entries: readonly SandboxFileEntry[]): SandboxFileEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  });
}

/** What the preview shows for one file. Fetched once; a change made by the bot asks the person to reload. */
export function useSandboxPreview(agentId: string, path: string | null) {
  return useQuery({
    enabled: !!path,
    queryKey: sandboxKeys.content(agentId, path ?? ""),
    queryFn: ({ signal }) =>
      api.get(`${base(agentId)}/files/content?${q({ path: path ?? "" })}`, {
        schema: SandboxFilePreview,
        signal,
      }),
    retry: noRetryOn4xx,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** The API route a file downloads from (an attachment; the only way bytes leave the sandbox). */
export function sandboxDownloadUrl(agentId: string, path: string): string {
  return `${getRuntimeConfig().apiUrl}${base(agentId)}/files/download?${q({ path })}`;
}

/** The file's bytes from the API, or a request error with the API's code. */
async function fetchBytes(agentId: string, path: string, signal?: AbortSignal): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(sandboxDownloadUrl(agentId, path), { credentials: "include", signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiRequestError(0, "network_error", "Can't reach the server");
  }
  if (!res.ok)
    throw new ApiRequestError(res.status, `http_${res.status}`, res.statusText || "Request failed");
  return res.blob();
}

/** Saves a file through the API's download route (`Content-Disposition: attachment`). */
export async function downloadSandboxFile(agentId: string, path: string, name: string): Promise<void> {
  const blob = await fetchBytes(agentId, path);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
  } finally {
    // The click starts the save synchronously; the URL can go once the event loop moves on.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * A raster image preview from the API's bytes as a local object URL (never the API URL in an `<img>`, which would
 * carry no credentials cross-site, and never inline data the server did not classify as an image). Revoked on change.
 */
export function useSandboxImage(agentId: string, path: string | null) {
  const [state, setState] = useState<{ url: string | null; error: boolean }>({ url: null, error: false });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    let url: string | null = null;
    setState({ url: null, error: false });
    fetchBytes(agentId, path, controller.signal).then(
      (blob) => {
        url = URL.createObjectURL(blob);
        setState({ url, error: false });
      },
      (err) => {
        if (!(err instanceof DOMException && err.name === "AbortError")) setState({ url: null, error: true });
      },
    );
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [agentId, path]);
  return state;
}

/** The people's upload and delete routes answer with these contract shapes (`{ path, size }`, `{ path, deleted }`). */
const Uploaded = AgentChannelSandboxWriteResponse;
const Deleted = AgentChannelSandboxDeleteResponse;

export interface SandboxUpload {
  promise: Promise<{ path: string; size: number }>;
  abort(): void;
}

/**
 * One file into `folder` (`""` = the root) as raw bytes (the API takes up to 50 MiB and answers 409 `upload_exists`
 * unless `replace`). `XMLHttpRequest` because `fetch` has no upload progress.
 */
export function uploadSandboxFile(
  agentId: string,
  folder: string,
  file: File,
  opts: { replace: boolean; onProgress: (fraction: number) => void },
): SandboxUpload {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ path: string; size: number }>((resolve, reject) => {
    const url = `${getRuntimeConfig().apiUrl}${base(agentId)}/files/upload?${q({
      path: folder,
      name: file.name,
      replace: opts.replace ? "1" : "0",
    })}`;
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) opts.onProgress(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = Uploaded.safeParse(body);
        if (parsed.success) resolve(parsed.data);
        else reject(new ApiRequestError(xhr.status, "invalid_response", "Upload failed"));
        return;
      }
      const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      reject(
        new ApiRequestError(
          xhr.status,
          typeof error?.code === "string" ? error.code : `http_${xhr.status}`,
          typeof error?.message === "string" ? error.message : "Upload failed",
        ),
      );
    };
    xhr.onerror = () => reject(new ApiRequestError(0, "network_error", "Upload failed"));
    xhr.onabort = () => reject(new DOMException("Upload stopped", "AbortError"));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

/** Deletes a file, or a folder with everything in it. */
export function useDeleteSandboxPath(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { path: string; folder: boolean }) =>
      api.del(`${base(agentId)}/files?${q({ path: p.path, recursive: p.folder ? "1" : "0" })}`, {
        schema: Deleted,
      }),
    onSettled: () => void qc.invalidateQueries({ queryKey: sandboxKeys.status(agentId) }),
  });
}

/** Stop or restart the bot's sandbox; the answer is the new status. */
export function useSandboxLifecycle(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: "stop" | "restart") =>
      api.post(`${base(agentId)}/${action}`, { schema: SandboxStatusView }),
    onSuccess: (view) => qc.setQueryData(sandboxKeys.status(agentId), view),
    onError: () => void qc.invalidateQueries({ queryKey: sandboxKeys.status(agentId) }),
  });
}
