"use client";

import type { LiveInputFrame, LiveServerFrame, WorkLiveClientFrame } from "@ocw/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { connectLive, type LiveConnection, type LiveSocketOptions } from "@/components/browser/live-socket";
import {
  canTake,
  type LiveUiState,
  type LiveView,
  nextLeaseDeadline,
  showsFrames,
  uiStateOf,
} from "@/components/browser/live-store";
import { workLiveSocketUrl } from "./work-browser-queries";

/**
 * The live view of one Work Zone session's browser (07.13-16; D-15, D-20, D-27, PD-13). One socket per open Browser
 * panel, through the bots' `connectLive` with the session's own route (`workLivePath`): the same authentication (the
 * access JWT as a subprotocol, never in the URL), reconnects, silence checks and final close codes. Its state has the
 * bots' `LiveView` shape (the session as the context, the runtime's label as the "bot"), so their chips, placeholder
 * and words render it unchanged; it lives here, per panel, never in the bots' one global live store.
 *
 * Frames go straight from the socket to the frame element's listeners: only the latest one is held (for an element that
 * mounts after it arrived), and it is dropped whenever the state stops showing the page (private, ended, no
 * permission), so a private page never stays in memory. Nothing here logs (P-10). Unmounting the panel closes the
 * socket, and the API stops asking the device for frames once no one watches.
 *
 * 07.13-21 (D-20, D-22): the person the server lets take control (`viewerCan.control`: the asker of the current or last
 * turn) takes the page, keeps it, types into it and hands it back with "Done, save my sign-in" (`release { save: true }`)
 * or "Done" (`save: false`). Input goes out only while this socket holds the page; the server drops anything before its
 * first `lease` frame anyway. A take asked before the socket is ready (the sign-in card's Open and sign in) waits in
 * `wantControl` and goes out as soon as the server allows it.
 */

/** The Work Zone's `idle`: the socket is open and the session has no page yet ("Nothing to show yet"). */
export function workUiStateOf(v: Pick<LiveView, "conn" | "server">): LiveUiState {
  const s = uiStateOf(v);
  return s === "connecting" && v.conn === "open" && v.server?.state === "connecting" ? "idle" : s;
}

/** States whose frame area shows the page. Unlike the bots' idle, the Work Zone's has no page to show. */
export function workShowsFrames(state: LiveUiState): boolean {
  return state !== "idle" && showsFrames(state);
}

/** Why a take was refused (the server's `refused` frame, or this client knowing it before asking). */
export type WorkRefusal = "not_allowed" | "someone_else" | "expired";

/** The bots' view plus the Work Zone's refusal line (shown under the frame until the next take). */
export interface WorkLiveView extends LiveView {
  refused: WorkRefusal | null;
}

/** The fixed sentence of a refused take, never naming a bot (UI-SPEC Refusals, in the Work Zone's words). */
export function workRefusalSentence(reason: WorkRefusal): string {
  switch (reason) {
    case "not_allowed":
      return "Only the person who asked can take control here.";
    case "someone_else":
      return "Someone else is in control right now.";
    case "expired":
      return "The page closed. The agent can open it again.";
  }
}

/** Take control is offered with `viewerCan.control` on a page that is there (the Work Zone's idle has none). */
export function workCanTake(v: Pick<LiveView, "viewerCan">, state: LiveUiState): boolean {
  return state !== "idle" && canTake(v, state);
}

export interface WorkLiveHooks {
  /** A short notice for the person (a toast in the panel): "{agent} continues." after a confirmed hand back. */
  notify?: (text: string) => void;
}

export interface FrameBus {
  latest: Blob | null;
  listeners: Set<(jpeg: Blob) => void>;
}

export interface WorkLive {
  getView(): WorkLiveView;
  subscribe(onChange: () => void): () => void;
  frames: FrameBus;
  start(): void;
  /** Closes the socket (1000) and forgets the latest frame. */
  stop(): void;
  /** Try again: a fresh view on a new socket. */
  retry(): void;
  /** Take control now, or as soon as the server allows it. */
  take(): void;
  /** "Keep control" in the lease's last minute. */
  keep(): void;
  /** Hand back: `save` = "Done, save my sign-in" (D-22). */
  release(save: boolean): void;
  /** One input frame from the frame element, sent only while this person controls the page; never kept or logged. */
  input(frame: LiveInputFrame): void;
}

function freshView(sessionId: string, agent: string, attempt: number): WorkLiveView {
  return {
    contextId: sessionId,
    bot: { id: sessionId, name: agent },
    expanded: false,
    wantControl: false,
    pending: null,
    closeAfterRelease: false,
    conn: "connecting",
    server: null,
    viewerCan: null,
    leaseDeadline: null,
    sensitive: false,
    hasFrame: false,
    attempt,
    signIn: null,
    closeOnRefuse: false,
    phoneArea: null,
    refused: null,
  };
}

