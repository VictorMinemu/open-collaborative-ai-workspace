"use client";

import { Id, MEMORY_ROOT_FILE } from "@ocw/contracts";
import { Inbox, NotebookText, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, Suspense, useEffect, useMemo, useRef } from "react";
import { EmptyState } from "@/components/common/empty-state";
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
import { useMediaQuery } from "@/hooks/use-media-query";
import { isDirty, useMemoryDraft } from "@/lib/memory-draft";
import { fileName, parentFolder } from "@/lib/memory-edit";
import { useMemoryFilesByScope, useMemoryLiveUpdates, useMemoryScopes } from "@/lib/memory-queries";
import {
  buildMemoryTree,
  fileNodeId,
  folderNodeId,
  type MemoryNode,
  memoryAncestorIds,
  memoryHref,
  pathFromSegments,
  scopeNodeId,
} from "@/lib/memory-tree";
import { cn } from "@/lib/utils";
import { FileSkeleton, focusHeadingNext, MemoryFile } from "./memory-file";
import { MemoryActionDialogs, MemoryCreateButtons, MemoryRowMenu, rowShortcut } from "./memory-file-actions";
import { MemorySearch } from "./memory-search";
import { MemoryTree, type OpenVia, useMemoryTreeState } from "./memory-tree";

/**
 * The memory viewer's geometry (Phase 07.2, MEM-02, UI-SPEC "Shell geometry", R1, R2):
 * - `wide` (≥ 1280): tree column 280 · file pane · the 360 px History column while History is open (07.2-12).
 * - `split` (1024–1279): tree column 280 · file pane with View · Edit · History tabs.
 * - stacked (< 1024): one full-screen tree whose scopes are 56 px top-level nodes, then a full-screen file screen
 *   with "Back to files". 768–1023 keeps the rail (existing shell); < 768 uses the top bar.
 */
export const MEMORY_WIDE_QUERY = "(min-width: 1280px)";
export const MEMORY_SPLIT_QUERY = "(min-width: 1024px)";

export type MemoryLayout = "wide" | "split" | "stacked";

export function useMemoryLayout(): MemoryLayout {
  const wide = useMediaQuery(MEMORY_WIDE_QUERY);
  const split = useMediaQuery(MEMORY_SPLIT_QUERY, true);
  return wide ? "wide" : split ? "split" : "stacked";
}

const SKELETON_WIDTHS = ["w-[70%]", "w-[55%]", "w-[80%]", "w-[60%]", "w-[75%]", "w-[50%]"];

function TreeSkeleton({ stacked }: { stacked: boolean }) {
  return (
    <div data-testid="memory-tree-loading" aria-busy className="grid gap-px">
      {SKELETON_WIDTHS.map((w) => (
        <div key={w} className={cn("flex items-center gap-2 px-2", stacked ? "h-11" : "h-8")}>
          <Skeleton className="size-4 shrink-0 rounded motion-reduce:animate-none" />
          <Skeleton className={cn("h-3.5 motion-reduce:animate-none", w)} />
        </div>
      ))}
    </div>
  );
}

function ProposalsRow({ stacked }: { stacked: boolean }) {
  return (
    <div className={cn("shrink-0 border-t px-2", stacked ? "py-1.5" : "py-1")}>
      <Link
        href="/memory/proposals"
        data-testid="memory-proposals-row"
        className={cn(
          "flex items-center gap-2 rounded-md px-2 text-sidebar-foreground text-sm outline-none hover:bg-sidebar-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/40",
          stacked ? "h-11" : "h-10",
        )}
      >
        <Inbox aria-hidden className="size-4 text-muted-foreground" />
        Proposals
      </Link>
    </div>
  );
}

