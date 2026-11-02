"use client";

import { Markdown } from "@/components/chat/markdown";
import { Spinner } from "@/components/ui/spinner";
import { DIGEST_COPY } from "./digest-form";

export type DigestPreviewState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; markdown: string; empty: boolean }
  | { state: "error" };

/**
 * The preview panel (UI-SPEC Surface 6, R6): the exact Markdown the bot would send now, through the same `<Markdown>`
 * that renders the DM (no raw HTML, `safeUrl` links; T-07.6-16-02). Nothing until Preview is pressed.
 */
export function DigestPreview({ state }: { state: DigestPreviewState }) {
  if (state.state === "idle") return null;
  return (
    <section
      data-testid="digest-preview"
      aria-labelledby="digest-preview-label"
      aria-busy={state.state === "loading" || undefined}
      className="grid gap-2"
    >
      <h2 id="digest-preview-label" className="font-semibold text-[15px] tracking-tight">
        {DIGEST_COPY.preview}
      </h2>
      <div className="min-w-0 rounded-xl border bg-muted/40 p-4 text-sm">
        {state.state === "loading" ? (
          <div className="flex min-h-16 items-center justify-center text-muted-foreground">
            <Spinner />
          </div>
        ) : state.state === "error" ? (
          <p role="alert" className="text-destructive">
            {DIGEST_COPY.previewError}
          </p>
        ) : state.empty ? (
          <p data-testid="digest-preview-empty" className="text-muted-foreground">
            {DIGEST_COPY.previewEmpty}
          </p>
        ) : (
          <div data-testid="digest-preview-body" className="min-w-0 break-words">
            <Markdown body={state.markdown} />
          </div>
        )}
      </div>
    </section>
  );
}
