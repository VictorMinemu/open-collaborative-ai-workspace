"use client";

import type { WorkPrompt } from "@ocw/contracts";
import { ArrowDown, ArrowUp, GripVertical, ListOrdered, Pencil, Trash2 } from "lucide-react";
import { type DragEvent, useState } from "react";
import { toast } from "sonner";
import { UserAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api";
import { useRuntimeConfig } from "@/lib/config";
import { cn, relativeTime } from "@/lib/utils";
import { useUpdatePrompt } from "@/lib/workzone-queries";
import { ProposedByLine } from "./proposed-by-line";

/** The shared queue: anyone can edit, remove or reorder queued prompts (drag, or the arrow buttons). */
export function QueuePanel({ sessionId, prompts }: { sessionId: string; prompts: WorkPrompt[] }) {
  const update = useUpdatePrompt(sessionId);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const queued = prompts
    .filter((p) => p.status === "queued")
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  const current = prompts.find((p) => p.status === "dispatched" || p.status === "running");
  const done = prompts.filter((p) => ["completed", "failed", "cancelled"].includes(p.status)).length;

  function act(body: Parameters<typeof update.mutate>[0]) {
    update.mutate(body, { onError: (err) => toast.error(errorMessage(err)) });
  }

  function onDrop(e: DragEvent, index: number) {
    e.preventDefault();
    if (dragId) act({ id: dragId, index });
    setDragId(null);
    setOverIndex(null);
  }

  return (
    <div className="grid gap-3" data-testid="queue-panel">
      {current ? (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
          <p className="mb-1.5 flex items-center gap-1.5 font-medium text-[11px] text-primary uppercase tracking-wider">
            <Spinner className="size-3" /> Running now
          </p>
          <PromptMeta p={current} />
          <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-[13px]">{current.body}</p>
          <PromptThumbs p={current} />
        </div>
      ) : null}

      {queued.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center">
          <ListOrdered className="mx-auto mb-2 size-5 text-muted-foreground" />
          <p className="font-medium text-sm">Queue is empty</p>
          <p className="mt-0.5 text-muted-foreground text-xs">
            Prompts sent while the agent works line up here. Anyone can reorder them.
          </p>
        </div>
      ) : (
        <ol className="grid gap-2">
          {queued.map((p, i) => (
            <li
              key={p.id}
              data-testid="queued-prompt"
              draggable
              onDragStart={(e) => {
                setDragId(p.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => {
                setDragId(null);
                setOverIndex(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOverIndex(i);
              }}
              onDrop={(e) => onDrop(e, i)}
              className={cn(
                "group rounded-lg border bg-card transition-[box-shadow,opacity,border-color]",
                dragId === p.id && "opacity-50",
                overIndex === i &&
                  dragId &&
                  dragId !== p.id &&
                  "border-primary/60 ring-[3px] ring-primary/15",
              )}
            >
              <QueuedItem
                p={p}
                index={i}
                last={i === queued.length - 1}
                onMove={(index) => act({ id: p.id, index })}
                onEdit={(body) => act({ id: p.id, body })}
                onRemove={() => act({ id: p.id, status: "cancelled" })}
              />
            </li>
          ))}
        </ol>
      )}
      {done > 0 ? (
        <p className="text-center text-muted-foreground text-xs">
          {done} earlier prompt{done === 1 ? "" : "s"} in the stream
        </p>
      ) : null}
    </div>
  );
}

function PromptMeta({ p }: { p: WorkPrompt }) {
  const name = p.authorName ?? "Someone";
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
      <UserAvatar name={name} seed={p.authorUserId} className="size-4 text-[8px]" />
      <span className="truncate font-medium text-foreground/80">{name}</span>
      {p.proposedBy ? <ProposedByLine agent={p.proposedBy} /> : null}
      <span>· {relativeTime(p.createdAt)}</span>
    </span>
  );
}

/**
 * A prompt's images in the queue (06.1, WZ-IMG-04): small square previews (the API's webp preview, never the original),
 * in send order, for every controller.
 */
function PromptThumbs({ p }: { p: WorkPrompt }) {
  const { apiUrl } = useRuntimeConfig();
  const images = p.attachments.filter((a) => a.isImage && a.previewUrl);
  if (images.length === 0) return null;
  return (
    <ul
      className="mt-2 flex flex-wrap gap-1.5"
      aria-label={`${images.length} attached image${images.length === 1 ? "" : "s"}`}
    >
      {images.map((a) => (
        <li key={a.id} className="size-11 shrink-0 overflow-hidden rounded-md border bg-muted">
          {/* biome-ignore lint/performance/noImgElement: an authorized API redirect to a short-lived URL */}
          <img
            src={`${apiUrl}${a.previewUrl}`}
            alt={a.filename}
            title={a.filename}
            loading="lazy"
            decoding="async"
            draggable={false}
            data-testid="prompt-thumb"
            className="size-full object-cover"
          />
        </li>
      ))}
    </ul>
  );
}

function QueuedItem({
  p,
  index,
  last,
  onMove,
  onEdit,
  onRemove,
}: {
  p: WorkPrompt;
  index: number;
  last: boolean;
  onMove: (index: number) => void;
  onEdit: (body: string) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(p.body);
  return (
    <div className="flex gap-2 p-2.5">
      <div className="flex flex-col items-center gap-1 pt-0.5">
        <GripVertical
          className="size-4 cursor-grab text-muted-foreground/60 active:cursor-grabbing"
          aria-hidden
        />
        <span className="font-medium text-[11px] text-muted-foreground tabular-nums">#{index + 1}</span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <PromptMeta p={p} />
          {editing ? null : (
            <div className="-my-1 ml-auto flex shrink-0 gap-0.5 opacity-100 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Move up"
                disabled={index === 0}
                onClick={() => onMove(index - 1)}
              >
                <ArrowUp />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Move down"
                disabled={last}
                onClick={() => onMove(index + 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Edit"
                onClick={() => {
                  setDraft(p.body);
                  setEditing(true);
                }}
              >
                <Pencil />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Remove"
                onClick={onRemove}
                className="hover:text-destructive"
              >
                <Trash2 />
              </Button>
            </div>
          )}
        </div>
        {editing ? (
          <form
            className="mt-1.5 grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim()) onEdit(draft.trim());
              setEditing(false);
            }}
          >
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              autoFocus
              aria-label="Edit prompt"
            />
            <div className="flex justify-end gap-1.5">
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm">
                Save
              </Button>
            </div>
          </form>
        ) : (
          <>
            <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-[13px]">{p.body}</p>
            <PromptThumbs p={p} />
          </>
        )}
      </div>
    </div>
  );
}