export function MemoryShell({ scopeId, segments }: { scopeId?: string; segments?: readonly string[] }) {
  const layout = useMemoryLayout();
  const stacked = layout === "stacked";
  const router = useRouter();
  const scopesQ = useMemoryScopes();
  const scopes = scopesQ.data?.scopes;
  const scopeIds = useMemo(() => (scopes ?? []).map((s) => s.id), [scopes]);
  const { files, isError: filesError, refetch: refetchFiles } = useMemoryFilesByScope(scopeIds);
  const ordered = useMemo(() => buildMemoryTree(scopes ?? [], new Map()), [scopes]);

  // The URL's file, re-parsed before any request (T-07.2-10-02); an invalid path is a not-found screen.
  const hasPath = !!segments && segments.length > 0;
  const parsed = useMemo(
    () => (hasPath && segments ? pathFromSegments(segments) : null),
    [hasPath, segments],
  );
  const urlPath = parsed?.ok ? parsed.path : null;
  // Desktop: `/memory` opens the first scope's MEMORY.md and `/memory/<scope>` that scope's MEMORY.md.
  const fileScopeId = scopeId ?? (stacked ? null : (ordered[0]?.scopeId ?? null));
  const filePath = hasPath ? urlPath : fileScopeId && !stacked ? MEMORY_ROOT_FILE : null;
  const showFile = stacked ? hasPath && !!scopeId : !!fileScopeId;
  const fileScope = scopes?.find((s) => s.id === fileScopeId) ?? null;
  const selected =
    fileScopeId && filePath && (stacked ? hasPath : true) ? { scopeId: fileScopeId, path: filePath } : null;

  const reveal = useMemoryTreeState((s) => s.reveal);
  const requestFocus = useMemoryTreeState((s) => s.requestFocus);
  const guard = useMemoryDraft((s) => s.guard);
  useMemoryLiveUpdates();

  // Deep links expand their ancestors (desktop: also the scope whose MEMORY.md opens by default); on the phone a scope
  // link also brings that scope's row into focus.
  useEffect(() => {
    if (!fileScopeId) return;
    reveal(memoryAncestorIds(fileScopeId, urlPath ?? undefined));
    if (stacked && !hasPath) requestFocus(scopeNodeId(fileScopeId));
  }, [fileScopeId, urlPath, stacked, hasPath, reveal, requestFocus]);

  // `/` (outside a text field) focuses the search field (UI-SPEC "Interaction Contract › Tree").
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
      if (!searchRef.current) return;
      e.preventDefault();
      searchRef.current.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Phone Back returns to the tree with the file's row focused.
  const fromTree = useRef(false);
  // Every way out of a dirty Edit asks first (UI-SPEC "Edit, save and guard"); unchanged drafts just leave.
  const onOpen = (node: MemoryNode, via: OpenVia) => {
    if (node.kind !== "file" || !node.path) return;
    const path = node.path;
    guard(() => {
      if (via === "keyboard" || stacked) focusHeadingNext();
      fromTree.current = stacked;
      router.push(memoryHref(node.scopeId, path));
    });
  };
  const onBack = () =>
    guard(() => {
      if (fileScopeId && filePath) requestFocus(fileNodeId(fileScopeId, filePath));
      if (fromTree.current) {
        fromTree.current = false;
        router.back();
      } else {
        router.push(fileScopeId ? memoryHref(fileScopeId) : "/memory");
      }
    });
  const onRevealFolder = (folder: string | null) => {
    if (!fileScopeId) return;
    const scope = fileScopeId;
    const target = folder ? folderNodeId(scope, folder) : scopeNodeId(scope);
    const reveals = () => {
      reveal(memoryAncestorIds(scope, folder ? `${folder}/x.md` : undefined));
      requestFocus(target);
    };
    if (stacked)
      guard(() => {
        reveals();
        router.push(memoryHref(scope));
      });
    else reveals();
  };

  let treeBody: ReactNode;
  if (scopesQ.isError || filesError) {
    treeBody = (
      <div data-testid="memory-tree-error" className="grid gap-2 px-2 py-3 text-sm">
        <p className="text-muted-foreground">Couldn't load memory.</p>
        <Button
          variant="outline"
          size="sm"
          className="w-fit max-lg:h-11"
          onClick={() => {
            void scopesQ.refetch();
            refetchFiles();
          }}
        >
          <RotateCcw /> Try again
        </Button>
      </div>
    );
  } else if (!scopes) {
    treeBody = <TreeSkeleton stacked={stacked} />;
  } else {
    treeBody = (
      <MemoryTree
        scopes={scopes}
        filesByScope={files}
        selected={selected}
        onOpen={onOpen}
        stacked={stacked}
        rowMenu={(node, menu) => (
          <MemoryRowMenu
            node={node}
            scope={scopes.find((s) => s.id === node.scopeId)}
            compact={stacked}
            open={menu.open}
            onOpenChange={menu.onOpenChange}
          />
        )}
        onRowKey={(node, key) =>
          rowShortcut(
            node,
            key,
            scopes.find((s) => s.id === node.scopeId),
          )
        }
      />
    );
  }

  if (scopes && scopes.length === 0) {
    return (
      <div data-testid="memory-shell" data-layout={layout} className="flex min-w-0 flex-1 flex-col">
        <EmptyState
          icon={NotebookText}
          title="You don't have access to any memory yet"
          description="Memory appears here when you join a team or start a private chat with a bot."
        />
      </div>
    );
  }

  const file =
    showFile && fileScopeId ? (
      <Suspense fallback={<FileSkeleton stacked={stacked} />}>
        <MemoryFile
          key={`${fileScopeId}:${filePath ?? ""}`}
          scopeId={fileScopeId}
          // A scope segment that is not an id, or a path the grammar refuses, is not found without any request.
          path={(hasPath && !parsed?.ok) || !Id.safeParse(fileScopeId).success ? null : filePath}
          scope={fileScope}
          layout={layout}
          onBack={stacked ? onBack : undefined}
          onRevealFolder={onRevealFolder}
        />
      </Suspense>
    ) : null;
  const overlays = (
    <>
      <Suspense fallback={null}>
        <DraftGuard scopeId={fileScopeId} path={filePath} />
      </Suspense>
      <MemoryActionDialogs />
    </>
  );

  const search = (
    <MemorySearch
      scopes={scopes ?? []}
      currentScopeId={hasPath ? (scopeId ?? null) : null}
      selected={selected}
      stacked={stacked}
      inputRef={searchRef}
    >
      {treeBody}
    </MemorySearch>
  );

  if (stacked) {
    return (
      <div data-testid="memory-shell" data-layout={layout} className="flex min-w-0 flex-1 flex-col">
        {file ?? (
          <div data-testid="memory-tree-screen" className="flex min-h-0 flex-1 flex-col">
            {search}
            <ProposalsRow stacked />
          </div>
        )}
        {overlays}
      </div>
    );
  }

  return (
    <div data-testid="memory-shell" data-layout={layout} className="flex min-w-0 flex-1">
      <aside
        data-testid="memory-tree-column"
        aria-label="Memory"
        className="flex w-[280px] shrink-0 flex-col border-r bg-sidebar/50 dark:bg-sidebar/40"
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-4">
          <h2 className="truncate font-semibold text-[13px] text-muted-foreground uppercase tracking-wider">
            Memory
          </h2>
          <MemoryCreateButtons scope={fileScope} folder={filePath ? parentFolder(filePath) : ""} />
        </div>
        {search}
        <ProposalsRow stacked={false} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {file ?? (scopes ? null : <FileSkeleton stacked={false} />)}
      </div>
      {overlays}
    </div>
  );
}

