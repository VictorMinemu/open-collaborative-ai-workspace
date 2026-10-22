"use client";

import { type KeyboardEvent, type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { useShellPrefs } from "@/components/shell/shell-context";
import { cn } from "@/lib/utils";
import { LiveActivityLine } from "./live-activity-line";
import { LiveFrame } from "./live-frame";
import { SmallHeader } from "./live-header";
import {
  cornerAfterKey,
  cornerPosition,
  cornerWords,
  type LiveView,
  nearestCorner,
  uiStateOf,
  useLiveStore,
  type Viewport,
} from "./live-store";
import { useOptionalLiveView } from "./live-view-provider";

/**
 * The desktop small window (07.8-22; UI-SPEC §1.1, Interaction "open, move, close", Focus management): 320 × 272,
 * floating above the workspace (`z-45`: below dialogs, sheets and toasts), bottom-right by default (16 from the right, 96
 * from the bottom, clear of the composer). The header drags it; on release it snaps to the nearest corner, which
 * persists. The grip is the keyboard handle: arrow keys move to the adjacent corner. It is a region, not a dialog: it
 * never steals focus; F6 moves focus between the page and the window.
 */

function railWidth(): number {
  const rail = document.querySelector<HTMLElement>('aside[aria-label="Workspace navigation"]');
  return rail ? rail.getBoundingClientRect().width : 0;
}

function useViewport(): Viewport | null {
  const collapsed = useShellPrefs((s) => s.railCollapsed);
  const [vp, setVp] = useState<Viewport | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a rail toggle changes the left inset (measured again)
  useEffect(() => {
    const measure = () => setVp({ width: window.innerWidth, height: window.innerHeight, rail: railWidth() });
    measure();
    // The rail animates its width (200 ms) after a toggle: measure again once it settled.
    const settle = setTimeout(measure, 250);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(settle);
      window.removeEventListener("resize", measure);
    };
  }, [collapsed]);
  return vp;
}

export function LiveWindow({ view }: { view: LiveView }) {
  const live = useOptionalLiveView();
  const corner = useLiveStore((s) => s.corner);
  const setCorner = useLiveStore((s) => s.setCorner);
  const vp = useViewport();
  const state = uiStateOf(view);
  const [drag, setDrag] = useState<{ left: number; top: number } | null>(null);
  const grab = useRef<{ dx: number; dy: number; id: number } | null>(null);
  const region = useRef<HTMLElement | null>(null);
  const outside = useRef<HTMLElement | null>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);

  // The bottom corners keep their 96 px inset whatever the window's real height (borders, coarse-pointer controls).
  useEffect(() => {
    const el = region.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setHeight(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const setRegion = useCallback(
    (el: HTMLElement | null) => {
      region.current = el;
      if (live) live.windowRef.current = el;
    },
    [live],
  );

  // F6: between the page and the live view (the window never takes focus on its own).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "F6" || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const el = region.current;
      if (!el) return;
      e.preventDefault();
      const active = document.activeElement as HTMLElement | null;
      if (active && el.contains(active)) {
        const back = outside.current;
        if (back?.isConnected) back.focus();
        else (document.querySelector<HTMLElement>("main") ?? document.body).focus();
        return;
      }
      outside.current = active && active !== document.body ? active : null;
      el.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onDragStart = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !vp) return;
    const target = e.target as Element;
    if (target.closest("button:not([data-testid='live-move']), a")) return;
    const box = region.current?.getBoundingClientRect();
    if (!box) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    grab.current = { dx: e.clientX - box.left, dy: e.clientY - box.top, id: e.pointerId };
    setDrag({ left: box.left, top: box.top });
    const el = e.currentTarget;
    const move = (ev: globalThis.PointerEvent) => {
      const g = grab.current;
      if (!g || ev.pointerId !== g.id) return;
      setDrag({ left: ev.clientX - g.dx, top: ev.clientY - g.dy });
    };
    const up = (ev: globalThis.PointerEvent) => {
      const g = grab.current;
      if (!g || ev.pointerId !== g.id) return;
      grab.current = null;
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      const next = nearestCorner(ev.clientX - g.dx, ev.clientY - g.dy, {
        width: window.innerWidth,
        height: window.innerHeight,
        rail: railWidth(),
      });
      setCorner(next);
      setDrag(null);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onMoveKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const next = cornerAfterKey(corner, e.key);
    if (!e.key.startsWith("Arrow")) return;
    e.preventDefault();
    if (!next) return;
    setCorner(next);
    live?.announce(`Moved to ${cornerWords(next)}`);
  };

  const pos = drag ?? (vp ? cornerPosition(corner, vp, height) : null);

  return (
    <section
      ref={setRegion}
      tabIndex={-1}
      aria-label={`Live view of ${view.bot.name}'s browser`}
      data-testid="live-window"
      data-corner={corner}
      style={pos ? { left: pos.left, top: pos.top } : { right: 16, bottom: 96 }}
      className={cn(
        "fixed z-45 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border bg-card shadow-2xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 dark:shadow-black/40",
        !drag && "transition-[left,top] duration-200 ease-out motion-reduce:transition-none",
      )}
    >
      <div data-testid="live-view" data-state={state} data-context={view.contextId}>
        <SmallHeader view={view} state={state} onDragStart={onDragStart} onMoveKey={onMoveKey} />
        <LiveFrame view={view} state={state} large={false} />
        <LiveActivityLine view={view} state={state} className="h-8 border-t px-3 pointer-coarse:h-10" />
      </div>
    </section>
  );
}
