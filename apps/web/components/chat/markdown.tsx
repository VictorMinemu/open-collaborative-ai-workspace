"use client";

import { memo } from "react";
import {
  MentionContext,
  type MentionContextValue,
  type MentionTarget,
  Markdown as SharedMarkdown,
} from "@/components/markdown/markdown";

export type { MentionContextValue, MentionTarget };
// The chat surfaces keep their import path; the renderer itself is shared (04-02, D-05).
export { MentionContext };

/** Message body: GitHub-flavoured markdown, highlighted code, @mention chips. Raw HTML is never rendered. */
export const Markdown = memo(function Markdown({ body, className }: { body: string; className?: string }) {
  return <SharedMarkdown text={body} variant="chat" className={className} />;
});
