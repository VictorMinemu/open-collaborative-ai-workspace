"use client";

import type { ActivityStep } from "@ocw/contracts";
import {
  Ban,
  Camera,
  Check,
  ChevronRight,
  Download,
  FilePen,
  FileText,
  Folder,
  Globe,
  Hand,
  Hourglass,
  LockKeyhole,
  LogIn,
  type LucideIcon,
  MousePointerClick,
  ScanText,
  Terminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { HostChip } from "./host-chip";
import type { LiveBot } from "./live-store";
import { useOptionalLiveView } from "./live-view-provider";

/**
 * One step of a bot turn's activity (07.8-20; R2, UI-SPEC Surface 5, Steps table). The API composed and masked every
 * string of the step (`agent-channel/activity.ts`): relative paths, hosts only, the masked command and output tail,
 * never typed text, environment values, full URLs, cookies or frames. This file only words it and lays it out: every
 * value is a React text node (T-07.8-20-01), never Markdown, a link or HTML. The row copies the Work Zone `ToolCard`
 * header's metrics and classes (the Work Zone file itself is not imported or edited).
 */

/** Who reads the step: `requester` is the person the bot acted for, when the caller knows it. */
export interface StepViewer {
  meId: string | null;
  requester: { id: string; name: string } | null;
}

/** "320 ms", "2.1 s", "1 min 5 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** A host as the server writes one in a step (`displayHost`: lower case, no space); "a page" is not one. */
const HOST_RE = /^[a-z0-9.\-[\]:]{1,260}$/;
const isHost = (s: string) => HOST_RE.test(s);

const isBrowserTool = (tool: string) => tool.startsWith("ocw_browser_");

/** `“Orders” on panel.autofy.app` → { lead: "“Orders”", host: "panel.autofy.app" }; a bare host → no lead. */
function splitOn(target: string): { lead: string | null; host: string } {
  const at = target.lastIndexOf(" on ");
  if (at < 0) return { lead: null, host: target };
  return { lead: target.slice(0, at), host: target.slice(at + 4) };
}

/** What a step says: the verb phrase (sans), then a mono target or a host chip, then an optional tail. */
export interface StepWords {
  verb: string;
  target: string | null;
  host: string | null;
  tail?: string;
}

function person(viewer: StepViewer): string | null {
  if (!viewer.requester) return null;
  return viewer.meId !== null && viewer.requester.id === viewer.meId ? "you" : viewer.requester.name;
}

/** Refusals in words (UI-SPEC Surface 5 › Refusal rows); anything else reads "Blocked:" + its target. */
function blockedWords(step: ActivityStep): StepWords {
  const browser = isBrowserTool(step.tool);
  const what = browser ? "browser" : "sandbox";
  const host = browser ? splitOn(step.target).host : null;
  switch (step.outcome.code) {
    case "navigation_refused":
      return {
        verb: "Blocked:",
        target: null,
        host: host && isHost(host) ? host : null,
        tail: " isn't allowed by the network rules",
      };
    case "cap_reached":
      return {
        verb: `Couldn't start the ${what}: the organization's limit is reached`,
        target: null,
        host: null,
      };
    case "killed":
      return {
        verb: browser ? "Browsers are stopped by an admin" : "Sandboxes are stopped by an admin",
        target: null,
        host: null,
      };
    case "disk_full":
      return { verb: "The sandbox is full", target: null, host: null };
    case "sandbox_off":
    case "module_off":
    case "bot_off":
      return { verb: `${browser ? "Browser" : "Sandbox"} is turned off`, target: null, host: null };
    default:
      return host && isHost(host)
        ? { verb: "Blocked:", target: null, host }
        : { verb: "Blocked:", target: step.target || null, host: null };
  }
}

/** The step in words (UI-SPEC Surface 5, Steps table): verbs fixed here, values from the server. */
export function stepWords(step: ActivityStep, viewer: StepViewer): StepWords {
  if (step.outcome.kind === "blocked" || step.verb === "blocked" || step.verb === "blocked_egress") {
    if (step.verb === "blocked_egress") {
      const { host } = splitOn(step.target);
      return {
        verb: "Blocked:",
        target: null,
        host: isHost(host) ? host : null,
        tail: " isn't allowed by the network rules",
      };
    }
    return blockedWords(step);
  }
  const t = step.target;
  const onHost = (verb: string): StepWords => {
    const { lead, host } = splitOn(t);
    const v = lead ? `${verb} ${lead} on` : `${verb} on`;
    return isHost(host) ? { verb: v, target: null, host } : { verb, target: t, host: null };
  };
  const hostOnly = (verb: string): StepWords =>
    isHost(t) ? { verb, target: null, host: t } : { verb, target: t, host: null };
  switch (step.verb) {
    case "ran":
      return { verb: "Ran", target: t, host: null };
    case "checked_process":
      return { verb: "Checked a running command", target: null, host: null };
    case "stopped_process":
      return { verb: "Stopped a running command", target: null, host: null };
    case "read":
      return { verb: "Read", target: t, host: null };
    case "listed":
      return { verb: "Listed", target: t, host: null };
    case "wrote":
      return { verb: "Wrote", target: t, host: null };
    case "deleted":
      return { verb: "Deleted", target: t, host: null };
    case "shared":
      return { verb: "Shared", target: t, host: null, tail: " here" };
    case "imported":
      return { verb: "Imported", target: t, host: null };
    case "opened":
      return hostOnly("Opened");
    case "read_page":
      return hostOnly("Read the page on");
    case "screenshot":
      return hostOnly("Took a screenshot of");
    case "waited":
      return hostOnly("Waited for");
    case "closed":
      return hostOnly("Closed the page on");
    case "clicked":
      return onHost("Clicked");
    case "typed":
      // Never the typed text: the server's target is the field's name and the host only.
      return onHost("Typed into");
    case "chose":
      return onHost("Chose");
    case "pressed":
      return onHost("Pressed");
    case "scrolled":
      return onHost("Scrolled");
    case "asked_signin": {
      const who = person(viewer);
      return hostOnly(who ? `Asked ${who} to sign in to` : "Asked for a sign-in to");
    }
    case "paused": {
      const who = person(viewer);
      return {
        verb: who ? `Paused while ${who} signed in` : "Paused for a sign-in",
        target: null,
        host: null,
      };
    }
    default:
      return { verb: "Used", target: t || null, host: null };
  }
}

const ICONS: Partial<Record<ActivityStep["verb"], LucideIcon>> = {
  ran: Terminal,
  checked_process: Terminal,
  stopped_process: Terminal,
  read: FileText,
  listed: Folder,
  wrote: FilePen,
  deleted: Trash2,
  shared: Upload,
  imported: Download,
  opened: Globe,
  read_page: ScanText,
  screenshot: Camera,
  clicked: MousePointerClick,
  typed: MousePointerClick,
  chose: MousePointerClick,
  pressed: MousePointerClick,
  scrolled: MousePointerClick,
  waited: Hourglass,
  asked_signin: LogIn,
  closed: Globe,
  paused: LockKeyhole,
  blocked: Ban,
  blocked_egress: Ban,
};

function iconOf(step: ActivityStep): LucideIcon {
  if (step.outcome.kind === "blocked") return Ban;
  return ICONS[step.verb] ?? Globe;
}

const isCommand = (step: ActivityStep) =>
  step.tool === "ocw_sandbox_exec" || step.tool === "ocw_sandbox_process";

/** The outcome in words: what the row shows after the target and what its accessible name says. */
export function outcomeOf(step: ActivityStep): { text: string | null; spoken: string } {
  const o = step.outcome;
  switch (o.kind) {
    case "ok":
      return { text: o.durationMs !== null ? formatDuration(o.durationMs) : null, spoken: "done" };
    case "error": {
      const exit = o.exitCode ?? step.details?.exitCode ?? null;
      if (exit !== null) return { text: `Exit ${exit}`, spoken: `failed, exit ${exit}` };
      if (o.code === "timeout") return { text: "Timed out", spoken: "failed, timed out" };
      return { text: "Failed", spoken: "failed" };
    }
    case "running":
      return isCommand(step)
        ? { text: "Still running", spoken: "still running" }
        : { text: null, spoken: "running" };
    case "approval":
      return { text: "Needs approval", spoken: "needs approval" };
    default:
      return { text: "Blocked", spoken: "blocked" };
  }
}

/** A permalink the server composed for the approval card; only an internal path is ever a link. */
const internalRoute = (route: string | null) => (route && /^\/(?!\/)/.test(route) ? route : null);

function Outcome({ step }: { step: ActivityStep }) {
  const o = step.outcome;
  const { text } = outcomeOf(step);
  if (o.kind === "approval") return null; // rendered after the toggle (a link never sits inside a button)
  return (
    <span data-testid="activity-outcome" data-kind={o.kind} className="flex h-6 shrink-0 items-center gap-1">
      {o.kind === "ok" ? (
        <Check aria-hidden className="size-3.5 text-emerald-600 dark:text-emerald-400" />
      ) : o.kind === "running" ? (
        <Spinner className="size-3.5 text-muted-foreground" />
      ) : (
        <X aria-hidden className="size-3.5 text-red-600 dark:text-red-400" />
      )}
      {text ? (
        <span
          className={cn(
            "whitespace-nowrap text-xs",
            o.kind === "ok" && "font-mono text-muted-foreground",
            o.kind === "running" && "text-muted-foreground",
            (o.kind === "error" || o.kind === "blocked") && "text-red-600 dark:text-red-400",
          )}
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}

function ApprovalOutcome({ step }: { step: ActivityStep }) {
  const route = internalRoute(step.approvalMessageRoute);
  const body = (
    <>
      <Hand aria-hidden className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
      <span>Needs approval</span>
    </>
  );
  const cls =
    "inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm text-amber-800 text-xs dark:text-amber-300";
  return route ? (
    <Link
      href={route}
      data-testid="activity-approval"
      className={cn(
        cls,
        "underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/40 max-md:h-11",
      )}
    >
      {body}
    </Link>
  ) : (
    <span data-testid="activity-approval" className={cls}>
      {body}
    </span>
  );
}

function Words({ words, signedIn }: { words: StepWords; signedIn: boolean }) {
  return (
    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 py-0.5 @[26rem]:flex-nowrap">
      <span className="min-w-0 break-words font-medium text-[13px] @[26rem]:max-w-[65%] @[26rem]:shrink-0 @[26rem]:truncate">
        {words.verb}
      </span>
      {/* Real spaces between the parts (copy, find in page, screen readers); flex ignores them in the layout. */}
      {words.target ? " " : null}
      {words.target ? (
        <span
          data-testid="activity-target"
          className="min-w-0 basis-full break-words font-mono text-[12px] text-muted-foreground @[26rem]:basis-auto @[26rem]:truncate"
        >
          {words.target}
        </span>
      ) : null}
      {words.host ? " " : null}
      {words.host ? (
        <HostChip
          host={words.host}
          secure={null}
          testId="activity-host"
          className="basis-full text-[12px] text-muted-foreground @[26rem]:basis-auto"
        />
      ) : null}
      {words.tail ? <span className="min-w-0 text-[13px]">{words.tail}</span> : null}
      {signedIn ? " " : null}
      {signedIn ? (
        <Badge variant="outline" data-testid="activity-signed-in" className="self-center">
          <LockKeyhole aria-hidden />
          Signed in
        </Badge>
      ) : null}
    </span>
  );
}

/** The plain sentence of a step for its accessible name: "Ran python fetch.py, failed, exit 1". */
export function stepSentence(step: ActivityStep, viewer: StepViewer): string {
  const w = stepWords(step, viewer);
  const what = [w.verb, w.target ?? w.host ?? ""].filter(Boolean).join(" ") + (w.tail ?? "");
  return `${what}, ${outcomeOf(step).spoken}`;
}

function Details({ step, id, open }: { step: ActivityStep; id: string; open: boolean }) {
  const d = step.details;
  const exit = d?.exitCode ?? step.outcome.exitCode;
  const meta = [
    step.tool === "ocw_sandbox_exec" ? `in ${d?.cwd || "workspace"}` : null,
    exit !== null && exit !== undefined ? `exit ${exit}` : null,
    step.outcome.durationMs !== null ? formatDuration(step.outcome.durationMs) : null,
  ].filter((x): x is string => x !== null);
  return (
    <div id={id} hidden={!open} data-testid="activity-details" className="border-t bg-muted/30 px-3 py-2">
      {d?.command ? (
        <p className="mb-1.5 whitespace-pre-wrap break-words font-mono text-[12px] text-foreground">
          {`$ ${d.command}`}
        </p>
      ) : null}
      {meta.length > 0 ? <p className="mb-1.5 text-muted-foreground text-xs">{meta.join(" · ")}</p> : null}
      {step.tool === "ocw_sandbox_exec" ? (
        d?.outputTail ? (
          <pre className="scrollbar-thin max-h-72 overflow-auto rounded-md bg-background p-2.5 font-mono text-[12px] leading-relaxed dark:bg-black/30">
            {d.outputTail}
          </pre>
        ) : (
          <p className="text-muted-foreground text-xs">
            {step.outcome.kind === "running" ? "Still running" : "No output"}
          </p>
        )
      ) : null}
    </div>
  );
}

/** A browser step offers Watch while its page is open (the server's `contextOpen`) and the bot is known (07.8-22). */
export function watchable(step: ActivityStep, bot: LiveBot | undefined): boolean {
  return !!bot && isBrowserTool(step.tool) && !!step.contextId && step.contextOpen === true;
}

/** `Watch` (UI-SPEC Surface 1b): opens the live view on the step's page; focus comes back here when it closes. */
function WatchLink({ step, bot }: { step: ActivityStep; bot: LiveBot }) {
  const live = useOptionalLiveView();
  const contextId = step.contextId;
  if (!contextId) return null;
  return (
    <Button
      variant="link"
      size="sm"
      data-testid="activity-watch"
      disabled={!live}
      onClick={(e) => live?.open({ contextId, bot, trigger: e.currentTarget })}
      className="h-6 max-md:h-11 max-md:min-w-11"
    >
      Watch
    </Button>
  );
}

/** One `<li>` of the activity's steps: a toggle when the step has details (exec, process), a plain row otherwise. */
export function ActivityStepRow({
  step,
  viewer,
  bot,
  defaultOpen = false,
}: {
  step: ActivityStep;
  viewer: StepViewer;
  /** The bot that acted; with it, a browser step whose page is open offers Watch. */
  bot?: LiveBot;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const detailsId = useId();
  const Icon = iconOf(step);
  const words = stepWords(step, viewer);
  const hasDetails =
    !!step.details &&
    (step.details.command !== undefined ||
      step.details.exitCode !== undefined ||
      step.details.outputTail !== undefined);
  const inner = (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon aria-hidden className="size-3.5" />
      </span>
      <Words words={words} signedIn={step.signedIn} /> <Outcome step={step} />
    </>
  );
  return (
    <li
      data-testid="activity-step"
      data-verb={step.verb}
      data-outcome={step.outcome.kind}
      className="min-w-0 overflow-hidden"
    >
      <div className="flex min-w-0 items-start">
        {hasDetails ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={stepSentence(step, viewer)}
            onClick={() => setOpen((v) => !v)}
            className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2 text-left outline-none hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:ring-inset max-md:min-h-11"
          >
            {inner}
            <span className="flex h-6 shrink-0 items-center">
              <ChevronRight
                aria-hidden
                className={cn("size-3.5 text-muted-foreground transition-transform", open && "rotate-90")}
              />
            </span>
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2">{inner}</div>
        )}
        {step.outcome.kind === "approval" ? (
          <span className="flex shrink-0 items-start py-2 pr-3">
            <ApprovalOutcome step={step} />
          </span>
        ) : null}
        {bot && watchable(step, bot) ? (
          <span className="flex shrink-0 items-start py-2 pr-3 max-md:py-0.5">
            <WatchLink step={step} bot={bot} />
          </span>
        ) : null}
      </div>
      {hasDetails ? <Details step={step} id={detailsId} open={open} /> : null}
    </li>
  );
}
