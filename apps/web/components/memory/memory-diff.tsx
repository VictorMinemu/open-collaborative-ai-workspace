"use client";

import { markdown } from "@codemirror/lang-markdown";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";
import { markdownHighlight, memoryTheme, PALETTE } from "@/lib/use-codemirror";
import { cn } from "@/lib/utils";

/**
 * A read-only diff between two versions of a memory file (Phase 07.2, 07.2-12, D-03; reused by 07.2-13): side by side
 * (`MergeView`) when the host is at least 520 px wide, unified (`unifiedMergeView`) below, measured on the host itself
 * so it follows the pane, not the window (UI-SPEC "Diff layout rule"). Unchanged stretches collapse ("⦚ N unchanged
 * lines"). Colours follow UI-SPEC "Diff colours": Work Zone line tints, 3 px change bars and `+`/`−` markers, so colour
 * is never the only cue; deleted text in the unified view is struck through. `highlights` are offsets into
 * `after.doc`, drawn with the "Sensitive span" style (07.2-13 findings).
 *
 * Lazy: import it through `next/dynamic` only, so reading a file never loads CodeMirror.
 */

export interface MemoryDiffSide {
  label: string;
  doc: string;
}

export interface MemoryDiffProps {
  before: MemoryDiffSide;
  after: MemoryDiffSide;
  /** Accessible name of the whole diff ("Changes from version 4 to version 5"). */
  label: string;
  /** Visually hidden summary read before the panes ("2 lines added, 0 removed"). */
  summary?: string;
  highlights?: readonly { start: number; end: number }[];
  /** `unified` always stacks (the History tab below 1280 px, UI-SPEC "Diff layout rule"); `auto` follows the host. */
  layout?: "auto" | "unified";
  /**
   * Jump to a finding (07.2-13, UI-SPEC "Interaction Contract › Proposals"): scrolls `after` to `line` (1-based) and
   * outlines `ranges` (offsets into `after.doc`); a new `nonce` repeats the jump. The outline clears after 2 s, or stays
   * until the next jump under reduced motion.
   */
  focus?: { line: number; ranges: readonly { start: number; end: number }[]; nonce: number } | null;
  className?: string;
}

const SPLIT_MIN = 520;
const mix = (v: string, pct: number) => `color-mix(in oklch, ${v} ${pct}%, transparent)`;

const LINE_PAD = "30px";
const marker = (sign: string, color: string) => ({
  content: `"${sign}"`,
  position: "absolute",
  left: "12px",
  color,
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
});

