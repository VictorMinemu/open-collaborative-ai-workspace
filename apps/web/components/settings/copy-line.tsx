"use client";

import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopy } from "@/hooks/use-copy";
import { cn } from "@/lib/utils";

/** A one-line command with a copy button (pairing commands, runtime update commands). */
export function CopyLine({
  text,
  buttonClassName,
  testId,
}: {
  text: string;
  buttonClassName?: string;
  testId?: string;
}) {
  const { copy, copied } = useCopy();
  return (
    <div
      className="flex items-center gap-2 rounded-lg border bg-muted/50 py-1.5 pr-1.5 pl-3"
      data-testid={testId}
    >
      <code className="scrollbar-thin min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12px]">
        {text}
      </code>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Copy command"
        className={cn(buttonClassName)}
        onClick={() => void copy(text)}
      >
        {copied === text ? <Check className="text-success" /> : <Copy />}
      </Button>
    </div>
  );
}
