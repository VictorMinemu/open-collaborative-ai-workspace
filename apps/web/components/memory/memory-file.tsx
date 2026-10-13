"use client";

import { MEMORY_ROOT_TEMPLATE, type MemoryFile as MemoryFileDto, type MemoryScope } from "@ocw/contracts";
import { ArrowLeft, ChevronRight, Eye, FileText, History, Lock, Pencil, RotateCcw, X } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip } from "@/components/ui/tooltip";
import { errorMessage, isApiError } from "@/lib/api";
import { useMemoryDraft } from "@/lib/memory-draft";
import { actorLabel } from "@/lib/memory-edit";
import { useMemoryFile } from "@/lib/memory-queries";
import { memoryHref, resolveMemoryLink } from "@/lib/memory-tree";
import { cn, relativeTime } from "@/lib/utils";
import { MemoryFileMenu } from "./memory-file-actions";
import { MemoryHistory, MemoryRevisionView } from "./memory-history";
import { scopeIcon, scopeTag } from "./memory-tree";

/** The editor and its CodeMirror bundle load only on entering Edit (T-07.2-12-04): reading never requests them. */
const MemoryEditor = dynamic(() => import("./memory-editor"), {
  ssr: false,
  loading: () => <EditorSkeleton />,
});

export type MemoryFileLayout = "wide" | "split" | "stacked";
type Mode = "view" | "edit" | "history";

/**
 * The reading pane (Phase 07.2, MEM-02, UI-SPEC "File header", "Read mode", "States"): breadcrumb with the file name
 * as `<h1>`, a meta row (scope, version, last editor, age), and the file through the shared `<Markdown
 * variant="document">` (no raw HTML). A missing file and one the viewer may not read are the same not-found state,
 * with no content (T-07.2-10-03).
 *
 * 07.2-12 adds Edit (lazy CodeMirror) and History (revisions and diffs) as URL state (`?tab=edit`, `?tab=history&v=N`;
 * Back restores the previous state). From 1280 px (`wide`) View·Edit are segmented tabs in the header and History is a
 * 360 px third column; from 1024 to 1279 px and on phones the file has View · Edit · History underline tabs (UI-SPEC
 * R2, R8). Edit is offered only to writers ("Read only" otherwise), and every way out of a dirty Edit asks first.
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
  /** The shell's tier (wide ≥ 1280, split 1024-1279, stacked); defaults from `stacked`. */
  layout?: MemoryFileLayout;
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
  stacked: stackedProp = false,
  layout: layoutProp,
  onBack,
  onRevealFolder,
  readOnly = false,
}: MemoryFileProps) {
  const layout: MemoryFileLayout = layoutProp ?? (stackedProp ? "stacked" : "split");
  const stacked = layout === "stacked";
  const q = useMemoryFile(scopeId, path);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const file = q.data;
  const loadedId = file?.id;

  // Keyboard opens (and every phone file screen) move focus to the file's <h1>, once per opened file.
  useEffect(() => {
    if (!loadedId) return;
    if (focusHeadingOnOpen || stacked) {
      focusHeadingOnOpen = false;
      headingRef.current?.focus({ preventScroll: true });
    }
  }, [loadedId, stacked]);

  // Relative `.md` links that stay inside the scope open in the viewer; the rest renders as text (UI-SPEC "Read mode").
  const resolveHref = useCallback(
    (href: string) => {
      const target = path ? resolveMemoryLink(path, href) : null;
      return target ? memoryHref(scopeId, target) : null;
    },
    [scopeId, path],
  );

  // Missing, unreadable and malformed (400) are one state: the viewer learns nothing about what exists.
  const notFound =
    path === null || isApiError(q.error, 404) || isApiError(q.error, 403) || isApiError(q.error, 400);
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

  return (
    <LoadedFile
      file={file}
      scope={scope}
      path={path}
      name={name}
      layout={layout}
      canWrite={file.viewerCan.includes("write") && !readOnly}
      headingRef={headingRef}
      resolveHref={resolveHref}
      onBack={onBack}
      onRevealFolder={onRevealFolder}
    />
  );
}

