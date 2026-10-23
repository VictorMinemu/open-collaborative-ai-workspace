"use client";

import {
  BROWSER_LIMITS,
  type BrowserContextState,
  type BrowserEndReason,
  type LiveStateFrame,
} from "@ocw/contracts";
import { create } from "zustand";

/**
 * The one live view of a bot's browser (07.8-22; D-06, D-07, UI-SPEC §1.1–1.4, Interaction "Live view: open, move,
 * close"). One context at a time; the state the server decided (`viewerCan`, `state`, `lease`, `focus`) and the
 * connection's own state live here. Frames never do: they go straight from the socket to the frame image (no React
 * render per frame, no copy kept beyond the latest), and nothing typed ever passes through this store (P-10).
 */

export interface LiveBot {
  id: string;
  name: string;
  avatarUrl?: string | null;
}

export type LiveCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type LiveConnection = "connecting" | "open" | "reconnecting" | "error" | "closed";
/** What the person sees: the server's state, or the connection's own (`error` is client-side only). */
export type LiveUiState = BrowserContextState | "error";

export interface LiveTarget {
  contextId: string;
  bot: LiveBot;
}

/** 07.8-26: the sign-in card a view was opened from ("Open and sign in", "Return to sign-in"). */
export interface LiveSignIn {
  messageId: string;
  host: string;
}

/** 07.8-26 (UI-SPEC §1.5): the phone dock's height, persisted (`ocw:live-dock`). */
export type LiveDockState = "peek" | "mini";

export interface LiveView extends LiveTarget {
  /** Large view (desktop dialog) instead of the small window. */
  expanded: boolean;
  /** Take control as soon as the server allows it (Take control from the small window, or an opener that asked). */
  wantControl: boolean;
  pending: null | "take" | "release";
  /** Close once the hand back is confirmed (Close while in control). */
  closeAfterRelease: boolean;
  conn: LiveConnection;
  server: LiveStateFrame | null;
  viewerCan: { watch: boolean; control: boolean } | null;
  /** Client-side deadline of the takeover lease (ms, this tab's clock), from the server's `lease` frames. */
  leaseDeadline: number | null;
  /** The focused field is password-like (the masking hint; never the value). */
  sensitive: boolean;
  /** At least one frame arrived since the view last showed a placeholder. */
  hasFrame: boolean;
  /** Bumped by Try again: the provider reconnects. */
  attempt: number;
  /** 07.8-26: opened from a sign-in card (the refusal words and the "Signed in to {host}" toast follow it). */
  signIn: LiveSignIn | null;
  /** 07.8-26: a take refused for a view its opener just opened closes it again (the card stays as it was). */
  closeOnRefuse: boolean;
  /** 07.8-26 (R10): the phone sheet's frame area while in control (CSS px), the phone viewport the page gets. */
  phoneArea: { width: number; height: number } | null;
}

export const CORNER_KEY = "ocw:live-corner";
export const DOCK_KEY = "ocw:live-dock";
const CORNERS: LiveCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

function savedDock(): LiveDockState {
  if (typeof window === "undefined") return "peek";
  try {
    return window.localStorage.getItem(DOCK_KEY) === "mini" ? "mini" : "peek";
  } catch {
    return "peek";
  }
}

function savedCorner(): LiveCorner {
  if (typeof window === "undefined") return "bottom-right";
  try {
    const v = window.localStorage.getItem(CORNER_KEY);
    return CORNERS.includes(v as LiveCorner) ? (v as LiveCorner) : "bottom-right";
  } catch {
    return "bottom-right";
  }
}

