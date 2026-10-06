"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * Chat scrolling: start at the bottom, follow new content while the reader is at the bottom, keep the
 * reading position when older content is prepended (`preserve()` before loading it). `detached` (a permalink
 * window, CHAT-14) disables following: the view decides where to scroll, and newer pages append below.
 */
export function useStickToBottom(contentKey: unknown, resetKey: string, detached = false) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const detachedRef = useRef(detached);
  detachedRef.current = detached;
  const restore = useRef<{ height: number; top: number } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when switching conversations
  useLayoutEffect(() => {
    atBottom.current = true;
    restore.current = null;
  }, [resetKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever the content changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (restore.current) {
      el.scrollTop = el.scrollHeight - restore.current.height + restore.current.top;
      restore.current = null;
      return;
    }
    if (atBottom.current && !detachedRef.current) el.scrollTop = el.scrollHeight;
  }, [contentKey]);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
  }, []);

  const preserve = useCallback(() => {
    const el = ref.current;
    if (el) restore.current = { height: el.scrollHeight, top: el.scrollTop };
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    atBottom.current = true;
    const el = ref.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  return { ref, onScroll, preserve, scrollToBottom, atBottom };
}
