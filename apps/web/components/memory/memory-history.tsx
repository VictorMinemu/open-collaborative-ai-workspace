"use client";

import type { MemoryFile, MemoryRevisionMeta } from "@ocw/contracts";
import { ArrowLeft, ArrowUpRight, RotateCcw, X } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { actorLabel, revisionAccessibleName, revisionOpLabel, saveErrorText } from "@/lib/memory-edit";
import { useMemoryRevision, useMemoryRevisions, useRestoreMemoryRevision } from "@/lib/memory-queries";
import { cn, relativeTime, shortAge } from "@/lib/utils";

/**
 * A memory file's history (Phase 07.2, 07.2-12, MEM-02, UI-SPEC "History list", "History and restore"): every
 * revision newest first (version, what happened, who — a bot on behalf of a person included —, when, +N −M, the
 * approval that applied it), 30 at a time. Selecting one shows its diff against the previous version (version 1
 * against empty) through the lazy `MemoryDiff`; writers can restore an older version as a new one.
 */

const MemoryDiff = dynamic(() => import("./memory-diff"), {
  ssr: false,
  loading: () => <DiffSkeleton />,
});

const PAGE = 30;

export const ADDED_CLASS = "text-emerald-700 dark:text-emerald-400";
export const REMOVED_CLASS = "text-red-700 dark:text-red-400";

export function Counts({
  added,
  removed,
  testIds = false,
}: {
  added: number;
  removed: number;
  testIds?: boolean;
}) {
  return (
    <span aria-hidden className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs tabular-nums">
      <span data-testid={testIds ? "memory-diff-added" : undefined} className={ADDED_CLASS}>
        +{added}
      </span>
      <span data-testid={testIds ? "memory-diff-removed" : undefined} className={REMOVED_CLASS}>
        −{removed}
      </span>
    </span>
  );
}

function DiffSkeleton() {
  return (
    <div aria-busy className="grid gap-2 p-4">
      {["w-3/4", "w-1/2", "w-5/6", "w-2/3"].map((w) => (
        <Skeleton key={w} className={cn("h-3.5 motion-reduce:animate-none", w)} />
      ))}
    </div>
  );
}

export interface MemoryHistoryProps {
  file: MemoryFile;
  selected: number | null;
  onSelect: (version: number) => void;
  /** Phone and the 1024–1279 History tab: 44 px controls. */
  compact?: boolean;
}

