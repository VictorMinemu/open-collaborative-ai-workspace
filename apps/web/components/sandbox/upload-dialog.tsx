"use client";

import { Info, Upload } from "lucide-react";
import { type DragEvent, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { formatBytes } from "@/components/chat/attachments/files";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/panel-dialog";
import { useIsDesktop } from "@/hooks/use-media-query";
import { isApiError } from "@/lib/api";
import { type SandboxUpload, UPLOAD_MAX_BYTES, uploadSandboxFile } from "@/lib/sandbox-queries";
import { LeaveUploadDialog } from "./sandbox-dialogs";
import { entryIcon } from "./sandbox-tree";

/**
 * Upload files into a bot's sandbox (07.8-15, UI-SPEC §3.3): a dropzone that is also a button, one row per file with
 * its own errors (over 50 MB, not enough space, a name the workspace refuses) and conflicts (Replace / Skip), sequential
 * uploads with a progress bar each, and Stop uploading. Leaving while files upload asks first. On success the dialog
 * closes with "{n} files uploaded to {folder}".
 */

type RowState =
  | { kind: "ready" }
  | { kind: "conflict" }
  | { kind: "replace" }
  | { kind: "error"; message: string }
  | { kind: "uploading"; progress: number }
  | { kind: "done" }
  | { kind: "failed" };

interface Row {
  key: string;
  file: File;
  state: RowState;
}

/** `/` and a leading `..` never make a workspace name (the API refuses them too). */
const badName = (name: string) => name.includes("/") || name.startsWith("..") || name === "." || name === "";

/** "reports" for the toast, "/workspace" for the root. */
export const folderLabel = (folder: string) => (folder === "" ? "/workspace" : folder);

/**
 * Per-file checks before anything is sent: the name, 50 MB each, the space left (in list order, as uploads run), and
 * a file that already exists asks Replace / Skip.
 */
export function checkFiles(
  files: readonly File[],
  existing: ReadonlySet<string>,
  freeBytes: number,
): RowState[] {
  let room = freeBytes;
  return files.map((f) => {
    if (badName(f.name)) return { kind: "error", message: "Names can't contain / or start with .." };
    if (f.size > UPLOAD_MAX_BYTES) return { kind: "error", message: `Over ${formatBytes(UPLOAD_MAX_BYTES)}` };
    if (f.size > room)
      return { kind: "error", message: `Not enough space (${formatBytes(Math.max(0, room))} free)` };
    room -= f.size;
    return existing.has(f.name) ? { kind: "conflict" } : { kind: "ready" };
  });
}

/** Uploaded by "Upload {n}": new files, chosen replacements, and failures (Upload again retries them). */
const eligible = (r: Row) =>
  r.state.kind === "ready" || r.state.kind === "replace" || r.state.kind === "failed";

let rowSeq = 0;

export function UploadDialog({
  open,
  agentId,
  bot,
  teamBot,
  folder,
  initialFiles,
  freeBytes,
  existingNames,
  onClose,
  onUploaded,
}: {
  open: boolean;
  agentId: string;
  bot: string;
  teamBot: boolean;
  /** `""` = the workspace root. */
  folder: string;
  /** Files dropped onto a folder row. */
  initialFiles: File[];
  freeBytes: number;
  /** Names already in `folder` (loaded when the dialog opens; empty until then). */
  existingNames: ReadonlySet<string>;
  onClose: () => void;
  onUploaded: (folder: string, paths: string[]) => void;
}) {
  const desktop = useIsDesktop();
  const input = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [uploading, setUploading] = useState(false);
  const [askLeave, setAskLeave] = useState(false);
  const current = useRef<SandboxUpload | null>(null);
  const stopped = useRef(false);

  const add = (files: File[]) => {
    setRows((prev) => {
      const all = [...prev.filter((r) => r.state.kind !== "done").map((r) => r.file), ...files];
      const states = checkFiles(all, existingNames, freeBytes);
      return all.map((file, i) => {
        const before = prev.find((r) => r.file === file);
        const state = states[i] ?? { kind: "ready" };
        // A choice already made (Replace) or a failure stays; everything else is re-checked.
        const keep = before && (before.state.kind === "replace" || before.state.kind === "failed");
        return { key: before?.key ?? `f${++rowSeq}`, file, state: keep ? before.state : state };
      });
    });
  };

  // A new dialog starts with the dropped files (or none).
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on open only
  useEffect(() => {
    if (!open) return;
    setRows([]);
    stopped.current = false;
    if (initialFiles.length > 0) add(initialFiles);
  }, [open]);

  // The folder's names arrive after the dialog opened: conflicts are re-checked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-check when the names arrive
  useEffect(() => {
    if (open && !uploading) setRows((prev) => (prev.length > 0 ? recheck(prev) : prev));
  }, [existingNames]);

  const recheck = (prev: Row[]) => {
    const states = checkFiles(
      prev.map((r) => r.file),
      existingNames,
      freeBytes,
    );
    return prev.map((r, i) =>
      r.state.kind === "ready" || r.state.kind === "conflict" ? { ...r, state: states[i] ?? r.state } : r,
    );
  };

  // Reloading or closing the tab while uploading asks the browser's own question.
  useEffect(() => {
    if (!uploading) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [uploading]);

  const setState = (key: string, state: RowState) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, state } : r)));

  const count = rows.filter(eligible).length;

  async function start() {
    const queue = rows.filter(eligible);
    if (queue.length === 0) return;
    setUploading(true);
    stopped.current = false;
    const done: string[] = [];
    let failed = 0;
    for (const row of queue) {
      if (stopped.current) break;
      setState(row.key, { kind: "uploading", progress: 0 });
      const handle = uploadSandboxFile(agentId, folder, row.file, {
        replace: row.state.kind === "replace",
        onProgress: (progress) => setState(row.key, { kind: "uploading", progress }),
      });
      current.current = handle;
      try {
        const out = await handle.promise;
        done.push(out.path);
        setState(row.key, { kind: "done" });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setState(row.key, row.state);
          break;
        }
        failed += 1;
        const code = isApiError(err) ? err.code : "";
        setState(
          row.key,
          code === "upload_exists"
            ? { kind: "conflict" }
            : code === "too_large"
              ? { kind: "error", message: `Over ${formatBytes(UPLOAD_MAX_BYTES)}` }
              : code === "disk_full"
                ? { kind: "error", message: `Not enough space (${formatBytes(Math.max(0, freeBytes))} free)` }
                : code === "invalid_path"
                  ? { kind: "error", message: "Names can't contain / or start with .." }
                  : { kind: "failed" },
        );
      }
    }
    current.current = null;
    setUploading(false);
    if (done.length > 0) {
      onUploaded(folder, done);
      if (failed === 0 && !stopped.current) {
        toast.success(
          done.length === 1
            ? `1 file uploaded to ${folderLabel(folder)}`
            : `${done.length} files uploaded to ${folderLabel(folder)}`,
        );
        onClose();
        return;
      }
      setRows((prev) => prev.filter((r) => r.state.kind !== "done"));
    }
  }

  const stop = () => {
    stopped.current = true;
    current.current?.abort();
  };

  const requestClose = () => {
    if (uploading) setAskLeave(true);
    else onClose();
  };

  const title = folder === "" ? "Upload to /workspace" : `Upload to ${folder}/`;
  const hint = `Up to ${formatBytes(UPLOAD_MAX_BYTES)} each · ${formatBytes(Math.max(0, freeBytes))} free`;
  const pick = () => input.current?.click();
  const onDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const files = [...e.dataTransfer.files];
    if (files.length > 0) add(files);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && requestClose()}>
        <DialogContent
          data-testid="upload-dialog"
          className="sm:max-w-md max-sm:inset-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:rounded-none"
        >
          <DialogHeader>
            <DialogTitle className="break-words">{title}</DialogTitle>
            <DialogDescription>
              Files go into {bot}'s sandbox. {bot} can read and change them.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid content-start gap-3">
            <input
              ref={input}
              type="file"
              multiple
              hidden
              data-testid="upload-input"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                if (files.length > 0) add(files);
              }}
            />
            {desktop ? (
              <button
                type="button"
                onClick={pick}
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDrop}
                disabled={uploading}
                data-testid="upload-dropzone"
                className="flex h-32 flex-col items-center justify-center gap-1 rounded-lg border border-dashed bg-muted/30 px-4 text-center outline-none transition-colors hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-50"
              >
                <span className="flex items-center gap-1.5 text-sm">
                  <Upload aria-hidden className="size-4 text-muted-foreground" />
                  Drop files here or <span className="text-primary">choose files</span>
                </span>
                <span className="text-muted-foreground text-xs">{hint}</span>
              </button>
            ) : (
              <div className="grid gap-1.5">
                <Button variant="outline" className="h-11" onClick={pick} disabled={uploading}>
                  <Upload /> Choose files
                </Button>
                <span className="text-center text-muted-foreground text-xs">{hint}</span>
              </div>
            )}
            {rows.length > 0 ? (
              <ul aria-label="Files to upload" className="grid gap-2" data-testid="upload-rows">
                {rows.map((r) => (
                  <UploadRow
                    key={r.key}
                    row={r}
                    disabled={uploading}
                    onReplace={() => setState(r.key, { kind: "replace" })}
                    onSkip={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}
                  />
                ))}
              </ul>
            ) : null}
            {teamBot ? (
              <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
                <Info aria-hidden className="mt-px size-3.5 shrink-0" />
                Everyone who can use {bot} works with these files.
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="outline"
              className="max-md:h-11"
              onClick={uploading ? stop : onClose}
              data-testid="upload-cancel"
            >
              {uploading ? "Stop uploading" : "Cancel"}
            </Button>
            <Button
              className="max-md:h-11"
              onClick={() => void start()}
              disabled={uploading || count === 0}
              data-testid="upload-submit"
            >
              Upload {count}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <LeaveUploadDialog
        open={askLeave}
        onStay={() => setAskLeave(false)}
        onLeave={() => {
          setAskLeave(false);
          stop();
          onClose();
        }}
      />
    </>
  );
}

