"use client";

import {
  hotkeysCoreFeature,
  type ItemInstance,
  selectionFeature,
  syncDataLoaderFeature,
} from "@headless-tree/core";
import { useTree } from "@headless-tree/react";
import { MEMORY_ROOT_FILE, type MemoryFileMeta, type MemoryScope } from "@ocw/contracts";
import {
  Bot,
  ChevronRight,
  FileText,
  Folder,
  FolderOpen,
  Globe,
  Lock,
  type LucideIcon,
  NotebookText,
} from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { UNIT_KIND_ICON, UNIT_KIND_LABEL } from "@/components/members/unit-chip";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip } from "@/components/ui/tooltip";
import { buildMemoryTree, fileNodeId, type MemoryNode, scopeAccessibleName } from "@/lib/memory-tree";
import { cn } from "@/lib/utils";

/**
 * The memory file tree (Phase 07.2, MEM-02, D-08, UI-SPEC "Tree rows" and "Interaction Contract › Tree"):
 * `@headless-tree/react` provides the ARIA tree (roving tab stop, levels, set sizes, expanded state, arrows,
 * Home/End); this file adds Enter/Space, typeahead and `*`, and renders the rows. Expanded state lives in a small
 * session store so leaving the tree (phone file screen, another page) and coming back keeps it.
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

export type OpenVia = "pointer" | "keyboard";

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

/** A name that truncates; the full name shows in a Tooltip only when it is cut. */
function TruncatedName({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const text = (
    <span
      ref={ref}
      onPointerEnter={() => {
        const el = ref.current;
        setCut(!!el && el.scrollWidth > el.clientWidth);
      }}
      className={cn("min-w-0 truncate", className)}
    >
      {children}
    </span>
  );
  return (
    <Tooltip content={children} side="right" disabled={!cut}>
      {text}
    </Tooltip>
  );
}

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
      expandOrDown: {
        hotkey: "ArrowRight",
        canRepeat: true,
        handler: (_e, t) => {
          const item = t.getFocusedItem();
          if (!item.isFolder()) return;
          if (!item.isExpanded()) {
            item.expand();
            return;
          }
          if (item.getChildren().length > 0) {
            t.focusNextItem();
            t.updateDomFocus();
          }
        },
      },
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

  // Typeahead buffer (500 ms, UI-SPEC).
  const typed = useRef({ text: "", at: 0 });

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    if (target.getAttribute("role") !== "treeitem") return;
    const item = tree.getFocusedItem();
    if (!item) return;
    const node = item.getItemData();
    if (e.key === "F2" || e.key === "Delete") {
      if (onRowKey?.(node, e.key)) e.preventDefault();
      return;
    }
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      if (rowMenu) {
        e.preventDefault();
        setMenuFor(node.id);
      }
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (node.kind === "file") onOpenRef.current(node, "keyboard");
      else if (item.isExpanded()) item.collapse();
      else item.expand();
      return;
    }
    if (e.key === "*") {
      e.preventDefault();
      const parent = item.getParent();
      const siblings = parent
        ? parent.getChildren()
        : tree.getItems().filter((i) => i.getItemMeta().level === 0);
      const ids = siblings.filter((s) => s.isFolder() && !s.isExpanded()).map((s) => s.getId());
      if (ids.length > 0) setExpanded([...tree.getState().expandedItems, ...ids]);
      return;
    }
    if (e.key.length === 1 && /\S/u.test(e.key)) {
      const now = Date.now();
      const buf = now - typed.current.at > 500 ? e.key : typed.current.text + e.key;
      typed.current = { text: buf, at: now };
      const items = tree.getItems();
      const from = item.getItemMeta().index + (buf.length === 1 ? 1 : 0);
      const wanted = buf.toLocaleLowerCase();
      for (let k = 0; k < items.length; k++) {
        const candidate = items[(from + k) % items.length];
        if (candidate?.getItemName().toLocaleLowerCase().startsWith(wanted)) {
          e.preventDefault();
          candidate.setFocused();
          tree.updateDomFocus();
          return;
        }
      }
    }
  }

  // One tab stop: the focused row when it is visible, else the open file, else the first row (a focused row inside a
  // collapsed folder would otherwise leave the tree unreachable by Tab).
  const items = tree.getItems();
  const focusedId = tree.getState().focusedItem;
  const visible = (id: string | null) => !!id && items.some((i) => i.getId() === id);
  const tabStop = visible(focusedId)
    ? focusedId
    : visible(selectedId)
      ? selectedId
      : (items[0]?.getId() ?? null);

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

