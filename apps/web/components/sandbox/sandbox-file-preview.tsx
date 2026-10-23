"use client";

import type { SandboxFileEntry } from "@ocw/contracts";
import {
  ArrowLeft,
  ChevronDown,
  Download,
  Ellipsis,
  File,
  FolderOpen,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { formatBytes } from "@/components/chat/attachments/files";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { useSandboxImage, useSandboxPreview } from "@/lib/sandbox-queries";
import { cn, relativeTime } from "@/lib/utils";

/**
 * A sandbox file's preview (07.8-15, UI-SPEC §3.1 "Preview", §3.2 file sheet; T-07.8-15-01). Text the server detected
 * as UTF-8 renders as one plain text node in a `<pre>` (Markdown, HTML and SVG show their source, never rendered); a
 * raster image comes from the API's bytes as a local object URL; anything else, or anything too large, offers Download.
 * A file the bot changed while it is open shows "This file changed. Reload" instead of swapping the content.
 */

export interface PreviewFile {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
}

export function previewFileOf(entry: SandboxFileEntry): PreviewFile {
  return { path: entry.path, name: entry.name, size: entry.size ?? 0, modifiedAt: entry.modifiedAt };
}

const folderOfPath = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

function NoPreview({ text, onDownload }: { text: string; onDownload: () => void }) {
  return (
    <div className="grid justify-items-start gap-3 py-2">
      <File aria-hidden className="size-6 text-muted-foreground" />
      <p className="text-muted-foreground text-sm">{text}</p>
      <Button variant="outline" size="sm" className="max-md:h-11" onClick={onDownload}>
        <Download /> Download
      </Button>
    </div>
  );
}

function ImagePreview({ agentId, path, name }: { agentId: string; path: string; name: string }) {
  const { url, error } = useSandboxImage(agentId, path);
  if (error) return <p className="text-muted-foreground text-sm">Couldn't open this file.</p>;
  if (!url) return <Skeleton className="h-48 w-full rounded-lg motion-reduce:animate-none" />;
  return (
    <div className="flex justify-center rounded-lg bg-muted p-3">
      {/* biome-ignore lint/performance/noImgElement: a local object URL of the API's bytes; next/image cannot load it */}
      <img src={url} alt={name} className="max-h-[60vh] max-w-full object-contain" />
    </div>
  );
}

/** The preview body: the region a keyboard user scrolls (`role="region"`, focusable). */
export function SandboxPreviewBody({
  agentId,
  file,
  changed,
  onReload,
  onDownload,
}: {
  agentId: string;
  file: PreviewFile;
  changed: boolean;
  onReload: () => void;
  onDownload: () => void;
}) {
  const q = useSandboxPreview(agentId, file.path);
  let body: ReactNode;
  if (q.isPending) {
    body = (
      <div aria-busy className="grid gap-2">
        {["w-[70%]", "w-[55%]", "w-[80%]", "w-[40%]"].map((w) => (
          <Skeleton key={w} className={cn("h-3.5 motion-reduce:animate-none", w)} />
        ))}
      </div>
    );
  } else if (q.isError) {
    body = (
      <div role="alert" className="grid justify-items-start gap-2 text-sm">
        <p className="text-muted-foreground">Couldn't open this file.</p>
        <Button variant="outline" size="sm" className="max-md:h-11" onClick={() => void q.refetch()}>
          <RotateCcw /> Try again
        </Button>
      </div>
    );
  } else {
    const p = q.data;
    body =
      p.kind === "text" ? (
        <pre className="whitespace-pre-wrap break-all rounded-lg border bg-muted/40 px-4 py-3 font-mono text-xs leading-5 dark:bg-white/[0.03]">
          {p.text}
        </pre>
      ) : p.kind === "image" ? (
        <ImagePreview agentId={agentId} path={file.path} name={file.name} />
      ) : p.kind === "too_large" ? (
        <NoPreview
          text={`This file is too large to preview (${formatBytes(p.size)}).`}
          onDownload={onDownload}
        />
      ) : (
        <NoPreview text="No preview for this file type." onDownload={onDownload} />
      );
  }
  return (
    <div
      role="region"
      aria-label={`Preview of ${file.name}`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the preview scrolls by keyboard (UI-SPEC Accessibility › Preview)
      tabIndex={0}
      data-testid="sandbox-preview"
      className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset sm:px-6"
    >
      {changed ? (
        <p data-testid="sandbox-preview-changed" className="mb-3 text-sm">
          <span className="text-muted-foreground">This file changed.</span>{" "}
          <Button variant="link" size="sm" className="h-auto p-0 text-sm max-md:min-h-11" onClick={onReload}>
            Reload
          </Button>
        </p>
      ) : null}
      {body}
    </div>
  );
}

function MetaLine({ file, withFolder = false }: { file: PreviewFile; withFolder?: boolean }) {
  const folder = folderOfPath(file.path);
  return (
    <p className="truncate text-muted-foreground text-xs">
      {withFolder && folder ? (
        <>
          <span className="font-mono">{folder}/</span> ·{" "}
        </>
      ) : null}
      <span className="font-mono">{formatBytes(file.size)}</span> ·{" "}
      <Tooltip content={new Date(file.modifiedAt).toLocaleString()}>
        <span>
          {withFolder ? "" : "modified "}
          {relativeTime(file.modifiedAt)}
        </span>
      </Tooltip>
    </p>
  );
}

/** Desktop pane (≥ 1024) and the in-place preview (768–1023, with "All files"). */
export function SandboxFilePane({
  agentId,
  file,
  changed,
  focusHeading,
  downloading,
  onReload,
  onDownload,
  onDelete,
  onBack,
}: {
  agentId: string;
  file: PreviewFile;
  changed: boolean;
  /** Opened from the keyboard: the file name heading takes focus. */
  focusHeading: boolean;
  downloading: boolean;
  onReload: () => void;
  onDownload: () => void;
  onDelete: () => void;
  /** In place (768–1023): back to the tree. */
  onBack?: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once per opened file
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, [file.path]);
  const segments = file.path.split("/");
  return (
    <div data-testid="sandbox-file-pane" className="flex min-h-0 min-w-0 flex-1 flex-col">
      {onBack ? (
        <div className="border-b px-2">
          <Button variant="ghost" className="h-11" onClick={onBack} data-testid="sandbox-all-files">
            <ArrowLeft /> All files
          </Button>
        </div>
      ) : null}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4 sm:px-6">
        <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-1 text-muted-foreground text-xs">
            {segments.slice(0, -1).map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: path segments repeat; the position is the identity
              <li key={i} className="flex shrink-0 items-center gap-1 font-mono">
                {s}
                <span aria-hidden>›</span>
              </li>
            ))}
            <li className="min-w-0">
              <h2
                ref={heading}
                tabIndex={-1}
                className="truncate font-mono font-semibold text-[15px] text-foreground leading-5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                {file.name}
              </h2>
            </li>
          </ol>
        </nav>
        <Button
          variant="outline"
          size="sm"
          onClick={onDownload}
          disabled={downloading}
          data-testid="sandbox-download"
          className="max-lg:h-11"
        >
          {downloading ? <Spinner /> : <Download />} Download
        </Button>
        <Tooltip content="Delete">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDelete}
            aria-label={`Delete ${file.name}`}
            data-testid="sandbox-delete"
            className="max-lg:size-11"
          >
            <Trash2 />
          </Button>
        </Tooltip>
      </div>
      <div className="flex h-10 shrink-0 items-center border-b px-4 sm:px-6">
        <MetaLine file={file} />
      </div>
      <SandboxPreviewBody
        agentId={agentId}
        file={file}
        changed={changed}
        onReload={onReload}
        onDownload={onDownload}
      />
    </div>
  );
}

