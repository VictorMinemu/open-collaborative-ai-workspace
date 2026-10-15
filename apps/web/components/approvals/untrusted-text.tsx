"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Text a bot or a model wrote, shown to the person who decides (Phase 07.5, UI-SPEC Surface 1 "Untrusted text",
 * T-07.5-13-01): argument values and labels in the action review, the Work Zone prompt, and the chat cards (07.5-14).
 * Text nodes only: never Markdown, HTML or links, so a URL or an email stays exactly what it says. The server has
 * already revealed every invisible character as `⟨U+202E⟩` and masked every secret-looking value (`ES91 •••• 1332`);
 * here a revealed character becomes a named amber chip and a masked run reads in mono. A long value clamps with a
 * Show more / Show less toggle (display only: the full text is already on the page).
 */

/** A revealed invisible character, as the server writes it (`revealInvisible`, uppercase hex, 4 to 6 digits). */
const MARKER = /⟨U\+[0-9A-F]{4,6}⟩/g;
/** A server-masked value: an optional short prefix ("ES91 ", "sk-ant-"), the mask, and the kept end ("1332"). */
const MASKED = /(?:[^\s•⟨⟩]{1,16} ?)?••••(?: [A-Za-z0-9]{1,8})?/g;

export type UntrustedPart =
  | { kind: "text"; text: string }
  | { kind: "marker"; text: string; code: string }
  | { kind: "masked"; text: string };

function splitMasked(text: string, out: UntrustedPart[]): void {
  let last = 0;
  for (const m of text.matchAll(MASKED)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: text.slice(last, at) });
    out.push({ kind: "masked", text: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
}

/** The text cut into plain runs, revealed characters and masked runs; joined back it is the same string. */
export function splitUntrusted(text: string): UntrustedPart[] {
  const out: UntrustedPart[] = [];
  let last = 0;
  for (const m of text.matchAll(MARKER)) {
    const at = m.index ?? 0;
    if (at > last) splitMasked(text.slice(last, at), out);
    out.push({ kind: "marker", text: m[0], code: m[0].slice(1, -1) });
    last = at + m[0].length;
  }
  if (last < text.length) splitMasked(text.slice(last), out);
  return out;
}

/** The chip of one revealed character: read as "hidden character U+202E" (UI-SPEC Accessibility Contract). */
export function HiddenCharacterChip({ text, code }: { text: string; code: string }) {
  return (
    <span
      role="img"
      aria-label={`hidden character ${code}`}
      data-testid="hidden-character"
      className="mx-px inline-block rounded bg-amber-100 px-1 align-baseline font-mono text-[11px] text-amber-900 leading-4 dark:bg-amber-400/15 dark:text-amber-200"
    >
      {text}
    </span>
  );
}

/** The parts of an untrusted string as React nodes: text, chips and mono masked runs (no element is ever a link). */
export function untrustedNodes(text: string): ReactNode[] {
  return splitUntrusted(text).map((p, i) => {
    switch (p.kind) {
      case "marker":
        // biome-ignore lint/suspicious/noArrayIndexKey: parts of one immutable string, never reordered
        return <HiddenCharacterChip key={i} text={p.text} code={p.code} />;
      case "masked":
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts of one immutable string, never reordered
          <span key={i} data-testid="masked-value" className="font-mono text-[0.92em]">
            {p.text}
          </span>
        );
      default:
        return p.text;
    }
  });
}

/** Characters per line a clamp estimate assumes before the browser measures. */
const CHARS_PER_LINE = 80;

export interface UntrustedTextProps {
  text: string;
  /** Clamp to this many lines with Show more when the value is longer. */
  clampLines?: number;
  /** The whole value in mono (technical values). */
  mono?: boolean;
  className?: string;
  /** For tests and anchors: the text container's id (default generated). */
  id?: string;
  "data-testid"?: string;
}

export function UntrustedText({
  text,
  clampLines,
  mono = false,
  className,
  id,
  "data-testid": testId,
}: UntrustedTextProps) {
  const generated = useId();
  const textId = id ?? `untrusted-${generated.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ref = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  // Before the browser measures, guess from line breaks and length; after, trust the layout.
  const guess =
    clampLines !== undefined &&
    (text.split("\n").length > clampLines || text.length > clampLines * CHARS_PER_LINE);
  const [overflows, setOverflows] = useState(guess);

  useEffect(() => {
    if (clampLines === undefined) return;
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [clampLines, expanded]);

  const body = (
    <span
      ref={ref}
      id={textId}
      data-testid={testId}
      className={cn(
        "whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
        mono && "font-mono",
        clampLines !== undefined ? "block" : null,
        clampLines === undefined ? className : null,
      )}
      style={
        clampLines !== undefined && !expanded
          ? {
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: clampLines,
              overflow: "hidden",
            }
          : undefined
      }
    >
      {untrustedNodes(text)}
    </span>
  );
  if (clampLines === undefined) return body;
  return (
    <span className={cn("grid min-w-0 justify-items-start gap-1", className)}>
      {body}
      {overflows ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto min-h-6 px-0 max-lg:min-h-11"
          aria-expanded={expanded}
          aria-controls={textId}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </span>
  );
}
