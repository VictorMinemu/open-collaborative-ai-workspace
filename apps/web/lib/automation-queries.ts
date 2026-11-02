"use client";

import {
  type Automation,
  AutomationList,
  AutomationOptions,
  type AutomationRun,
  AutomationRunList,
  type AutomationRunReason,
  type AutomationRunStatus,
  AutomationSchedule,
  Automation as AutomationSchema,
  AutomationTargetOptions,
  type CreateAutomationRequest,
  CreateAutomationResponse,
  DigestTestResponse,
  EventTypes,
  isKnownTimeZone,
  RunAutomationResponse,
  SchedulePreviewResponse,
  topic,
  type UpdateAutomationRequest,
} from "@ocw/contracts";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, errorMessage, isApiError } from "./api";
import { permalinkPath } from "./permalink";
import { useMe } from "./queries";
import { useTopic } from "./realtime";

/**
 * Automations in the web (07.6-15, AUTO-01, D-07, UI-SPEC Surfaces 1 and 2): REST hooks over `/api/v1/automations`,
 * the editor's schedule presets ↔ cron mapping, and every sentence the list, the editor and the run history show. The
 * API decides every permission (`viewerCan`, `canManage`, options); the browser only words what it was told.
 */

export { scheduleSummary } from "@ocw/contracts";

export type AutomationScope = "mine" | "all";

export const automationKeys = {
  all: ["automations"] as const,
  list: (scope: AutomationScope) => ["automations", "list", scope] as const,
  detail: (id: string) => ["automations", "detail", id] as const,
  runs: (id: string) => ["automations", "runs", id] as const,
  options: ["automations", "options"] as const,
  targets: (agentId: string) => ["automations", "targets", agentId] as const,
  preview: (cron: string, timeZone: string) => ["automations", "preview", cron, timeZone] as const,
};

function noRetryOn4xx(failureCount: number, err: unknown): boolean {
  if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
  return failureCount < 1;
}

const BASE = "/api/v1/automations";

// ---------------------------------------------------------------- reads

export function useAutomations(scope: AutomationScope) {
  return useQuery({
    queryKey: automationKeys.list(scope),
    queryFn: ({ signal }) => api.get(`${BASE}?scope=${scope}`, { schema: AutomationList, signal }),
    retry: noRetryOn4xx,
  });
}

export function useAutomation(id: string | null) {
  return useQuery({
    queryKey: automationKeys.detail(id ?? ""),
    queryFn: ({ signal }) =>
      api.get(`${BASE}/${encodeURIComponent(id ?? "")}`, { schema: AutomationSchema, signal }),
    enabled: !!id,
    retry: noRetryOn4xx,
  });
}

