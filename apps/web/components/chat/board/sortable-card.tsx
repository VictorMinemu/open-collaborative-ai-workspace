"use client";

import { KeyboardSensor, PointerSensor } from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { GripVertical } from "lucide-react";
import { useRef } from "react";
import { cn } from "@/lib/utils";
import { CardTile, type CardTileProps } from "./card-tile";

/**
 * A card tile that can be dragged (07.1-UI-SPEC Interaction Contract › Drag and drop, Keyboard move; BOARD-03, D-04).
 * One of the two dnd-kit importers (P-05). Rendered only for viewers who can post: read-only viewers get a plain
 * `CardTile`, so dnd-kit never marks their tiles as draggable.
 *
 * - **Desktop:** the grip button is the handle (faint at rest, full on hover or focus, so the title indent it reserves reads as a control) (keyboard: Space/Enter, arrows, Space/Enter, Escape); a pointer drag
 *   starts anywhere on the tile after 5 px, so a click still opens the thread.
 * - **Touch (390):** no grip; a 250 ms press with 5 px tolerance on the tile starts a reorder within the column, so a
 *   swipe still scrolls and a tap still opens. The open button is the handle, which keeps dnd-kit's ARIA on a button.
 */

type PointerOptions = NonNullable<Parameters<typeof PointerSensor.configure>[0]>;
type Activation = Extract<
  NonNullable<PointerOptions["activationConstraints"]>,
  (...args: never[]) => unknown
>;
type Source = Parameters<Activation>[1];

/**
 * Touch keeps dnd-kit's default (hold 250 ms, 5 px tolerance). Mouse and pen take only the distance part of the
 * default for a press off the handle (5 px): the default's 200 ms hold would turn a slow click into a drag.
 */
const activation: Activation = (event, source) => {
  const base = PointerSensor.defaults.activationConstraints;
  if (typeof base !== "function") return base;
  if (event.pointerType === "touch") return base(event, source);
  const offHandle = base(event, { handle: undefined, element: source.element } as unknown as Source);
  return offHandle && offHandle.length > 1 ? offHandle.slice(-1) : offHandle;
};

const pointer = PointerSensor.configure({
  activatorElements: (source) => [source.element],
  activationConstraints: activation,
  // The card menu is its own control; everything else on the tile (grip, open button) may start a drag.
  preventActivation: (event) =>
    event.target instanceof Element && event.target.closest('[data-slot="card-menu"]') !== null,
});
const DESKTOP_SENSORS = [pointer, KeyboardSensor];
const TOUCH_SENSORS = [pointer];

export type SortableCardProps = Omit<CardTileProps, "grip" | "appearance" | "canPost"> & {
  index: number;
  columnId: string;
  mode: "desktop" | "touch";
  /** Sortable shift transitions off under reduced motion. */
  reducedMotion: boolean;
};

export function SortableCard({
  index,
  columnId,
  mode,
  reducedMotion,
  card,
  className,
  openRef,
  ...tile
}: SortableCardProps) {
  const gripRef = useRef<HTMLButtonElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const desktop = mode === "desktop";
  const { ref, isDragSource } = useSortable({
    id: card.messageId,
    index,
    group: columnId,
    type: "card",
    accept: "card",
    handle: desktop ? gripRef : openButtonRef,
    sensors: desktop ? DESKTOP_SENSORS : TOUCH_SENSORS,
    transition: reducedMotion ? { duration: 0 } : undefined,
  });

  const setOpen = (el: HTMLButtonElement | null) => {
    openButtonRef.current = el;
    if (typeof openRef === "function") openRef(el);
    else if (openRef) openRef.current = el;
  };

  return (
    <CardTile
      ref={ref}
      card={card}
      canPost
      openRef={setOpen}
      appearance={isDragSource ? "placeholder" : "default"}
      className={cn(
        "relative",
        // The drop line: where the card lands, over the placeholder (UI-SPEC Accent 3).
        isDragSource &&
          "before:absolute before:inset-x-1 before:-top-[5px] before:z-10 before:h-0.5 before:rounded-full before:bg-primary",
        !desktop && "select-none [-webkit-touch-callout:none]",
        className,
      )}
      grip={
        desktop ? (
          <button
            ref={gripRef}
            type="button"
            data-slot="card-grip-button"
            aria-label={`Move card ${card.title}`}
            aria-roledescription="draggable card"
            className="-ml-1 inline-flex size-5 cursor-grab items-center justify-center rounded text-muted-foreground opacity-40 outline-none transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/40 group-hover/tile:opacity-100 group-focus-within/tile:opacity-100 active:cursor-grabbing"
          >
            <GripVertical className="size-4" aria-hidden />
          </button>
        ) : undefined
      }
      {...tile}
    />
  );
}
