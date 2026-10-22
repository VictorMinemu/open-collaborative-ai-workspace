"use client";

import type { ActivityStep, BotTurnActivity, Message } from "@ocw/contracts";
import { ChevronRight, Wrench } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { useAgents, useLiveTurns } from "@/lib/chat-queries";
import { cn } from "@/lib/utils";
import { ActivityStepRow, type StepViewer } from "./activity-step";
import type { LiveBot } from "./live-store";

/**
 * What a bot did in its sandbox and browser during a turn (07.8-20; R2, UI-SPEC Surface 5). The API composes the
 * activity from the confined calls it decided, masks every string and attaches it to the bot's reply, so every reader of
 * the reply sees it, above the reply text and inside the same message. Collapsed by default; expanding is local state.
 * The group button copies the Work Zone `ToolGroup` look (13.5 px muted, wrench, rotating chevron).
 *
 * While the turn runs (no reply yet) readers see only the live label `BotActivityLive`, fed by the ephemeral
 * `turn.activity` events (`chat-queries.ts`), and replaced by this group once the reply arrives.
 */

const NO_VIEWER: StepViewer = { meId: null, requester: null };

/** Total steps of a turn: the ones listed plus the ones counted in `more`. */
export const stepCount = (a: Pick<BotTurnActivity, "steps" | "more">) => a.steps.length + a.more;

/** "Used its sandbox · 2 steps", "Used its browser · 1 step", "Used its sandbox and browser · 6 steps". */
export function activityLabel(a: Pick<BotTurnActivity, "steps" | "more">): string {
  const browser = a.steps.some((s) => s.tool.startsWith("ocw_browser_"));
  const sandbox = a.steps.some((s) => !s.tool.startsWith("ocw_browser_"));
  const what = browser && sandbox ? "sandbox and browser" : browser ? "browser" : "sandbox";
  const n = stepCount(a);
  return `Used its ${what} · ${n} ${n === 1 ? "step" : "steps"}`;
}