/** Newest first, 30 a page; `Show older runs` asks for the page before the last run shown. */
export function useAutomationRuns(id: string | null) {
  return useInfiniteQuery({
    queryKey: automationKeys.runs(id ?? ""),
    queryFn: ({ pageParam, signal }) =>
      api.get(
        `${BASE}/${encodeURIComponent(id ?? "")}/runs${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ""}`,
        { schema: AutomationRunList, signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!id,
    retry: noRetryOn4xx,
  });
}

export function useAutomationOptions(enabled = true) {
  return useQuery({
    queryKey: automationKeys.options,
    queryFn: ({ signal }) => api.get(`${BASE}/options`, { schema: AutomationOptions, signal }),
    enabled,
    retry: noRetryOn4xx,
  });
}

/** Channels and boards a bot could deliver to, with the reason an option is not offered. */
export function useTargetOptions(agentId: string | null) {
  return useQuery({
    queryKey: automationKeys.targets(agentId ?? ""),
    queryFn: ({ signal }) =>
      api.get(`${BASE}/target-options?agentId=${encodeURIComponent(agentId ?? "")}`, {
        schema: AutomationTargetOptions,
        signal,
      }),
    enabled: !!agentId,
    retry: noRetryOn4xx,
  });
}

/** `value`, `ms` after it last changed. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export type SchedulePreviewState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; next: string[] }
  | {
      state: "error";
      code: "invalid_cron" | "invalid_time_zone" | "schedule_too_frequent";
      minMinutes?: number;
    };

/**
 * The next three runs from `POST /automations/schedule-preview` (R13: the save's own code path), 400 ms after the
 * schedule last changed. A schedule that is not even five cron fields in a known zone never reaches the API.
 */
export function useSchedulePreview(
  schedule: { cron: string; timeZone: string } | null,
): SchedulePreviewState {
  const settled = useDebounced(schedule ? `${schedule.cron}\u0000${schedule.timeZone}` : "", 400);
  const [cron = "", timeZone = ""] = settled.split("\u0000");
  const shape = settled ? AutomationSchedule.safeParse({ cron, timeZone }) : null;
  const query = useQuery({
    queryKey: automationKeys.preview(cron, timeZone),
    queryFn: ({ signal }) =>
      api.post(`${BASE}/schedule-preview`, {
        body: { cron, timeZone },
        schema: SchedulePreviewResponse,
        signal,
      }),
    enabled: !!shape?.success,
    retry: noRetryOn4xx,
    staleTime: 30_000,
  });
  if (!schedule) return { state: "idle" };
  const current = `${schedule.cron}\u0000${schedule.timeZone}`;
  if (current !== settled) return { state: "loading" };
  if (shape && !shape.success) {
    return { state: "error", code: isKnownTimeZone(timeZone) ? "invalid_cron" : "invalid_time_zone" };
  }
  if (query.data) {
    return query.data.ok
      ? { state: "ok", next: query.data.next }
      : {
          state: "error",
          code: query.data.code,
          ...(query.data.minMinutes !== undefined ? { minMinutes: query.data.minMinutes } : {}),
        };
  }
  if (query.isError) return { state: "error", code: "invalid_cron" };
  return { state: "loading" };
}

// ---------------------------------------------------------------- writes

function useInvalidateAutomations() {
  const qc = useQueryClient();
  return (id?: string) => {
    void qc.invalidateQueries({ queryKey: ["automations", "list"] });
    void qc.invalidateQueries({ queryKey: automationKeys.options });
    if (id) {
      void qc.invalidateQueries({ queryKey: automationKeys.detail(id) });
      void qc.invalidateQueries({ queryKey: automationKeys.runs(id) });
    }
  };
}

export type SaveAutomationInput =
  | { id?: undefined; body: CreateAutomationRequest }
  | { id: string; body: UpdateAutomationRequest };

/** Create (`POST`, 201) or update (`PATCH` with `expectedVersion`; 409 `version` when someone saved first). */
export function useSaveAutomation() {
  const qc = useQueryClient();
  const invalidate = useInvalidateAutomations();
  return useMutation({
    // A webhook's create response carries its secret once: the editor resets the mutation, and gcTime 0 drops it.
    gcTime: 0,
    mutationFn: (input: SaveAutomationInput) =>
      input.id
        ? api.patch(`${BASE}/${encodeURIComponent(input.id)}`, {
            body: input.body,
            schema: CreateAutomationResponse,
          })
        : api.post(BASE, { body: input.body, schema: CreateAutomationResponse }),
    onSuccess: (res) => {
      qc.setQueryData(automationKeys.detail(res.automation.id), res.automation);
      invalidate(res.automation.id);
    },
  });
}

function useLifecycle(path: "pause" | "resume") {
  const qc = useQueryClient();
  const invalidate = useInvalidateAutomations();
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`${BASE}/${encodeURIComponent(id)}/${path}`, { schema: AutomationSchema }),
    onSuccess: (a) => {
      qc.setQueryData(automationKeys.detail(a.id), a);
      invalidate(a.id);
    },
  });
}

export const usePauseAutomation = () => useLifecycle("pause");
export const useResumeAutomation = () => useLifecycle("resume");

export function useDeleteAutomation() {
  const qc = useQueryClient();
  const invalidate = useInvalidateAutomations();
  return useMutation({
    mutationFn: (id: string) => api.del<null>(`${BASE}/${encodeURIComponent(id)}`),
    onSuccess: (_res, id) => {
      qc.removeQueries({ queryKey: automationKeys.detail(id) });
      qc.removeQueries({ queryKey: automationKeys.runs(id) });
      invalidate();
    },
  });
}

