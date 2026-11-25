"use client";

import type { LiveServerFrame } from "@ocw/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { connectLive, type LiveConnection, type LiveSocketOptions } from "@/components/browser/live-socket";
import {
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

export interface FrameBus {
  latest: Blob | null;
  listeners: Set<(jpeg: Blob) => void>;
}

export interface WorkLive {
  getView(): LiveView;
  subscribe(onChange: () => void): () => void;
  frames: FrameBus;
  start(): void;
  /** Closes the socket (1000) and forgets the latest frame. */
  stop(): void;
  /** Try again: a fresh view on a new socket. */
  retry(): void;
}

function freshView(sessionId: string, agent: string, attempt: number): LiveView {
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
  };
}

export function createWorkLive(sessionId: string, agent: string, options: LiveSocketOptions = {}): WorkLive {
  let view = freshView(sessionId, agent, 0);
  let conn: LiveConnection | null = null;
  let leaseSeen: string | null = null;
  const listeners = new Set<() => void>();
  const frames: FrameBus = { latest: null, listeners: new Set() };

  const patch = (p: Partial<LiveView>) => {
    view = { ...view, ...p };
    for (const l of listeners) l();
  };

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
        patch({ pending: null, wantControl: false });
        return;
      case "state": {
        const next: Partial<LiveView> = { server: frame };
        if (!workShowsFrames(workUiStateOf({ conn: view.conn, server: frame }))) {
          frames.latest = null;
          next.hasFrame = false;
        }
        if (frame.state !== "controlling") {
          next.leaseDeadline = null;
          leaseSeen = null;
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
          const p: Partial<LiveView> = { conn: status };
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
      for (const l of listeners) l();
      connect();
    },
  };
}

/**
 * The hook the Browser panel mounts: one socket while it is mounted (`agent` = the runtime's label, e.g. "Claude
 * Code"). The panel is keyed by the session, so another session is another mount and another socket. Returns the view,
 * the frame bus for the frame element and Try again.
 */
export function useWorkLive(
  sessionId: string,
  agent: string,
  options?: LiveSocketOptions,
): { view: LiveView; frames: FrameBus; retry: () => void } {
  const [live] = useState(() => createWorkLive(sessionId, agent, options));
  useEffect(() => {
    live.start();
    return () => live.stop();
  }, [live]);
  const view = useSyncExternalStore(live.subscribe, live.getView, live.getView);
  return { view, frames: live.frames, retry: live.retry };
}
