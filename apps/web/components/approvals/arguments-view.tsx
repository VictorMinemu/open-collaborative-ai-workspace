"use client";

import { Braces, ChevronDown } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { untrustedNodes } from "./untrusted-text";

/**
 * "All arguments" of an action review (Phase 07.5, D-02, UI-SPEC Surface 2, R7, Pitfall 6): the server's pretty
 * canonical JSON, exactly as given, because approval binds to exactly this object. Never parsed, re-sorted or
 * re-serialized here and never syntax-coloured by a library: a tiny tokenizer over the given string gives keys,
 * strings and punctuation their tone as plain spans; revealed invisible characters (`⟨U+202E⟩`) become chips. The
 * viewer is always rendered, scrolls inside itself (480 px, 360 px on phones) and is a focusable named region;
 * Expand only removes the max height.
 */

/** "512 B", "1.2 KB", "32 KB" (one decimal, none when whole). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = Math.round((n / 1024) * 10) / 10;
  return `${Number.isInteger(kb) ? kb.toFixed(0) : kb.toFixed(1)} KB`;
}

export type JsonToken = { kind: "key" | "string" | "punct" | "plain"; text: string };

/** A string literal (escapes kept; an unterminated one at the end of a cut text runs to the end), or one punctuation. */
const TOKEN = /"(?:[^"\\]|\\.)*(?:"|$)|[{}[\],:]/g;

/** The given text as tokens; joined back it is the same string. A string followed by `:` is a key. */
export function tokenizeJson(json: string): JsonToken[] {
  const out: JsonToken[] = [];
  let last = 0;
  const push = (t: JsonToken) => {
    const prev = out[out.length - 1];
    if (t.kind === "plain" && prev?.kind === "plain") prev.text += t.text;
    else out.push(t);
  };
  for (const m of json.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) push({ kind: "plain", text: json.slice(last, at) });
    const text = m[0];
    if (text.startsWith('"')) {
      const key = /^\s*:/.test(json.slice(at + text.length));
      push({ kind: key ? "key" : "string", text });
    } else {
      push({ kind: "punct", text });
    }
    last = at + text.length;
  }
  if (last < json.length) push({ kind: "plain", text: json.slice(last) });
  return out;
}

const TONE: Record<JsonToken["kind"], string> = {
  key: "text-foreground",
  string: "text-foreground/80",
  punct: "text-muted-foreground",
  plain: "",
};

export function ArgumentsView({
  json,
  bytes,
  initialExpanded = false,
}: {
  json: string;
  bytes: number;
  /** Starts expanded (tests). */
  initialExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const regionId = useId();
  const size = formatBytes(bytes);
  return (
    <div data-testid="arguments-view" className="grid min-w-0 gap-2">
      <div className="flex min-h-8 items-center gap-2">
        <Braces aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <h2 className="font-semibold text-muted-foreground text-xs uppercase tracking-wider">
          All arguments
        </h2>
        <span aria-hidden className="text-muted-foreground text-xs">
          ·
        </span>
        <span data-testid="arguments-size" className="text-muted-foreground text-xs tabular-nums">
          {size}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="arguments-expand"
          className="ml-auto max-lg:h-11"
          aria-expanded={expanded}
          aria-controls={regionId}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Collapse" : "Expand"}
          <ChevronDown
            aria-hidden
            className={cn("transition-transform motion-reduce:transition-none", expanded && "rotate-180")}
          />
        </Button>
      </div>
      <pre
        id={regionId}
        role="region"
        aria-label={`All arguments, ${size}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (axe scrollable-region-focusable)
        tabIndex={0}
        data-testid="arguments-json"
        data-expanded={expanded}
        className={cn(
          "min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/40 px-4 py-3 font-mono text-xs leading-5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 dark:bg-white/[0.03]",
          !expanded && "max-h-[480px] max-sm:max-h-[360px]",
        )}
      >
        {tokenizeJson(json).map((t, i) =>
          t.kind === "plain" ? (
            t.text
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: tokens of one immutable string, never reordered
            <span key={i} className={TONE[t.kind]}>
              {t.kind === "punct" ? t.text : untrustedNodes(t.text)}
            </span>
          ),
        )}
      </pre>
    </div>
  );
}