export function createWorkLive(
  sessionId: string,
  agent: string,
  options: LiveSocketOptions = {},
  hooks: WorkLiveHooks = {},
): WorkLive {
  let view = freshView(sessionId, agent, 0);
  let conn: LiveConnection | null = null;
  let leaseSeen: string | null = null;
  const listeners = new Set<() => void>();
  const frames: FrameBus = { latest: null, listeners: new Set() };

  const emit = () => {
    for (const l of listeners) l();
  };

  /**
   * A Work Zone frame on the bots' socket: `WorkLiveClientFrame` is structurally one of the bots' client frames
   * (`release` carries an extra `save`), and the socket sends it as JSON unchanged.
   */
  const send = (frame: WorkLiveClientFrame): boolean => conn?.send(frame) ?? false;

  /** A wanted take, sent once the socket is open and the server allows it; refused at once when it never will be. */
  const settleTake = (): Partial<WorkLiveView> | null => {
    if (!view.wantControl || view.conn !== "open" || !view.server || !view.viewerCan) return null;
    const s = workUiStateOf(view);
    if (s === "controlling") return { wantControl: false };
    if (!view.viewerCan.control) return { wantControl: false, refused: "not_allowed" };
    if (s === "private") return { wantControl: false, refused: "someone_else" };
    if (s === "ended" || s === "no_permission") return { wantControl: false, refused: "expired" };
    if (!workCanTake(view, s)) return null;
    return send({ type: "take" }) ? { wantControl: false, pending: "take", refused: null } : null;
  };

  const patch = (p: Partial<WorkLiveView>) => {
    view = { ...view, ...p };
    const taken = settleTake();
    if (taken) view = { ...view, ...taken };
    emit();
  };

  const controlling = () => workUiStateOf(view) === "controlling";

  const onServer = (frame: LiveServerFrame) => {
    switch (frame.type) {
      case "viewerCan":
        patch({ viewerCan: { watch: frame.watch, control: frame.control } });
        return;
      case "lease": {
        const leaseDeadline = nextLeaseDeadline(
          { expiresAt: leaseSeen, deadline: view.leaseDeadline },
          frame.expiresAt,
          Date.now(),
        );
        leaseSeen = frame.expiresAt;
        patch({ leaseDeadline });
        return;
      }
      case "focus":
        patch({ sensitive: frame.sensitive });
        return;
      case "refused":
        patch({ pending: null, wantControl: false, refused: frame.reason });
        return;
      case "state": {
        const before = workUiStateOf(view);
        const after = workUiStateOf({ conn: view.conn, server: frame });
        const next: Partial<WorkLiveView> = { server: frame };
        if (!workShowsFrames(after)) {
          frames.latest = null;
          next.hasFrame = false;
        }
        if (after === "controlling") {
          if (view.pending === "take") next.pending = null;
          next.refused = null;
        } else {
          next.leaseDeadline = null;
          leaseSeen = null;
          if (before === "controlling" && view.pending === "release") {
            next.pending = null;
            hooks.notify?.(`${agent} continues.`);
          }
          // A take the server never answered with control (the page ended, someone else took it) is no longer pending.
          if (view.pending === "take" && after !== "live" && after !== "paused") next.pending = null;
        }
        patch(next);
        return;
      }
    }
  };

  const connect = () => {
    conn = connectLive(
      sessionId,
      {
        onStatus(status) {
          const p: Partial<WorkLiveView> = { conn: status };
          if (status === "error" || status === "closed") {
            frames.latest = null;
            p.hasFrame = false;
          }
          patch(p);
        },
        onServer,
        onFrame(jpeg) {
          // Defense in depth (T-07.13-16-03): a frame that arrives while the view shows a placeholder is dropped unseen.
          if (!workShowsFrames(workUiStateOf(view))) return;
          frames.latest = jpeg;
          if (!view.hasFrame) patch({ hasFrame: true });
          for (const l of frames.listeners) l(jpeg);
        },
      },
      { ...options, url: options.url ?? workLiveSocketUrl(sessionId) },
    );
  };

  const disconnect = () => {
    conn?.close();
    conn = null;
    frames.latest = null;
  };

  return {
    getView: () => view,
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    frames,
    start() {
      if (!conn) connect();
    },
    stop: disconnect,
    retry() {
      disconnect();
      leaseSeen = null;
      view = freshView(sessionId, agent, view.attempt + 1);
      emit();
      connect();
    },
    take() {
      if (view.pending === "take" || controlling()) return;
      patch({ wantControl: true, refused: null });
    },
    keep() {
      if (controlling()) send({ type: "keep" });
    },
    release(save) {
      if (!controlling() || view.pending === "release") return;
      if (send({ type: "release", save })) patch({ pending: "release" });
    },
    input(frame) {
      if (controlling()) send(frame);
    },
  };
}

/** What the panel's controls call: take, keep, hand back (with or without saving) and the frame's input. */
export type WorkLiveActions = Pick<WorkLive, "take" | "keep" | "release" | "input">;

/**
 * The hook the Browser panel mounts: one socket while it is mounted (`agent` = the runtime's label, e.g. "Claude
 * Code"). The panel is keyed by the session, so another session is another mount and another socket. Returns the view,
 * the frame bus for the frame element, Try again and the takeover actions.
 */
export function useWorkLive(
  sessionId: string,
  agent: string,
  options?: LiveSocketOptions,
  hooks?: WorkLiveHooks,
): { view: WorkLiveView; frames: FrameBus; retry: () => void; actions: WorkLiveActions } {
  const [live] = useState(() => createWorkLive(sessionId, agent, options, hooks));
  useEffect(() => {
    live.start();
    return () => live.stop();
  }, [live]);
  const view = useSyncExternalStore(live.subscribe, live.getView, live.getView);
  return { view, frames: live.frames, retry: live.retry, actions: live };
}