interface LiveStore {
  view: LiveView | null;
  corner: LiveCorner;
  /** 07.8-26: the phone dock's height (peek or mini). */
  dock: LiveDockState;
  /**
   * 07.8-26: a hand back from a sign-in card's view, waiting for the card to say "Signed in" (then the toast reads
   * "Signed in to {host}. {bot} continues."; after a few seconds without it, "{bot} continues."). Outside the view, so a
   * Close while in control still gets its toast.
   */
  signInHandBack: { messageId: string; host: string; bot: string; at: number } | null;
  open(
    target: LiveTarget & {
      takeControl?: boolean;
      expanded?: boolean;
      signIn?: { messageId: string; host: string } | null;
    },
  ): void;
  close(): void;
  patch(contextId: string, p: Partial<LiveView>): void;
  setCorner(corner: LiveCorner): void;
  setDock(dock: LiveDockState): void;
  setSignInHandBack(v: LiveStore["signInHandBack"]): void;
}

export const useLiveStore = create<LiveStore>()((set, get) => ({
  view: null,
  corner: savedCorner(),
  dock: savedDock(),
  signInHandBack: null,
  open(target) {
    const current = get().view;
    const signIn = target.signIn ? { ...target.signIn } : null;
    if (current && current.contextId === target.contextId) {
      set({
        view: {
          ...current,
          bot: target.bot,
          expanded: current.expanded || !!target.expanded || !!target.takeControl,
          wantControl: current.wantControl || !!target.takeControl,
          signIn: signIn ?? current.signIn,
          // Already showing it: a refused take leaves it as it was.
          closeOnRefuse: false,
        },
      });
      return;
    }
    set({
      view: {
        contextId: target.contextId,
        bot: target.bot,
        expanded: !!target.expanded || !!target.takeControl,
        wantControl: !!target.takeControl,
        pending: null,
        closeAfterRelease: false,
        conn: "connecting",
        server: null,
        viewerCan: null,
        leaseDeadline: null,
        sensitive: false,
        hasFrame: false,
        attempt: 0,
        signIn,
        closeOnRefuse: !!target.takeControl && !!signIn,
        phoneArea: null,
      },
    });
  },
  close() {
    set({ view: null });
  },
  patch(contextId, p) {
    const view = get().view;
    if (!view || view.contextId !== contextId) return;
    set({ view: { ...view, ...p } });
  },
  setCorner(corner) {
    try {
      window.localStorage.setItem(CORNER_KEY, corner);
    } catch {
      // Private mode: the corner holds for this tab only.
    }
    set({ corner });
  },
  setDock(dock) {
    try {
      window.localStorage.setItem(DOCK_KEY, dock);
    } catch {
      // Private mode: the dock state holds for this tab only.
    }
    set({ dock });
  },
  setSignInHandBack(signInHandBack) {
    set({ signInHandBack });
  },
}));

// ---------------------------------------------------------------- derived state (pure, unit-tested)

const TERMINAL: ReadonlySet<BrowserContextState> = new Set(["ended", "no_permission"]);

/** The state the live view renders (UI-SPEC §1.4). `access_lost` renders as `no_permission`. */
export function uiStateOf(v: Pick<LiveView, "conn" | "server">): LiveUiState {
  const s = v.server?.state;
  if (s && TERMINAL.has(s))
    return s === "ended" && v.server?.endReason === "access_lost" ? "no_permission" : s;
  if (v.conn === "error" || v.conn === "closed") return "error";
  if (v.conn === "reconnecting") return "reconnecting";
  if (!v.server || v.conn === "connecting") return "connecting";
  return s ?? "connecting";
}

/** The state chip's word (UI-SPEC Copywriting › State chips). */
export const CHIP: Record<LiveUiState, string> = {
  connecting: "Connecting",
  live: "Live",
  idle: "Idle",
  paused: "Paused",
  private: "Private",
  controlling: "In control",
  reconnecting: "Reconnecting",
  ended: "Ended",
  error: "Error",
  no_permission: "Unavailable",
};

/** States whose frame area shows the page (the latest frame); the others show a placeholder and drop the last frame. */
export function showsFrames(state: LiveUiState): boolean {
  return (
    state === "live" ||
    state === "idle" ||
    state === "paused" ||
    state === "controlling" ||
    state === "reconnecting"
  );
}

