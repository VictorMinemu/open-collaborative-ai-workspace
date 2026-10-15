"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Chat scrolling: start at the bottom, follow new content while the reader is at the bottom, keep the
 * reading position when older content is prepended (`preserve()` before loading it). `detached` (a permalink
 * window, CHAT-14) disables following: the view decides where to scroll, and newer pages append below.
 *
 * Content can also grow without a new message (a live card whose approval link arrives, an image that loads) and the
 * list can shrink (a phone's composer grows): a ResizeObserver on the list and its content keeps a reader who was at
 * the bottom there, so the newest content never sits under the composer (07.5, WINDOWS #226). Only scrolling up
 * leaves the bottom.
 */
export function useStickToBottom(contentKey: unknown, resetKey: string, detached = false) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const detachedRef = useRef(detached);
  detachedRef.current = detached;
  const restore = useRef<{ height: number; top: number } | null>(null);
  const observed = useRef<{ el: HTMLDivElement; disconnect: () => void } | null>(null);

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

  // Size changes that come with no new message: (re)attached whenever the list element itself changes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (observed.current?.el === el) return;
    observed.current?.disconnect();
    observed.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const follow = () => {
      if (atBottom.current && !detachedRef.current && !restore.current) el.scrollTop = el.scrollHeight;
    };
    const resize = new ResizeObserver(follow);
    const watchChildren = () => {
      resize.disconnect();
      resize.observe(el);
      for (const child of el.children) resize.observe(child);
    };
    watchChildren();
    const mutations = new MutationObserver(watchChildren);
    mutations.observe(el, { childList: true });
    observed.current = {
      el,
      disconnect: () => {
        resize.disconnect();
        mutations.disconnect();
      },
    };
  });

  useEffect(
    () => () => {
      observed.current?.disconnect();
      observed.current = null;
    },
    [],
  );

  // Only a scroll UP leaves the bottom. A scroll event can arrive after the content already grew under it (our own
  // scroll to the bottom, dispatched a frame later), and must not read as the reader moving away (WINDOWS #226).
  const lastTop = useRef(0);
  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 96) atBottom.current = true;
    else if (el.scrollTop < lastTop.current - 1) atBottom.current = false;
    lastTop.current = el.scrollTop;
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
