import type { WaitingOn } from "@ocw/contracts";
import { cn } from "@/lib/utils";

/**
 * Who a card waits on (UI-SPEC Color › Waiting state). The label is always written out, never colour alone. `both` is
 * fuchsia, not violet (violet sits next to the brand accent and would read as "selected"), with a dot split into the
 * amber and sky halves of the other two states. This map is the only place these palette classes live.
 */
export const WAITING: Record<
  Exclude<WaitingOn, "none">,
  { label: string; tone: string; dot: readonly [string] | readonly [string, string] }
> = {
  us: {
    label: "Waiting on us",
    tone: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
    dot: ["bg-amber-500"],
  },
  customer: {
    label: "Waiting on customer",
    tone: "bg-sky-100 text-sky-800 dark:bg-sky-400/15 dark:text-sky-300",
    dot: ["bg-sky-500"],
  },
  both: {
    label: "Waiting on both",
    tone: "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-400/15 dark:text-fuchsia-300",
    dot: ["bg-amber-500", "bg-sky-500"],
  },
};

/** The radio options of "Waiting on…" (menus, card strip): `none` reads "Nobody". */
export const WAITING_OPTIONS: ReadonlyArray<{ value: WaitingOn; label: string }> = [
  { value: "none", label: "Nobody" },
  { value: "us", label: "Us" },
  { value: "customer", label: "Customer" },
  { value: "both", label: "Both" },
];

/** The 6 px state dot (split in two for `both`); a same-size blank for `none` so menu labels stay aligned. */
export function WaitingDot({ state, className }: { state: WaitingOn; className?: string }) {
  const halves = state === "none" ? null : WAITING[state].dot;
  return (
    <span
      data-slot="waiting-dot"
      aria-hidden
      className={cn("flex size-1.5 shrink-0 overflow-hidden rounded-full", className)}
    >
      {halves?.length === 2 ? (
        halves.map((bg) => <span key={bg} className={cn("h-full w-1/2", bg)} />)
      ) : halves ? (
        <span className={cn("size-full", halves[0])} />
      ) : null}
    </span>
  );
}

/** The waiting chip on tiles and the card strip; renders nothing for `none`. */
export function WaitingOnBadge({ state, className }: { state: WaitingOn; className?: string }) {
  if (state === "none") return null;
  const { label, tone } = WAITING[state];
  return (
    <span
      data-testid="waiting-on-badge"
      data-state={state}
      className={cn(
        "inline-flex h-5 w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-xs font-semibold",
        tone,
        className,
      )}
    >
      <WaitingDot state={state} />
      {label}
    </span>
  );
}
