"use client";

import type { Device, WorkZoneProposalView as WorkZoneProposal, WorkZoneStartBlock } from "@ocw/contracts";
import { FolderGit2, FolderX, Info, Laptop, type LucideIcon, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { permissionModeMeta } from "@/components/work-zone/meta";
import { cn } from "@/lib/utils";
import { UntrustedText } from "./untrusted-text";

/**
 * The body of a Work Zone proposal review (Phase 07.5, D-03, APPROVE-03, UI-SPEC Surface 2 "Work Zone proposal
 * review", R8, R9): a fact strip that says in seconds what runs where and as whom (project, device with its live
 * state, runtime, and the mode, always Supervised), then the bot's full prompt as plain text and the two notes. The
 * decision footer and dialogs live in `approval-review.tsx`. Every value comes from the API's view for this viewer;
 * the device state is live from `useDevices()` (device presence on the org stream), falling back to the view.
 */

/** The only mode a proposal starts in (UI-SPEC R8): the product's own name for `default`, never "Default". */
export const PROPOSAL_MODE = permissionModeMeta("default");
const MODE_HINT = "asks before edits and commands";

/** What the device cell says right now (UI-SPEC "Device cell"). */
export type DeviceStateKind = "online" | "offline" | "signed_out" | "not_shared";

/**
 * The device's state for this proposal, live when the viewer's device list knows it: not shared (the view says the
 * person may no longer use it, or it left their list), offline, the runtime signed out, or online.
 */
export function deviceStateOf(
  view: Pick<WorkZoneProposal, "device" | "runtime">,
  live: Pick<Device, "status" | "runtimes"> | null | undefined,
  listed: boolean,
): DeviceStateKind {
  if (!view.device.usable || (listed && !live)) return "not_shared";
  const online = live ? live.status === "online" : view.device.online;
  if (!online) return "offline";
  const rt = live?.runtimes.find((r) => r.id === view.runtime.id);
  const available = live ? rt?.installed === true && rt.loggedIn === true : view.runtime.available;
  return available ? "online" : "signed_out";
}

/**
 * Why Start is unavailable now, in the server's order (`startBlocked`), with the device facts replaced by the live
 * ones: a device that comes back online enables Start without a reload, one that goes offline disables it at once.
 * The API decides again on Start whatever this says.
 */
export function liveStartBlock(
  view: Pick<WorkZoneProposal, "startBlocked" | "project">,
  device: DeviceStateKind,
  canDecide: boolean,
): WorkZoneStartBlock | null {
  if (!canDecide || view.startBlocked === "not_allowed") return "not_allowed";
  if (view.project.removed || view.startBlocked === "project_not_found") return "project_not_found";
  if (device === "not_shared" || view.startBlocked === "device_not_shared") return "device_not_shared";
  if (device === "offline") return "device_offline";
  if (device === "signed_out") return "runtime_unavailable";
  return null;
}

/** The visible reason next to a disabled Start (UI-SPEC Copywriting › Work Zone proposal "Start unavailable"). */
export function startBlockedText(
  block: WorkZoneStartBlock,
  view: Pick<WorkZoneProposal, "device" | "runtime">,
): string {
  switch (block) {
    case "device_offline":
      return `${view.device.name} is offline. You can start it when the device is back.`;
    case "runtime_unavailable":
      return `${view.runtime.label} isn't signed in on ${view.device.name}.`;
    case "device_not_shared":
      return `You can no longer use ${view.device.name}.`;
    case "project_not_found":
      return "This project was removed.";
    case "not_allowed":
      return "You can't start Work Zone sessions.";
  }
}

/** Why a Start failed, in words (UI-SPEC "Failed reasons"); never an API code. */
export function failedStartText(
  code: string | null | undefined,
  view: Pick<WorkZoneProposal, "device" | "runtime">,
): string {
  switch (code) {
    case "device_offline":
      return `${view.device.name} went offline before the session started.`;
    case "runtime_unavailable":
      return `${view.runtime.label} isn't available on ${view.device.name} any more.`;
    case "project_not_found":
      return "This project was removed.";
    case "device_not_shared":
      return `You can no longer use ${view.device.name}.`;
    case "settings_denied":
      return "Your organization doesn't allow this session's settings.";
    default:
      return "Couldn't start the session.";
  }
}

const DEVICE_TEXT: Record<DeviceStateKind, (runtime: string) => string> = {
  online: () => "Online",
  offline: () => "Offline",
  signed_out: (runtime) => `${runtime} isn't signed in`,
  not_shared: () => "Not shared with you any more",
};

/**
 * The device's state as words, with a 6 px dot for Online / Offline (UI-SPEC "Device cell"). The text always carries
 * the state; the dot is decoration (`aria-hidden`). Signed out reads amber, not shared red, both at AA.
 */
export function DeviceState({
  state,
  runtime,
  className,
}: {
  state: DeviceStateKind;
  runtime: string;
  className?: string;
}) {
  return (
    <span
      data-testid="device-state"
      data-state={state}
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5",
        state === "signed_out" && "text-amber-800 dark:text-amber-300",
        state === "not_shared" && "text-red-700 dark:text-red-400",
        className,
      )}
    >
      {state === "online" || state === "offline" ? (
        <span
          aria-hidden
          className={cn(
            "inline-flex size-1.5 shrink-0 rounded-full",
            state === "online" ? "bg-emerald-500" : "bg-muted-foreground/50",
          )}
        />
      ) : null}
      <span className="min-w-0">{DEVICE_TEXT[state](runtime)}</span>
    </span>
  );
}

