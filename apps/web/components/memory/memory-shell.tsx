"use client";

import { MEMORY_ROOT_FILE } from "@ocw/contracts";
import { Inbox, NotebookText, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { EmptyState } from "@/components/common/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useMemoryFilesByScope, useMemoryScopes } from "@/lib/memory-queries";
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
import { MemorySearch } from "./memory-search";
import { MemoryTree, type OpenVia, useMemoryTreeState } from "./memory-tree";

/**
 * The memory viewer's geometry (Phase 07.2, MEM-02, UI-SPEC "Shell geometry", R1, R2):
 * - `wide` (≥ 1280): tree column 280 · file pane; 07.2-12 adds the 360 px History column here.
 * - `split` (1024–1279): tree column 280 · file pane.
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
  const onOpen = (node: MemoryNode, via: OpenVia) => {
    if (node.kind !== "file" || !node.path) return;
    if (via === "keyboard" || stacked) focusHeadingNext();
    fromTree.current = stacked;
    router.push(memoryHref(node.scopeId, node.path));
  };
  const onBack = () => {
    if (fileScopeId && filePath) requestFocus(fileNodeId(fileScopeId, filePath));
    if (fromTree.current) {
      fromTree.current = false;
      router.back();
    } else {
      router.push(fileScopeId ? memoryHref(fileScopeId) : "/memory");
    }
  };
  const onRevealFolder = (folder: string | null) => {
    if (!fileScopeId) return;
    const target = folder ? folderNodeId(fileScopeId, folder) : scopeNodeId(fileScopeId);
    reveal(memoryAncestorIds(fileScopeId, folder ? `${folder}/x.md` : undefined));
    requestFocus(target);
    if (stacked) router.push(memoryHref(fileScopeId));
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
      <MemoryFile
        key={`${fileScopeId}:${filePath ?? ""}`}
        scopeId={fileScopeId}
        path={hasPath && !parsed?.ok ? null : filePath}
        scope={fileScope}
        stacked={stacked}
        onBack={stacked ? onBack : undefined}
        onRevealFolder={onRevealFolder}
      />
    ) : null;

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
        </div>
        {search}
        <ProposalsRow stacked={false} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {file ?? (scopes ? null : <FileSkeleton stacked={false} />)}
      </div>
    </div>
  );
}
