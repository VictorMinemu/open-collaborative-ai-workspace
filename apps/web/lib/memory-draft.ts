"use client";

import { create } from "zustand";

/**
 * The open memory draft (Phase 07.2, 07.2-12, UI-SPEC "Edit, save and guard"). It lives outside the lazy editor so
 * the shell can guard every way out of Edit (tree, breadcrumb, tabs, back controls, browser back) and a draft
 * survives the editor unmounting. One draft at a time: Edit opens on one file.
 */

export interface MemoryDraft {
  scopeId: string;
  path: string;
  fileId: string;
  /** The version the edit started from; sent as `expectedVersion`. */
  baseVersion: number;
  /** The content of `baseVersion` (Save stays disabled while the draft equals it). */
  original: string;
  content: string;
}

interface DraftState {
  draft: MemoryDraft | null;
  /** A pending way out of Edit, held until the Discard dialog answers. */
  pending: { leave: () => void; stay?: () => void } | null;
  start: (draft: Omit<MemoryDraft, "content"> & { content?: string }) => void;
  update: (content: string) => void;
  /** After a successful save (or Keep mine) the draft rebases on the saved version. */
  rebase: (version: number, content: string) => void;
  clear: () => void;
  /** Runs `leave` now when nothing is unsaved, else asks first (Discard dialog). */
  guard: (leave: () => void, stay?: () => void) => void;
  answer: (discard: boolean) => void;
}

export const isDirty = (d: MemoryDraft | null): boolean => !!d && d.content !== d.original;

export const useMemoryDraft = create<DraftState>()((set, get) => ({
  draft: null,
  pending: null,
  start: (d) => set({ draft: { ...d, content: d.content ?? d.original } }),
  update: (content) => set((s) => (s.draft ? { draft: { ...s.draft, content } } : s)),
  rebase: (version, content) =>
    set((s) => (s.draft ? { draft: { ...s.draft, baseVersion: version, original: content, content } } : s)),
  clear: () => set({ draft: null, pending: null }),
  guard: (leave, stay) => {
    if (!isDirty(get().draft)) {
      set({ draft: null });
      leave();
      return;
    }
    set({ pending: { leave, ...(stay ? { stay } : {}) } });
  },
  answer: (discard) => {
    const pending = get().pending;
    if (discard) {
      set({ draft: null, pending: null });
      pending?.leave();
    } else {
      set({ pending: null });
      pending?.stay?.();
    }
  },
}));
