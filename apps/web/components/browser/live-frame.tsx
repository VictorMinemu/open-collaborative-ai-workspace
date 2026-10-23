"use client";

import { CircleAlert, LockKeyhole, MonitorOff } from "lucide-react";
import {
  type ClipboardEvent,
  type CompositionEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useRef,
} from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  type Box,
  compositionFrame,
  EXPANDED_PAGE,
  isComposingKey,
  isModifierKey,
  isPasteChord,
  isReleaseChord,
  keyFrame,
  mouseFrame,
  moveGate,
  pasteFrame,
  phoneViewport,
  SMALL_PAGE,
  swipeFrame,
  tapFrames,
  wheelFrame,
} from "./live-input";
import { endedSentence, type LiveUiState, type LiveView, showsFrames } from "./live-store";
import { useOptionalLiveView } from "./live-view-provider";

/**
 * The frame area of the live view (07.8-22; UI-SPEC §1.1–1.4, Accessibility "Frame"). It shows the page (the latest
 * JPEG, as a blob URL; the previous URL is revoked as soon as the next one is drawn, so at most two exist) or the
 * state's placeholder. Frames come from the provider's bus straight to the image element: no React render per frame.
 *
 * In control (large view) the area becomes the remote browser: it takes focus and forwards keys, mouse, wheel and paste
 * as `LiveInputFrame`s on the live-view socket, and nothing else (P-10: no log, no store, no echo, no DOM text). The
 * listeners exist only while the person controls the page; `Shift+Esc` never reaches it and moves focus to Hand back.
 * IME: the area is not an editable element (an editable one would hold the composed text in the DOM), so composed text
 * arrives through `compositionend` where the platform raises it, and paste always works.
 *
 * 07.8-26 (phones, `phone`): in control the area fills the sheet and maps a tap to the page's touch events and a swipe
 * to a scroll, at the phone viewport's coordinates (R10); typing goes through the sheet's keyboard input, never through
 * this area. Pinch zooms the workspace page locally (`touch-action: pinch-zoom`); nothing of it reaches the page.
 */

export interface Placeholder {
  icon: "connecting" | "private" | "ended" | "error" | "no_permission";
  title: string;
  body: string | null;
  strong: boolean;
}

/** What the frame area shows instead of the page (UI-SPEC §1.4 "Frame area"), or null when it shows the page. */
export function placeholderOf(v: Pick<LiveView, "server" | "bot">, state: LiveUiState): Placeholder | null {
  const bot = v.bot.name;
  const s = v.server;
  switch (state) {
    case "connecting":
      return { icon: "connecting", title: `Connecting to ${bot}'s browser…`, body: null, strong: false };
    case "private": {
      if (s?.privateReason === "member_session") {
        // D-12 U-2 (P-02): a member's signed-in page is theirs alone.
        const member = s.memberName ?? "a member";
        return {
          icon: "private",
          title: `Private browsing for ${member}`,
          body: `Only ${member} can watch while ${bot} uses their sign-in.`,
          strong: true,
        };
      }
      return {
        icon: "private",
        title: "Private sign-in in progress",
        body:
          s?.controller === "other_device"
            ? "You're signing in on another device."
            : `${s?.memberName ?? "Someone"} is signing in. The view comes back when they hand control back.`,
        strong: true,
      };
    }
    case "ended":
      return { icon: "ended", title: endedSentence(s?.endReason, bot), body: null, strong: false };
    case "error":
      return { icon: "error", title: "Couldn't connect to the live view.", body: null, strong: false };
    case "no_permission":
      return {
        icon: "no_permission",
        title: "You can't watch this browser",
        body: `Only people who can read the conversation where ${bot} works can watch it.`,
        strong: true,
      };
    default:
      return null;
  }
}