/** Take control renders only with `viewerCan.control`, while nobody holds the page (UI-SPEC §1.4 Controls). */
export function canTake(v: Pick<LiveView, "viewerCan">, state: LiveUiState): boolean {
  return !!v.viewerCan?.control && (state === "live" || state === "idle" || state === "paused");
}

/** Expand is offered while the page may still show something. */
export function canExpand(state: LiveUiState): boolean {
  return (
    state === "connecting" ||
    state === "live" ||
    state === "idle" ||
    state === "paused" ||
    state === "private"
  );
}

/** One sentence per server `endReason` (UI-SPEC "Ended reasons"). */
export function endedSentence(reason: BrowserEndReason | undefined, bot: string): string {
  switch (reason) {
    case "closed_by_bot":
      return `${bot} closed the browser.`;
    case "idle":
      return `The browser closed after ${BROWSER_LIMITS.idleStopMinutes} minutes without activity.`;
    case "kill_switch":
      return "An admin stopped all bot browsers.";
    case "module_off":
      return "Browser was turned off for you.";
    case "access_lost":
      return "You can no longer watch this browser.";
    case "takeover_abandoned":
      return `Control ended without a hand back, so the browser closed. ${bot} can open it again.`;
    default:
      return `The browser stopped unexpectedly. ${bot} can open it again.`;
  }
}

export interface ActivityWords {
  icon: "spinner" | "hand" | "signin" | "keyboard" | null;
  text: string;
  /** The Review link of a pending approval (an internal route only). */
  review: string | null;
}

/** The activity line under the frame (UI-SPEC §1.4 "Activity line"), or null when it is empty. */
export function activityWordsOf(
  v: Pick<LiveView, "server" | "bot" | "viewerCan">,
  state: LiveUiState,
  frameFocused = false,
): ActivityWords | null {
  const bot = v.bot.name;
  const s = v.server;
  switch (state) {
    case "live":
      return s?.activity
        ? { icon: "spinner", text: `${bot} is ${s.activity}`, review: null }
        : { icon: null, text: `${bot} isn't doing anything right now.`, review: null };
    case "idle":
      return { icon: null, text: `${bot} isn't doing anything right now.`, review: null };
    case "paused":
      if (s?.pausedFor === "signin") {
        return {
          icon: "signin",
          text: v.viewerCan?.control
            ? "Waiting for you to sign in"
            : `Waiting for ${s.requesterName ?? "someone"} to sign in`,
          review: null,
        };
      }
      return {
        icon: "hand",
        text: s?.activity ? `Waiting for approval: ${s.activity}` : "Waiting for approval",
        review: s?.approvalRoute && /^\/(?!\/)/.test(s.approvalRoute) ? s.approvalRoute : null,
      };
    case "private":
      return { icon: null, text: `${bot} is paused.`, review: null };
    case "controlling":
      return {
        icon: "keyboard",
        text: frameFocused
          ? "Typing goes to the page · Shift+Esc gives your keyboard back"
          : "Click the page to type",
        review: null,
      };
    case "reconnecting":
      return { icon: null, text: "Connection lost. Reconnecting…", review: null };
    default:
      return null;
  }
}

/** "Only {person} can take control here." for a viewer who watches but cannot take control. */
export function watchOnlyLine(v: Pick<LiveView, "server" | "viewerCan">, state: LiveUiState): string | null {
  if (v.viewerCan?.control || !v.viewerCan?.watch) return null;
  if (!showsFrames(state) || state === "controlling") return null;
  const who = v.server?.requesterName;
  return who ? `Only ${who} can take control here.` : null;
}

