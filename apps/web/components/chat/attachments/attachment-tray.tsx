"use client";

import { type Attachment, INLINE_IMAGE_TYPES } from "@ocw/contracts";
import { AlertCircle, RotateCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { type UploadHandle, uploadAttachment } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { FileIcon } from "./file-card";
import {
  contentTypeOf,
  formatBytes,
  type Limits,
  middleEllipsis,
  screenFiles,
  uploadErrorText,
} from "./files";

/** One file in the composer: uploading as soon as it is added, then `ready` (sendable) or `error`. */
export interface QueueItem {
  localId: string;
  file: File;
  name: string;
  size: number;
  contentType: string;
  /** A local thumbnail (object URL) for raster images; revoked when the item leaves the tray. */
  thumbUrl: string | null;
  status: "uploading" | "ready" | "error";
  /** 0..1 of the PUT to storage. */
  progress: number;
  error: string | null;
  /** Client-side refusals (size, empty) cannot be retried; server and network failures can. */
  retryable: boolean;
  attachment: Attachment | null;
}

export interface AttachmentQueue {
  items: QueueItem[];
  add(files: File[]): void;
  remove(localId: string): void;
  retry(localId: string): void;
  /** Ids of the uploaded, verified files, in tray order. */
  readyIds: string[];
  /** The verified attachments, in tray order (pending rows show them while the message is sent). */
  ready: Attachment[];
  /** An upload is still running: sending waits. */
  busy: boolean;
  /** A file failed or was refused: it must be removed (or retried) before sending. */
  blocked: boolean;
  reset(): void;
}

const INLINE = new Set<string>(INLINE_IMAGE_TYPES);
const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";
let seq = 0;

/**
 * The composer's attachment queue for one conversation (CHAT-12): files are checked against the server limits
 * before anything is uploaded, then each one uploads on its own (presign → PUT with progress → complete). Changing
 * conversation or unmounting cancels running uploads and frees the local thumbnails.
 */
export function useAttachmentQueue(conversationId: string, limits?: Limits | null): AttachmentQueue {
  const [items, setItems] = useState<QueueItem[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const handles = useRef(new Map<string, UploadHandle>());

  const patch = useCallback((localId: string, next: Partial<QueueItem>) => {
    setItems((prev) => prev.map((i) => (i.localId === localId ? { ...i, ...next } : i)));
  }, []);

  const start = useCallback(
    (item: QueueItem) => {
      const handle = uploadAttachment(conversationId, item.file, (progress) =>
        patch(item.localId, { progress }),
      );
      handles.current.set(item.localId, handle);
      handle.promise.then(
        (attachment) => patch(item.localId, { status: "ready", progress: 1, attachment }),
        (err) => {
          if (isAbort(err)) return;
          patch(item.localId, {
            status: "error",
            error: uploadErrorText(err, limits?.maxBytes),
            retryable: true,
          });
        },
      );
      void handle.promise
        .finally(() => {
          if (handles.current.get(item.localId) === handle) handles.current.delete(item.localId);
        })
        .catch(() => {});
    },
    [conversationId, limits?.maxBytes, patch],
  );

  const add = useCallback(
    (files: File[]) => {
      if (!limits || files.length === 0) return;
      const { accepted, dropped } = screenFiles(files, limits, itemsRef.current.length);
      if (dropped > 0) toast.error(`You can attach up to ${limits.maxPerMessage} files to a message`);
      const added = accepted.map(({ file, error }): QueueItem => {
        const contentType = contentTypeOf(file);
        return {
          localId: `f${++seq}`,
          file,
          name: file.name || "file",
          size: file.size,
          contentType,
          thumbUrl: INLINE.has(contentType) && !error ? URL.createObjectURL(file) : null,
          status: error ? "error" : "uploading",
          progress: 0,
          error,
          retryable: false,
          attachment: null,
        };
      });
      if (added.length === 0) return;
      itemsRef.current = [...itemsRef.current, ...added];
      setItems((prev) => [...prev, ...added]);
      for (const item of added) if (item.status === "uploading") start(item);
    },
    [limits, start],
  );

  const drop = useCallback((item: QueueItem) => {
    handles.current.get(item.localId)?.abort();
    handles.current.delete(item.localId);
    if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  }, []);

  const remove = useCallback(
    (localId: string) => {
      const item = itemsRef.current.find((i) => i.localId === localId);
      if (item) drop(item);
      itemsRef.current = itemsRef.current.filter((i) => i.localId !== localId);
      setItems((prev) => prev.filter((i) => i.localId !== localId));
    },
    [drop],
  );

  const retry = useCallback(
    (localId: string) => {
      const item = itemsRef.current.find((i) => i.localId === localId);
      if (!item?.retryable) return;
      const next = { ...item, status: "uploading" as const, progress: 0, error: null, retryable: false };
      patch(localId, next);
      start(next);
    },
    [patch, start],
  );

  const reset = useCallback(() => {
    for (const item of itemsRef.current) drop(item);
    itemsRef.current = [];
    setItems([]);
  }, [drop]);

  // A different conversation (or leaving the view) cancels what is still uploading here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the conversation changes
  useEffect(() => reset, [conversationId, reset]);

  return useMemo(() => {
    const ready = items.flatMap((i) => (i.status === "ready" && i.attachment ? [i.attachment] : []));
    return {
      items,
      add,
      remove,
      retry,
      reset,
      ready,
      readyIds: ready.map((a) => a.id),
      busy: items.some((i) => i.status === "uploading"),
      blocked: items.some((i) => i.status === "error"),
    };
  }, [items, add, remove, retry, reset]);
}

/** The files waiting in the composer: thumbnails or file chips, progress, errors, retry and remove. */
export function AttachmentTray({ queue }: { queue: AttachmentQueue }) {
  if (queue.items.length === 0) return null;
  return (
    <ul
      data-testid="attachment-tray"
      aria-label="Files to send"
      className="scrollbar-thin -mx-1 flex gap-2 overflow-x-auto px-1 pt-1 pb-2"
    >
      {queue.items.map((item) => (
        <TrayItem
          key={item.localId}
          item={item}
          onRemove={() => queue.remove(item.localId)}
          onRetry={() => queue.retry(item.localId)}
        />
      ))}
    </ul>
  );
}

function Progress({ item }: { item: QueueItem }) {
  if (item.status === "error") return null;
  const pct = Math.round(item.progress * 100);
  return (
    <div
      role="progressbar"
      aria-label={`Uploading ${item.name}`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      data-testid="attachment-progress"
      data-done={item.status === "ready" ? "true" : undefined}
      className={cn(
        "absolute inset-x-0 bottom-0 h-1 bg-black/10 transition-opacity duration-500 dark:bg-white/10",
        item.status === "ready" && "opacity-0",
      )}
    >
      <div
        className="h-full bg-primary transition-[width] duration-200 ease-out"
        style={{ width: `${item.status === "ready" ? 100 : Math.max(4, pct)}%` }}
      />
    </div>
  );
}

function RemoveButton({
  name,
  onRemove,
  floating,
}: {
  name: string;
  onRemove: () => void;
  floating?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={`Remove ${name}`}
      data-testid="attachment-remove"
      onClick={onRemove}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40",
        floating
          ? "absolute top-1 right-1 size-5 bg-black/60 text-white hover:bg-black/80"
          : "size-6 text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <X className={floating ? "size-3" : "size-3.5"} strokeWidth={2.5} />
    </button>
  );
}

function TrayItem({
  item,
  onRemove,
  onRetry,
}: {
  item: QueueItem;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const failed = item.status === "error";
  if (item.thumbUrl && !failed) {
    return (
      <li
        data-testid="attachment-item"
        data-status={item.status}
        title={`${item.name} · ${formatBytes(item.size)}`}
        className="relative size-16 shrink-0 overflow-hidden rounded-lg border bg-muted"
      >
        {/* biome-ignore lint/performance/noImgElement: a local object URL, not an optimisable asset */}
        <img
          src={item.thumbUrl}
          alt={item.name}
          data-testid="attachment-thumb"
          className={cn("size-full object-cover", item.status === "uploading" && "opacity-70")}
        />
        <RemoveButton name={item.name} onRemove={onRemove} floating />
        <Progress item={item} />
      </li>
    );
  }
  return (
    <li
      data-testid="attachment-item"
      data-status={item.status}
      className={cn(
        "relative flex h-16 w-56 shrink-0 items-center gap-2.5 overflow-hidden rounded-lg border bg-background py-2 pr-1.5 pl-2.5 dark:bg-input/20",
        failed && "border-destructive/50 bg-destructive/[0.04] dark:bg-destructive/10",
      )}
    >
      {failed ? (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-destructive/10 text-destructive">
          <AlertCircle className="size-[18px]" />
        </span>
      ) : (
        <FileIcon contentType={item.contentType} name={item.name} className="size-9" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-[13px] leading-5" title={item.name}>
          {middleEllipsis(item.name, 28)}
        </p>
        {failed ? (
          <p data-testid="attachment-error" className="line-clamp-2 text-[11.5px] text-destructive leading-4">
            {item.error}
          </p>
        ) : (
          <p className="text-[11.5px] text-muted-foreground tabular-nums leading-4">
            {item.status === "uploading"
              ? `${Math.round(item.progress * 100)}% of ${formatBytes(item.size)}`
              : formatBytes(item.size)}
          </p>
        )}
      </div>
      {failed && item.retryable ? (
        <button
          type="button"
          aria-label={`Retry ${item.name}`}
          data-testid="attachment-retry"
          onClick={onRetry}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          <RotateCw className="size-3.5" />
        </button>
      ) : null}
      <RemoveButton name={item.name} onRemove={onRemove} />
      <Progress item={item} />
    </li>
  );
}