export function FramePlaceholder({
  placeholder,
  large,
  onRetry,
}: {
  placeholder: Placeholder;
  large: boolean;
  onRetry?: () => void;
}) {
  const icon = large ? "size-8" : "size-6";
  return (
    <div
      data-testid="live-placeholder"
      data-kind={placeholder.icon}
      className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-4 text-center"
    >
      {placeholder.icon === "connecting" ? (
        <Spinner className="size-5 text-muted-foreground" />
      ) : placeholder.icon === "ended" ? (
        <MonitorOff aria-hidden className={cn(icon, "text-muted-foreground")} />
      ) : placeholder.icon === "error" ? (
        <CircleAlert aria-hidden className={cn(icon, "text-red-700 dark:text-red-300")} />
      ) : (
        <LockKeyhole aria-hidden className={cn(icon, "text-muted-foreground")} />
      )}
      <p
        className={cn(
          "max-w-sm text-balance",
          placeholder.icon === "connecting"
            ? "text-muted-foreground text-xs"
            : placeholder.strong
              ? "font-semibold text-sm"
              : "text-sm",
        )}
      >
        {placeholder.title}
      </p>
      {placeholder.body ? (
        <p className="max-w-sm text-balance text-muted-foreground text-xs">{placeholder.body}</p>
      ) : null}
      {placeholder.icon === "error" ? (
        <Button
          variant="outline"
          size="sm"
          data-testid="live-retry"
          className="mt-1 pointer-coarse:h-11 max-md:h-11"
          onClick={onRetry}
        >
          Try again
        </Button>
      ) : null}
    </div>
  );
}

/** Draws the bus's frames into `img`: latest wins, the previous blob URL revoked once the next one is drawn. */
function useFrames(img: React.RefObject<HTMLImageElement | null>, active: boolean) {
  const live = useOptionalLiveView();
  const frames = live?.frames;
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
  }, [img, active, frames]);
}

/** Where the frame is drawn on screen: the image when there is one, else the frame area. */
function boxOfFrame(img: HTMLImageElement | null, area: HTMLElement | null): Box | null {
  const r = img?.getBoundingClientRect() ?? area?.getBoundingClientRect();
  return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null;
}

