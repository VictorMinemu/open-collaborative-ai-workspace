"use client";

import {
  hotkeysCoreFeature,
  type ItemInstance,
  selectionFeature,
  syncDataLoaderFeature,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { MEMORY_ROOT_FILE, type MemoryFileMeta, type MemoryScope } from "@ocw/contracts";
import { Bot, FileText, Folder, FolderOpen, Globe, Lock, type LucideIcon, NotebookText } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import {
  expandOrDownHotkey,
  TREE_INDENT,
  type TreeOpenVia,
  TreeRowView,
  TruncatedName,
  treeTabStop,
  useTreeKeyboard,
} from "@/components/common/tree-row";
import { UNIT_KIND_ICON, UNIT_KIND_LABEL } from "@/components/members/unit-chip";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { buildMemoryTree, fileNodeId, type MemoryNode, scopeAccessibleName } from "@/lib/memory-tree";
import { cn } from "@/lib/utils";

/**
 * The memory file tree (Phase 07.2, MEM-02, D-08, UI-SPEC "Tree rows" and "Interaction Contract › Tree"):
 * `@headless-tree/react` provides the ARIA tree (roving tab stop, levels, set sizes, expanded state, arrows,
 * Home/End); the shared `TreeRowView` and `useTreeKeyboard` (07.8-15, R4) add Enter/Space, typeahead and `*` and draw
 * the rows. Expanded state lives in a small session store so leaving the tree (phone file screen, another page) and
 * coming back keeps it.
 */

interface TreeUiState {
  expanded: string[];
  setExpanded: (ids: string[]) => void;
  /** Expands these ids (deep links, breadcrumbs), keeping the rest. */
  reveal: (ids: readonly string[]) => void;
  /** A row to focus once it is rendered (phone Back, breadcrumb folders, Escape from search). */
  focusRequest: string | null;
  requestFocus: (id: string | null) => void;
}

export const useMemoryTreeState = create<TreeUiState>()((set) => ({
  expanded: [],
  setExpanded: (ids) => set({ expanded: ids }),
  reveal: (ids) =>
    set((s) => {
      const missing = ids.filter((id) => !s.expanded.includes(id));
      return missing.length === 0 ? s : { expanded: [...s.expanded, ...missing] };
    }),
  focusRequest: null,
  requestFocus: (id) => set({ focusRequest: id }),
}));

export type OpenVia = TreeOpenVia;

const ROOT = "memory-root";
const ROOT_NODE: MemoryNode = { id: ROOT, kind: "scope", name: "", scopeId: "" };

export const SCOPE_KIND_TAG: Record<MemoryScope["kind"], string> = {
  personal: "Private",
  agent: "Bot",
  unit: "Team",
  org: "Everyone",
};

export function scopeTag(scope: MemoryScope): string {
  return scope.kind === "unit" && scope.unitKind
    ? UNIT_KIND_LABEL[scope.unitKind]
    : SCOPE_KIND_TAG[scope.kind];
}

export function scopeIcon(scope: MemoryScope): LucideIcon {
  switch (scope.kind) {
    case "personal":
      return Lock;
    case "agent":
      return Bot;
    case "unit":
      return scope.unitKind ? UNIT_KIND_ICON[scope.unitKind] : Folder;
    case "org":
      return Globe;
  }
}

function accessibleName(node: MemoryNode): string {
  if (node.kind === "scope" && node.scope) {
    const empty = node.loaded && (node.children?.length ?? 0) === 0;
    return `${scopeAccessibleName(node.scope)}${empty ? ", no files yet" : ""}`;
  }
  return node.kind === "folder" ? `${node.name}, folder` : node.name;
}

const filesLabel = (n: number) => (n === 1 ? "1 file" : `${n} files`);

function FileName({ name }: { name: string }) {
  if (!name.endsWith(".md")) return <>{name}</>;
  return (
    <>
      {name.slice(0, -3)}
      <span className="text-muted-foreground">.md</span>
    </>
  );
}

export interface MemoryTreeProps {
  scopes: readonly MemoryScope[];
  filesByScope: ReadonlyMap<string, readonly MemoryFileMeta[]>;
  /** The open file, if any (`aria-selected` + `aria-current="page"`). */
  selected: { scopeId: string; path: string } | null;
  onOpen: (node: MemoryNode, via: OpenVia) => void;
  /** Only the scopes of one bot (the agent page, 07.2-14). */
  scopeFilter?: { agentId: string };
  /** Phone and stacked layouts: 56 px scope rows with a file count, 44 px rows. */
  stacked?: boolean;
  label?: string;
  className?: string;
  /**
   * A row's ⋯ menu (07.2-12, writers only; null hides it). Shown on hover, on the selected row and while open on
   * desktop; on the focused row only on phones. Shift+F10 / ContextMenu opens the focused row's menu.
   */
  rowMenu?: (node: MemoryNode, menu: { open: boolean; onOpenChange: (open: boolean) => void }) => ReactNode;
  /** F2 (rename or move) and Delete on the focused row; returns whether it handled the key. */
  onRowKey?: (node: MemoryNode, key: "F2" | "Delete") => boolean;
}

export function MemoryTree({
  scopes,
  filesByScope,
  selected,
  onOpen,
  scopeFilter,
  stacked = false,
  label = "Memory files",
  className,
  rowMenu,
  onRowKey,
}: MemoryTreeProps) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const visibleScopes = useMemo(
    () => (scopeFilter ? scopes.filter((s) => s.agentId === scopeFilter.agentId) : scopes),
    [scopes, scopeFilter],
  );
  const nodes = useMemo(() => {
    const built = buildMemoryTree(visibleScopes, filesByScope);
    // One bot's scopes (agent page, UI-SPEC "Agent page"): its notebook first, then the viewer's private memory with it.
    if (!scopeFilter) return built;
    const rank = (n: MemoryNode) => (n.scope?.kind === "agent" ? 0 : 1);
    return [...built].sort((x, y) => rank(x) - rank(y));
  }, [visibleScopes, filesByScope, scopeFilter]);
  const index = useMemo(() => {
    const m = new Map<string, { node: MemoryNode; parent: string }>();
    const walk = (list: readonly MemoryNode[], parent: string) => {
      for (const n of list) {
        m.set(n.id, { node: n, parent });
        if (n.children) walk(n.children, n.id);
      }
    };
    walk(nodes, ROOT);
    return m;
  }, [nodes]);

  const expanded = useMemoryTreeState((s) => s.expanded);
  const setExpanded = useMemoryTreeState((s) => s.setExpanded);
  const focusRequest = useMemoryTreeState((s) => s.focusRequest);
  const requestFocus = useMemoryTreeState((s) => s.requestFocus);
  const selectedId = selected ? fileNodeId(selected.scopeId, selected.path) : null;
  const selectedItems = useMemo(() => (selectedId ? [selectedId] : []), [selectedId]);

  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  const tree = useTree<MemoryNode>({
    rootItemId: ROOT,
    getItemName: (item) => item.getItemData().name,
    isItemFolder: (item) => item.getItemData().kind !== "file",
    dataLoader: {
      getItem: (id) => (id === ROOT ? ROOT_NODE : (index.get(id)?.node ?? ROOT_NODE)),
      getChildren: (id) =>
        id === ROOT ? nodes.map((n) => n.id) : (index.get(id)?.node.children ?? []).map((c) => c.id),
    },
    initialState: { focusedItem: selectedId },
    state: { expandedItems: expanded, selectedItems },
    setExpandedItems: (ids) => setExpanded(typeof ids === "function" ? ids(expanded) : ids),
    // Selection is the open file (from the URL), never a separate multi-select.
    setSelectedItems: () => {},
    onPrimaryAction: (item) => {
      const node = item.getItemData();
      if (node.kind === "file") onOpenRef.current(node, "pointer");
    },
    hotkeys: {
      // → on a file does nothing (UI-SPEC); on a closed scope or folder it expands; on an open one it enters.
      expandOrDown: expandOrDownHotkey,
    },
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
  });

  // New data (a scope's list arrived, a file appeared) rebuilds the flat item list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuild when the data changes
  useEffect(() => {
    tree.rebuildTree();
  }, [tree, nodes]);

  // A requested row (phone Back, breadcrumb, Escape from search) gets focus once it is rendered.
  useEffect(() => {
    if (!focusRequest || !index.has(focusRequest)) return;
    const item = tree.getItemInstance(focusRequest);
    item.setFocused();
    tree.updateDomFocus();
    requestFocus(null);
  }, [focusRequest, index, tree, requestFocus]);

  // The open file (deep link, search result) scrolls into view without animation (reduced motion, UI-SPEC); it runs
  // again once a reveal has expanded its folders and the row exists.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `expanded` re-runs it after a reveal
  useEffect(() => {
    if (!selectedId || !index.has(selectedId)) return;
    if (tree.getState().focusedItem === null) tree.getItemInstance(selectedId).setFocused();
    const el = tree.getItemInstance(selectedId).getElement();
    el?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [selectedId, index, tree, expanded]);

  const onKeyDown = useTreeKeyboard<MemoryNode>({
    tree,
    onOpen: (item) => {
      const node = item.getItemData();
      if (node.kind === "file") onOpenRef.current(node, "keyboard");
    },
    expandMany: (ids) => setExpanded([...tree.getState().expandedItems, ...ids]),
    onRowKey: onRowKey ? (item, key) => onRowKey(item.getItemData(), key) : undefined,
    onMenuKey: rowMenu ? (item) => setMenuFor(item.getId()) : undefined,
  });

  const items = tree.getItems();
  const tabStop = treeTabStop(tree, selectedId);

  return (
    <div
      {...tree.getContainerProps(label)}
      role="tree"
      data-testid="memory-tree"
      onKeyDown={onKeyDown}
      className={cn("grid gap-px outline-none", className)}
    >
      {items.map((item) => (
        <TreeRow
          key={item.getId()}
          item={item}
          selected={item.getId() === selectedId}
          tabStop={item.getId() === tabStop}
          stacked={stacked}
          menu={
            rowMenu?.(item.getItemData(), {
              open: menuFor === item.getId(),
              onOpenChange: (open) => setMenuFor(open ? item.getId() : null),
            }) ?? null
          }
          menuOpen={menuFor === item.getId()}
        />
      ))}
    </div>
  );
}

function TreeRow({
  item,
  selected,
  tabStop,
  stacked,
  menu,
  menuOpen,
}: {
  item: ItemInstance<MemoryNode>;
  selected: boolean;
  tabStop: boolean;
  stacked: boolean;
  menu: ReactNode;
  menuOpen: boolean;
}) {
  const node = item.getItemData();
  const level = item.getItemMeta().level;
  const expanded = item.isExpanded();
  const isScope = node.kind === "scope";
  const folderish = node.kind !== "file";
  const scope = node.scope;
  const Icon: LucideIcon =
    isScope && scope
      ? scopeIcon(scope)
      : node.kind === "folder"
        ? expanded
          ? FolderOpen
          : Folder
        : node.name === MEMORY_ROOT_FILE && level === 1
          ? NotebookText
          : FileText;
  const pad = (stacked ? 4 : 8) + level * TREE_INDENT;
  const showEmpty = isScope && expanded && node.loaded && (node.children?.length ?? 0) === 0;
  const showLoading = isScope && expanded && !node.loaded;

  return (
    <>
      <TreeRowView
        itemProps={item.getProps()}
        // Tab (or a click) landing on a row makes it the tree's focused item, so the arrows start from it.
        onFocus={(e) => {
          if (e.target === e.currentTarget && !item.isFocused()) item.setFocused();
        }}
        label={accessibleName(node)}
        current={selected}
        dataAttributes={{
          "data-testid": "memory-tree-row",
          "data-kind": node.kind,
          "data-path": node.path,
          "data-scope-id": node.scopeId,
          "data-selected": selected || undefined,
        }}
        level={level}
        folder={folderish}
        expanded={expanded}
        heading={isScope}
        selected={selected}
        tabStop={tabStop}
        stacked={stacked}
        icon={Icon}
        iconTile={isScope && stacked}
        trailing={
          isScope && scope ? (
            <Badge aria-hidden variant="outline" className="ml-auto font-normal">
              {scopeTag(scope)}
            </Badge>
          ) : null
        }
        menu={menu}
        menuShown={!stacked || item.isFocused() || menuOpen}
        menuOpen={menuOpen}
        menuPushRight={!isScope}
      >
        {isScope && stacked ? (
          <span className="flex min-w-0 flex-1 flex-col">
            <TruncatedName>{node.name}</TruncatedName>
            <span aria-hidden className="truncate font-normal text-muted-foreground text-xs">
              {node.loaded ? filesLabel(node.fileCount ?? 0) : " "}
            </span>
          </span>
        ) : (
          <TruncatedName className="flex-1">
            {node.kind === "file" ? <FileName name={node.name} /> : node.name}
          </TruncatedName>
        )}
      </TreeRowView>
      {showEmpty ? (
        <div
          aria-hidden
          className={cn("flex items-center text-muted-foreground text-xs", stacked ? "h-11" : "h-8")}
          style={{ paddingLeft: pad + TREE_INDENT + (stacked ? 32 : 28) }}
        >
          No files yet
        </div>
      ) : null}
      {showLoading ? (
        <div
          aria-hidden
          className={cn("flex items-center", stacked ? "h-11" : "h-8")}
          style={{ paddingLeft: pad + TREE_INDENT + 28 }}
        >
          <Skeleton className="h-3 w-32 motion-reduce:animate-none" />
        </div>
      ) : null}
    </>
  );
}