/** UI-SPEC "Diff colours"; `.dark &` selectors carry the dark alphas and bars. */
const diffTheme = EditorView.theme({
  "&.cm-editor .cm-line": { position: "relative", paddingLeft: LINE_PAD },
  ".cm-activeLine": { backgroundColor: "transparent" },
  // Inserted lines (side b, and the unified view's own lines).
  "&.cm-merge-b .cm-changedLine": {
    backgroundColor: `${mix("var(--success)", 12)} !important`,
    boxShadow: `inset 3px 0 0 ${PALETTE.emerald600}`,
  },
  ".dark &.cm-merge-b .cm-changedLine": {
    backgroundColor: `${mix("var(--success)", 15)} !important`,
    boxShadow: `inset 3px 0 0 ${PALETTE.emerald400}`,
  },
  "&.cm-merge-b .cm-changedLine::before": marker("+", PALETTE.emerald700),
  ".dark &.cm-merge-b .cm-changedLine::before": { color: PALETTE.emerald400 },
  // Deleted lines (side a, and the unified view's deleted chunks).
  "&.cm-merge-a .cm-changedLine, & .cm-deletedChunk .cm-deletedLine": {
    backgroundColor: `${mix("var(--destructive)", 12)} !important`,
    boxShadow: `inset 3px 0 0 ${PALETTE.red600}`,
  },
  ".dark &.cm-merge-a .cm-changedLine, .dark & .cm-deletedChunk .cm-deletedLine": {
    backgroundColor: `${mix("var(--destructive)", 15)} !important`,
    boxShadow: `inset 3px 0 0 ${PALETTE.red400}`,
  },
  "&.cm-merge-a .cm-changedLine::before, & .cm-deletedChunk .cm-deletedLine::before": marker(
    "−",
    PALETTE.red700,
  ),
  ".dark &.cm-merge-a .cm-changedLine::before, .dark & .cm-deletedChunk .cm-deletedLine::before": {
    color: PALETTE.red400,
  },
  "& .cm-deletedChunk": { paddingLeft: "0 !important", backgroundColor: "transparent !important" },
  "& .cm-deletedChunk .cm-deletedLine": { position: "relative", padding: `0 16px 0 ${LINE_PAD}` },
  "&.cm-editor .cm-deletedChunk .cm-deletedLine del": { textDecoration: "line-through" },
  // Changed words.
  "&.cm-merge-b .cm-changedText": { background: `${mix("var(--success)", 28)} !important` },
  ".dark &.cm-merge-b .cm-changedText": { background: `${mix("var(--success)", 32)} !important` },
  "&.cm-merge-a .cm-changedText, & .cm-deletedChunk .cm-deletedText": {
    background: `${mix("var(--destructive)", 28)} !important`,
  },
  ".dark &.cm-merge-a .cm-changedText, .dark & .cm-deletedChunk .cm-deletedText": {
    background: `${mix("var(--destructive)", 32)} !important`,
  },
  // Collapsed unchanged lines: muted tokens, no gradient.
  "&.cm-editor .cm-collapsedLines": {
    background: "var(--muted) !important",
    color: "var(--muted-foreground) !important",
    fontSize: "12px",
    padding: "4px 16px",
  },
  // Sensitive spans (07.2-13): amber background and a 2 px amber underline.
  ".cm-sensitiveSpan": {
    backgroundColor: mix(PALETTE.amber200, 80),
    textDecoration: `underline 2px ${PALETTE.amber700}`,
    textUnderlineOffset: "3px",
  },
  ".dark & .cm-sensitiveSpan": {
    backgroundColor: mix(PALETTE.amber400, 25),
    textDecorationColor: PALETTE.amber300,
  },
  // The finding a reviewer jumped to (07.2-13): a 2 px amber outline on its spans.
  ".cm-sensitiveFocus": {
    outline: `2px solid ${PALETTE.amber500}`,
    outlineOffset: "1px",
    borderRadius: "2px",
  },
});

const SENSITIVE = Decoration.mark({ class: "cm-sensitiveSpan" });
const FOCUSED = Decoration.mark({ class: "cm-sensitiveFocus" });

/** The finding a reviewer jumped to: outlined spans, replaced or cleared by the next effect. */
const setFocusRanges = StateEffect.define<readonly { start: number; end: number }[]>();
const focusField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setFocusRanges)) continue;
      const b = new RangeSetBuilder<Decoration>();
      const len = tr.state.doc.length;
      for (const r of [...e.value].sort((x, y) => x.start - y.start)) {
        const start = Math.max(0, Math.min(r.start, len));
        const end = Math.max(start, Math.min(r.end, len));
        if (end > start) b.add(start, end, FOCUSED);
      }
      next = b.finish();
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function highlightSpans(doc: string, spans: readonly { start: number; end: number }[]): Extension {
  const b = new RangeSetBuilder<Decoration>();
  for (const s of [...spans].sort((x, y) => x.start - y.start)) {
    const start = Math.max(0, Math.min(s.start, doc.length));
    const end = Math.max(start, Math.min(s.end, doc.length));
    if (end > start) b.add(start, end, SENSITIVE);
  }
  const set = b.finish();
  return EditorView.decorations.of(set);
}

