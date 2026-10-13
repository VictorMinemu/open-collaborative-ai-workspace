"use client";

import {
  MEMORY_ROOT_TEMPLATE,
  type MemoryActor,
  type MemoryFile as MemoryFileDto,
  type MemoryScope,
} from "@ocw/contracts";
import { ArrowLeft, ChevronRight, FileText, Lock, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { EmptyState } from "@/components/common/empty-state";
import { Markdown } from "@/components/markdown/markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage, isApiError } from "@/lib/api";
import { useMemoryFile } from "@/lib/memory-queries";
import { memoryHref } from "@/lib/memory-tree";
import { cn, relativeTime } from "@/lib/utils";
import { scopeIcon, scopeTag } from "./memory-tree";

/**
 * The reading pane (Phase 07.2, MEM-02, UI-SPEC "File header", "Read mode", "States"): breadcrumb with the file name
 * as `<h1>`, a meta row (scope, version, last editor, age), and the file through the shared `<Markdown
 * variant="document">` (no raw HTML). A missing file and one the viewer may not read are the same not-found state,
 * with no content (T-07.2-10-03). Editing and history arrive with 07.2-12.
 */

/** Set before a keyboard navigation (tree Enter, search result, breadcrumb, in-viewer link): the next file shown
 * moves focus to its `<h1>` (UI-SPEC "Focus management"). Pointer opens leave focus where it was. */
let focusHeadingOnOpen = false;
export function focusHeadingNext(): void {
  focusHeadingOnOpen = true;
}

const PRIVATE_NOTE = "Only you can see this. Admins can't.";

export interface MemoryFileProps {
  scopeId: string;
  /** The parsed path, or null when the URL did not hold a valid one (rendered as not found, no request). */
  path: string | null;
  /** The scope as listed by the API (label, kind); null while loading or when the viewer can't read it. */
  scope: MemoryScope | null;
  /** Stacked (< 1024): the phone file screen with a back control. */
  stacked?: boolean;
  onBack?: () => void;
  /** Breadcrumb folders reveal and focus their node in the tree. */
  onRevealFolder?: (folder: string | null) => void;
  /** Hides every write affordance (agent page, 07.2-14). */
  readOnly?: boolean;
}

export function MemoryFile({
  scopeId,
  path,
  scope,
  stacked = false,
  onBack,
  onRevealFolder,
  readOnly = false,
}: MemoryFileProps) {
  const q = useMemoryFile(scopeId, path);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const file = q.data;

  // Keyboard opens (and every phone file screen) move focus to the file's <h1>.
  useEffect(() => {
    if (!file) return;
    if (focusHeadingOnOpen || stacked) {
      focusHeadingOnOpen = false;
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [file, stacked]);

  const notFound = path === null || isApiError(q.error, 404) || isApiError(q.error, 403);
  const name = path ? (path.split("/").pop() ?? path) : "";

  if (notFound) {
    return (
      <Pane stacked={stacked} onBack={onBack} testId="memory-file-notfound">
        <EmptyState
          icon={FileText}
          title="This file doesn't exist or you can't open it"
          description={null}
          className="[&>p:empty]:hidden"
        >
          <Button
            variant="outline"
            className="max-lg:h-11"
            render={<Link href={scope ? memoryHref(scope.id) : "/memory"} />}
          >
            {scope ? `Back to ${scope.label}` : "Back to memory"}
          </Button>
        </EmptyState>
      </Pane>
    );
  }

  if (q.isError) {
    return (
      <Pane stacked={stacked} onBack={onBack} testId="memory-file-error">
        <EmptyState icon={FileText} title="Couldn't open this file." description={errorMessage(q.error)}>
          <Button variant="outline" className="max-lg:h-11" onClick={() => void q.refetch()}>
            <RotateCcw /> Try again
          </Button>
        </EmptyState>
      </Pane>
    );
  }

  if (!file || !scope || !path) return <FileSkeleton stacked={stacked} onBack={onBack} />;

  const canWrite = file.viewerCan.includes("write") && !readOnly;
  const templateOnly = path === "MEMORY.md" && file.content.trim() === MEMORY_ROOT_TEMPLATE.trim();

  return (
    <section
      data-testid="memory-file"
      data-path={path}
      aria-labelledby="memory-file-title"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <header
        className={cn("flex shrink-0 items-center gap-1 border-b", stacked ? "h-14 px-1" : "h-12 px-6")}
      >
        {stacked && onBack ? (
          <Button variant="ghost" size="icon" className="size-11" aria-label="Back to files" onClick={onBack}>
            <ArrowLeft className="size-5" />
          </Button>
        ) : null}
        <Breadcrumb
          ref={headingRef}
          scope={scope}
          path={path}
          name={name}
          stacked={stacked}
          onRevealFolder={onRevealFolder}
        />
      </header>
      <MetaRow file={file} scope={scope} stacked={stacked} canWrite={canWrite} />
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto w-full max-w-[760px]", stacked ? "px-4 py-6" : "px-6 py-8")}>
          <Markdown text={file.content} variant="document" />
          {templateOnly ? (
            <p className="mt-2 text-muted-foreground text-sm">Nothing saved here yet.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Pane({
  stacked,
  onBack,
  testId,
  children,
}: {
  stacked: boolean;
  onBack?: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section data-testid={testId} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {stacked && onBack ? (
        <header className="flex h-14 shrink-0 items-center px-1">
          <Button variant="ghost" size="icon" className="size-11" aria-label="Back to files" onClick={onBack}>
            <ArrowLeft className="size-5" />
          </Button>
        </header>
      ) : null}
      {children}
    </section>
  );
}

const crumbClass =
  "min-w-0 shrink truncate rounded-sm text-muted-foreground text-sm outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40";

function Breadcrumb({
  ref,
  scope,
  path,
  name,
  stacked,
  onRevealFolder,
}: {
  ref: React.Ref<HTMLHeadingElement>;
  scope: MemoryScope;
  path: string;
  name: string;
  stacked: boolean;
  onRevealFolder?: (folder: string | null) => void;
}) {
  const folders = path.split("/").slice(0, -1);
  const crumbs = folders.map((label, i) => ({ label, folder: folders.slice(0, i + 1).join("/") }));
  // Desktop shows up to 4 segments (scope, folders, file); the phone keeps the scope and the last two segments.
  const keep = stacked ? 1 : 2;
  const collapsed = crumbs.length > keep ? crumbs.slice(0, crumbs.length - keep) : [];
  const shown = crumbs.slice(collapsed.length);
  const sep = <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center gap-1.5">
        <li className="flex min-w-0 shrink items-center gap-1.5">
          <button
            type="button"
            className={cn(crumbClass, stacked && "py-3")}
            onClick={() => onRevealFolder?.(null)}
          >
            {scope.label}
          </button>
        </li>
        {collapsed.length > 0 ? (
          <li className="flex shrink-0 items-center gap-1.5">
            {sep}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Show full path"
                className={cn(crumbClass, "px-1", stacked && "flex size-11 items-center justify-center")}
              >
                …
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {collapsed.map((c) => (
                  <DropdownMenuItem key={c.folder} onClick={() => onRevealFolder?.(c.folder)}>
                    {c.folder}/
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ) : null}
        {shown.map((c) => (
          <li key={c.folder} className="flex min-w-0 shrink items-center gap-1.5">
            {sep}
            <button
              type="button"
              className={cn(crumbClass, stacked && "py-3")}
              onClick={() => onRevealFolder?.(c.folder)}
            >
              {c.label}
            </button>
          </li>
        ))}
        <li className="flex min-w-0 shrink-[0.5] items-center gap-1.5">
          {sep}
          <h1
            ref={ref}
            id="memory-file-title"
            tabIndex={-1}
            aria-current="page"
            title={name}
            className="min-w-0 truncate rounded-sm font-semibold text-[15px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            {name}
          </h1>
        </li>
      </ol>
    </nav>
  );
}

const fullDate = (iso: string) =>
  new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });

function actorLabel(actor: MemoryActor): string {
  if (actor.kind === "system") return "Workspace";
  if (actor.kind === "agent" && actor.onBehalfOf)
    return `${actor.displayName} for ${actor.onBehalfOf.displayName}`;
  return actor.displayName;
}

function MetaRow({
  file,
  scope,
  stacked,
  canWrite,
}: {
  file: MemoryFileDto;
  scope: MemoryScope;
  stacked: boolean;
  canWrite: boolean;
}) {
  const Icon = scopeIcon(scope);
  const actor = file.updatedBy;
  const isPrivate = scope.kind === "personal";
  const badge = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate text-foreground">{scope.label}</span>
      <Badge variant="outline" className="font-normal">
        {scopeTag(scope)}
      </Badge>
    </span>
  );
  const dot = <span aria-hidden>·</span>;
  return (
    <div
      data-testid="memory-file-meta"
      className={cn(
        "flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs",
        stacked ? "border-b px-4 py-2.5" : "h-10 px-6",
      )}
    >
      {isPrivate && !stacked ? (
        <Tooltip content={PRIVATE_NOTE}>
          <span className="inline-flex min-w-0">
            {badge}
            <span className="sr-only">. {PRIVATE_NOTE}</span>
          </span>
        </Tooltip>
      ) : (
        badge
      )}
      {dot}
      <span data-testid="memory-file-version">Version {file.version}</span>
      {dot}
      <span className="inline-flex min-w-0 items-center gap-1">
        <PrincipalAvatar
          kind={actor.kind === "agent" ? "agent" : actor.kind === "system" ? "system" : "user"}
          name={actor.displayName}
          seed={actor.id}
          compact
          className="size-5 text-[10px]"
        />
        <span data-testid="memory-file-editor" className="truncate text-foreground">
          {actorLabel(actor)}
        </span>
      </span>
      {dot}
      <Tooltip content={fullDate(file.updatedAt)}>
        <time dateTime={file.updatedAt}>
          {relativeTime(file.updatedAt)}
          <span className="sr-only">, {fullDate(file.updatedAt)}</span>
        </time>
      </Tooltip>
      {canWrite ? null : (
        <Tooltip content="You can read this file but not edit it.">
          <Badge variant="outline" className="font-normal">
            Read only
          </Badge>
        </Tooltip>
      )}
      {isPrivate && stacked ? (
        <span className="flex basis-full items-center gap-1">
          <Lock aria-hidden className="size-3" /> {PRIVATE_NOTE}
        </span>
      ) : null}
    </div>
  );
}

const LINE_WIDTHS = ["w-11/12", "w-4/5", "w-full", "w-3/4", "w-5/6", "w-2/3", "w-11/12", "w-1/2"];

export function FileSkeleton({ stacked, onBack }: { stacked: boolean; onBack?: () => void }) {
  return (
    <section data-testid="memory-file-loading" aria-busy className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={cn("flex shrink-0 items-center gap-2 border-b", stacked ? "h-14 px-1" : "h-12 px-6")}>
        {stacked && onBack ? (
          <Button variant="ghost" size="icon" className="size-11" aria-label="Back to files" onClick={onBack}>
            <ArrowLeft className="size-5" />
          </Button>
        ) : null}
        <Skeleton className="h-4 w-56 motion-reduce:animate-none" />
      </div>
      <div className={cn("flex h-10 shrink-0 items-center gap-2", stacked ? "px-4" : "px-6")}>
        <Skeleton className="h-3 w-24 motion-reduce:animate-none" />
        <Skeleton className="h-3 w-16 motion-reduce:animate-none" />
        <Skeleton className="h-3 w-28 motion-reduce:animate-none" />
      </div>
      <div className={cn("mx-auto grid w-full max-w-[760px] gap-3", stacked ? "px-4 py-6" : "px-6 py-8")}>
        <Skeleton className="mb-2 h-5 w-1/3 motion-reduce:animate-none" />
        {LINE_WIDTHS.map((w, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder lines
          <Skeleton key={i} className={cn("h-3.5 motion-reduce:animate-none", w)} />
        ))}
      </div>
    </section>
  );
}