/** The fixed sentence of a refused take (UI-SPEC Refusals); a sign-in card's open words it as a sign-in. */
export function refusalSentence(
  reason: "not_allowed" | "someone_else" | "expired",
  v: Pick<LiveView, "server" | "bot"> & { signIn?: LiveSignIn | null },
): string {
  if (reason === "someone_else") return "Someone else is in control right now.";
  if (reason === "expired") return `This sign-in expired. Ask ${v.bot.name} again.`;
  const who = v.server?.requesterName;
  if (v.signIn) return who ? `Only ${who} can sign in here.` : "You can't sign in here.";
  return who ? `Only ${who} can take control here.` : "You can't take control here.";
}

// ---------------------------------------------------------------- the idle lease (UI-SPEC §1.3)

/** The warning shows during the lease's last minute (9 of 10 minutes without input). */
export const LEASE_WARN_MS = (BROWSER_LIMITS.takeoverMinutes - BROWSER_LIMITS.takeoverWarnMinutes) * 60_000;
export const LEASE_MS = BROWSER_LIMITS.takeoverMinutes * 60_000;

/**
 * The lease deadline on this tab's clock. A `lease` frame whose `expiresAt` changed is a renewal (take, keep, input):
 * the server just set it 10 minutes ahead, so the deadline is now + 10 min whatever the two clocks say. A frame with the
 * same `expiresAt` (the server's 9-minute warning) keeps the deadline.
 */
export function nextLeaseDeadline(
  prev: { expiresAt: string | null; deadline: number | null },
  expiresAt: string,
  nowMs: number,
): number {
  if (prev.expiresAt === expiresAt && prev.deadline !== null) return prev.deadline;
  return nowMs + LEASE_MS;
}

/** Seconds left when the warning shows, else null. */
export function leaseWarning(deadline: number | null, nowMs: number): number | null {
  if (deadline === null) return null;
  const left = deadline - nowMs;
  if (left > LEASE_WARN_MS) return null;
  return Math.max(0, Math.ceil(left / 1000));
}

// ---------------------------------------------------------------- the small window's corners (UI-SPEC §1.1)

export const WINDOW_W = 320;
export const WINDOW_H = 272;
const INSET = { top: 72, bottom: 96, right: 16, left: 16 } as const;

export interface Viewport {
  width: number;
  height: number;
  /** Width of the workspace rail on the left (0 when there is none). */
  rail: number;
}

/** The window's top-left for a corner. */
export function cornerPosition(
  corner: LiveCorner,
  vp: Viewport,
  /** The window's measured height (coarse pointers make the header taller); 272 by default. */
  height: number = WINDOW_H,
): { left: number; top: number } {
  const minLeft = vp.rail + INSET.left;
  const right = Math.max(minLeft, vp.width - INSET.right - WINDOW_W);
  const bottom = Math.max(INSET.top, vp.height - INSET.bottom - height);
  return {
    left: corner.endsWith("left") ? minLeft : right,
    top: corner.startsWith("top") ? INSET.top : bottom,
  };
}

/** The corner nearest to a window whose top-left is at (left, top). */
export function nearestCorner(left: number, top: number, vp: Viewport): LiveCorner {
  const cx = left + WINDOW_W / 2;
  const cy = top + WINDOW_H / 2;
  const midX = (vp.rail + vp.width) / 2;
  const vertical = cy < vp.height / 2 ? "top" : "bottom";
  const horizontal = cx < midX ? "left" : "right";
  return `${vertical}-${horizontal}`;
}

/** The corner an arrow key moves to (adjacent corner; the same corner when there is none that way). */
export function cornerAfterKey(corner: LiveCorner, key: string): LiveCorner | null {
  const [v, h] = corner.split("-") as ["top" | "bottom", "left" | "right"];
  switch (key) {
    case "ArrowLeft":
      return h === "left" ? null : `${v}-left`;
    case "ArrowRight":
      return h === "right" ? null : `${v}-right`;
    case "ArrowUp":
      return v === "top" ? null : `top-${h}`;
    case "ArrowDown":
      return v === "bottom" ? null : `bottom-${h}`;
    default:
      return null;
  }
}

/** "Moved to bottom left". */
export const cornerWords = (corner: LiveCorner) => corner.replace("-", " ");
