"use client";

import { ImageUp } from "lucide-react";
import { type DragEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const carriesFiles = (e: DragEvent | globalThis.DragEvent) =>
  Array.from(e.dataTransfer?.types ?? []).includes("Files");

/**
 * Drag-and-drop target for a conversation pane (CHAT-12): while files are dragged over it, an overlay says where
 * they will go; dropping hands them to the composer. Disabled (no storage, or no permission), it is a plain wrapper
 * and the browser's default drop behaviour is untouched (P-10). Enabled, a file dropped just outside the pane does
 * not navigate the tab away to the file.
 */
export function DropZone({
  conversationLabel,
  enabled,
  onFiles,
  children,
  hint,
  className,
}: {
  conversationLabel: string;
  enabled: boolean;
  onFiles: (files: File[]) => void;
  children: ReactNode;
  /** A second line, e.g. the limits. */
  hint?: string;
  className?: string;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const guard = (e: globalThis.DragEvent) => {
      if (carriesFiles(e)) e.preventDefault();
    };
    window.addEventListener("dragover", guard);
    window.addEventListener("drop", guard);
    return () => {
      window.removeEventListener("dragover", guard);
      window.removeEventListener("drop", guard);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      depth.current = 0;
      setOver(false);
    }
  }, [enabled]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the paperclip is the keyboard path
    <div
      data-testid="drop-zone"
      data-dragging={over ? "true" : undefined}
      className={cn("relative flex min-h-0 flex-1 flex-col", className)}
      onDragEnter={(e) => {
        if (!enabled || !carriesFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!enabled || !carriesFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={() => {
        if (!enabled) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        if (!enabled) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length > 0) onFiles(files);
      }}
    >
      {children}
      {over ? (
        <div
          data-testid="drop-zone-overlay"
          className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-primary/60 border-dashed bg-background/90 text-center backdrop-blur-sm sm:inset-3"
        >
          <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <ImageUp className="size-7" />
          </span>
          <div className="px-6">
            <p className="font-semibold text-[15px] tracking-tight">
              Drop files to share in {conversationLabel}
            </p>
            {hint ? <p className="mt-0.5 text-muted-foreground text-xs">{hint}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