/** "Run now": the API queues a `manual` run (or records it skipped at a limit) and answers its id. */
export function useRunNow() {
  const invalidate = useInvalidateAutomations();
  return useMutation({
    mutationFn: (id: string) =>
      api.post(`${BASE}/${encodeURIComponent(id)}/run`, { schema: RunAutomationResponse }),
    onSuccess: (_res, id) => invalidate(id),
  });
}

/** The digest row's "Send now" (07.6-13's test send of the saved digest). */
export function useSendDigestNow() {
  const invalidate = useInvalidateAutomations();
  return useMutation({
    mutationFn: () => api.post("/api/v1/digest/test", { schema: DigestTestResponse }),
    onSuccess: () => invalidate(),
  });
}

/**
 * `automation.updated` / `automation_run.updated` on the viewer's own `user:` stream (ids only) refresh the list, the
 * open automation and its runs. Both `ev` and `eph` frames count (07.6-22: a 07.6 frame may be ephemeral).
 */
export function useAutomationLive() {
  const qc = useQueryClient();
  const userId = useMe({ enabled: false }).data?.user.id ?? null;
  useTopic(userId ? topic("user", userId) : null, (frame) => {
    if (frame.op !== "ev" && frame.op !== "eph") return;
    if (frame.type !== EventTypes.automationUpdated && frame.type !== EventTypes.automationRunUpdated) return;
    const id = (frame.data as { automationId?: unknown } | null)?.automationId;
    void qc.invalidateQueries({ queryKey: ["automations", "list"] });
    if (typeof id === "string") {
      void qc.invalidateQueries({ queryKey: automationKeys.detail(id) });
      void qc.invalidateQueries({ queryKey: automationKeys.runs(id) });
    }
  });
}

// ---------------------------------------------------------------- schedule presets ↔ cron (UI-SPEC Surface 2)

export type SchedulePreset = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";

export const SCHEDULE_PRESETS: ReadonlyArray<{ value: SchedulePreset; label: string }> = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "custom", label: "Custom" },
];

export const HOURLY_MINUTES = ["00", "15", "30", "45"] as const;

/** Monday first; `n` is the cron weekday (Sunday 0). */
export const WEEK_DAYS = [
  { n: 1, short: "Mon", letter: "M", long: "Monday" },
  { n: 2, short: "Tue", letter: "T", long: "Tuesday" },
  { n: 3, short: "Wed", letter: "W", long: "Wednesday" },
  { n: 4, short: "Thu", letter: "T", long: "Thursday" },
  { n: 5, short: "Fri", letter: "F", long: "Friday" },
  { n: 6, short: "Sat", letter: "S", long: "Saturday" },
  { n: 0, short: "Sun", letter: "S", long: "Sunday" },
] as const;

export interface ScheduleValue {
  preset: SchedulePreset;
  /** Every hour: the minute (`00`, `15`, `30`, `45`). */
  minute: string;
  /** `HH:MM`, 24-hour (every preset but hourly and custom). */
  time: string;
  /** Every week: cron weekdays (Sunday 0). */
  days: number[];
  /** Every month: `1`…`28` or `L` (the last day). */
  monthDay: string;
  /** Custom: the five cron fields as typed. */
  cron: string;
  timeZone: string;
}

/** The browser's IANA zone (the default of a new automation). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** A new automation: every week on Friday at 17:00 in the browser's zone. */
export function defaultSchedule(timeZone: string = browserTimeZone()): ScheduleValue {
  return { preset: "weekly", minute: "00", time: "17:00", days: [5], monthDay: "1", cron: "", timeZone };
}