/** The phone file sheet (< 768, UI-SPEC §3.2): full height, actions at the bottom. */
export function SandboxFileSheet({
  agentId,
  file,
  changed,
  downloading,
  onReload,
  onDownload,
  onDelete,
  onClose,
}: {
  agentId: string;
  file: PreviewFile | null;
  changed: boolean;
  downloading: boolean;
  onReload: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={file !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="bottom"
        showClose={false}
        data-testid="sandbox-file-sheet"
        className="h-dvh rounded-none border-t-0"
      >
        {file ? (
          <>
            <div className="flex h-14 shrink-0 items-center gap-1 border-b px-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-11"
                aria-label="Close file"
                onClick={onClose}
              >
                <ChevronDown />
              </Button>
              <SheetTitle className="min-w-0 flex-1 truncate font-mono font-semibold text-[15px]">
                {file.name}
              </SheetTitle>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="icon" className="size-11" aria-label="File actions" />
                  }
                >
                  <Ellipsis />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem className="min-h-11" onClick={onDownload}>
                    <Download />
                    Download
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" className="min-h-11" onClick={onDelete}>
                    <Trash2 />
                    Delete…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="shrink-0 px-4 pt-2">
              <MetaLine file={file} withFolder />
            </div>
            <SandboxPreviewBody
              agentId={agentId}
              file={file}
              changed={changed}
              onReload={onReload}
              onDownload={onDownload}
            />
            <div className="flex shrink-0 gap-2 border-t px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
              <Button
                variant="outline"
                className="h-11 flex-1"
                onClick={onDownload}
                disabled={downloading}
                data-testid="sandbox-download"
              >
                {downloading ? <Spinner /> : <Download />} Download
              </Button>
              <Button
                variant="outline"
                className="h-11 flex-1 text-destructive hover:text-destructive"
                onClick={onDelete}
                data-testid="sandbox-delete"
              >
                <Trash2 /> Delete
              </Button>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** Nothing selected yet (desktop pane). */
export function PickAFile() {
  return (
    <EmptyState
      icon={FolderOpen}
      title="Pick a file to preview it"
      description={null}
      className="py-10 [&>p:empty]:hidden"
    />
  );
}
