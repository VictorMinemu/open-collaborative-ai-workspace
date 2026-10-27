"use client";

import { type KeyboardEvent, type RefObject, useCallback, useEffect } from "react";

/**
 * Arrow keys in the Work Zone sidebar (Phase 07.10-04, UI-SPEC § Keyboard, Accessibility Contract): a small handler on
 * the `<nav>` that moves focus between the row-level targets in DOM order (section toggles, project and session links,
 * "more" rows, the foot links), skipping the "+" buttons and the repository rows. No roving tabindex: Tab keeps its
 * native order. ←/→ collapse and expand a section on its toggle (Enter and Space toggle natively); ArrowDown in the
 * search field enters the rows or the results, Escape clears the query and keeps focus in the field. When the focused
 * row disappears on a live update (its approval decided, its session settled), focus moves to the next row of the same
 * section, else to that section's toggle; never to the top.
 */

/** Row-level targets: links and the buttons that expand something (toggles, inline "more"); never a "+" or a retry. */
const TARGETS = "a[href], button[aria-expanded]";

/** A section's toggle carries the `wz-section-{key}` id (`SidebarSectionHeader`). */
const isToggle = (el: Element) => el.id.startsWith("wz-section-");

function visible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && !el.closest('[aria-hidden="true"], [inert]');
}

function targetsIn(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TARGETS)].filter(visible);
}

/** The index to focus after `key` from `index` among `count` rows; -1 = the search field; null = not ours. */
export function moveFocus(count: number, index: number, key: string): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return Math.min(index + 1, count - 1);
    case "ArrowUp":
      return index - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Whether ←/→ on a section toggle should click it: ← collapses an expanded section, → expands a collapsed one. */
export function toggleKey(key: string, expanded: boolean): boolean {
  return (key === "ArrowLeft" && expanded) || (key === "ArrowRight" && !expanded);
}

/** Where focus goes when the focused row left the DOM: the row now at its place, else the toggle, else the sidebar. */
export function nextAfterRemoval(at: {
  sectionRows: number;
  index: number;
  hasToggle: boolean;
}): { kind: "row"; index: number } | { kind: "toggle" } | { kind: "global" } {
  if (at.index >= 0 && at.index < at.sectionRows) return { kind: "row", index: at.index };
  return at.hasToggle ? { kind: "toggle" } : { kind: "global" };
}

/** The rows of a section other than its toggle. */
const rowsOf = (section: Element) => targetsIn(section).filter((el) => !isToggle(el));

export function useSidebarKeys(
  navRef: RefObject<HTMLElement | null>,
  searchRef: RefObject<HTMLInputElement | null>,
  onClearSearch: () => void,
): (e: KeyboardEvent<HTMLElement>) => void {
  // Focus survival: remember where the focused row was; when it leaves the DOM with focus, put focus back nearby.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    let last: {
      el: HTMLElement;
      section: Element | null;
      index: number;
      toggle: HTMLElement | null;
      global: number;
    } | null = null;
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as HTMLElement;
      const all = targetsIn(nav);
      if (!all.includes(el) || isToggle(el)) {
        last = null;
        return;
      }
      const section = el.closest("section");
      last = {
        el,
        section,
        index: section ? rowsOf(section).indexOf(el) : -1,
        toggle: section?.querySelector<HTMLElement>('[id^="wz-section-"]') ?? null,
        global: all.indexOf(el),
      };
    };
    const observer = new MutationObserver(() => {
      if (!last || last.el.isConnected) return;
      const active = document.activeElement;
      // Focus already went somewhere on purpose: leave it there.
      if (active && active !== document.body) {
        last = null;
        return;
      }
      const { section, index, toggle, global } = last;
      const alive = section?.isConnected === true;
      const rows = alive && section ? rowsOf(section) : [];
      const where = nextAfterRemoval({
        sectionRows: rows.length,
        index,
        hasToggle: alive && !!toggle?.isConnected,
      });
      let next: HTMLElement | undefined;
      if (where.kind === "row") next = rows[where.index];
      else if (where.kind === "toggle") next = toggle ?? undefined;
      else {
        const all = targetsIn(nav);
        next = all[Math.min(global, all.length - 1)];
      }
      last = null;
      next?.focus();
    });
    nav.addEventListener("focusin", onFocusIn);
    observer.observe(nav, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      nav.removeEventListener("focusin", onFocusIn);
    };
  }, [navRef]);

  return useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const nav = navRef.current;
      if (!nav || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const target = e.target as HTMLElement;
      if (target === searchRef.current) {
        if (e.key === "ArrowDown") {
          const first = targetsIn(nav)[0];
          if (first) {
            e.preventDefault();
            first.focus();
          }
        } else if (e.key === "Escape" && searchRef.current?.value) {
          // Clear the query, keep focus in the field (and keep the drawer open on a phone).
          e.preventDefault();
          e.stopPropagation();
          onClearSearch();
        }
        return;
      }
      const all = targetsIn(nav);
      const index = all.indexOf(target);
      if (index < 0) return;
      if (isToggle(target) && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        if (toggleKey(e.key, target.getAttribute("aria-expanded") === "true")) target.click();
        return;
      }
      const to = moveFocus(all.length, index, e.key);
      if (to === null) return;
      e.preventDefault();
      if (to < 0) searchRef.current?.focus();
      else all[to]?.focus();
    },
    [navRef, searchRef, onClearSearch],
  );
}
