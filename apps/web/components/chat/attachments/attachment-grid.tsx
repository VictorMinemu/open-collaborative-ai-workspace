"use client";

import type { Attachment } from "@ocw/contracts";
import { ImageOff } from "lucide-react";
import { useState } from "react";
import { useRuntimeConfig } from "@/lib/config";
import { cn } from "@/lib/utils";
import { FileCard } from "./file-card";
import { imageBox } from "./files";

/** Most image tiles shown under a message; the last one carries "+N" for the rest (all open in the lightbox). */
const MAX_TILES = 4;
const SINGLE_MAX_W = 480;
const SINGLE_MAX_H = 360;

/**
 * The files of a message (CHAT-12): images first, as one large preview or a 2-column grid of up to four tiles, then a
 * card per other file. Images load the API's webp preview (never the original, T-04-12-02) with their box reserved
 * from the stored dimensions, so nothing jumps while they load.
 */
export function MessageAttachments({
  attachments,
  onOpenImage,
  className,
}: {
  attachments: Attachment[] | undefined;
  onOpenImage: (index: number) => void;
  /** Extra classes for the column (e.g. `items-end` for a right-aligned Work Zone prompt, 06.1). */
  className?: string;
}) {
  const list = attachments ?? [];
  if (list.length === 0) return null;
  const images = list.filter((a) => a.isImage && a.previewUrl);
  const files = list.filter((a) => !(a.isImage && a.previewUrl));
  return (
    <div className={cn("mt-1.5 flex flex-col gap-1.5", className)} data-testid="message-attachments">
      {images.length === 1 && images[0] ? (
        <SingleImage image={images[0]} onOpen={() => onOpenImage(0)} />
      ) : images.length > 1 ? (
        <ImageGrid images={images} onOpen={onOpenImage} />
      ) : null}
      {files.map((a) => (
        <FileCard key={a.id} attachment={a} />
      ))}
    </div>
  );
}

function Preview({ image, className, sizes }: { image: Attachment; className?: string; sizes?: string }) {
  const { apiUrl } = useRuntimeConfig();
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  if (state === "error") {
    return (
      <span className="flex size-full flex-col items-center justify-center gap-1.5 p-2 text-muted-foreground">
        <ImageOff className="size-5" />
        <span className="max-w-full truncate text-[11.5px]">{image.filename}</span>
      </span>
    );
  }
  return (
    // biome-ignore lint/performance/noImgElement: an authorized API redirect to a short-lived URL, not a static asset
    <img
      src={`${apiUrl}${image.previewUrl}`}
      alt={image.filename}
      width={image.width ?? undefined}
      height={image.height ?? undefined}
      sizes={sizes}
      loading="lazy"
      decoding="async"
      draggable={false}
      data-testid="attachment-image"
      onLoad={() => setState("loaded")}
      onError={() => setState("error")}
      className={cn(
        "size-full object-cover transition-opacity duration-200",
        state === "loading" ? "opacity-0" : "opacity-100",
        className,
      )}
    />
  );
}

const tileClass =
  "relative block overflow-hidden rounded-lg border bg-muted outline-none transition-[filter,box-shadow] hover:brightness-[0.96] focus-visible:ring-[3px] focus-visible:ring-ring/40 dark:hover:brightness-110";

function SingleImage({ image, onOpen }: { image: Attachment; onOpen: () => void }) {
  const box = imageBox(image.width, image.height, SINGLE_MAX_W, SINGLE_MAX_H);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${image.filename}`}
      data-testid="attachment-tile"
      className={cn(tileClass, "max-w-full")}
      style={{ width: box.width, aspectRatio: `${box.width} / ${box.height}` }}
    >
      <Preview image={image} />
    </button>
  );
}

function ImageGrid({ images, onOpen }: { images: Attachment[]; onOpen: (index: number) => void }) {
  const shown = images.slice(0, MAX_TILES);
  const extra = images.length - shown.length;
  return (
    <div className="grid w-full max-w-[26rem] grid-cols-2 gap-1">
      {shown.map((image, i) => {
        // Three images: the first one spans the row, so the grid stays a rectangle.
        const wide = shown.length === 3 && i === 0;
        const more = extra > 0 && i === shown.length - 1;
        return (
          <button
            key={image.id}
            type="button"
            onClick={() => onOpen(i)}
            aria-label={more ? `Open ${image.filename} and ${extra} more` : `Open ${image.filename}`}
            data-testid="attachment-tile"
            className={cn(tileClass, wide ? "col-span-2 aspect-[2/1]" : "aspect-square")}
          >
            <Preview image={image} sizes="(max-width: 640px) 50vw, 208px" />
            {more ? (
              <span className="absolute inset-0 flex items-center justify-center bg-black/50 font-semibold text-white text-xl tracking-tight">
                +{extra}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
