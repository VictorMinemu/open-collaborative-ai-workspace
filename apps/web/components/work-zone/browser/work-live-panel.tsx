"use client";

import type { WorkSession } from "@ocw/contracts";
import { type RefObject, useEffect, useRef } from "react";
import { HostChip } from "@/components/browser/host-chip";
import { FramePlaceholder, placeholderOf } from "@/components/browser/live-frame";
import { StateChip } from "@/components/browser/live-header";
import type { LiveUiState, LiveView } from "@/components/browser/live-store";
import { Spinner } from "@/components/ui/spinner";
import { type FrameBus, useWorkLive, workShowsFrames, workUiStateOf } from "@/lib/use-work-live";
import { cn } from "@/lib/utils";
import { RUNTIMES } from "../meta";

/**
 * The session's browser, live (07.13-16; D-15, D-20, D-27, PD-13; 07.8 UI-SPEC Surface 1 live view): the Browser tab of
 * the session view, beside Queue and Changes. The session's audience watches the page its agent drives on the device.
 *
 * It reuses the bots' live pieces that read only their props (the state chip, the host chip, the frame placeholder and
 * its words) and never the bots' frame element, header or sheet: those read the app shell's one live-view context,
 * which belongs to a bot's browser, so mounting them here would draw that bot's frames. The frame element is this
 * file's small `WorkLiveFrame`, fed by the panel's own socket (`useWorkLive`).
 */

export function WorkLivePanel({ session }: { session: Pick<WorkSession, "id" | "runtime" | "deviceName"> }) {
  const agent = RUNTIMES[session.runtime].label;
  const { view, frames, retry } = useWorkLive(session.id, agent);
  return <WorkLiveBody view={view} frames={frames} onRetry={retry} deviceName={session.deviceName} />;
}

/** The panel's markup for one view (static-renderable: the tests render every state with it). */
export function WorkLiveBody({
  view,
  frames,
  onRetry,
  deviceName,
}: {
  view: LiveView;
  frames: FrameBus | null;
  onRetry?: () => void;
  deviceName: string;
}) {
  const state = workUiStateOf(view);
  const host = view.server?.host ?? null;
  return (
    <section
      data-testid="work-live-panel"
      data-state={state}
      aria-label="Session browser"
      className="grid gap-2"
    >
      <div className="flex min-w-0 items-center gap-2">
        {host ? (
          <HostChip
            host={host}
            secure={view.server?.secure ?? null}
            testId="work-live-host"
            className="min-w-0 flex-1 text-foreground"
          />
        ) : (
          <span
            data-testid="work-live-host"
            className="min-w-0 flex-1 truncate text-muted-foreground text-xs"
          >
            {deviceName}
          </span>
        )}
        <StateChip state={state} />
      </div>
      <WorkLiveFrame view={view} state={state} frames={frames} onRetry={onRetry} />
    </section>
  );
}

/** Draws the bus's frames into `img`: latest wins, the previous blob URL revoked once the next one is drawn. */
function useFrames(img: RefObject<HTMLImageElement | null>, frames: FrameBus | null, active: boolean) {
  useEffect(() => {
    const el = img.current;
    if (!active || !frames || !el) return;
    let shown: string | null = null;
    let loading: string | null = null;
    const settled = () => {
      if (!loading || el.src !== loading) return;
      if (shown) URL.revokeObjectURL(shown);
      shown = loading;
      loading = null;
    };
    const show = (jpeg: Blob) => {
      const url = URL.createObjectURL(jpeg);
      // A frame that never got drawn is dropped (latest wins), so no backlog of URLs builds up.
      if (loading) URL.revokeObjectURL(loading);
      loading = url;
      el.src = url;
    };
    el.addEventListener("load", settled);
    el.addEventListener("error", settled);
    if (frames.latest) show(frames.latest);
    frames.listeners.add(show);
    return () => {
      frames.listeners.delete(show);
      el.removeEventListener("load", settled);
      el.removeEventListener("error", settled);
      if (loading) URL.revokeObjectURL(loading);
      if (shown) URL.revokeObjectURL(shown);
      el.removeAttribute("src");
    };
  }, [img, frames, active]);
}

function WorkLiveFrame({
  view,
  state,
  frames,
  onRetry,
}: {
  view: LiveView;
  state: LiveUiState;
  frames: FrameBus | null;
  onRetry?: () => void;
}) {
  const img = useRef<HTMLImageElement | null>(null);
  const framed = workShowsFrames(state);
  const placeholder = framed ? null : placeholderOf(view, state);
  const host = view.server?.host ?? null;
  useFrames(img, frames, framed);
  return (
    <figure
      data-testid="work-live-frame"
      aria-label="Live view of the session's browser"
      className="relative m-0 aspect-[8/5] w-full overflow-hidden rounded-md border bg-muted dark:bg-black/40"
    >
      {framed ? (
        // biome-ignore lint/performance/noImgElement: frames are blob URLs drawn imperatively (no Next image)
        <img
          ref={img}
          alt={`${view.bot.name}'s browser on ${host ?? "a page"}`}
          draggable={false}
          className={cn(
            "pointer-events-none absolute inset-0 size-full select-none object-contain",
            !view.hasFrame && "invisible",
            state === "reconnecting" && "opacity-60",
          )}
        />
      ) : null}
      {framed && !view.hasFrame ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      ) : null}
      {placeholder ? <FramePlaceholder placeholder={placeholder} large={false} onRetry={onRetry} /> : null}
    </figure>
  );
}