export function LiveFrame({
  view,
  state,
  large,
  hintId,
  onFocusChange,
  frameRef,
  chrome = 104,
  phone = false,
}: {
  view: LiveView;
  state: LiveUiState;
  /** The large view (frame fits the dialog's remaining height). */
  large: boolean;
  /** The capture hint the frame is described by while in control. */
  hintId?: string;
  onFocusChange?: (focused: boolean) => void;
  frameRef?: React.RefObject<HTMLDivElement | null>;
  /** Pixels of chrome around the frame in the large view (header, bars, footer). */
  chrome?: number;
  /** 07.8-26: the phone dock or full sheet (touch input in control; the area fills the sheet). */
  phone?: boolean;
}) {
  const live = useOptionalLiveView();
  const img = useRef<HTMLImageElement | null>(null);
  const ownArea = useRef<HTMLDivElement | null>(null);
  const area = frameRef ?? ownArea;
  const placeholder = placeholderOf(view, state);
  const framed = showsFrames(state);
  const controlling = state === "controlling" && (large || phone);
  const fill = phone && controlling;
  const host = view.server?.host ?? null;
  useFrames(img, framed);

  // Input only while this person controls the page (D-07); every listener goes away with the lease.
  const page = phone
    ? view.phoneArea
      ? phoneViewport(view.phoneArea.width, view.phoneArea.height)
      : SMALL_PAGE
    : view.expanded
      ? EXPANDED_PAGE
      : SMALL_PAGE;
  const boxOf = (): Box | null => boxOfFrame(img.current, area.current);
  const gate = useRef(moveGate());
  useEffect(() => {
    const el = area.current;
    if (!controlling || phone || !el || !live) return;
    // A native listener: React's wheel listener is passive and could not keep the workspace from scrolling.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = boxOfFrame(img.current, el);
      const frame = box ? wheelFrame(e, box, page) : null;
      if (frame) live.input(frame);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [controlling, phone, live, page, area]);

  const pointer = (event: "move" | "down" | "up") => (e: MouseEvent<HTMLDivElement>) => {
    if (!live) return;
    if (event === "move" && !gate.current(performance.now())) return;
    if (event === "down") {
      e.preventDefault();
      area.current?.focus();
    }
    const box = boxOf();
    const frame = box ? mouseFrame(event, e, box, page) : null;
    if (frame) live.input(frame);
  };

  // Modifiers pressed on the page (never characters): released there when the keyboard leaves it (Shift+Esc, a click
  // elsewhere), so the remote page is never left with Shift held down.
  const held = useRef(new Map<string, string>());
  const releaseHeld = () => {
    if (!live) return;
    for (const [key, code] of held.current) {
      live.input({ type: "key", event: "up", key, code, modifiers: 0 });
    }
    held.current.clear();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!live) return;
    if (isReleaseChord(e)) {
      e.preventDefault();
      e.stopPropagation();
      releaseHeld();
      live.handBackRef.current?.focus();
      return;
    }
    if (isPasteChord(e)) {
      // The browser raises `paste` with the clipboard's text; nothing else of the chord goes to the page.
      e.stopPropagation();
      return;
    }
    if (!isComposingKey(e)) e.preventDefault();
    e.stopPropagation();
    const frame = keyFrame(e, "down");
    if (frame && isModifierKey(e.key)) held.current.set(e.key, frame.type === "key" ? frame.code : e.code);
    if (frame) live.input(frame);
  };
  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!live) return;
    if (!isComposingKey(e)) e.preventDefault();
    e.stopPropagation();
    const frame = keyFrame(e, "up");
    held.current.delete(e.key);
    if (frame) live.input(frame);
  };
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const frame = pasteFrame(e.clipboardData?.getData("text/plain"));
    if (frame && live) live.input(frame);
  };
  const onCompositionEnd = (e: CompositionEvent<HTMLDivElement>) => {
    const frame = compositionFrame(e.data);
    if (frame && live) live.input(frame);
  };
  const block = (e: { preventDefault(): void }) => e.preventDefault();

  // Phones: a tap is the page's touch, a swipe its scroll (UI-SPEC "Input (phone)").
  const finger = useRef<{ id: number; clientX: number; clientY: number } | null>(null);
  const onFingerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary) return;
    finger.current = { id: e.pointerId, clientX: e.clientX, clientY: e.clientY };
  };
  const onFingerUp = (e: PointerEvent<HTMLDivElement>) => {
    const from = finger.current;
    finger.current = null;
    if (!live || !from || from.id !== e.pointerId) return;
    const box = boxOf();
    if (!box) return;
    const swipe = swipeFrame(from, e, box, page);
    if (swipe) {
      live.input(swipe);
      return;
    }
    for (const frame of tapFrames(from, box, page) ?? []) live.input(frame);
  };
  const onFingerCancel = () => {
    finger.current = null;
  };

  const touchCapture = {
    tabIndex: -1,
    role: "application",
    "aria-roledescription": "remote browser",
    "aria-label": `${host ?? "The page"}, controlled by you`,
    "aria-describedby": hintId,
    onPointerDown: onFingerDown,
    onPointerUp: onFingerUp,
    onPointerCancel: onFingerCancel,
    onContextMenu: block,
    onDrop: block,
    onDragOver: block,
  };

  const capture =
    controlling && phone
      ? touchCapture
      : controlling
        ? {
            tabIndex: 0,
            role: "application",
            "aria-roledescription": "remote browser",
            "aria-label": `${host ?? "The page"}, controlled by you`,
            "aria-describedby": hintId,
            onKeyDown,
            onKeyUp,
            onPaste,
            onCompositionEnd,
            onMouseDown: pointer("down"),
            onMouseUp: pointer("up"),
            onMouseMove: pointer("move"),
            onContextMenu: block,
            onDrop: block,
            onDragOver: block,
            onFocus: () => onFocusChange?.(true),
            onBlur: () => {
              releaseHeld();
              onFocusChange?.(false);
            },
          }
        : {};

  return (
    <div
      ref={area}
      data-testid="live-frame"
      data-controlling={controlling ? "true" : undefined}
      className={cn(
        "relative w-full overflow-hidden bg-muted outline-none dark:bg-black/40",
        fill ? "h-full touch-pinch-zoom select-none" : "aspect-[16/10]",
        large && !phone && "mx-auto",
        controlling && "cursor-default",
      )}
      style={large && !phone ? { maxWidth: `calc((100dvh - 2rem - ${chrome}px) * 1.6)` } : undefined}
      {...capture}
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
      {controlling ? (
        // The amber ring sits above the page image (an inset ring on the area itself would be covered by it).
        <div
          aria-hidden
          data-testid="live-control-ring"
          className="pointer-events-none absolute inset-0 ring-2 ring-amber-500 ring-inset dark:ring-amber-400"
        />
      ) : null}
      {framed && !view.hasFrame ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      ) : null}
      {placeholder ? (
        <FramePlaceholder placeholder={placeholder} large={large} onRetry={live?.retry} />
      ) : null}
    </div>
  );
}
