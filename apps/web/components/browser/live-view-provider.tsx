"use client";

import type { LiveClientFrame, LiveInputFrame, LiveServerFrame } from "@ocw/contracts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { useIsDesktop } from "@/hooks/use-media-query";
import { LiveDock } from "./live-dock";
import { LiveExpanded } from "./live-expanded";
import { LiveFullSheet } from "./live-full-sheet";
import { phoneViewport } from "./live-input";
import { connectLive, type LiveConnection } from "./live-socket";
import {
  canTake,
  type LiveBot,
  nextLeaseDeadline,
  refusalSentence,
  showsFrames,
  uiStateOf,
  useLiveStore,
} from "./live-store";
import { LiveWindow } from "./live-window";

/**
 * The live view of a bot's browser, mounted once in the app shell (07.8-22; D-06, D-07, BRW-02, BRW-03, UI-SPEC §1,
 * Interaction "Live view: open, move, close" and "Take control and hand back"). It owns the one socket, applies the
 * server's frames to the store, routes JPEG frames straight to the frame image (latest wins; dropped whenever the
 * state stops showing the page, so a private or ended view never keeps an earlier frame), and renders the small window
 * or the large view in a portal, so the view survives in-app navigation.
 *
 * Openers call `useLiveView().open({ contextId, bot })` (the activity's Watch, the live chip, the sign-in card);
 * `takeControl` opens the large view and asks for control once the server allows it.
 *
 * 07.8-26: below 768 the view is the phone dock (peek and mini, non-modal) and the full-screen sheet (expand and
 * control) instead of the small window and the large view; while the person controls the page from the sheet, the page
 * gets a phone viewport the size of the sheet's frame area (R10) and goes back to 960×600 on hand back. A view opened
 * from a sign-in card words its refusals as a sign-in, closes again when its take is refused, and its hand back toasts
 * "Signed in to {host}. {bot} continues." once the card says so.
 */

export interface OpenLiveView {
  contextId: string;
  bot: LiveBot;
  takeControl?: boolean;
  /** Focus returns here when the live view closes (the Watch link, the chip, the card button). */
  trigger?: HTMLElement | null;
  /** 07.8-26: opened from a sign-in card ("Open and sign in", "Return to sign-in"). */
  signIn?: { messageId: string; host: string } | null;
}

interface FrameBus {
  latest: Blob | null;
  listeners: Set<(jpeg: Blob) => void>;
}

export interface LiveActions {
  open(target: OpenLiveView): void;
  /** Ends watching; while in control, hands back first. */
  close(): void;
  expand(): void;
  minimize(): void;
  take(): void;
  release(): void;
  keep(): void;
  retry(): void;
  /** Input from the frame while in control; never stored or logged. */
  input(frame: LiveInputFrame): void;
  announce(text: string): void;
  frames: FrameBus;
  /** The Hand back button registers itself so Shift+Esc can reach it. */
  handBackRef: { current: HTMLElement | null };
  /** The small window's region (F6). */
  windowRef: { current: HTMLElement | null };
}

const LiveContext = createContext<LiveActions | null>(null);

export function useLiveView(): LiveActions {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error("useLiveView() outside LiveViewProvider");
  return ctx;
}

/** The live view's actions, or null outside the provider (static renders, tests). */
export function useOptionalLiveView(): LiveActions | null {
  return useContext(LiveContext);
}

const RELEASE_FALLBACK_MS = 3_000;
/** How long a sign-in hand back waits for the card's "Signed in" before the plain "{bot} continues." toast. */
export const SIGNIN_TOAST_WAIT_MS = 8_000;