export function MemoryHistory({ file, selected, onSelect, compact = false }: MemoryHistoryProps) {
  const q = useMemoryRevisions(file.id);
  const [shown, setShown] = useState(PAGE);
  const revisions = q.data?.revisions;

  if (q.isError) {
    return (
      <div data-testid="memory-history-error" className="grid gap-2 px-4 py-4 text-sm">
        <p className="text-muted-foreground">Couldn't load history.</p>
        <Button variant="outline" size="sm" className="w-fit max-lg:h-11" onClick={() => void q.refetch()}>
          <RotateCcw /> Try again
        </Button>
      </div>
    );
  }
  if (!revisions) {
    return (
      <div data-testid="memory-history-loading" aria-busy className="grid">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="grid h-16 content-center gap-2 border-b px-4">
            <Skeleton className="h-3.5 w-1/2 motion-reduce:animate-none" />
            <Skeleton className="h-3 w-1/3 motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div data-testid="memory-history">
      <ul aria-label="Versions" className="grid">
        {revisions.slice(0, shown).map((rev, i) => (
          <RevisionRow
            key={rev.version}
            rev={rev}
            older={revisions[i + 1]}
            selected={rev.version === selected}
            onSelect={() => onSelect(rev.version)}
          />
        ))}
      </ul>
      {revisions.length === 1 ? (
        <p className="px-4 py-3 text-muted-foreground text-xs">No earlier versions.</p>
      ) : null}
      {revisions.length > shown ? (
        <div className="px-4 py-3">
          <Button
            variant="outline"
            size="sm"
            className={cn("w-full", compact && "h-11")}
            onClick={() => setShown((n) => n + PAGE)}
          >
            Show older versions
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function RevisionRow({
  rev,
  older,
  selected,
  onSelect,
}: {
  rev: MemoryRevisionMeta;
  older: MemoryRevisionMeta | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const op = revisionOpLabel(rev, older);
  // The visible age is short ("2m ago"); the row's accessible name keeps the long form (UI-SPEC a11y).
  const age = relativeTime(rev.createdAt);
  const actor = rev.author;
  return (
    <li className={cn("relative border-b", selected && "bg-accent")}>
      {selected ? (
        <span aria-hidden className="absolute top-2 bottom-2 left-0 w-0.5 rounded-r-full bg-primary" />
      ) : null}
      <button
        type="button"
        data-testid="memory-revision"
        data-version={rev.version}
        aria-pressed={selected}
        aria-label={revisionAccessibleName(rev, op, age)}
        onClick={onSelect}
        className={cn(
          "grid min-h-16 w-full gap-1 px-4 py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset",
          !selected && "hover:bg-accent/60",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono font-semibold text-muted-foreground text-xs tabular-nums">
            v{rev.version}
          </span>
          <span className="min-w-0 flex-1 truncate font-semibold text-sm">{op}</span>
          <Counts added={rev.linesAdded} removed={rev.linesRemoved} />
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          <PrincipalAvatar
            kind={actor.kind === "agent" ? "agent" : actor.kind === "system" ? "system" : "user"}
            name={actor.displayName}
            seed={actor.id}
            compact
            className="size-5 text-[10px]"
          />
          <span className="min-w-0 truncate">{actorLabel(actor)}</span>
          <span aria-hidden>·</span>
          <time dateTime={rev.createdAt} className="shrink-0">
            {shortAge(rev.createdAt)}
          </time>
        </span>
      </button>
      {rev.approvalRequestId ? (
        <p
          data-testid="memory-revision-approval"
          className="-mt-2 flex min-w-0 items-center gap-1 px-4 pb-3 text-muted-foreground text-xs"
        >
          <span className="min-w-0 truncate">
            {rev.approvedBy ? `Approved by ${rev.approvedBy.displayName}` : "Approved proposal"}
          </span>
          <span aria-hidden>·</span>
          <Link
            href={`/memory/proposals/${rev.approvalRequestId}`}
            className="inline-flex items-center gap-0.5 rounded-sm text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            View proposal <ArrowUpRight aria-hidden className="size-3" />
          </Link>
        </p>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------- one revision against the previous one

export interface MemoryRevisionViewProps {
  file: MemoryFile;
  version: number;
  canWrite: boolean;
  compact: boolean;
  onClose: () => void;
  /** After a restore: the new version (the diff closes, the document shows it). */
  onRestored: (file: MemoryFile) => void;
}

export function MemoryRevisionView({
  file,
  version,
  canWrite,
  compact,
  onClose,
  onRestored,
}: MemoryRevisionViewProps) {
  const list = useMemoryRevisions(file.id);
  const meta = list.data?.revisions.find((r) => r.version === version);
  const after = useMemoryRevision(file.id, version);
  const before = useMemoryRevision(file.id, version > 1 ? version - 1 : null);
  const [confirming, setConfirming] = useState(false);
  const latest = list.data?.revisions[0]?.version ?? file.version;
  const fromLabel = version > 1 ? `Version ${version - 1}` : "Empty";

  // Escape closes the comparison (desktop; the phone uses "All versions").
  useEffect(() => {
    if (compact) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('[role="dialog"], [role="menu"], input, textarea')) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [compact, onClose]);

  const ready = after.data && (version === 1 || before.data);
  const failed = after.isError || before.isError;

  return (
    <section
      data-testid="memory-revision-view"
      data-version={version}
      className="flex min-h-0 flex-1 flex-col"
    >
      {compact ? (
        <div className="flex h-11 shrink-0 items-center justify-between gap-2 px-1">
          <Button variant="ghost" className="h-11" onClick={onClose}>
            <ArrowLeft /> All versions
          </Button>
          {canWrite && version !== latest ? (
            <Button variant="outline" className="mr-3 h-11" onClick={() => setConfirming(true)}>
              <RotateCcw /> Restore
            </Button>
          ) : null}
        </div>
      ) : null}
      <div
        className={cn(
          "flex shrink-0 items-center gap-3 border-b text-sm",
          compact ? "min-h-11 px-4 py-2" : "h-12 px-6",
        )}
      >
        <span className="min-w-0 truncate font-semibold">
          {fromLabel} → Version {version}
        </span>
        {meta ? <Counts added={meta.linesAdded} removed={meta.linesRemoved} testIds /> : null}
        {!compact ? (
          <span className="ml-auto flex items-center gap-1">
            {canWrite && version !== latest ? (
              <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
                <RotateCcw /> Restore version {version}
              </Button>
            ) : null}
            <Button variant="ghost" size="icon-sm" aria-label="Close comparison" onClick={onClose}>
              <X />
            </Button>
          </span>
        ) : null}
      </div>
      {failed ? (
        <div className="grid gap-2 px-6 py-6 text-sm">
          <p className="text-muted-foreground">Couldn't load this version.</p>
          <Button
            variant="outline"
            size="sm"
            className="w-fit max-lg:h-11"
            onClick={() => {
              void after.refetch();
              void before.refetch();
            }}
          >
            <RotateCcw /> Try again
          </Button>
        </div>
      ) : ready ? (
        <MemoryDiff
          className="min-h-0 flex-1"
          layout={compact ? "unified" : "auto"}
          label={`Changes from ${version > 1 ? `version ${version - 1}` : "empty"} to version ${version}`}
          summary={meta ? `${meta.linesAdded} lines added, ${meta.linesRemoved} removed` : undefined}
          before={{ label: fromLabel, doc: before.data?.content ?? "" }}
          after={{ label: `Version ${version}`, doc: after.data?.content ?? "" }}
        />
      ) : (
        <DiffSkeleton />
      )}
      <RestoreDialog
        open={confirming}
        onOpenChange={setConfirming}
        file={file}
        version={version}
        latest={latest}
        onRestored={onRestored}
      />
    </section>
  );
}

function RestoreDialog({
  open,
  onOpenChange,
  file,
  version,
  latest,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: MemoryFile;
  version: number;
  latest: number;
  onRestored: (file: MemoryFile) => void;
}) {
  const restore = useRestoreMemoryRevision();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);
  const confirm = () =>
    restore.mutate(
      { fileId: file.id, version, expectedVersion: file.version },
      {
        onSuccess: (restored) => {
          onOpenChange(false);
          toast.success(`Restored version ${version} as version ${restored.version}`);
          onRestored(restored);
        },
        onError: (err) => setError(saveErrorText(err)),
      },
    );
  return (
    <Dialog open={open} onOpenChange={(o) => !restore.isPending && onOpenChange(o)}>
      <DialogContent data-testid="memory-restore-dialog" initialFocus={cancelRef}>
        <DialogHeader>
          <DialogTitle>Restore version {version}?</DialogTitle>
          <DialogDescription>
            Its content becomes version {latest + 1}. Nothing is lost: version {latest} stays in history.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-sm"
          >
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            ref={cancelRef}
            variant="outline"
            className="max-lg:h-11"
            disabled={restore.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button className="max-lg:h-11" disabled={restore.isPending} onClick={confirm}>
            {restore.isPending ? <Spinner /> : <RotateCcw />}
            Restore version {version}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
