"use client";

import { memo } from "react";
import { Markdown as SharedMarkdown } from "@/components/markdown/markdown";

/** Safe markdown (no raw HTML) for the session stream: the shared renderer's document variant (04-02, D-05). */
export const Markdown = memo(function Markdown({
  text,
  className,
  streaming,
}: {
  text: string;
  className?: string;
  streaming?: boolean;
}) {
  return <SharedMarkdown text={text} variant="document" streaming={streaming} className={className} />;
});