function readOnlySide(label: string): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.lineWrapping,
    markdown(),
    markdownHighlight,
    memoryTheme,
    diffTheme,
    EditorView.contentAttributes.of({ "aria-label": label }),
  ];
}

const COLLAPSE = { margin: 2, minSize: 4 };

export function MemoryDiff({
  before,
  after,
  label,
  summary,
  highlights,
  layout = "auto",
  focus,
  className,
}: MemoryDiffProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorsRef = useRef<HTMLDivElement>(null);
  /** The editor that shows `after` (side b, or the unified view), for finding jumps. */
  const afterRef = useRef<EditorView | null>(null);
  const [built, setBuilt] = useState(0);
  const [split, setSplit] = useState<boolean | null>(null);

  // The layout follows the host's own width (a container query in JS: CodeMirror needs to know which view to build).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (layout === "unified") {
      setSplit(false);
      return;
    }
    const measure = () => setSplit(host.getBoundingClientRect().width >= SPLIT_MIN);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [layout]);

  useEffect(() => {
    const parent = editorsRef.current;
    if (!parent || split === null) return;
    const spans = highlights && highlights.length > 0 ? [highlightSpans(after.doc, highlights)] : [];
    if (split) {
      const mv = new MergeView({
        a: { doc: before.doc, extensions: readOnlySide(before.label) },
        b: { doc: after.doc, extensions: [...readOnlySide(after.label), ...spans, focusField] },
        parent,
        gutter: false,
        highlightChanges: true,
        collapseUnchanged: COLLAPSE,
      });
      afterRef.current = mv.b;
      setBuilt((n) => n + 1);
      return () => {
        afterRef.current = null;
        mv.destroy();
      };
    }
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: after.doc,
        extensions: [
          ...readOnlySide(`${before.label} to ${after.label}`),
          unifiedMergeView({
            original: before.doc,
            gutter: false,
            highlightChanges: true,
            mergeControls: false,
            syntaxHighlightDeletions: false,
            collapseUnchanged: COLLAPSE,
          }),
          ...spans,
          focusField,
        ],
      }),
    });
    afterRef.current = view;
    setBuilt((n) => n + 1);
    return () => {
      afterRef.current = null;
      view.destroy();
    };
  }, [split, before.doc, before.label, after.doc, after.label, highlights]);

  // A finding jump: scroll its first line into view (no smooth scrolling) and outline its spans.
  useEffect(() => {
    const view = afterRef.current;
    if (!view || !focus || built === 0) return;
    const line = view.state.doc.line(Math.max(1, Math.min(focus.line, view.state.doc.lines)));
    view.dispatch({
      effects: [setFocusRanges.of(focus.ranges), EditorView.scrollIntoView(line.from, { y: "center" })],
    });
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = window.setTimeout(() => view.dispatch({ effects: setFocusRanges.of([]) }), 2000);
    return () => window.clearTimeout(t);
  }, [focus, built]);

  return (
    <section
      ref={hostRef}
      aria-label={label}
      data-testid="memory-diff"
      data-layout={split === null ? undefined : split ? "split" : "unified"}
      className={cn("flex min-w-0 flex-col font-sans", className)}
    >
      {summary ? <p className="sr-only">{summary}</p> : null}
      {split ? (
        <div aria-hidden className="grid shrink-0 grid-cols-2 border-b text-muted-foreground text-xs">
          <span className="truncate px-4 py-2">{before.label}</span>
          <span className="truncate border-l px-4 py-2">{after.label}</span>
        </div>
      ) : null}
      {/* The scroll area takes keyboard focus so it can be scrolled without a pointer (the panes are read-only). */}
      <div
        ref={editorsRef}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (axe)
        tabIndex={0}
        className="scrollbar-thin min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset [&_.cm-mergeViewEditor+.cm-mergeViewEditor]:border-l"
      />
    </section>
  );
}

export default MemoryDiff;
