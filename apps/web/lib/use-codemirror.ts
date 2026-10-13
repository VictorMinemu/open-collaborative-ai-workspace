"use client";

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import {
  Compartment,
  EditorState,
  type Extension,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  highlightActiveLine,
  keymap,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

/**
 * A plain CodeMirror 6 Markdown editor for memory files (Phase 07.2, 07.2-12, D-03, UI-SPEC "Desktop Edit mode"): no
 * wrapper library. History, the default and history keymaps (neither binds Tab, so keyboard users can always leave),
 * Markdown, line wrapping, Mod-S to save, and a theme built only from the app's CSS variables so one theme serves
 * light and dark. Only imported by lazy components (`memory-editor`, `memory-diff`): reading never loads it.
 */

/**
 * Tailwind palette values used by the diff and secret styles (UI-SPEC "Diff colours", "Secret refused"). CodeMirror
 * injects unlayered styles, so these live in its theme instead of utility classes; the values are Tailwind 4's.
 */
export const PALETTE = {
  emerald400: "oklch(76.5% 0.177 163.223)",
  emerald600: "oklch(59.6% 0.145 163.225)",
  emerald700: "oklch(50.8% 0.118 165.612)",
  red50: "oklch(97.1% 0.013 17.38)",
  red400: "oklch(70.4% 0.191 22.216)",
  red600: "oklch(57.7% 0.245 27.325)",
  red700: "oklch(50.5% 0.213 27.518)",
  amber200: "oklch(92.4% 0.12 95.746)",
  amber300: "oklch(87.9% 0.169 91.605)",
  amber400: "oklch(82.8% 0.189 84.429)",
  amber700: "oklch(55.5% 0.163 48.998)",
} as const;

const mix = (v: string, pct: number) => `color-mix(in oklch, ${v} ${pct}%, transparent)`;

/** The shared look of every memory CodeMirror surface: app fonts and colours, 14/22 text, primary caret. */
export const memoryTheme: Extension = EditorView.theme({
  "&": { color: "var(--foreground)", backgroundColor: "transparent", fontSize: "14px", height: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "22px", overflow: "auto" },
  ".cm-content": { padding: "16px 0", caretColor: "var(--primary)" },
  ".cm-line": { padding: "0 16px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: `${mix("var(--primary)", 20)} !important` },
  ".cm-activeLine": { backgroundColor: mix("var(--muted)", 40) },
  // A line holding a refused secret: red tint and a 3 px bar (UI-SPEC "Secret refused").
  "&.cm-editor .cm-line.cm-secretLine": {
    backgroundColor: PALETTE.red50,
    boxShadow: `inset 3px 0 0 ${PALETTE.red600}`,
  },
  ".dark &.cm-editor .cm-line.cm-secretLine": {
    backgroundColor: mix(PALETTE.red400, 10),
    boxShadow: `inset 3px 0 0 ${PALETTE.red400}`,
  },
});

/** Markdown highlighting from the app palette, by syntax node name (UI-SPEC "Desktop Edit mode"). */
const MARK_CLASS: Record<string, string> = {
  ATXHeading1: "font-semibold text-foreground",
  ATXHeading2: "font-semibold text-foreground",
  ATXHeading3: "font-semibold text-foreground",
  ATXHeading4: "font-semibold text-foreground",
  ATXHeading5: "font-semibold text-foreground",
  ATXHeading6: "font-semibold text-foreground",
  SetextHeading1: "font-semibold text-foreground",
  SetextHeading2: "font-semibold text-foreground",
  Emphasis: "italic",
  StrongEmphasis: "font-semibold",
  Link: "text-primary",
  URL: "text-primary",
  Autolink: "text-primary",
  InlineCode: "rounded-sm bg-muted font-mono text-[13px]",
  Blockquote: "text-muted-foreground",
  HeaderMark: "text-muted-foreground",
  ListMark: "text-muted-foreground",
  QuoteMark: "text-muted-foreground",
  EmphasisMark: "text-muted-foreground",
  LinkMark: "text-muted-foreground",
};
const CODE_LINE = Decoration.line({ class: "bg-muted/60 font-mono text-[13px]" });
const marks = new Map(
  Object.entries(MARK_CLASS).map(([name, cls]) => [name, Decoration.mark({ class: cls })]),
);

function highlight(view: EditorView): DecorationSet {
  const ranges: { from: number; to: number; deco: Decoration; line: boolean }[] = [];
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name === "FencedCode" || node.name === "CodeBlock") {
          const first = view.state.doc.lineAt(node.from).number;
          const last = view.state.doc.lineAt(node.to).number;
          for (let n = first; n <= last; n++) {
            const pos = view.state.doc.line(n).from;
            ranges.push({ from: pos, to: pos, deco: CODE_LINE, line: true });
          }
          return false;
        }
        const deco = marks.get(node.name);
        if (deco && node.to > node.from) ranges.push({ from: node.from, to: node.to, deco, line: false });
        return undefined;
      },
    });
  }
  // Line decorations first at a position, then marks by start (RangeSetBuilder needs sorted input).
  ranges.sort((a, b) => a.from - b.from || Number(b.line) - Number(a.line) || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  let lastLine = -1;
  for (const r of ranges) {
    if (r.line) {
      if (r.from === lastLine) continue;
      lastLine = r.from;
    }
    builder.add(r.from, r.to, r.deco);
  }
  return builder.finish();
}

