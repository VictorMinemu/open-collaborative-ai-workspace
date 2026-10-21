"use client";

import type { ItemInstance, TreeInstance } from "@headless-tree/core";
import { ChevronRight, type LucideIcon } from "lucide-react";
import {
  type FocusEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The 07.2 tree row and its keyboard contract, shared by the memory tree and the sandbox file tree (07.8-15, UI-SPEC
 * R4). `@headless-tree/react` gives the ARIA tree (roving tab stop, levels, set sizes, expanded state, arrows,
 * Home/End); this file adds Enter/Space, typeahead (500 ms), `*`, and the host's keys (F2, Delete, Shift+F10), and draws
 * the row: desktop h-8 (h-9 headings), phone h-11 (h-14 headings), indent 12 per level with 1 px guides, a 20 px (24 on
 * phones) chevron box, selected `bg-sidebar-accent` with a 2 px primary bar, keyboard focus as an inset ring. The memory
 * tree renders exactly what it rendered before the extraction (a pixel backstop guards it).
 */

export const TREE_INDENT = 12;

export type TreeOpenVia = "pointer" | "keyboard";

/** A name that truncates; the full name shows in a Tooltip only when it is cut. */
export function TruncatedName({ children, className }: { children: ReactNode; className?: string }) {
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

export interface TreeRowViewProps {
  /** `item.getProps()` of headless-tree (click, ARIA level and set data). Empty in static renders. */
  itemProps?: HTMLAttributes<HTMLDivElement> & Record<string, unknown>;
  /** The host's test and data attributes (`data-testid`, `data-path`, …). */
  dataAttributes?: Record<`data-${string}`, string | boolean | undefined>;
  level: number;
  /** A folder or a scope: draws the chevron. */
  folder: boolean;
  expanded: boolean;
  /** A heading row (a memory scope): taller and semibold. */
  heading?: boolean;
  selected: boolean;
  /** The tree's single tab stop. */
  tabStop: boolean;
  /** Phone and stacked layouts: 44 px rows (56 px headings), a 24 px chevron box. */
  stacked: boolean;
  /** The accessible name (sizes and kinds included, e.g. "q3.csv, 12 KB"). */
  label: string;
  icon: LucideIcon;
  /** The icon sits in a 32 px muted tile (memory scope headings on phones). */
  iconTile?: boolean;
  /** The name (and anything that sits with it). */
  children: ReactNode;
  /** After the name: a badge, a size. */
  trailing?: ReactNode;
  /** The row's ⋯ menu; drawn only when `menuShown`. */
  menu?: ReactNode;
  menuShown?: boolean;
  menuOpen?: boolean;
  /** The menu pushes itself to the right edge (nothing trailing does). */
  menuPushRight?: boolean;
  onFocus?: (e: FocusEvent<HTMLDivElement>) => void;
  /** `aria-current="page"` on the open file. */
  current?: boolean;
  className?: string;
  /** Drop-target and other row events of the host (drag and drop of files onto a folder). */
  rowHandlers?: Pick<HTMLAttributes<HTMLDivElement>, "onDragOver" | "onDragEnter" | "onDragLeave" | "onDrop">;
}

export function TreeRowView({
  itemProps,
  dataAttributes,
  level,
  folder,
  expanded,
  heading = false,
  selected,
  tabStop,
  stacked,
  label,
  icon: Icon,
  iconTile = false,
  children,
  trailing,
  menu,
  menuShown = false,
  menuOpen = false,
  menuPushRight = true,
  onFocus,
  current,
  className,
  rowHandlers,
}: TreeRowViewProps) {
  const pad = (stacked ? 4 : 8) + level * TREE_INDENT;
  return (
    <div
      {...itemProps}
      {...rowHandlers}
      role="treeitem"
      tabIndex={tabStop ? 0 : -1}
      onFocus={onFocus}
      aria-label={label}
      aria-current={current ? "page" : undefined}
      {...dataAttributes}
      className={cn(
        "group relative flex cursor-pointer select-none items-center gap-2 rounded-md pr-2 text-sidebar-foreground text-sm outline-none",
        "focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset",
        heading ? (stacked ? "h-14 font-semibold" : "h-9 font-semibold") : stacked ? "h-11" : "h-8",
        selected
          ? "bg-sidebar-accent font-semibold text-sidebar-accent-foreground"
          : "lg:hover:bg-sidebar-accent/60",
        className,
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
          style={{ left: (stacked ? 4 : 8) + i * TREE_INDENT + (stacked ? 12 : 10) }}
        />
      ))}
      {folder ? (
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
      {iconTile ? (
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-5 text-muted-foreground" />
        </span>
      ) : (
        <Icon
          aria-hidden
          className={cn("size-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")}
        />
      )}
      {children}
      {trailing}
      {menu && menuShown ? (
        <span
          className={cn(
            "flex shrink-0 items-center",
            menuPushRight && "ml-auto",
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
  );
}

/**
 * → on a file does nothing; on a closed folder it expands; on an open one it moves into it (07.2 UI-SPEC). Pass as
 * `hotkeys.expandOrDown` of `useTree`.
 */
export const expandOrDownHotkey = {
  hotkey: "ArrowRight",
  canRepeat: true,
  handler: <T,>(_e: unknown, t: TreeInstance<T>) => {
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
};

/**
 * The tree's single tab stop: the focused row when it is visible, else the open file, else the first row (a focused row
 * inside a collapsed folder would otherwise leave the tree unreachable by Tab).
 */
export function treeTabStop<T>(tree: TreeInstance<T>, selectedId: string | null): string | null {
  const items = tree.getItems();
  const focusedId = tree.getState().focusedItem;
  const visible = (id: string | null) => !!id && items.some((i) => i.getId() === id);
  return visible(focusedId) ? focusedId : visible(selectedId) ? selectedId : (items[0]?.getId() ?? null);
}

export interface TreeKeyboardOptions<T> {
  tree: TreeInstance<T>;
  /** Enter or Space on a leaf. */
  onOpen: (item: ItemInstance<T>) => void;
  /** `*`: expands these closed sibling folders at once. */
  expandMany: (ids: string[]) => void;
  /** F2 and Delete on the focused row; returns whether the host handled the key. */
  onRowKey?: (item: ItemInstance<T>, key: "F2" | "Delete") => boolean;
  /** Shift+F10 / ContextMenu: opens the focused row's menu (absent: the keys do nothing). */
  onMenuKey?: (item: ItemInstance<T>) => void;
}

/** The 07.2 keyboard additions on top of headless-tree: Enter/Space, `*`, typeahead and the host's keys. */
export function useTreeKeyboard<T>(opts: TreeKeyboardOptions<T>) {
  // Typeahead buffer (500 ms, UI-SPEC).
  const typed = useRef({ text: "", at: 0 });
  return function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const { tree } = opts;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    if (target.getAttribute("role") !== "treeitem") return;
    const item = tree.getFocusedItem();
    if (!item) return;
    if (e.key === "F2" || e.key === "Delete") {
      if (opts.onRowKey?.(item, e.key)) e.preventDefault();
      return;
    }
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      if (opts.onMenuKey) {
        e.preventDefault();
        opts.onMenuKey(item);
      }
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!item.isFolder()) opts.onOpen(item);
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
      if (ids.length > 0) opts.expandMany(ids);
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
  };
}