const TIME_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** The cron of the editor's schedule, or null when a field the preset needs is missing (no time, no day). */
export function scheduleToCron(v: ScheduleValue): string | null {
  if (v.preset === "custom") return v.cron.trim() || null;
  if (v.preset === "hourly") return `${Number(v.minute)} * * * *`;
  const t = TIME_RE.exec(v.time);
  if (!t) return null;
  const at = `${Number(t[2])} ${Number(t[1])}`;
  switch (v.preset) {
    case "daily":
      return `${at} * * *`;
    case "weekdays":
      return `${at} * * 1-5`;
    case "weekly": {
      const days = [...new Set(v.days.map((d) => d % 7))].sort((a, b) => a - b);
      return days.length > 0 ? `${at} * * ${days.join(",")}` : null;
    }
    case "monthly":
      return `${at} ${v.monthDay} * *`;
  }
}

const MIN_RE = /^(?:[0-9]|[1-5][0-9])$/;
const HOUR_RE = /^(?:[0-9]|1[0-9]|2[0-3])$/;
const two = (n: number) => String(n).padStart(2, "0");

/**
 * The editor's form of a stored cron (the inverse of `scheduleToCron`); a cron no preset produces opens as Custom
 * (a bot's proposal may carry one).
 */
export function cronToSchedule(cron: string, timeZone: string): ScheduleValue {
  const base = { ...defaultSchedule(timeZone), cron: cron.trim() };
  const custom: ScheduleValue = { ...base, preset: "custom" };
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return custom;
  const [min, hour, dom, month, dow] = f as [string, string, string, string, string];
  if (!MIN_RE.test(min) || month !== "*") return custom;
  const minute = Number(min);
  if (hour === "*" && dom === "*" && dow === "*") {
    return HOURLY_MINUTES.includes(two(minute) as (typeof HOURLY_MINUTES)[number])
      ? { ...base, preset: "hourly", minute: two(minute) }
      : custom;
  }
  if (!HOUR_RE.test(hour)) return custom;
  const time = `${two(Number(hour))}:${two(minute)}`;
  if (dom === "*" && dow === "*") return { ...base, preset: "daily", time };
  if (dom === "*" && dow === "1-5") return { ...base, preset: "weekdays", time };
  if (dom === "*" && /^[0-7](?:,[0-7])*$/.test(dow)) {
    const days = [...new Set(dow.split(",").map((d) => Number(d) % 7))].sort((a, b) => a - b);
    return { ...base, preset: "weekly", time, days };
  }
  if (dow === "*" && (dom === "L" || /^(?:[1-9]|1[0-9]|2[0-8])$/.test(dom))) {
    return { ...base, preset: "monthly", time, monthDay: dom };
  }
  return custom;
}

// ---------------------------------------------------------------- dates in an automation's zone

/** `Fri, Oct 9, 5:00 PM` in `timeZone`. */
export function formatRunInstant(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}

const dayKey = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );

/**
 * ` (11:00 AM your time)` when the browser's zone is not the automation's (with the weekday when the day differs:
 * ` (Sat, 1:00 AM your time)`); empty when they are the same zone or tell the same wall time.
 */
