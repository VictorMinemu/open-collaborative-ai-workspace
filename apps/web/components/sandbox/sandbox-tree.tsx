"use client";

import {
  asyncDataLoaderFeature,
  hotkeysCoreFeature,
  type ItemInstance,
  selectionFeature,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import type { SandboxFileEntry } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  Download,
  Ellipsis,
  File,
  FileCode,
  FileImage,
  FileText,
  Folder,
  FolderOpen,
  type LucideIcon,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import {
  type DragEvent,
  forwardRef,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatBytes } from "@/components/chat/attachments/files";
import {
  expandOrDownHotkey,
  TREE_INDENT,
  type TreeOpenVia,
  TreeRowView,
  TruncatedName,
  treeTabStop,
  useTreeKeyboard,
} from "@/components/common/tree-row";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { FILES_REFRESH_MS, fetchSandboxFolder, sortEntries } from "@/lib/sandbox-queries";
import { cn } from "@/lib/utils";

/**
 * The sandbox file tree (07.8-15, UI-SPEC §3.1 "Tree rows", R4): the 07.2 rows (`TreeRowView`) over
 * `@headless-tree/react` with `asyncDataLoaderFeature`, so every folder loads when it is first expanded (one request).
 * Folders come first, then files (numeric-aware); dot files show muted. Expanded folders refresh every 10 s while the
 * page is visible, and after each change, without moving focus. Names are text nodes only (T-07.8-15-01).
 */

/** The workspace root's id (never a relative path, which has no leading slash). */
const ROOT = "/";
const ROOT_NODE: SandboxFileEntry = {
  path: "root",
  name: "/workspace",
  kind: "dir",
  size: null,
  modifiedAt: new Date(0).toISOString(),
  hidden: false,
};
const LOADING_NODE: SandboxFileEntry = { ...ROOT_NODE, name: "" };

const folderOf = (id: string) => (id === ROOT ? "" : id);

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/iu;
const CODE =
  /\.(m?[jt]sx?|cjs|py|sh|bash|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|php|swift|json|ya?ml|toml|sql|css|scss|html?|xml|ini|env)$/iu;
const TEXT = /\.(txt|md|markdown|csv|tsv|log|rst)$/iu;

/** `Folder` / `FolderOpen`; `FileImage`, `FileCode`, `FileText` by extension; `File` otherwise (UI-SPEC §3.1). */
export function entryIcon(entry: Pick<SandboxFileEntry, "kind" | "name">, expanded = false): LucideIcon {
  if (entry.kind === "dir") return expanded ? FolderOpen : Folder;
  if (IMAGE.test(entry.name)) return FileImage;
  if (CODE.test(entry.name)) return FileCode;
  if (TEXT.test(entry.name)) return FileText;
  return File;
}

export interface SandboxTreeHandle {
  /** Re-reads these folders (`""` = the root), or the root and every expanded folder. Keeps the old rows meanwhile. */
  refresh(folders?: string[]): Promise<void>;
  /** Where Upload puts files: the focused folder, the focused file's folder, else the root. */
  uploadFolder(): string;
  /** Moves the tree's focus to a row once it is rendered. */
  focusPath(path: string): void;
}

export interface SandboxTreeProps {
  agentId: string;
  bot: string;
  /** Phones: 44 px rows, a 24 px chevron box, the ⋯ only on the selected or focused row. */
  stacked: boolean;
  selectedPath: string | null;
  expanded: string[];
  onExpandedChange: (ids: string[]) => void;
  onOpen: (entry: SandboxFileEntry, via: TreeOpenVia) => void;
  /** Every folder listing as it arrives (the open file's newest `modifiedAt`). */
  onEntries?: (entries: readonly SandboxFileEntry[]) => void;
  onDownload: (entry: SandboxFileEntry) => void;
  onDelete: (entry: SandboxFileEntry) => void;
  onUploadHere: (folder: string) => void;
  /** Files dropped onto a folder row (desktop). */
  onDropFiles: (folder: string, files: File[]) => void;
}

const SKELETON_WIDTHS = ["w-[70%]", "w-[55%]", "w-[80%]", "w-[60%]", "w-[75%]", "w-[50%]"];

export function SandboxTreeSkeleton({ stacked }: { stacked: boolean }) {
  return (
    <div data-testid="sandbox-tree-loading" aria-busy className="grid gap-px">
      {SKELETON_WIDTHS.map((w) => (
        <div key={w} className={cn("flex items-center gap-2 px-2", stacked ? "h-11" : "h-8")}>
          <Skeleton className="size-4 shrink-0 rounded motion-reduce:animate-none" />
          <Skeleton className={cn("h-3.5 motion-reduce:animate-none", w)} />
        </div>
      ))}
    </div>
  );
}

type RootState = { status: "loading" } | { status: "error" } | { status: "ready"; count: number };

export const SandboxTree = forwardRef<SandboxTreeHandle, SandboxTreeProps>(function SandboxTree(
  {
    agentId,
    bot,
    stacked,
    selectedPath,
    expanded,
    onExpandedChange,
    onOpen,
    onEntries,
    onDownload,
    onDelete,
    onUploadHere,
    onDropFiles,
  },
  ref,
) {
  const qc = useQueryClient();
  const [root, setRoot] = useState<RootState>({ status: "loading" });
  /** Entries past the first 500 of a folder (the API lists 500). */
  const [more, setMore] = useState<Record<string, number>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<string | null>(null);

  const callbacks = useRef({ onOpen, onEntries });
  callbacks.current = { onOpen, onEntries };

  const selectedItems = useMemo(() => (selectedPath ? [selectedPath] : []), [selectedPath]);

  const tree = useTree<SandboxFileEntry>({
    rootItemId: ROOT,
    getItemName: (item) => item.getItemData()?.name ?? "",
    isItemFolder: (item) => item.getItemData()?.kind !== "file",
    createLoadingItemData: () => LOADING_NODE,
    dataLoader: {
      getItem: async (id) =>
        id === ROOT
          ? ROOT_NODE
          : { ...ROOT_NODE, path: id, name: id.split("/").at(-1) ?? id, kind: "dir" as const },
      getChildrenWithData: async (id) => {
        try {
          const list = await fetchSandboxFolder(qc, agentId, folderOf(id));
          setMore((m) => (m[id] === list.more ? m : { ...m, [id]: list.more }));
          if (id === ROOT) setRoot({ status: "ready", count: list.entries.length });
          callbacks.current.onEntries?.(list.entries);
          return sortEntries(list.entries).map((e) => ({ id: e.path, data: e }));
        } catch {
          // The root shows the error with Try again; a folder that vanished is simply empty until the next refresh.
          if (id === ROOT) setRoot({ status: "error" });
          return [];
        }
      },
    },
    state: { expandedItems: expanded, selectedItems },
    setExpandedItems: (ids) => onExpandedChange(typeof ids === "function" ? ids(expanded) : ids),
    // Selection is the open file, never a separate multi-select.
    setSelectedItems: () => {},
    onPrimaryAction: (item) => {
      const node = item.getItemData();
      if (node?.kind === "file") callbacks.current.onOpen(node, "pointer");
    },
    hotkeys: { expandOrDown: expandOrDownHotkey },
    features: [asyncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });

  const refresh = useCallback(
    async (folders?: string[]) => {
      const ids = folders
        ? folders.map((f) => (f === "" ? ROOT : f))
        : [ROOT, ...tree.getState().expandedItems];
      await Promise.all([...new Set(ids)].map((id) => tree.getItemInstance(id).invalidateChildrenIds(true)));
    },
    [tree],
  );

  useImperativeHandle(
    ref,
    () => ({
      refresh,
      uploadFolder: () => {
        const id = tree.getState().focusedItem;
        if (!id || id === ROOT) return "";
        const node = tree.getItemInstance(id).getItemData();
        if (!node || node === LOADING_NODE) return "";
        if (node.kind === "dir") return node.path;
        return node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
      },
      focusPath: (path) => setFocusRequest(path),
    }),
    [refresh, tree],
  );

  // Files the bot writes show up: expanded folders are re-read every 10 s while the page is visible.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, FILES_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const items = tree.getItems();

  // A requested row gets focus once it is rendered (after an upload, the new file).
  useEffect(() => {
    if (!focusRequest || !items.some((i) => i.getId() === focusRequest)) return;
    tree.getItemInstance(focusRequest).setFocused();
    tree.updateDomFocus();
    setFocusRequest(null);
  }, [focusRequest, items, tree]);

  const onKeyDown = useTreeKeyboard<SandboxFileEntry>({
    tree,
    onOpen: (item) => {
      const node = item.getItemData();
      if (node?.kind === "file") callbacks.current.onOpen(node, "keyboard");
    },
    expandMany: (ids) => onExpandedChange([...tree.getState().expandedItems, ...ids]),
    onRowKey: (item, key) => {
      const node = item.getItemData();
      if (key !== "Delete" || !node || node === LOADING_NODE) return false;
      onDelete(node);
      return true;
    },
    onMenuKey: (item) => setMenuFor(item.getId()),
  });

  if (root.status === "error") {
    return (
      <div
        data-testid="sandbox-files-error"
        role="alert"
        className="grid justify-items-start gap-2 px-4 py-4 text-sm"
      >
        <p className="text-muted-foreground">Couldn't load {bot}'s sandbox.</p>
        <Button
          variant="outline"
          size="sm"
          className="max-md:h-11"
          onClick={() => {
            setRoot({ status: "loading" });
            void refresh([""]);
          }}
        >
          <RotateCcw /> Try again
        </Button>
      </div>
    );
  }
  if (root.status === "loading") return <SandboxTreeSkeleton stacked={stacked} />;
  if (root.count === 0 && items.length === 0) {
    return (
      <div
        data-testid="sandbox-files-empty"
        className="grid justify-items-center gap-3 px-4 py-10 text-center"
      >
        <span
          aria-hidden
          className="flex size-12 items-center justify-center rounded-xl border bg-muted/50 text-muted-foreground"
        >
          <FolderOpen className="size-5" />
        </span>
        <p className="font-semibold text-[15px]">No files yet</p>
        <Button variant="outline" size="sm" className="max-md:h-11" onClick={() => onUploadHere("")}>
          <Upload /> Upload
        </Button>
      </div>
    );
  }

  // "{n} more" after a folder's last visible row (the API lists the first 500 of a folder).
  const moreAfter = new Map<number, Array<{ id: string; n: number; level: number }>>();
  for (const [id, n] of Object.entries(more)) {
    if (n <= 0) continue;
    if (id !== ROOT && !expanded.includes(id)) continue;
    let last = -1;
    let level = 0;
    items.forEach((it, idx) => {
      const p = it.getId();
      if (id === ROOT || p === id || p.startsWith(`${id}/`)) last = idx;
      if (p === id) level = it.getItemMeta().level + 1;
    });
    if (last >= 0) moreAfter.set(last, [...(moreAfter.get(last) ?? []), { id, n, level }]);
  }

  const tabStop = treeTabStop(tree, selectedPath);
  const label = `Files in ${bot}'s sandbox`;

  return (
    <div
      {...tree.getContainerProps(label)}
      role="tree"
      data-testid="sandbox-tree"
      onKeyDown={onKeyDown}
      className="grid gap-px outline-none"
    >
      {items.map((item, idx) => (
        <SandboxRow
          key={item.getId()}
          item={item}
          stacked={stacked}
          selected={item.getId() === selectedPath}
          tabStop={item.getId() === tabStop}
          menuOpen={menuFor === item.getId()}
          onMenuOpenChange={(o) => setMenuFor(o ? item.getId() : null)}
          dropOn={dropOn}
          setDropOn={setDropOn}
          onDownload={onDownload}
          onDelete={onDelete}
          onUploadHere={onUploadHere}
          onDropFiles={onDropFiles}
          after={moreAfter.get(idx)}
        />
      ))}
    </div>
  );
});

function SandboxRow({
  item,
  stacked,
  selected,
  tabStop,
  menuOpen,
  onMenuOpenChange,
  dropOn,
  setDropOn,
  onDownload,
  onDelete,
  onUploadHere,
  onDropFiles,
  after,
}: {
  item: ItemInstance<SandboxFileEntry>;
  stacked: boolean;
  selected: boolean;
  tabStop: boolean;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  dropOn: string | null;
  setDropOn: (path: string | null) => void;
  onDownload: (entry: SandboxFileEntry) => void;
  onDelete: (entry: SandboxFileEntry) => void;
  onUploadHere: (folder: string) => void;
  onDropFiles: (folder: string, files: File[]) => void;
  after?: Array<{ id: string; n: number; level: number }>;
}) {
  const node = item.getItemData();
  const level = item.getItemMeta().level;
  const expanded = item.isExpanded();
  if (!node || node === LOADING_NODE) {
    return (
      <div aria-hidden className={cn("flex items-center", stacked ? "h-11" : "h-8")}>
        <Skeleton
          className="h-3 w-32 motion-reduce:animate-none"
          style={{ marginLeft: (stacked ? 4 : 8) + level * TREE_INDENT + 28 }}
        />
      </div>
    );
  }
  const folder = node.kind === "dir";
  const size = folder ? null : formatBytes(node.size ?? 0);
  const loadingChildren = folder && expanded && item.isLoading() && item.getChildren().length === 0;
  const pad = (stacked ? 4 : 8) + (level + 1) * TREE_INDENT + (stacked ? 32 : 28);

  const isFileDrag = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const dropHandlers =
    folder && !stacked
      ? {
          onDragEnter: (e: DragEvent<HTMLDivElement>) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            setDropOn(node.path);
          },
          onDragOver: (e: DragEvent<HTMLDivElement>) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            if (dropOn !== node.path) setDropOn(node.path);
          },
          onDragLeave: (e: DragEvent<HTMLDivElement>) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            if (dropOn === node.path) setDropOn(null);
          },
          onDrop: (e: DragEvent<HTMLDivElement>) => {
            if (!isFileDrag(e)) return;
            e.preventDefault();
            setDropOn(null);
            const files = [...e.dataTransfer.files];
            if (files.length > 0) onDropFiles(node.path, files);
          },
        }
      : undefined;

  const stop = (e: SyntheticEvent) => e.stopPropagation();
  const menu = (
    <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            tabIndex={-1}
            className={cn(stacked ? "size-11" : "size-6", "text-muted-foreground")}
            aria-label={`Actions for ${node.name}`}
            onClick={stop}
            onPointerDown={stop}
            onKeyDown={stop}
          />
        }
      >
        <Ellipsis />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="sandbox-row-menu">
        {folder ? (
          <DropdownMenuItem className={cn(stacked && "min-h-11")} onClick={() => onUploadHere(node.path)}>
            <Upload />
            Upload here
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem className={cn(stacked && "min-h-11")} onClick={() => onDownload(node)}>
            <Download />
            Download
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          variant="destructive"
          className={cn(stacked && "min-h-11")}
          onClick={() => onDelete(node)}
        >
          <Trash2 />
          Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      <TreeRowView
        itemProps={item.getProps()}
        rowHandlers={dropHandlers}
        onFocus={(e) => {
          if (e.target === e.currentTarget && !item.isFocused()) item.setFocused();
        }}
        label={folder ? `${node.name}, folder` : `${node.name}, ${size}`}
        current={selected}
        dataAttributes={{
          "data-testid": `sandbox-row-${node.path}`,
          "data-kind": node.kind,
          "data-path": node.path,
          "data-selected": selected || undefined,
          "data-drop-target": dropOn === node.path || undefined,
        }}
        level={level}
        folder={folder}
        expanded={expanded}
        selected={selected}
        tabStop={tabStop}
        stacked={stacked}
        icon={entryIcon(node, expanded)}
        trailing={
          size ? (
            <span
              aria-hidden
              className="ml-auto shrink-0 font-mono text-muted-foreground text-xs tabular-nums"
            >
              {size}
            </span>
          ) : null
        }
        menu={menu}
        menuShown={!stacked || selected || item.isFocused() || menuOpen}
        menuOpen={menuOpen}
        menuPushRight={folder}
        className={cn(dropOn === node.path && "bg-sidebar-accent ring-1 ring-ring/40 ring-inset")}
      >
        <TruncatedName className={cn("flex-1", node.hidden && "text-muted-foreground")}>
          {node.name}
        </TruncatedName>
      </TreeRowView>
      {loadingChildren ? (
        <div
          aria-hidden
          className={cn("flex items-center", stacked ? "h-11" : "h-8")}
          style={{ paddingLeft: pad }}
        >
          <Skeleton className="h-3 w-32 motion-reduce:animate-none" />
        </div>
      ) : null}
      {after?.map((m) => (
        <div
          key={`more-${m.id}`}
          data-testid="sandbox-more"
          className={cn("flex items-center text-muted-foreground text-xs", stacked ? "h-11" : "h-8")}
          style={{ paddingLeft: (stacked ? 4 : 8) + m.level * TREE_INDENT + (stacked ? 32 : 28) }}
        >
          {m.n === 1 ? "1 more not listed" : `${m.n.toLocaleString()} more not listed`}
        </div>
      ))}
    </>
  );
}
