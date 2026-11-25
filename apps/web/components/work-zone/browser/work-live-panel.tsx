"use client";

import { type BrowserEndReason, WORK_BROWSER_LIMITS, type WorkSession } from "@ocw/contracts";
import { type RefObject, useEffect, useRef } from "react";
import { HostChip } from "@/components/browser/host-chip";
import { FramePlaceholder, type Placeholder, placeholderOf } from "@/components/browser/live-frame";
import { StateChip } from "@/components/browser/live-header";
import { activityWordsOf, type LiveUiState, type LiveView } from "@/components/browser/live-store";
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

/** The Work Zone's ended sentences: the bots' reasons, never naming a bot (UI-SPEC "Ended reasons"). */
export function workEndedSentence(reason: BrowserEndReason | undefined): string {
  switch (reason) {
    case "idle":
      return `The browser closed after ${WORK_BROWSER_LIMITS.idleMinutes} minutes without use.`;
    case "closed_by_bot":
      return "The agent closed the browser.";
    case "kill_switch":
      return "An admin turned the browser off.";
    case "module_off":
      return "The browser was turned off for you.";
    case "takeover_abandoned":
      return "Control ended without a hand back, so the browser closed. The agent can open it again.";
    default:
      return "The browser stopped unexpectedly. The agent can open it again.";
  }
}

/** What the frame area shows instead of the page, in the Work Zone's words, or null when it shows the page. */
export function workPlaceholderOf(
  v: Pick<LiveView, "server" | "bot">,
  state: LiveUiState,
): Placeholder | null {
  switch (state) {
    case "connecting":
      return { icon: "connecting", title: "Connecting…", body: null, strong: false };
    case "idle":
      return {
        icon: "ended",
        title: "Nothing to show yet: the agent has not opened a page",
        body: null,
        strong: false,
      };
    case "private":
      if (v.server?.privateReason === "member_session") {
        // D-27: a member's signed-in page is theirs alone; the others learn who, not where.
        const member = v.server.memberName ?? "a member";
        return {
          icon: "private",
          title: `Private browsing for ${member}`,
          body: `Only ${member} can watch while the agent uses their sign-in.`,
          strong: true,
        };
      }
      // D-20: a takeover's words are the bots' ("Private sign-in in progress", who signs in).
      return placeholderOf(v, state);
    case "ended":
      return { icon: "ended", title: workEndedSentence(v.server?.endReason), body: null, strong: false };
    case "no_permission":
      return {
        icon: "no_permission",
        title: "You can't watch this browser",
        body: "Only people who can see this session can watch its browser.",
        strong: true,
      };
    case "error":
      return placeholderOf(v, state);
    default:
      return null;
  }
}

/** The line under the frame (UI-SPEC §1.4 "Activity line"), or null when the placeholder says it all. */
export function workActivityOf(
  v: Pick<LiveView, "server" | "bot" | "viewerCan">,
  state: LiveUiState,
  deviceName: string,
): string | null {
  switch (state) {
    case "live":
      return v.server?.activity
        ? `${v.bot.name} is ${v.server.activity}`
        : `${v.bot.name}'s browser on ${deviceName}`;
    case "reconnecting":
    case "paused":
    case "controlling":
      return activityWordsOf(v, state)?.text ?? null;
    default:
      return null;
  }
}

export function WorkLivePanel({
  session,
}: {
  session: Pick<WorkSession, "id" | "runtime" | "deviceName" | "browser">;
}) {
  const agent = RUNTIMES[session.runtime].label;
  const { view, frames, retry } = useWorkLive(session.id, agent);
  // The page ended and the agent opened a new one (the session stream says so): watch the new page.
  // Only on the flag's false → true after the end, so a stale `live` never loops reconnects.
  const ended = view.server?.state === "ended" && view.server.endReason !== "access_lost";
  const pageOpen = session.browser?.live === true;
  const sawClosed = useRef(false);
  useEffect(() => {
    if (!ended) {
      sawClosed.current = false;
      return;
    }
    if (!pageOpen) sawClosed.current = true;
    else if (sawClosed.current) {
      sawClosed.current = false;
      retry();
    }
  }, [ended, pageOpen, retry]);
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
  const activity = workActivityOf(view, state, deviceName);
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
      {activity ? (
        // The state chip is the polite region; this line changes with every action, so it is not announced.
        <p data-testid="work-live-activity" className="min-w-0 truncate text-muted-foreground text-xs">
          {activity}
        </p>
      ) : null}
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
  const placeholder = framed ? null : workPlaceholderOf(view, state);
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
