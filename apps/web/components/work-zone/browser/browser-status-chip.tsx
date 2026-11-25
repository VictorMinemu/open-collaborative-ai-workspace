"use client";

import type { WorkSessionBrowserState } from "@ocw/contracts";
import { Globe, GlobeOff } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type Status = WorkSessionBrowserState["status"];

/**
 * 07.13 (D-19): what the footer says about the session's browser, and who can change it. The browser needs three
 * switches (D-10): the organization's policy, the device owner's opt-in and a device that reports the capability.
 */
export const BROWSER_CHIP_COPY: Record<Status, { label: string; tip: string }> = {
  available: { label: "Browser", tip: "Agents in this session can open web pages on its device" },
  off_policy: {
    label: "Browser off (organization)",
    tip: "A workspace admin can allow it in Settings › Work Zone policy",
  },
  off_device: {
    label: "Browser off on this device",
    tip: "The device's owner can allow it from the OCW desktop app or with ocw-runtime browser on",
  },
  update_device: {
    label: "Update this device to use the browser",
    tip: "The device's owner can update the OCW desktop app or the runtime on that device",
  },
};

/** The chip's label and tooltip for a state ("Browser · live" while a page is open). */
export function browserChipCopy(state: WorkSessionBrowserState): { label: string; tip: string } {
  const copy = BROWSER_CHIP_COPY[state.status];
  return state.status === "available" && state.live ? { ...copy, label: "Browser · live" } : copy;
}

/**
 * The session footer's browser chip (D-19). Viewer-neutral: it reads only the session DTO's `browser` field and renders
 * nothing when an older API sends none. A tap or a click opens the explanation (tooltips never open on touch). From
 * 640 px it is a 24 px pill with the label, truncated when the footer is tight; below, the footer has no room for
 * text, so it is the icon alone (crossed out when off, amber when the device needs an update) in a 44 × 44 button whose
 * accessible name is the label and the explanation (its negative margin lends the footer's gaps to the hit area).
 */
export function BrowserStatusChip({ state }: { state: WorkSessionBrowserState | undefined }) {
  if (!state) return null;
  const { label, tip } = browserChipCopy(state);
  const on = state.status === "available";
  const off = state.status === "off_policy" || state.status === "off_device";
  const Icon = off ? GlobeOff : Globe;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-testid="browser-status-chip"
            data-status={state.status}
            aria-label={`${label}. ${tip}`}
            title={tip}
            className="group flex h-full shrink-0 items-center justify-center rounded-full outline-none max-sm:-mx-2 max-sm:min-h-11 max-sm:min-w-11 sm:min-w-0 sm:shrink"
          >
            <span
              className={cn(
                "relative inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-full px-2 font-medium text-[12px] transition-colors group-focus-visible:ring-[3px] group-focus-visible:ring-ring/40 max-sm:w-6 max-sm:justify-center max-sm:px-0",
                state.status === "update_device"
                  ? "bg-warning/15 text-amber-800 group-hover:bg-warning/25 group-data-popup-open:bg-warning/25 dark:text-amber-300"
                  : on
                    ? "bg-muted text-foreground group-hover:bg-accent group-data-popup-open:bg-accent"
                    : "bg-muted/60 text-muted-foreground group-hover:bg-accent group-data-popup-open:bg-accent",
              )}
            >
              <Icon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate max-sm:sr-only">{label}</span>
              {on && state.live ? (
                <span
                  aria-hidden
                  className="size-1.5 shrink-0 rounded-full bg-emerald-500 max-sm:absolute max-sm:-top-px max-sm:-right-px max-sm:size-2 max-sm:ring-2 max-sm:ring-background dark:bg-emerald-400"
                />
              ) : null}
            </span>
          </button>
        }
      />
      <PopoverContent side="top" align="start" className="w-64 max-w-[calc(100vw-1rem)] p-3">
        <p className="font-medium text-[13px]">{label}</p>
        <p className="mt-0.5 text-muted-foreground text-xs leading-relaxed">{tip}</p>
      </PopoverContent>
    </Popover>
  );
}
