"use client";

import { type RefObject, useEffect } from "react";

/** Added to the bottom offset of the app's toasts (components/ui/sonner.tsx). */
export const TOAST_CLEARANCE_VAR = "--toast-clearance";

/**
 * Keeps bottom-anchored toasts clear of `ref`, an element pinned to the bottom of the viewport (the Work Zone
 * session's dock: approval banner, agent bar, composer): while mounted, `--toast-clearance` on <html> is the
 * distance from the viewport's bottom edge to the element's top edge, kept current as it grows (an approval, a
 * longer prompt, a hint line) or the window resizes.
 */
export function useToastClearance(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const update = () => {
      const clearance = Math.max(0, Math.round(window.innerHeight - el.getBoundingClientRect().top));
      root.style.setProperty(TOAST_CLEARANCE_VAR, `${clearance}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      root.style.removeProperty(TOAST_CLEARANCE_VAR);
    };
  }, [ref]);
}
