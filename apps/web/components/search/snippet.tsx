import { splitSnippet } from "@ocw/contracts";
import { cn } from "@/lib/utils";

/**
 * A search snippet: plain text runs and `<mark>` runs from the API's private-use markers (T-04-06-04). React
 * escapes every run; nothing is ever rendered as HTML.
 */
export function Snippet({ text, className }: { text: string; className?: string }) {
  const parts = splitSnippet(text);
  return (
    <span className={cn("break-words", className)}>
      {parts.map((p, i) =>
        p.mark ? (
          <mark
            // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and never reorder
            key={i}
            className="rounded-[3px] bg-amber-200/80 px-0.5 font-medium text-foreground dark:bg-amber-400/25 dark:text-amber-100"
          >
            {p.text}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and never reorder
          <span key={i}>{p.text}</span>
        ),
      )}
    </span>
  );
}