export const markdownHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = highlight(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = highlight(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------------------------------------------------------------- secret lines

const setSecretLinesEffect = StateEffect.define<readonly number[]>();
const SECRET_LINE = Decoration.line({ class: "cm-secretLine" });

const secretLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setSecretLinesEffect)) continue;
      const b = new RangeSetBuilder<Decoration>();
      for (const n of [...e.value].sort((a, z) => a - z)) {
        if (n >= 1 && n <= tr.state.doc.lines)
          b.add(tr.state.doc.line(n).from, tr.state.doc.line(n).from, SECRET_LINE);
      }
      next = b.finish();
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Marks the lines a refused secret was found on (1-based); an empty list clears them. */
export function setSecretLines(view: EditorView, lines: readonly number[]): void {
  view.dispatch({ effects: setSecretLinesEffect.of(lines) });
}

/** Scrolls to a 1-based line, puts the caret at its start and focuses the editor ("Go to line N"). */
export function goToLine(view: EditorView, line: number): void {
  const n = Math.min(Math.max(line, 1), view.state.doc.lines);
  const pos = view.state.doc.line(n).from;
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
  view.focus();
}

// ---------------------------------------------------------------- hook

export interface UseCodeMirrorOptions {
  doc: string;
  /** The editor's accessible name ("Markdown source of clients/acme.md"). */
  label: string;
  readOnly?: boolean;
  onChange?: (doc: string) => void;
  onSave?: () => void;
}

/**
 * Mounts one editor into `parent` for the component's lifetime (destroyed on unmount). `doc` is the initial text only;
 * `setDoc` replaces the content without recreating the view. Callbacks may change between renders.
 */
export function useCodeMirror(
  parent: RefObject<HTMLDivElement | null>,
  opts: UseCodeMirrorOptions,
): { view: EditorView | null; setDoc: (doc: string) => void } {
  const [view, setView] = useState<EditorView | null>(null);
  const latest = useRef(opts);
  latest.current = opts;
  const readOnly = useRef(new Compartment());

  // biome-ignore lint/correctness/useExhaustiveDependencies: created once per mount; options are read through `latest`
  useEffect(() => {
    const host = parent.current;
    if (!host) return;
    const ro = latest.current.readOnly === true;
    const v = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: latest.current.doc,
        extensions: [
          history(),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                latest.current.onSave?.();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          markdown(),
          markdownHighlight,
          EditorView.lineWrapping,
          highlightActiveLine(),
          memoryTheme,
          secretLines,
          readOnly.current.of([EditorState.readOnly.of(ro), EditorView.editable.of(!ro)]),
          EditorView.contentAttributes.of({ "aria-label": latest.current.label, "aria-multiline": "true" }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) latest.current.onChange?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    setView(v);
    return () => {
      v.destroy();
      setView(null);
    };
  }, []);

  useEffect(() => {
    if (!view) return;
    const ro = opts.readOnly === true;
    view.dispatch({
      effects: readOnly.current.reconfigure([EditorState.readOnly.of(ro), EditorView.editable.of(!ro)]),
    });
  }, [view, opts.readOnly]);

  const setDoc = useCallback(
    (doc: string) => {
      if (!view || view.state.doc.toString() === doc) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
    },
    [view],
  );

  return { view, setDoc };
}