export function yourTimeSuffix(iso: string, timeZone: string, browserZone: string): string {
  const fmt = (zone: string, opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat("en-US", { ...opts, timeZone: zone }).format(new Date(iso));
  const clock = (zone: string) => fmt(zone, { hour: "numeric", minute: "2-digit" });
  if (browserZone === timeZone) return "";
  const sameDay = dayKey(iso, timeZone) === dayKey(iso, browserZone);
  if (sameDay && clock(timeZone) === clock(browserZone)) return "";
  const day = sameDay ? "" : `${fmt(browserZone, { weekday: "short" })}, `;
  return ` (${day}${clock(browserZone)} your time)`;
}

/** `It's 2:05 PM there now.` */
export function nowThere(timeZone: string, now: number = Date.now()): string | null {
  if (!isKnownTimeZone(timeZone)) return null;
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(
    new Date(now),
  );
  return `It's ${time} there now.`;
}

/** The list's next run: `in 12 min`, `in 3 h`, `Fri` (within a week), `Oct 23` (later), in the automation's zone. */
export function nextRelative(iso: string, timeZone: string, now: number = Date.now()): string {
  const ms = new Date(iso).getTime() - now;
  if (ms < 60 * 60_000) return `in ${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 12 * 3_600_000) return `in ${Math.round(ms / 3_600_000)} h`;
  if (ms < 6.5 * 86_400_000) {
    return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(new Date(iso));
  }
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(new Date(iso));
}

/** `40 s`, `3 min`, `1 h 5 min`. */
export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

// ---------------------------------------------------------------- words of the list and the run history

export type ResultTone = "done" | "running" | "failed" | "muted";

/** A run status in words (UI-SPEC § Copy › Last run); a digest's answered run reads `Sent`. */
export function runResult(status: AutomationRunStatus, digest = false): { label: string; tone: ResultTone } {
  switch (status) {
    case "answered":
      return { label: digest ? "Sent" : "Done", tone: "done" };
    case "delivered":
      return { label: "Running", tone: "running" };
    case "queued":
      return { label: "Queued", tone: "running" };
    case "no_reply":
      return { label: "No reply", tone: "failed" };
    case "failed":
      return { label: "Failed", tone: "failed" };
    case "skipped":
      return { label: "Skipped", tone: "muted" };
  }
}

/** Dot and label colours per tone (UI-SPEC § Color › Run result): text at AA contrast in both themes. */
export const RESULT_TONE: Record<ResultTone, { text: string; dot: string }> = {
  done: { text: "text-emerald-800 dark:text-emerald-300", dot: "bg-emerald-500 dark:bg-emerald-400" },
  running: { text: "text-primary dark:text-blue-200", dot: "bg-primary dark:bg-blue-300" },
  failed: { text: "text-red-800 dark:text-red-300", dot: "bg-red-500 dark:bg-red-400" },
  muted: { text: "text-muted-foreground", dot: "bg-muted-foreground/60" },
};

export const TRIGGER_WORD: Record<AutomationRun["trigger"], string> = {
  schedule: "Scheduled",
  webhook: "Webhook",
  mail: "Mail",
  manual: "Run now",
};

/** Where an automation delivers, as the list and the reasons name it: `#sales`, `orders board · Intake`, `your DM`. */
export function targetName(a: Pick<Automation, "target" | "runAs">, me: string | null): string {
  if (a.target.kind === "dm" && a.runAs.id === me) return "your DM";
  return a.target.label;
}

/** Why a run was skipped or failed, in the run history's words (UI-SPEC § Copy › Run reasons). */
export function runReasonSentence(
  reason: AutomationRunReason,
  ctx: { bot: string; conversation: string; maxRunsPerDay: number },
): string {
  switch (reason) {
    case "no_reply":
      return `${ctx.bot} didn't answer within 15 minutes.`;
    case "agent_not_member":
      return `${ctx.bot} isn't a member of ${ctx.conversation} any more.`;
    case "target_not_postable":
      return `You can no longer post in ${ctx.conversation}.`;
    case "agent_daily_limit":
      return `${ctx.bot}'s daily limit was reached.`;
    case "runs_per_day":
      return `This automation reached its ${ctx.maxRunsPerDay} runs for today.`;
    case "hourly_cap":
      return "Too many incoming items this hour.";
    case "agent_disabled":
      return `${ctx.bot} is turned off.`;
    case "run_as_not_allowed":
      return "You're no longer allowed to run automations.";
    case "bot_not_readable":
      return `${ctx.bot} isn't available any more.`;
    case "missed":
      return "Missed while the server was down.";
    case "paused":
      return "Paused when it was due.";
    case "delivery_failed":
      return `${ctx.bot} couldn't be reached for this run.`;
    case "nothing_new":
      return "Nothing new.";
    case "summary_skipped_limit":
      return "Sent without the AI summary: your AI chat limit was reached.";
    case "summary_failed":
      return "Sent without the AI summary: it couldn't be written.";
  }
}

/** The run history's second line: the reason, or how long the bot took. */
export function runLine(run: AutomationRun, a: Automation, me: string | null): string | null {
  if (run.reason) {
    return runReasonSentence(run.reason, {
      bot: a.agent.displayName,
      conversation: targetName(a, me),
      maxRunsPerDay: a.maxRunsPerDay,
    });
  }
  if (run.status === "answered" && run.answeredAt) {
    return `Answered in ${durationText(new Date(run.answeredAt).getTime() - new Date(run.createdAt).getTime())}`;
  }
  return null;
}

/** The run's anchor message (channel thread, board card thread or the DM), or null when nothing was posted. */
export function runOpenHref(run: AutomationRun, a: Pick<Automation, "target">): string | null {
  if (!run.anchor) return null;
  const kind = a.target.kind === "dm" ? "dm" : "channel";
  return permalinkPath(
    { id: run.anchor.conversationId, kind },
    run.anchor.messageId,
    kind === "channel" ? run.anchor.threadRootId : null,
  );
}

/** `Resumed “{name}”. Next run {when}.` (no next run for an inbound trigger). */
export function resumedText(a: Automation): string {
  const zone = a.trigger.schedule?.timeZone;
  return a.nextRunAt && zone
    ? `Resumed “${a.name}”. Next run ${formatRunInstant(a.nextRunAt, zone)}.`
    : `Resumed “${a.name}”.`;
}

/** An automation's status word (Active · Paused · Needs attention). */
export function statusWord(status: Automation["status"]): string {
  return status === "active" ? "Active" : status === "paused" ? "Paused" : "Needs attention";
}

/** The trigger's summary for the list and the editor (`Fridays at 5:00 PM`, `Webhook · 41 today`). */
export function triggerSummary(a: Automation, summary: (cron: string) => string): string {
  if (a.trigger.kind === "schedule" && a.trigger.schedule) return summary(a.trigger.schedule.cron);
  if (a.trigger.kind === "webhook") return `Webhook · ${a.inboundToday} today`;
  const m = a.trigger.mailbox;
  return m ? `${m.vaultItemName} · every ${m.pollIntervalMinutes} min` : "Mail";
}

// ---------------------------------------------------------------- API refusals in words (UI-SPEC § Copy › API errors)

const detail = (err: unknown, key: string): number | null => {
  if (!isApiError(err)) return null;
  const v = (err.details as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === "number" ? v : null;
};

/**
 * The fixed sentence of an API refusal on save, never the API's code. `version` is the editor's own banner (Reload),
 * so it is not worded here.
 */
export function automationErrorText(
  err: unknown,
  ctx: { bot: string; conversation: string; maxAutomations?: number; minMinutes?: number },
): string {
  if (!isApiError(err)) return errorMessage(err);
  if (err.isNetwork) return errorMessage(err);
  switch (err.code) {
    case "automation_cap":
      return `You've reached ${detail(err, "max") ?? ctx.maxAutomations ?? "the maximum number of"} automations. Delete one to add another.`;
    case "schedule_too_frequent":
      return `Runs can be at most every ${detail(err, "minMinutes") ?? ctx.minMinutes ?? 15} minutes in this workspace.`;
    case "invalid_cron":
      return "That schedule isn't valid";
    case "invalid_time_zone":
      return "Pick a time zone from the list";
    case "agent_not_member":
      return `${ctx.bot} isn't a member of ${ctx.conversation}. Add it from Bots first.`;
    case "target_not_postable":
      return `You can't post in ${ctx.conversation}.`;
    case "personal_bot_target":
      return "Personal bots deliver only to your DMs.";
    case "agent_unavailable":
      return `${ctx.bot} isn't available right now. Pick another bot.`;
    case "not_allowed":
      return "You can't create automations. Ask an admin.";
    case "webhook_not_allowed":
      return "Only team leads and admins can create webhooks.";
    case "mailbox_host_not_allowed": {
      const d = (err.details ?? {}) as { host?: unknown; key?: unknown };
      const host = typeof d.host === "string" ? d.host : "this server";
      const key = typeof d.key === "string" ? d.key : "the key";
      return `Add ${host} to the allowed hosts of “${key}” in Keychain.`;
    }
    case "mailbox_key_not_usable":
      return "Choose a username and password key from your Keychain.";
    case "approval_expired":
      return "This proposal expired. Create the automation without it.";
    case "approval_already_decided":
      return "This proposal was already decided.";
    default:
      return "Couldn't save the automation. Try again.";
  }
}
