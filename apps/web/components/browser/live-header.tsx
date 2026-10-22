"use client";

import {
  CircleAlert,
  GripHorizontal,
  LockKeyhole,
  type LucideIcon,
  Maximize2,
  Minimize2,
  MousePointerClick,
  Undo2,
  X,
} from "lucide-react";
import type { KeyboardEvent, PointerEvent, Ref } from "react";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { HostChip } from "./host-chip";
import { CHIP, canExpand, canTake, type LiveUiState, type LiveView, watchOnlyLine } from "./live-store";
import { useOptionalLiveView } from "./live-view-provider";

/**
 * The live view's header (07.8-22; UI-SPEC §1.1 small window, §1.2–1.3 large view): the bot, the page's host (from the
 * server's browser context, never from bot text), the state chip with its word, and the controls the state allows
 * (UI-SPEC §1.4 Controls). Icon buttons are named exactly as their tooltips.
 */

export const DOT: Partial<Record<LiveUiState, string>> = {
  live: "bg-emerald-500 dark:bg-emerald-400",
  paused: "bg-amber-500 dark:bg-amber-400",
  controlling: "bg-amber-500 dark:bg-amber-400",
  idle: "bg-muted-foreground",
  ended: "bg-muted-foreground",
};

export const TONE: Record<LiveUiState, string> = {
  connecting: "bg-muted text-muted-foreground",
  reconnecting: "bg-muted text-muted-foreground",
  live: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
  idle: "bg-muted text-muted-foreground",
  paused: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
  controlling: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
  private: "bg-muted text-muted-foreground",
  ended: "bg-muted text-muted-foreground",
  error: "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300",
  no_permission: "bg-red-100 text-red-800 dark:bg-red-400/15 dark:text-red-300",
};

/** The state chip: a word next to its colour, always (`role="status"`: state changes are announced). */
export function StateChip({ state }: { state: LiveUiState }) {
  const dot = DOT[state];
  return (
    <span
      data-testid="live-state"
      data-state={state}
      role="status"
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 font-semibold text-xs leading-none",
        TONE[state],
      )}
    >
      {state === "connecting" || state === "reconnecting" ? (
        <Spinner className="size-3" />
      ) : state === "private" ? (
        <LockKeyhole aria-hidden className="size-3" />
      ) : state === "error" ? (
        <CircleAlert aria-hidden className="size-3 text-red-700 dark:text-red-300" />
      ) : dot ? (
        <span aria-hidden className={cn("size-1.5 rounded-full", dot)} />
      ) : null}
      {CHIP[state]}
    </span>
  );
}

function IconButton({
  label,
  icon: Icon,
  testId,
  onClick,
  buttonRef,
}: {
  label: string;
  icon: LucideIcon;
  testId: string;
  onClick: () => void;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <Tooltip content={label}>
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        data-testid={testId}
        onClick={onClick}
        className="text-muted-foreground hover:text-foreground pointer-coarse:size-11 max-md:size-11"
      >
        <Icon aria-hidden className="size-4" />
      </Button>
    </Tooltip>
  );
}

function Where({ view }: { view: LiveView }) {
  const host = view.server?.host;
  return host ? (
    <HostChip
      host={host}
      secure={view.server?.secure ?? null}
      testId="live-host"
      className="min-w-0 flex-1 text-foreground"
    />
  ) : (
    <span data-testid="live-host" className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
      {view.bot.name}
    </span>
  );
}

/** The small window's header: also the drag handle (pointer anywhere outside its buttons). */
export function SmallHeader({
  view,
  state,
  onDragStart,
  onMoveKey,
}: {
  view: LiveView;
  state: LiveUiState;
  onDragStart: (e: PointerEvent<HTMLDivElement>) => void;
  onMoveKey: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const live = useOptionalLiveView();
  return (
    <div
      data-testid="live-header"
      onPointerDown={onDragStart}
      className="flex h-10 cursor-grab touch-none select-none items-center gap-1.5 border-b px-2 active:cursor-grabbing pointer-coarse:h-12 max-md:h-12"
    >
      <Tooltip content="Move live view">
        <button
          type="button"
          data-testid="live-move"
          aria-label="Move live view"
          onKeyDown={onMoveKey}
          className="inline-flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 pointer-coarse:size-11 max-md:size-11"
        >
          <GripHorizontal aria-hidden className="size-3.5" />
        </button>
      </Tooltip>
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
        {canTake(view, state) ? (
          <IconButton
            label="Take control"
            icon={MousePointerClick}
            testId="live-take-control"
            onClick={() => live?.take()}
          />
        ) : null}
        {canExpand(state) ? (
          <IconButton label="Expand" icon={Maximize2} testId="live-expand" onClick={() => live?.expand()} />
        ) : null}
        <IconButton label="Close" icon={X} testId="live-close" onClick={() => live?.close()} />
      </div>
    </div>
  );
}

/** The large view's header (h-14): who, where, the state, the watch-only line and the primary action. */
export function LargeHeader({
  view,
  state,
  titleId,
  primaryRef,
}: {
  view: LiveView;
  state: LiveUiState;
  titleId: string;
  primaryRef: Ref<HTMLButtonElement>;
}) {
  const live = useOptionalLiveView();
  const controlling = state === "controlling";
  const watchOnly = watchOnlyLine(view, state);
  const take = canTake(view, state);
  return (
    <div
      data-testid="live-header"
      className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 sm:flex-nowrap sm:py-0"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <PrincipalAvatar
          kind="agent"
          name={view.bot.name}
          avatarUrl={view.bot.avatarUrl}
          seed={view.bot.id}
          className="size-6 rounded-md text-xs"
        />
        <h2 id={titleId} className="shrink-0 font-semibold text-sm">
          {view.bot.name}
          <span className="sr-only">'s browser</span>
        </h2>
        <Where view={view} />
        <StateChip state={state} />
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {watchOnly ? (
          <p data-testid="live-watch-only" className="hidden text-muted-foreground text-xs lg:block">
            {watchOnly}
          </p>
        ) : null}
        {controlling ? (
          <Button
            ref={primaryRef}
            data-testid="live-hand-back"
            onClick={() => live?.release()}
            disabled={view.pending === "release"}
            className="pointer-coarse:h-11 max-md:h-11"
          >
            {view.pending === "release" ? <Spinner /> : <Undo2 aria-hidden />}
            {view.pending === "release" ? "Handing back…" : "Hand back"}
          </Button>
        ) : take || view.pending === "take" ? (
          <Button
            ref={primaryRef}
            data-testid="live-take-control"
            onClick={() => live?.take()}
            disabled={view.pending === "take"}
            className="pointer-coarse:h-11 max-md:h-11"
          >
            {view.pending === "take" ? <Spinner /> : <MousePointerClick aria-hidden />}
            {view.pending === "take" ? "Taking control…" : "Take control"}
          </Button>
        ) : null}
        {controlling ? null : (
          <IconButton
            label="Back to small window"
            icon={Minimize2}
            testId="live-minimize"
            onClick={() => live?.minimize()}
          />
        )}
        <IconButton label="Close" icon={X} testId="live-close" onClick={() => live?.close()} />
      </div>
      {watchOnly ? (
        // Below 1024 the line wraps under the header instead (one of the two is displayed at any width).
        <p className="basis-full text-muted-foreground text-xs lg:hidden">{watchOnly}</p>
      ) : null}
    </div>
  );
}
