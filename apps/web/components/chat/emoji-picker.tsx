"use client";

import { EmojiPicker as Frimousse } from "frimousse";
import { Search } from "lucide-react";
import { type ReactElement, useState } from "react";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { useIsDesktop } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

/**
 * Emoji data is served by this app (public/emojibase, copied from emojibase-data), never from frimousse's default
 * CDN: the picker works on air-gapped self-hosted installs and no browser talks to a third party (principle 10).
 */
const EMOJIBASE_URL = "/emojibase/17.0.0";

/** The frimousse picker itself: search, skin tones, sticky categories, keyboard navigation, live preview. */
function PickerBody({
  onPick,
  columns,
  compact,
}: {
  onPick(emoji: string): void;
  columns: number;
  compact: boolean;
}) {
  return (
    <Frimousse.Root
      data-testid="emoji-picker"
      emojibaseUrl={EMOJIBASE_URL}
      locale="en"
      columns={columns}
      onEmojiSelect={({ emoji }) => onPick(emoji)}
      className={cn("isolate flex w-full flex-col", compact ? "min-h-0 flex-1" : "h-[392px]")}
    >
      <div className="flex items-center gap-1.5 p-2 pb-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Frimousse.Search
            data-testid="emoji-search"
            aria-label="Search emoji"
            placeholder="Search emoji"
            className="h-9 w-full appearance-none rounded-lg border bg-background pr-2.5 pl-8 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 sm:text-sm"
          />
        </div>
        <Frimousse.SkinToneSelector
          aria-label="Change skin tone"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-lg outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40"
        />
      </div>
      <Frimousse.Viewport className="scrollbar-thin relative min-h-0 flex-1 outline-none">
        <Frimousse.Loading className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          <Spinner />
        </Frimousse.Loading>
        <Frimousse.Empty className="absolute inset-0 flex items-center justify-center px-6 text-center text-muted-foreground text-sm">
          {({ search }) => `No emoji match "${search}"`}
        </Frimousse.Empty>
        <Frimousse.List
          className="select-none pb-1.5"
          components={{
            CategoryHeader: ({ category, ...props }) => (
              <div
                className={cn(
                  "px-3 pt-2.5 pb-1 font-medium text-[11.5px] text-muted-foreground",
                  compact ? "bg-background" : "bg-popover",
                )}
                {...props}
              >
                {category.label}
              </div>
            ),
            Row: ({ children, ...props }) => (
              <div
                className={cn("scroll-my-1.5", compact ? "flex justify-between px-2.5" : "px-1.5")}
                {...props}
              >
                {children}
              </div>
            ),
            Emoji: ({ emoji, ...props }) => (
              <button
                type="button"
                data-testid="emoji-option"
                data-emoji={emoji.emoji}
                className="flex size-9 items-center justify-center rounded-lg text-[22px] leading-none data-[active]:bg-accent"
                {...props}
              >
                {emoji.emoji}
              </button>
            ),
          }}
        />
      </Frimousse.Viewport>
      <div className="flex h-10 items-center gap-2 border-t px-3 text-muted-foreground text-xs">
        <Frimousse.ActiveEmoji>
          {({ emoji }) =>
            emoji ? (
              <>
                <span className="text-xl leading-none">{emoji.emoji}</span>
                <span className="truncate font-medium text-foreground">{emoji.label}</span>
              </>
            ) : (
              <span>Pick an emoji…</span>
            )
          }
        </Frimousse.ActiveEmoji>
      </div>
    </Frimousse.Root>
  );
}

/**
 * The full emoji picker (CHAT-07). Desktop: a popover anchored to `trigger`. Narrow screens: a bottom sheet. Without
 * a `trigger` it is a sheet controlled through `open` / `onOpenChange` (e.g. opened from the long-press sheet).
 */
export function EmojiPicker({
  onPick,
  trigger,
  open: openProp,
  onOpenChange,
  title = "Add reaction",
}: {
  onPick(emoji: string): void;
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?(open: boolean): void;
  title?: string;
}) {
  const isDesktop = useIsDesktop();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (o: boolean) => {
    setOpenState(o);
    onOpenChange?.(o);
  };
  const pick = (emoji: string) => {
    setOpen(false);
    onPick(emoji);
  };

  // Without a trigger there is nothing to anchor a popover to: the sheet serves every width.
  if (isDesktop && trigger) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger render={trigger} />
        <PopoverContent
          side="top"
          align="end"
          className="w-[352px] overflow-hidden p-0"
          data-testid="emoji-picker-popover"
        >
          <PopoverTitle className="sr-only">{title}</PopoverTitle>
          {open ? <PickerBody onPick={pick} columns={9} compact={false} /> : null}
        </PopoverContent>
      </Popover>
    );
  }
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {trigger ? <SheetTrigger render={trigger} /> : null}
      <SheetContent
        side="bottom"
        showClose={false}
        // The keyboard would cover half the grid: the search takes focus only when tapped.
        initialFocus={false}
        data-testid="emoji-picker-sheet"
        className="h-[min(560px,78dvh)] gap-0 overflow-hidden pt-2 pb-[env(safe-area-inset-bottom)]"
      >
        <div aria-hidden className="mx-auto mb-1 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/25" />
        <SheetTitle className="px-4 pt-1 pb-0.5 font-semibold text-sm">{title}</SheetTitle>
        {open ? <PickerBody onPick={pick} columns={9} compact /> : null}
      </SheetContent>
    </Sheet>
  );
}