export function BotActivity({
  activity,
  viewer = NO_VIEWER,
  bot,
  defaultOpen = false,
  className,
}: {
  activity: BotTurnActivity;
  viewer?: StepViewer;
  /** The bot that acted (the reply's author): browser steps whose page is open offer Watch (07.8-22). */
  bot?: LiveBot;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();
  if (stepCount(activity) === 0) return null;
  const running = activity.running || activity.steps.some((s) => s.outcome.kind === "running");
  return (
    <div
      data-testid="bot-activity"
      data-state={open ? "open" : "closed"}
      className={cn("@container grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 py-1", className)}
    >
      <button
        type="button"
        data-testid="bot-activity-toggle"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="flex w-fit max-w-full items-center gap-2 rounded-md py-0.5 text-left text-[13.5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 max-md:h-11"
      >
        {running ? <Spinner className="size-3.5" /> : <Wrench aria-hidden className="size-3.5 shrink-0" />}
        <span className="min-w-0">{activityLabel(activity)}</span>
        <ChevronRight
          aria-hidden
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
      </button>
      <ol
        id={listId}
        aria-label="Steps"
        hidden={!open}
        className={cn(
          "ml-5 min-w-0 divide-y overflow-hidden rounded-lg border bg-card",
          open ? "block" : "hidden",
        )}
      >
        {activity.steps.map((s: ActivityStep) => (
          <ActivityStepRow key={s.id} step={s} viewer={viewer} bot={bot} />
        ))}
        {activity.more > 0 ? (
          <li data-testid="activity-more" className="px-3 py-2 text-muted-foreground text-xs">
            {activity.more} more {activity.more === 1 ? "step isn't" : "steps aren't"} shown.
          </li>
        ) : null}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------- while the turn runs

/** The server's live phrases (`agent-channel/activity.ts` PHRASES), for a step whose own phrase never reached us. */
const PHRASES: Partial<Record<ActivityStep["verb"], (target: string) => string>> = {
  ran: (t) => `running ${t}`,
  checked_process: () => "checking a running command",
  stopped_process: () => "stopping a running command",
  read: (t) => `reading ${t}`,
  listed: (t) => `listing ${t}`,
  wrote: (t) => `writing ${t}`,
  deleted: (t) => `deleting ${t}`,
  shared: (t) => `sharing ${t}`,
  imported: (t) => `importing ${t}`,
  opened: (t) => `opening ${t}`,
  read_page: (t) => `reading the page on ${t}`,
  screenshot: (t) => `taking a screenshot of ${t}`,
  clicked: (t) => `clicking ${t}`,
  typed: (t) => `typing into ${t}`,
  chose: (t) => `choosing ${t}`,
  pressed: (t) => `pressing ${t}`,
  scrolled: (t) => `scrolling on ${t}`,
  waited: (t) => `waiting for ${t}`,
  closed: (t) => `closing ${t}`,
};

/** What the bot does now: the server's `current`, else the phrase of its latest step, else "working". At most 80. */
export function livePhrase(a: Pick<BotTurnActivity, "steps" | "current">, lastPhrase: string | null = null) {
  if (a.current) return a.current;
  if (lastPhrase) return lastPhrase;
  const last = a.steps.at(-1);
  const phrase = last ? PHRASES[last.verb]?.(last.target.split(" · ")[0] ?? last.target) : undefined;
  return (phrase ?? "working").slice(0, 80);
}

/** "Scout is writing reports/late.csv · step 1" (UI-SPEC Copywriting › Chat activity › Running). */
export function liveLabel(bot: string, phrase: string, step: number): string {
  return step > 0 ? `${bot} is ${phrase} · step ${step}` : `${bot} is ${phrase}`;
}

/** The verb of a phrase ("writing reports/late.csv" → "writing"): announcements follow verb changes only. */
const verbOf = (phrase: string) => phrase.split(" ")[0] ?? phrase;

/** At most one announcement every 5 s, and only when the verb changes (UI-SPEC Accessibility › Activity line). */
const ANNOUNCE_EVERY_MS = 5000;

function useAnnouncement(label: string, phrase: string): string {
  const [spoken, setSpoken] = useState(label);
  const last = useRef<{ verb: string; at: number }>({ verb: verbOf(phrase), at: Date.now() });
  useEffect(() => {
    const verb = verbOf(phrase);
    if (verb === last.current.verb) return;
    const wait = Math.max(0, last.current.at + ANNOUNCE_EVERY_MS - Date.now());
    const t = window.setTimeout(() => {
      last.current = { verb, at: Date.now() };
      setSpoken(label);
    }, wait);
    return () => window.clearTimeout(t);
  }, [label, phrase]);
  return spoken;
}

/** The running state of a turn: a spinner and the live label, announced politely (throttled). */
export function BotActivityLive({ bot, phrase, step }: { bot: string; phrase: string; step: number }) {
  const label = liveLabel(bot, phrase, step);
  const spoken = useAnnouncement(label, phrase);
  return (
    <div
      data-testid="bot-activity"
      data-state="running"
      className="flex min-w-0 items-center gap-2 py-1 text-[13.5px] text-muted-foreground"
    >
      <Spinner className="size-3.5 shrink-0" />
      <span data-testid="bot-activity-live" aria-hidden className="min-w-0 break-words">
        {label}
      </span>
      <span className="sr-only" aria-live="polite" data-testid="bot-activity-announce">
        {spoken}
      </span>
    </div>
  );
}

/** One running turn as the message list shows it: the bot's author block with the live label. */
export interface LiveActivityRow {
  eventId: string;
  agentId: string;
  name: string;
  avatarUrl: string | null;
  phrase: string;
  step: number;
  startedAt: number;
}

/**
 * The running turns of a conversation (`threadRootId` null) or a thread, named: the bot's name from its latest message
 * here, else the organization's bot list. Ephemeral `turn.activity` only (readers of the conversation); a silent turn
 * expires after `LIVE_ACTIVITY_TIMEOUT_MS`.
 */
export function useLiveActivity(
  convId: string,
  threadRootId: string | null,
  messages: readonly Message[],
): LiveActivityRow[] {
  const turns = useLiveTurns(convId, threadRootId);
  const agents = useAgents();
  return turns.map((t) => {
    let author: Message["author"];
    for (let i = messages.length - 1; i >= 0 && !author; i--) {
      const m = messages[i];
      if (m?.authorKind === "agent" && m.authorId === t.agentId) author = m.author;
    }
    const agent = agents.data?.agents.find((a) => a.id === t.agentId);
    return {
      eventId: t.eventId,
      agentId: t.agentId,
      name: author?.displayName ?? agent?.name ?? "The bot",
      avatarUrl: author?.avatarUrl ?? agent?.avatarUrl ?? null,
      phrase: livePhrase(t.activity, t.phrase),
      step: stepCount(t.activity),
      startedAt: t.startedAt,
    };
  });
}