function LoadedFile({
  file,
  scope,
  path,
  name,
  layout,
  canWrite,
  headingRef,
  resolveHref,
  onBack,
  onRevealFolder,
}: {
  file: MemoryFileDto;
  scope: MemoryScope;
  path: string;
  name: string;
  layout: MemoryFileLayout;
  canWrite: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  resolveHref: (href: string) => string | null;
  onBack?: (() => void) | undefined;
  onRevealFolder?: ((folder: string | null) => void) | undefined;
}) {
  const router = useRouter();
  const search = useSearchParams();
  const guard = useMemoryDraft((s) => s.guard);
  const clearDraft = useMemoryDraft((s) => s.clear);
  const draftVersion = useMemoryDraft((s) => (s.draft?.fileId === file.id ? s.draft.baseVersion : null));
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [announce, setAnnounce] = useState("");
  const focusTab = useRef<"view" | "edit" | null>(null);
  const ownVersion = useRef<number | null>(null);
  const seenVersion = useRef(file.version);

  const stacked = layout === "stacked";
  const wide = layout === "wide";
  const compact = !wide;
  const tab = search.get("tab");
  const mode: Mode = tab === "edit" && canWrite ? "edit" : tab === "history" ? "history" : "view";
  const v = Number(search.get("v"));
  const selectedVersion = mode === "history" && Number.isInteger(v) && v >= 1 && v <= file.version ? v : null;
  const base = memoryHref(file.scopeId, path);

  const go = useCallback(
    (next: Mode, opts: { v?: number | null; replace?: boolean } = {}) => {
      const qs = next === "view" ? "" : `?tab=${next}${opts.v ? `&v=${opts.v}` : ""}`;
      if (opts.replace) router.replace(`${base}${qs}`, { scroll: false });
      else router.push(`${base}${qs}`, { scroll: false });
    },
    [router, base],
  );
  const setMode = (next: Mode) => {
    if (next === mode) return;
    if (mode === "edit") guard(() => go(next));
    else go(next);
  };

  // After a save the focus lands on the Edit tab (desktop) or the View tab (phone tabs) (UI-SPEC "Edit, save and guard").
  useEffect(() => {
    if (mode !== "view" || !focusTab.current) return;
    const target = document.querySelector<HTMLElement>(`[data-memory-tab="${focusTab.current}"]`);
    focusTab.current = null;
    target?.focus();
  }, [mode]);

  // A version written elsewhere (another tab, a bot for its owner) is announced politely (UI-SPEC "Read mode").
  useEffect(() => {
    if (file.version === seenVersion.current) return;
    seenVersion.current = file.version;
    if (file.version === ownVersion.current) return;
    setAnnounce(`Updated to version ${file.version} by ${actorLabel(file.updatedBy)}`);
  }, [file.version, file.updatedBy]);

  const onSaved = (saved: MemoryFileDto) => {
    ownVersion.current = saved.version;
    focusTab.current = wide ? "edit" : "view";
    go("view", { replace: true });
  };
  const onLeave = () => {
    clearDraft();
    focusTab.current = wide ? "edit" : "view";
    go("view");
  };
  const onRestored = (restored: MemoryFileDto) => {
    ownVersion.current = restored.version;
    go(wide ? "history" : "view");
  };

  const editor = (
    <MemoryEditor
      file={file}
      compact={compact}
      actionsSlot={wide ? actionsSlot : null}
      onSaved={onSaved}
      onLeave={onLeave}
    />
  );
  const revision = selectedVersion ? (
    <MemoryRevisionView
      key={selectedVersion}
      file={file}
      version={selectedVersion}
      canWrite={canWrite}
      compact={compact}
      onClose={() => go("history")}
      onRestored={onRestored}
    />
  ) : null;
  const history = (
    <MemoryHistory
      file={file}
      selected={selectedVersion}
      onSelect={(n) => go("history", { v: n })}
      compact={compact}
    />
  );
  const reading = (
    <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
      <div className={cn("mx-auto w-full max-w-[760px]", stacked ? "px-4 py-6" : "px-6 py-8")}>
        <Markdown text={file.content} variant="document" resolveHref={resolveHref} />
        {path === "MEMORY.md" && file.content.trim() === MEMORY_ROOT_TEMPLATE.trim() ? (
          <p className="mt-2 text-muted-foreground text-sm">Nothing saved here yet.</p>
        ) : null}
      </div>
    </div>
  );

  const header = (
    <header className={cn("flex shrink-0 items-center gap-1 border-b", stacked ? "h-14 px-1" : "h-12 px-6")}>
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
      {wide && mode === "edit" ? <div ref={setActionsSlot} className="flex shrink-0 items-center" /> : null}
      {wide && mode !== "edit" ? (
        <span className="flex shrink-0 items-center gap-1">
          {canWrite ? (
            <Tabs value="view" onValueChange={(next) => next === "edit" && setMode("edit")}>
              <TabsList aria-label="File view">
                <TabsTrigger value="view" data-memory-tab="view">
                  <Eye aria-hidden className="size-3.5" /> View
                </TabsTrigger>
                <TabsTrigger value="edit" data-memory-tab="edit">
                  <Pencil aria-hidden className="size-3.5" /> Edit
                </TabsTrigger>
              </TabsList>
            </Tabs>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={mode === "history"}
            className={cn(mode === "history" && "bg-accent")}
            onClick={() => setMode(mode === "history" ? "view" : "history")}
          >
            <History /> History
          </Button>
        </span>
      ) : null}
      {wide && mode === "edit" ? null : (
        <MemoryFileMenu scope={scope} file={file} canWrite={canWrite} compact={stacked} />
      )}
    </header>
  );

  const meta = (
    <MetaRow
      file={file}
      scope={scope}
      stacked={stacked}
      canWrite={canWrite}
      editingVersion={mode === "edit" ? (draftVersion ?? file.version) : null}
    />
  );
  const live = (
    <p className="sr-only" aria-live="polite">
      {announce}
    </p>
  );

  if (wide) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1">
        <section
          data-testid="memory-file"
          data-path={path}
          data-mode={mode}
          aria-labelledby="memory-file-title"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          {header}
          {meta}
          {mode === "edit" ? editor : (revision ?? reading)}
          {live}
        </section>
        {mode === "history" ? (
          <aside
            data-testid="memory-history-column"
            aria-label="History"
            className="flex w-[360px] shrink-0 flex-col border-l bg-background"
          >
            <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b pr-2 pl-4">
              <h2 className="font-semibold text-[13px] text-muted-foreground uppercase tracking-wider">
                History
              </h2>
              <Button variant="ghost" size="icon-sm" aria-label="Close history" onClick={() => go("view")}>
                <X />
              </Button>
            </div>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">{history}</div>
          </aside>
        ) : null}
      </div>
    );
  }

  return (
    <section
      data-testid="memory-file"
      data-path={path}
      data-mode={mode}
      aria-labelledby="memory-file-title"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {header}
      {meta}
      <Tabs
        variant="underline"
        value={mode}
        onValueChange={(next) => setMode(next as Mode)}
        className="min-h-0 flex-1"
      >
        <TabsList
          aria-label="File view"
          className={cn("grid shrink-0", canWrite ? "grid-cols-3" : "grid-cols-2")}
        >
          <TabsTrigger value="view" data-memory-tab="view" className="justify-center">
            View
          </TabsTrigger>
          {canWrite ? (
            <TabsTrigger value="edit" data-memory-tab="edit" className="justify-center">
              Edit
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="history" data-memory-tab="history" className="justify-center">
            History
          </TabsTrigger>
        </TabsList>
        <TabsContent value="view" className="flex flex-col">
          {reading}
        </TabsContent>
        {canWrite ? (
          <TabsContent value="edit" className="flex flex-col">
            {mode === "edit" ? editor : null}
          </TabsContent>
        ) : null}
        <TabsContent value="history" className="flex flex-col">
          {revision ?? <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">{history}</div>}
        </TabsContent>
      </Tabs>
      {live}
    </section>
  );
}

function EditorSkeleton() {
  return (
    <div aria-busy className="mx-auto grid w-full max-w-[760px] gap-2 px-6 py-6">
      {["w-1/3", "w-11/12", "w-4/5", "w-5/6", "w-2/3"].map((w) => (
        <Skeleton key={w} className={cn("h-[22px] motion-reduce:animate-none", w)} />
      ))}
    </div>
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

function MetaRow({
  file,
  scope,
  stacked,
  canWrite,
  editingVersion = null,
}: {
  file: MemoryFileDto;
  scope: MemoryScope;
  stacked: boolean;
  canWrite: boolean;
  /** In Edit the row says which version is being edited instead of the last editor. */
  editingVersion?: number | null;
}) {
  const Icon = scopeIcon(scope);
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
      {editingVersion !== null ? (
        <span data-testid="memory-file-version">Editing version {editingVersion}</span>
      ) : (
        <>
          <span data-testid="memory-file-version">Version {file.version}</span>
          {dot}
          <MetaActor file={file} />
        </>
      )}
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

function MetaActor({ file }: { file: MemoryFileDto }) {
  const actor = file.updatedBy;
  return (
    <>
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
      <span aria-hidden>·</span>
      <Tooltip content={fullDate(file.updatedAt)}>
        <time dateTime={file.updatedAt}>
          {relativeTime(file.updatedAt)}
          <span className="sr-only">, {fullDate(file.updatedAt)}</span>
        </time>
      </Tooltip>
    </>
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
