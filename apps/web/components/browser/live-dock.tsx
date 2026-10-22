"use client";

import { ChevronDown, Maximize2, X } from "lucide-react";
import { type PointerEvent, useCallback, useEffect, useRef } from "react";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { LiveActivityLine } from "./live-activity-line";
import { LiveFrame } from "./live-frame";
import { IconButton, StateChip, Where } from "./live-header";
import {
  activityWordsOf,
  canExpand,
  type LiveDockState,
  type LiveView,
  uiStateOf,
  useLiveStore,
} from "./live-store";
import { useOptionalLiveView } from "./live-view-provider";

/**
 * The phone live view's dock (07.8-26; D-06, UI-SPEC §1.5, Accessibility "Small window / dock"): a non-modal bottom
 * region over the chat, so the conversation and its composer stay usable. Peek (default) shows the header, the frame
 * and the activity line; mini is one row (host, activity, state). The handle swipes up to the full sheet, down to mini,
 * and a tap toggles peek and mini; the state persists (`ocw:live-dock`). The shell's `<main>` gets the dock's height as
 * bottom padding (`--live-dock-h`), so the composer sits above it. It is a region, never a dialog, and F6 reaches it.
 */

/** A swipe on the handle further than this (CSS px) expands or shrinks the dock. */
const HANDLE_SWIPE_PX = 24;

export function LiveDock({ view }: { view: LiveView }) {
  const live = useOptionalLiveView();
  const dock = useLiveStore((s) => s.dock);
  const setDock = useLiveStore((s) => s.setDock);
  const state = uiStateOf(view);
  const region = useRef<HTMLElement | null>(null);
  const outside = useRef<HTMLElement | null>(null);

  const setRegion = useCallback(
    (el: HTMLElement | null) => {
      region.current = el;
      if (live) live.windowRef.current = el;
    },
    [live],
  );

  // The chat keeps its composer above the dock: `<main>` is padded by the dock's height while it shows.
  useEffect(() => {
    const el = region.current;
    if (!el) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty("--live-dock-h", `${el.offsetHeight}px`);
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty("--live-dock-h");
    };
  }, []);

  // F6: between the page and the dock (it never takes focus on its own).
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

  // The handle: swipe up → full sheet, swipe down → mini, tap → peek ↔ mini.
  const swipe = useRef<{ id: number; y: number } | null>(null);
  const swiped = useRef(false);
  const onHandleDown = (e: PointerEvent<HTMLButtonElement>) => {
    swipe.current = { id: e.pointerId, y: e.clientY };
    swiped.current = false;
    // The release lands on the handle even when the finger (or a mouse) left it.
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onHandleUp = (e: PointerEvent<HTMLButtonElement>) => {
    const from = swipe.current;
    swipe.current = null;
    if (!from || from.id !== e.pointerId) return;
    const dy = e.clientY - from.y;
    if (dy < -HANDLE_SWIPE_PX) {
      swiped.current = true;
      if (canExpand(state)) live?.expand();
    } else if (dy > HANDLE_SWIPE_PX) {
      swiped.current = true;
      setDock("mini");
    }
  };
  const onHandleClick = () => {
    if (swiped.current) {
      swiped.current = false;
      return;
    }
    setDock(dock === "peek" ? "mini" : "peek");
  };

  return (
    <section
      ref={setRegion}
      tabIndex={-1}
      aria-label={`Live view of ${view.bot.name}'s browser`}
      data-testid="live-dock"
      data-dock={dock}
      className="fixed inset-x-0 bottom-0 z-45 rounded-t-2xl border-t bg-background pb-[max(env(safe-area-inset-bottom),8px)] shadow-2xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 dark:shadow-black/40"
    >
      <div data-testid="live-view" data-state={state} data-context={view.contextId}>
        <div className="relative h-5">
          {/* A 44 px target centred on the 20 px handle area (it reaches past the dock's top edge, never a control). */}
          <button
            type="button"
            data-testid="live-dock-handle"
            aria-label="Resize live view"
            onPointerDown={onHandleDown}
            onPointerUp={onHandleUp}
            onPointerCancel={() => {
              swipe.current = null;
            }}
            onClick={onHandleClick}
            className="absolute -top-3 left-1/2 flex h-11 w-24 -translate-x-1/2 touch-none items-center justify-center rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          >
            <span aria-hidden className="h-1 w-9 rounded-full bg-muted-foreground/30" />
          </button>
        </div>
        {dock === "mini" ? <MiniRow view={view} onShow={() => setDock("peek")} /> : <Peek view={view} />}
      </div>
    </section>
  );
}

function Peek({ view }: { view: LiveView }) {
  const live = useOptionalLiveView();
  const state = uiStateOf(view);
  return (
    <>
      <div data-testid="live-header" className="flex h-12 items-center gap-1.5 pr-1 pl-4">
        <PrincipalAvatar
          kind="agent"
          name={view.bot.name}
          avatarUrl={view.bot.avatarUrl}
          seed={view.bot.id}
          className="size-5 rounded-md text-[11px]"
        />
        <Where view={view} />
        <StateChip state={state} />
        <div className="flex shrink-0 items-center">
          {canExpand(state) ? (
            <IconButton label="Expand" icon={Maximize2} testId="live-expand" onClick={() => live?.expand()} />
          ) : null}
          <IconButton label="Close" icon={X} testId="live-close" onClick={() => live?.close()} />
        </div>
      </div>
      <div className="mx-4 overflow-hidden rounded-lg border">
        <LiveFrame view={view} state={state} large={false} phone />
      </div>
      <LiveActivityLine view={view} state={state} className="h-10 px-4" />
    </>
  );
}

export function MiniRow({ view, onShow }: { view: LiveView; onShow: () => void }) {
  const live = useOptionalLiveView();
  const state = uiStateOf(view);
  const words = activityWordsOf(view, state);
  const host = view.server?.host ?? view.bot.name;
  return (
    <div data-testid="live-header" className="flex h-14 items-center gap-2 pr-1 pl-3">
      <PrincipalAvatar
        kind="agent"
        name={view.bot.name}
        avatarUrl={view.bot.avatarUrl}
        seed={view.bot.id}
        className="size-5 shrink-0 rounded-md text-[11px]"
      />
      <div className="grid min-w-0 flex-1">
        <span data-testid="live-host" className="truncate font-mono font-semibold text-sm">
          {host}
        </span>
        <span data-testid="live-activity" className="truncate text-muted-foreground text-xs">
          {words?.text ?? ""}
        </span>
      </div>
      <StateChip state={state} />
      <div className="flex shrink-0 items-center">
        <IconButton
          label="Show live view"
          icon={ChevronDown}
          iconClassName="rotate-180"
          testId="live-dock-show"
          onClick={onShow}
        />
        <IconButton label="Close" icon={X} testId="live-close" onClick={() => live?.close()} />
      </div>
    </div>
  );
}

export type { LiveDockState };