function FactCell({
  icon: Icon,
  term,
  value,
  detail,
  testId,
  tone,
}: {
  icon: LucideIcon;
  /** The cell's name for assistive tech ("Project", "Device", …): the `<dt>`, which carries the glyph. */
  term: string;
  value: ReactNode;
  detail: ReactNode;
  testId: string;
  tone?: "danger";
}) {
  // A `<dl>` group holds only `<dt>`/`<dd>` (axe definition-list): the glyph sits in the `<dt>` with the hidden term.
  return (
    <div
      data-testid={testId}
      className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] content-start gap-x-3 gap-y-0.5 rounded-lg border bg-card p-4 shadow-xs dark:shadow-none max-sm:flex max-sm:min-h-14 max-sm:flex-wrap max-sm:content-center max-sm:items-center max-sm:gap-x-1.5 max-sm:py-2"
    >
      <dt className="row-span-2 pt-0.5 max-sm:mr-1.5 max-sm:pt-0">
        <Icon
          aria-hidden
          className={cn(
            "size-4",
            tone === "danger" ? "text-red-700 dark:text-red-400" : "text-muted-foreground",
          )}
        />
        <span className="sr-only">{term}</span>
      </dt>
      <dd className="min-w-0 break-words font-semibold text-sm">{value}</dd>
      <dd className="min-w-0 break-words text-muted-foreground text-xs">{detail}</dd>
    </div>
  );
}

const SECTION_TITLE = "font-semibold text-muted-foreground text-xs uppercase tracking-wider";

/**
 * The fact strip, the prompt and the notes. `device` is the live state (see `deviceStateOf`). The prompt is the bot's
 * text (untrusted model output): `UntrustedText`, so text nodes with its whitespace kept, revealed invisible characters
 * as chips, never Markdown, HTML or links (T-07.5-12-01, T-07.5-13-01).
 */
export function WorkZoneProposalView({ view, device }: { view: WorkZoneProposal; device: DeviceStateKind }) {
  const bot = view.agent.displayName;
  const Mode = PROPOSAL_MODE?.icon;
  return (
    <div data-testid="work-zone-proposal-body" className="@container grid min-w-0 gap-6">
      <dl
        aria-label="What runs where"
        data-testid="work-zone-facts"
        className="grid grid-cols-1 gap-3 @md:grid-cols-2 @3xl:grid-cols-4"
      >
        <FactCell
          testId="work-zone-fact-project"
          icon={view.project.removed ? FolderX : FolderGit2}
          tone={view.project.removed ? "danger" : undefined}
          term="Project"
          value={view.project.name}
          detail={
            view.project.removed ? (
              <span className="text-red-700 dark:text-red-400">This project was removed.</span>
            ) : (
              "project"
            )
          }
        />
        <FactCell
          testId="work-zone-fact-device"
          icon={Laptop}
          term="Device"
          value={view.device.name}
          detail={<DeviceState state={device} runtime={view.runtime.label} />}
        />
        <FactCell
          testId="work-zone-fact-runtime"
          icon={Sparkles}
          term="Runtime"
          value={view.runtime.label}
          detail={
            device === "signed_out" ? (
              <span className="text-amber-800 dark:text-amber-300">isn't signed in</span>
            ) : (
              "signed in"
            )
          }
        />
        <FactCell
          testId="work-zone-fact-mode"
          icon={Mode ?? Info}
          term="Mode"
          value={PROPOSAL_MODE?.label ?? "Supervised"}
          detail={MODE_HINT}
        />
      </dl>

      <div className="grid min-w-0 gap-2">
        <h2 id="work-zone-prompt-title" className={SECTION_TITLE}>
          Prompt
        </h2>
        {/* A focusable named region: a long prompt scrolls inside it, by keyboard too. */}
        <div
          role="region"
          aria-labelledby="work-zone-prompt-title"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard (axe scrollable-region-focusable)
          tabIndex={0}
          data-testid="work-zone-prompt"
          className="max-h-[480px] overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/50 px-4 py-3 text-sm leading-5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 dark:bg-white/[0.03]"
        >
          <UntrustedText text={view.prompt} />
        </div>
        <p data-testid="work-zone-written-by" className="text-muted-foreground text-xs">
          Written by {bot}. Read it before starting: it runs on your device, as you.
        </p>
        <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
          <Info aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>Bots never choose Full access. You can change the mode after the session starts.</span>
        </p>
      </div>
    </div>
  );
}