const INDENT = 12;

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
  const pad = (stacked ? 4 : 8) + level * INDENT;
  const showEmpty = isScope && expanded && node.loaded && (node.children?.length ?? 0) === 0;
  const showLoading = isScope && expanded && !node.loaded;
  const props = item.getProps();

  return (
    <>
      <div
        {...props}
        role="treeitem"
        tabIndex={tabStop ? 0 : -1}
        // Tab (or a click) landing on a row makes it the tree's focused item, so the arrows start from it.
        onFocus={(e) => {
          if (e.target === e.currentTarget && !item.isFocused()) item.setFocused();
        }}
        aria-label={accessibleName(node)}
        aria-current={selected ? "page" : undefined}
        data-testid="memory-tree-row"
        data-kind={node.kind}
        data-path={node.path}
        data-scope-id={node.scopeId}
        data-selected={selected || undefined}
        className={cn(
          "group relative flex cursor-pointer select-none items-center gap-2 rounded-md pr-2 text-sidebar-foreground text-sm outline-none",
          "focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset",
          isScope ? (stacked ? "h-14 font-semibold" : "h-9 font-semibold") : stacked ? "h-11" : "h-8",
          selected
            ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground"
            : "lg:hover:bg-sidebar-accent/60",
        )}
        style={{ paddingLeft: pad }}
      >
        {selected ? (
          <span aria-hidden className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-r-full bg-primary" />
        ) : null}
        {Array.from({ length: level }, (_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: one static guide per ancestor level
            key={i}
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-border"
            style={{ left: (stacked ? 4 : 8) + i * INDENT + (stacked ? 12 : 10) }}
          />
        ))}
        {folderish ? (
          <span
            aria-hidden
            className={cn(
              "flex shrink-0 items-center justify-center text-muted-foreground",
              stacked ? "size-6" : "size-5",
            )}
          >
            <ChevronRight
              className={cn("size-3.5 motion-safe:transition-transform", expanded && "rotate-90")}
            />
          </span>
        ) : (
          <span aria-hidden className={cn("shrink-0", stacked ? "size-6" : "size-5")} />
        )}
        {isScope && stacked ? (
          <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Icon className="size-5 text-muted-foreground" />
          </span>
        ) : (
          <Icon
            aria-hidden
            className={cn("size-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")}
          />
        )}
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
        {isScope && scope ? (
          <Badge aria-hidden variant="outline" className="ml-auto font-normal">
            {scopeTag(scope)}
          </Badge>
        ) : null}
        {menu && (!stacked || item.isFocused() || menuOpen) ? (
          <span
            className={cn(
              "flex shrink-0 items-center",
              !isScope && "ml-auto",
              !stacked &&
                !selected &&
                !menuOpen &&
                "opacity-0 focus-within:opacity-100 group-hover:opacity-100 group-focus-visible:opacity-100",
            )}
          >
            {menu}
          </span>
        ) : null}
      </div>
      {showEmpty ? (
        <div
          aria-hidden
          className={cn("flex items-center text-muted-foreground text-xs", stacked ? "h-11" : "h-8")}
          style={{ paddingLeft: pad + INDENT + (stacked ? 32 : 28) }}
        >
          No files yet
        </div>
      ) : null}
      {showLoading ? (
        <div
          aria-hidden
          className={cn("flex items-center", stacked ? "h-11" : "h-8")}
          style={{ paddingLeft: pad + INDENT + 28 }}
        >
          <Skeleton className="h-3 w-32 motion-reduce:animate-none" />
        </div>
      ) : null}
    </>
  );
}