function UploadRow({
  row,
  disabled,
  onReplace,
  onSkip,
}: {
  row: Row;
  disabled: boolean;
  onReplace: () => void;
  onSkip: () => void;
}) {
  const Icon = entryIcon({ kind: "file", name: row.file.name });
  const s = row.state;
  return (
    <li data-testid="upload-row" data-state={s.kind} className="grid gap-1.5 rounded-lg border px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{row.file.name}</span>
        <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
          {formatBytes(row.file.size)}
        </span>
      </div>
      {s.kind === "uploading" || s.kind === "done" ? (
        <div className="flex items-center gap-2">
          <div
            role="progressbar"
            aria-label={`Uploading ${row.file.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={s.kind === "done" ? 100 : Math.round(s.progress * 100)}
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
              style={{ width: `${s.kind === "done" ? 100 : Math.round(s.progress * 100)}%` }}
            />
          </div>
          <span className="w-9 shrink-0 text-right font-mono text-muted-foreground text-xs tabular-nums">
            {s.kind === "done" ? 100 : Math.round(s.progress * 100)}%
          </span>
        </div>
      ) : s.kind === "conflict" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1 text-amber-800 text-xs dark:text-amber-300">
            {row.file.name} already exists.
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 max-md:h-11"
            onClick={onReplace}
            disabled={disabled}
          >
            Replace
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 max-md:h-11"
            onClick={onSkip}
            disabled={disabled}
          >
            Skip
          </Button>
        </div>
      ) : s.kind === "error" ? (
        <span role="alert" className="text-red-800 text-xs dark:text-red-300">
          {s.message}
        </span>
      ) : s.kind === "failed" ? (
        <span role="alert" className="text-red-800 text-xs dark:text-red-300">
          Upload failed. Try again.
        </span>
      ) : null}
    </li>
  );
}