/**
 * The Discard dialog for every guarded way out of Edit, and the net under the ones that can't be intercepted (browser
 * Back and Forward, a search result link): when the location leaves a dirty draft's Edit, it asks now and "Keep
 * editing" returns to the draft, which survived in `useMemoryDraft`.
 */
function DraftGuard({ scopeId, path }: { scopeId: string | null; path: string | null }) {
  const router = useRouter();
  const search = useSearchParams();
  const draft = useMemoryDraft((s) => s.draft);
  const pending = useMemoryDraft((s) => s.pending);
  const answer = useMemoryDraft((s) => s.answer);
  const keepRef = useRef<HTMLButtonElement>(null);
  const onDraft = !!draft && draft.scopeId === scopeId && draft.path === path && search.get("tab") === "edit";

  // "Keep editing" navigates back to the draft; until the location is there again, don't ask a second time.
  const returning = useRef(false);
  useEffect(() => {
    if (onDraft) returning.current = false;
    if (!draft || !isDirty(draft) || onDraft || pending || returning.current) return;
    const back = `${memoryHref(draft.scopeId, draft.path)}?tab=edit`;
    useMemoryDraft.getState().guard(
      () => {},
      () => {
        returning.current = true;
        router.push(back, { scroll: false });
      },
    );
  }, [draft, onDraft, pending, router]);

  // Only a dirty draft clears when the location moves on; an unchanged one is dropped.
  useEffect(() => {
    if (draft && !isDirty(draft) && !onDraft) useMemoryDraft.getState().clear();
  }, [draft, onDraft]);

  return (
    <Dialog open={!!pending} onOpenChange={(o) => !o && answer(false)}>
      <DialogContent data-testid="memory-discard-dialog" initialFocus={keepRef}>
        <DialogHeader>
          <DialogTitle>Discard unsaved changes?</DialogTitle>
          <DialogDescription>
            Your changes to {draft ? fileName(draft.path) : "this file"} haven't been saved.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button ref={keepRef} variant="outline" className="max-lg:h-11" onClick={() => answer(false)}>
            Keep editing
          </Button>
          <Button variant="destructive" className="max-lg:h-11" onClick={() => answer(true)}>
            Discard changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
