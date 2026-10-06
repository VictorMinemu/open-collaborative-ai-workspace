"use client";

import { Dialog } from "@base-ui/react/dialog";
import type { Attachment } from "@ocw/contracts";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { type KeyboardEvent, type SyntheticEvent, useRef, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { useRuntimeConfig } from "@/lib/config";
import { cn } from "@/lib/utils";
import { formatBytes } from "./files";

const SWIPE_PX = 50;

const iconButton =
  "inline-flex size-10 shrink-0 items-center justify-center rounded-full text-white/85 outline-none transition-colors hover:bg-white/15 hover:text-white focus-visible:ring-[3px] focus-visible:ring-white/40";

/**
 * Full-screen image viewer (CHAT-12): the large webp rendition (never the original), previous/next with the arrow keys,
 * the buttons or a swipe, a download through the API, and Escape or × to close. Events never bubble to the message row
 * behind it (a tap there opens the thread on phones).
 */
export function Lightbox({
  images,
  index,
  onClose,
}: {
  images: Attachment[];
  index: number;
  onClose: () => void;
}) {
  const { apiUrl } = useRuntimeConfig();
  const [current, setCurrent] = useState(() => Math.min(Math.max(0, index), images.length - 1));
  const [loaded, setLoaded] = useState<string | null>(null);
  const swipe = useRef<{ x: number; id: number } | null>(null);
  const image = images[current];
  if (!image) return null;
  const many = images.length > 1;
  const go = (delta: number) => setCurrent((i) => (i + delta + images.length) % images.length);
  const stop = (e: SyntheticEvent) => e.stopPropagation();

  const onKeyDown = (e: KeyboardEvent) => {
    if (!many) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      go(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(-1);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: only stops React events from reaching the message row
    <div className="contents" onClick={stop} onPointerDown={stop} onPointerUp={stop} onContextMenu={stop}>
      <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/95 backdrop-blur-sm transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
          <Dialog.Popup
            data-testid="lightbox"
            aria-label={image.filename}
            onKeyDown={onKeyDown}
            className="fixed inset-0 z-50 flex flex-col text-white outline-none transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0"
          >
            <header className="flex shrink-0 items-center gap-2 px-3 pt-[max(env(safe-area-inset-top),8px)] pb-2 sm:px-4">
              <div className="min-w-0 flex-1 px-1">
                <Dialog.Title className="truncate font-medium text-[14px] leading-5">
                  {image.filename}
                </Dialog.Title>
                <p className="text-[12px] text-white/60 tabular-nums">
                  {many ? `${current + 1} of ${images.length} · ` : ""}
                  {image.width && image.height ? `${image.width} × ${image.height} · ` : ""}
                  {formatBytes(image.size)}
                </p>
              </div>
              <a
                href={`${apiUrl}${image.downloadUrl}`}
                data-testid="lightbox-download"
                aria-label={`Download ${image.filename}`}
                title="Download"
                rel="noopener"
                className={iconButton}
              >
                <Download className="size-5" />
              </a>
              <Dialog.Close aria-label="Close" data-testid="lightbox-close" className={iconButton}>
                <X className="size-5" />
              </Dialog.Close>
            </header>

            {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: swipe and click-outside; the buttons and arrow keys do the same */}
            <div
              className="relative flex min-h-0 flex-1 items-center justify-center px-2 pb-[max(env(safe-area-inset-bottom),12px)] sm:px-16"
              onPointerDown={(e) => {
                if (e.pointerType === "touch") swipe.current = { x: e.clientX, id: e.pointerId };
              }}
              onPointerUp={(e) => {
                const s = swipe.current;
                swipe.current = null;
                if (!s || s.id !== e.pointerId || !many) return;
                const dx = e.clientX - s.x;
                if (Math.abs(dx) > SWIPE_PX) go(dx < 0 ? 1 : -1);
              }}
              onClick={(e) => {
                // A click on the dark area around the image closes, like a backdrop.
                if (e.target === e.currentTarget) onClose();
              }}
            >
              {loaded !== image.id ? <Spinner className="absolute size-6 text-white/70" /> : null}
              {/* biome-ignore lint/performance/noImgElement: an authorized API redirect to a short-lived URL */}
              <img
                key={image.id}
                src={`${apiUrl}${image.largeUrl ?? image.previewUrl}`}
                alt={image.filename}
                draggable={false}
                data-testid="lightbox-image"
                onLoad={() => setLoaded(image.id)}
                onError={() => setLoaded(image.id)}
                className={cn(
                  "max-h-full max-w-full select-none rounded-sm object-contain shadow-2xl transition-opacity duration-200",
                  loaded === image.id ? "opacity-100" : "opacity-0",
                )}
              />
              {many ? (
                <>
                  <button
                    type="button"
                    aria-label="Previous image"
                    data-testid="lightbox-prev"
                    onClick={() => go(-1)}
                    className={cn(iconButton, "absolute left-2 bg-black/40 sm:left-4")}
                  >
                    <ChevronLeft className="size-6" />
                  </button>
                  <button
                    type="button"
                    aria-label="Next image"
                    data-testid="lightbox-next"
                    onClick={() => go(1)}
                    className={cn(iconButton, "absolute right-2 bg-black/40 sm:right-4")}
                  >
                    <ChevronRight className="size-6" />
                  </button>
                </>
              ) : null}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
