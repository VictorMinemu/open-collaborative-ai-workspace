import { BROWSER_LIMITS, type LiveInputFrame } from "@ocw/contracts";

/**
 * Pure mappers from the person's DOM input to `LiveInputFrame`s (07.8-22; D-07, BRW-03, UI-SPEC "Take control and hand
 * back"). Nothing here stores, logs or echoes what is typed (P-10): each function returns one frame for the live-view
 * socket and keeps no state. `Shift+Esc` is never forwarded: it gives the person's keyboard back to the workspace.
 */

/** CDP modifier bits, as `LiveKeyFrame.modifiers` carries them: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

export interface ModifierState {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface KeyLike extends ModifierState {
  key: string;
  code: string;
  isComposing?: boolean;
  keyCode?: number;
}

export function modifiersOf(e: ModifierState): number {
  return (
    (e.altKey ? MODIFIER_BITS.alt : 0) |
    (e.ctrlKey ? MODIFIER_BITS.ctrl : 0) |
    (e.metaKey ? MODIFIER_BITS.meta : 0) |
    (e.shiftKey ? MODIFIER_BITS.shift : 0)
  );
}

/** Shift+Esc: the one chord the remote page never receives (it moves focus to Hand back). */
export function isReleaseChord(e: Pick<KeyLike, "key" | "shiftKey">): boolean {
  return e.shiftKey && (e.key === "Escape" || e.key === "Esc");
}

/** The paste chord (Cmd+V / Ctrl+V): left to the browser so its `paste` event carries the clipboard text. */
export function isPasteChord(e: KeyLike): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "v";
}

/** Shift, Control, Alt, Meta (and AltGraph): the keys a lost focus could leave held down on the page. */
export function isModifierKey(key: string): boolean {
  return key === "Shift" || key === "Control" || key === "Alt" || key === "Meta" || key === "AltGraph";
}

/** An IME composition key (the text arrives on `compositionend`, never key by key). */
export function isComposingKey(e: Pick<KeyLike, "isComposing" | "key" | "keyCode">): boolean {
  return e.isComposing === true || e.key === "Process" || e.keyCode === 229;
}

const KEY_MAX = 32;

/**
 * A key frame for `keydown` / `keyup`, or null when the key must not reach the page: Shift+Esc, the paste chord (its
 * `paste` event sends the text), a key during an IME composition, or a key name the contract cannot carry.
 */
export function keyFrame(e: KeyLike, event: "down" | "up"): LiveInputFrame | null {
  if (isReleaseChord(e) || isPasteChord(e) || isComposingKey(e)) return null;
  const key = e.key;
  if (!key || key.length > KEY_MAX) return null;
  const code = e.code && e.code.length <= KEY_MAX ? e.code : "Unidentified";
  return { type: "key", event, key, code, modifiers: modifiersOf(e) };
}

/** Pasted text as one `text` frame, cut to 1,000 characters (UI-SPEC: "Paste … ≤ 1,000 characters"); null when empty. */
export function pasteFrame(text: string | null | undefined): LiveInputFrame | null {
  if (!text) return null;
  let cut = text.slice(0, BROWSER_LIMITS.pasteMaxChars);
  // Never half an emoji: a cut that ends on a high surrogate drops it.
  const last = cut.charCodeAt(cut.length - 1);
  if (cut.length < text.length && last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut ? { type: "text", text: cut } : null;
}

/** The composed text of an IME composition, sent once on `compositionend`. */
export function compositionFrame(data: string | null | undefined): LiveInputFrame | null {
  return pasteFrame(data);
}

/** The displayed frame (the image element's client rect). */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The remote page's viewport in CSS pixels. */
export interface PageSize {
  width: number;
  height: number;
}

export const SMALL_PAGE: PageSize = { width: BROWSER_LIMITS.frameWidth, height: BROWSER_LIMITS.frameHeight };
export const EXPANDED_PAGE: PageSize = {
  width: BROWSER_LIMITS.expandedWidth,
  height: BROWSER_LIMITS.expandedHeight,
};

/**
 * A pointer position on the frame, in page coordinates: the frame is drawn `object-contain` (letterboxed when the box's
 * aspect differs from the page's), so the page's drawn rectangle is found first and the position scaled from it.
 * Null outside the drawn page (a letterbox bar).
 */
export function toPage(
  clientX: number,
  clientY: number,
  box: Box,
  page: PageSize,
): { x: number; y: number } | null {
  if (box.width <= 0 || box.height <= 0 || page.width <= 0 || page.height <= 0) return null;
  const scale = Math.min(box.width / page.width, box.height / page.height);
  const drawnW = page.width * scale;
  const drawnH = page.height * scale;
  const left = box.left + (box.width - drawnW) / 2;
  const top = box.top + (box.height - drawnH) / 2;
  const rx = clientX - left;
  const ry = clientY - top;
  if (rx < 0 || ry < 0 || rx > drawnW || ry > drawnH) return null;
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
  return {
    x: clamp(Math.round((rx / scale) * 100) / 100, page.width),
    y: clamp(Math.round((ry / scale) * 100) / 100, page.height),
  };
}

/** DOM `MouseEvent.button` → the contract's button. */
export function buttonOf(button: number): "left" | "middle" | "right" | "none" {
  return button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : "none";
}

export function mouseFrame(
  event: "move" | "down" | "up",
  pointer: { clientX: number; clientY: number; button: number },
  box: Box,
  page: PageSize,
): LiveInputFrame | null {
  const at = toPage(pointer.clientX, pointer.clientY, box, page);
  if (!at) return null;
  return {
    type: "mouse",
    event,
    x: at.x,
    y: at.y,
    button: event === "move" ? "none" : buttonOf(pointer.button),
  };
}

/** DOM `WheelEvent.deltaMode`: 0 pixels, 1 lines, 2 pages. */
const LINE_PX = 16;
const WHEEL_MAX = 10_000;

export function wheelFrame(
  wheel: { clientX: number; clientY: number; deltaX: number; deltaY: number; deltaMode: number },
  box: Box,
  page: PageSize,
): LiveInputFrame | null {
  const at = toPage(wheel.clientX, wheel.clientY, box, page);
  if (!at) return null;
  const unit = wheel.deltaMode === 1 ? LINE_PX : wheel.deltaMode === 2 ? page.height : 1;
  const bound = (v: number) => Math.max(-WHEEL_MAX, Math.min(WHEEL_MAX, Math.round(v * unit)));
  const dx = bound(wheel.deltaX);
  const dy = bound(wheel.deltaY);
  if (dx === 0 && dy === 0) return null;
  return { type: "wheel", x: at.x, y: at.y, dx, dy };
}

/** Mouse moves at most `hz` times a second (UI-SPEC: ≤ 30 Hz); buttons and wheel are never throttled. */
export function moveGate(hz: number = BROWSER_LIMITS.mouseMoveHz) {
  const every = 1000 / hz;
  let last = Number.NEGATIVE_INFINITY;
  return (nowMs: number): boolean => {
    if (nowMs - last < every) return false;
    last = nowMs;
    return true;
  };
}