export function LiveViewProvider({ children }: { children: ReactNode }) {
  const view = useLiveStore((s) => s.view);
  const isDesktop = useIsDesktop();
  const contextId = view?.contextId ?? null;
  const attempt = view?.attempt ?? 0;
  const conn = useRef<LiveConnection | null>(null);
  const bus = useRef<FrameBus>({ latest: null, listeners: new Set() });
  const trigger = useRef<HTMLElement | null>(null);
  const handBackRef = useRef<HTMLElement | null>(null);
  const windowRef = useRef<HTMLElement | null>(null);
  const leaseSeen = useRef<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [announcement, setAnnouncement] = useState({ text: "", n: 0 });

  useEffect(() => setMounted(true), []);

  const announce = useCallback((text: string) => setAnnouncement((a) => ({ text, n: a.n + 1 })), []);

  const send = useCallback((frame: LiveClientFrame) => conn.current?.send(frame) ?? false, []);

  const finishClose = useCallback(() => {
    const back = trigger.current;
    trigger.current = null;
    useLiveStore.getState().close();
    if (back?.isConnected) back.focus();
  }, []);

  // ---------------------------------------------------------------- the socket of the open context

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the Try again trigger (a new socket)
  useEffect(() => {
    if (!contextId) return;
    const id = contextId;
    const store = useLiveStore.getState;
    const patch = (p: Parameters<ReturnType<typeof store>["patch"]>[1]) => store().patch(id, p);
    const frames = bus.current;
    const dropFrames = () => {
      frames.latest = null;
      if (store().view?.hasFrame) patch({ hasFrame: false });
    };
    leaseSeen.current = null;

    const onServer = (frame: LiveServerFrame) => {
      const v = store().view;
      if (!v || v.contextId !== id) return;
      switch (frame.type) {
        case "viewerCan":
          if (!frame.control && v.wantControl && v.closeOnRefuse) {
            // A sign-in card's open that the server will not let take control: the card stays as it was.
            toast(refusalSentence("not_allowed", v));
            patch({ viewerCan: { watch: frame.watch, control: frame.control }, wantControl: false });
            finishClose();
            return;
          }
          patch({
            viewerCan: { watch: frame.watch, control: frame.control },
            ...(frame.control ? {} : { wantControl: false }),
          });
          return;
        case "lease": {
          const deadline = nextLeaseDeadline(
            { expiresAt: leaseSeen.current, deadline: v.leaseDeadline },
            frame.expiresAt,
            Date.now(),
          );
          leaseSeen.current = frame.expiresAt;
          patch({ leaseDeadline: deadline });
          return;
        }
        case "focus":
          patch({ sensitive: frame.sensitive });
          return;
        case "refused":
          patch({ pending: null, wantControl: false });
          toast(refusalSentence(frame.reason, v));
          if (v.closeOnRefuse) finishClose();
          return;
        case "state": {
          const before = uiStateOf(v);
          const after = uiStateOf({ conn: v.conn, server: frame });
          const next: Parameters<typeof patch>[0] = { server: frame };
          if (!showsFrames(after)) {
            frames.latest = null;
            next.hasFrame = false;
          }
          if (v.server?.host && frame.host && v.server.host !== frame.host) announce(`Now on ${frame.host}`);
          if (after === "controlling") {
            if (v.pending === "take") next.pending = null;
            next.closeOnRefuse = false;
          } else {
            next.leaseDeadline = null;
            if (before === "controlling") {
              leaseSeen.current = null;
              const handedBack = v.pending === "release";
              if (handedBack) next.pending = null;
              if ((handedBack || v.closeAfterRelease) && v.signIn) {
                // The card says whether the sign-in was kept; its "Signed in" brings the toast (or the fallback).
                store().setSignInHandBack({
                  messageId: v.signIn.messageId,
                  host: v.signIn.host,
                  bot: v.bot.name,
                  at: Date.now(),
                });
              } else if (handedBack || v.closeAfterRelease) {
                toast(`${v.bot.name} continues.`);
              } else if (v.leaseDeadline !== null && Date.now() >= v.leaseDeadline - 5_000) {
                toast(`You were away, so control went back to ${v.bot.name}.`);
              }
              if (v.closeAfterRelease) {
                patch(next);
                finishClose();
                return;
              }
            }
            if (v.pending === "take" && after !== "live" && after !== "idle" && after !== "paused") {
              next.pending = null;
            }
          }
          patch(next);
          return;
        }
      }
    };

    const connection = connectLive(id, {
      onStatus(status) {
        patch({ conn: status });
        if (status === "error" || status === "closed") dropFrames();
      },
      onServer,
      onFrame(jpeg) {
        const v = store().view;
        // Defense in depth (F-5, U-2): a frame that arrives while the view shows a placeholder is dropped unseen.
        if (!v || v.contextId !== id || !showsFrames(uiStateOf(v))) return;
        frames.latest = jpeg;
        if (!v.hasFrame) patch({ hasFrame: true });
        for (const listener of frames.listeners) listener(jpeg);
      },
    });
    conn.current = connection;
    return () => {
      connection.close();
      if (conn.current === connection) conn.current = null;
      frames.latest = null;
    };
  }, [contextId, attempt, announce, finishClose]);

  // Take control once the server allows it (Take control from the small window, or an opener that asked).
  const wantControl = view?.wantControl ?? false;
  const state = view ? uiStateOf(view) : null;
  const viewerCan = view?.viewerCan ?? null;
  const connOpen = view?.conn === "open";
  const closeOnRefuse = view?.closeOnRefuse ?? false;
  useEffect(() => {
    if (!wantControl || !contextId || !connOpen || !state) return;
    if (state === "private" && closeOnRefuse) {
      // Someone (or this person on another device) holds the page: a sign-in card's open is refused as a take is.
      const v = useLiveStore.getState().view;
      if (v) toast(refusalSentence("someone_else", v));
      finishClose();
      return;
    }
    if (!canTake({ viewerCan }, state)) return;
    if (send({ type: "take" })) {
      useLiveStore.getState().patch(contextId, { wantControl: false, pending: "take" });
    }
  }, [wantControl, contextId, connOpen, state, viewerCan, send, closeOnRefuse, finishClose]);

  // The page's size follows this viewer's view (R10): small 960×600, large 1280×800; on a phone, the sheet's frame area
  // while this person controls the page (a phone viewport), else 960×600.
  const expanded = view?.expanded ?? false;
  const controlling = state === "controlling";
  const phoneW = view?.phoneArea?.width ?? null;
  const phoneH = view?.phoneArea?.height ?? null;
  useEffect(() => {
    if (!connOpen) return;
    if (!isDesktop) {
      if (controlling && expanded && phoneW !== null && phoneH !== null) {
        send({ type: "resize", mode: "phone", ...phoneViewport(phoneW, phoneH) });
      } else {
        send({ type: "resize", mode: "small" });
      }
      return;
    }
    send({ type: "resize", mode: expanded ? "expanded" : "small" });
  }, [expanded, connOpen, send, isDesktop, controlling, phoneW, phoneH]);

  // A sign-in hand back the card never confirmed (nothing of the site was kept): the plain toast, once.
  const handBack = useLiveStore((s) => s.signInHandBack);
  useEffect(() => {
    if (!handBack) return;
    const t = setTimeout(() => {
      const now = useLiveStore.getState().signInHandBack;
      if (now?.at !== handBack.at) return;
      useLiveStore.getState().setSignInHandBack(null);
      toast(`${handBack.bot} continues.`);
    }, SIGNIN_TOAST_WAIT_MS);
    return () => clearTimeout(t);
  }, [handBack]);

  // A hand back that the server never confirms still closes (the socket's close ends the lease server-side).
  const closeAfterRelease = view?.closeAfterRelease ?? false;
  useEffect(() => {
    if (!closeAfterRelease) return;
    const t = setTimeout(finishClose, RELEASE_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [closeAfterRelease, finishClose]);

  const actions = useMemo<LiveActions>(
    () => ({
      open(target) {
        const current = useLiveStore.getState().view;
        if (target.trigger !== undefined) trigger.current = target.trigger;
        const same = current?.contextId === target.contextId;
        useLiveStore.getState().open({
          contextId: target.contextId,
          bot: target.bot,
          takeControl: target.takeControl,
          signIn: target.signIn ?? null,
        });
        if (same) {
          // Already showing it: bring it to the person.
          windowRef.current?.focus();
          return;
        }
        if (!target.takeControl) {
          announce(`Live view of ${target.bot.name}'s browser opened. Press F6 to reach it.`);
        }
      },
      close() {
        const v = useLiveStore.getState().view;
        if (!v) return;
        if (uiStateOf(v) === "controlling") {
          useLiveStore.getState().patch(v.contextId, { pending: "release", closeAfterRelease: true });
          if (!send({ type: "release" })) finishClose();
          return;
        }
        finishClose();
      },
      expand() {
        const v = useLiveStore.getState().view;
        if (v) useLiveStore.getState().patch(v.contextId, { expanded: true });
      },
      minimize() {
        const v = useLiveStore.getState().view;
        if (!v || uiStateOf(v) === "controlling") return;
        useLiveStore.getState().patch(v.contextId, { expanded: false });
        requestAnimationFrame(() => windowRef.current?.focus());
      },
      take() {
        const v = useLiveStore.getState().view;
        if (!v) return;
        if (!v.expanded) {
          // The small window never takes keyboard control: the large view opens and asks in one step.
          useLiveStore.getState().patch(v.contextId, { expanded: true, wantControl: true });
          return;
        }
        if (v.pending) return;
        if (send({ type: "take" })) useLiveStore.getState().patch(v.contextId, { pending: "take" });
      },
      release() {
        const v = useLiveStore.getState().view;
        if (!v || v.pending === "release") return;
        if (send({ type: "release" })) useLiveStore.getState().patch(v.contextId, { pending: "release" });
      },
      keep() {
        send({ type: "keep" });
      },
      retry() {
        const v = useLiveStore.getState().view;
        if (!v) return;
        useLiveStore.getState().patch(v.contextId, {
          attempt: v.attempt + 1,
          conn: "connecting",
          server: null,
          viewerCan: null,
          hasFrame: false,
          pending: null,
        });
      },
      input(frame) {
        const v = useLiveStore.getState().view;
        if (!v || uiStateOf(v) !== "controlling") return;
        send(frame);
      },
      announce,
      frames: bus.current,
      handBackRef,
      windowRef,
    }),
    [announce, send, finishClose],
  );

  return (
    <LiveContext.Provider value={actions}>
      {children}
      {mounted
        ? createPortal(
            <>
              <div data-testid="live-announce" aria-live="polite" aria-atomic="true" className="sr-only">
                {/* The same sentence twice in a row is still announced: a no-break space toggles the content. */}
                {announcement.text}
                {announcement.n % 2 === 1 ? " " : ""}
              </div>
              {view ? (
                isDesktop ? (
                  view.expanded ? (
                    <LiveExpanded view={view} />
                  ) : (
                    <LiveWindow view={view} />
                  )
                ) : view.expanded ? (
                  <LiveFullSheet view={view} />
                ) : (
                  <LiveDock view={view} />
                )
              ) : null}
            </>,
            document.body,
          )
        : null}
    </LiveContext.Provider>
  );
}
