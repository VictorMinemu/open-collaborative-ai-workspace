import { AUTOMATION_LIMITS, type Automation, type AutomationRun, AutomationRunReason } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/api";
import {
  automationErrorText,
  automationKeys,
  baseVersionAfter,
  cronToSchedule,
  defaultSchedule,
  expectedTurnsPerDay,
  INTERVAL_MINUTES,
  intervalOptions,
  nextRelative,
  rowOpenTarget,
  runOpenHref,
  runReasonSentence,
  runsPerDayOfSchedule,
  runsPerDayPrefill,
  SCHEDULE_PRESETS,
  type ScheduleValue,
  scheduleSummary,
  scheduleToCron,
  yourTimeSuffix,
} from "@/lib/automation-queries";
import { DailyLimitWarning } from "./automation-editor-sheet";
import { RunHistory } from "./run-history";
import { NextRuns } from "./schedule-builder";
import { conversationOptionLabel, EMPTY_TARGET, TargetPicker } from "./target-picker";
import { TriggerStep } from "./trigger-step";

/**
 * The automations UI (07.6-15, AUTO-01, D-07, UI-SPEC Surface 2): the editor's presets ↔ cron, the words of schedules,
 * the next runs the API previews across DST in Madrid and Sydney, targets and their reasons, refusals in words, and the
 * run history's lines. Static markup in node; the browser flows are in e2e/tests/automations.spec.ts.
 */

const ID = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";
const CONV = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e60";
const ME = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e61";

const sched = (patch: Partial<ScheduleValue>): ScheduleValue => ({
  ...defaultSchedule("Europe/Madrid"),
  ...patch,
});

function render(node: ReactNode, seed?: (qc: QueryClient) => void): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["me"], { user: { id: ME, name: "Víctor Ruiz" }, organization: { id: ID } });
  seed?.(qc);
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

/** Visible text of the markup (tags removed, entities decoded for the few we use). */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("the editor's base version after its own Pause / Resume (07.6 review C ME-04)", () => {
  it("advances when the form was loaded from the version the action changed, never over a version saved meanwhile", () => {
    // Loaded at 4, Resume answers 5: a later save sends 5 (no false 409, no lost edits).
    expect(baseVersionAfter(4, 4, 5)).toBe(5);
    // Loaded at 3 while the server was at 4 (changed meanwhile): the base stays, so the save is still a real 409.
    expect(baseVersionAfter(3, 4, 5)).toBe(3);
    // Nothing loaded yet: nothing to advance.
    expect(baseVersionAfter(null, 4, 5)).toBeNull();
  });
});

describe("where a row opens (07.6 review C LO-03)", () => {
  const ME = "01a11635-d6e7-7c87-9f17-0000000000a1";
  const LENA = "01a11635-d6e7-7c87-9f17-0000000000a2";
  const row = (actionKind: "agent_turn" | "digest", runAs: string) => ({
    id: "01a11635-d6e7-7c87-9f17-0000000000c1",
    actionKind,
    runAs: { id: runAs },
  });
  it("my digest opens my Settings › Digest; Lena's digest opens its runs, never my own settings", () => {
    expect(rowOpenTarget(row("digest", ME), ME)).toEqual({ kind: "digest_settings" });
    expect(rowOpenTarget(row("digest", LENA), ME)).toEqual({
      kind: "editor",
      id: "01a11635-d6e7-7c87-9f17-0000000000c1",
      tab: "runs",
    });
    expect(rowOpenTarget(row("agent_turn", LENA), ME)).toEqual({
      kind: "editor",
      id: "01a11635-d6e7-7c87-9f17-0000000000c1",
    });
  });
});

describe("schedule presets ↔ cron (UI-SPEC Surface 2)", () => {
  it("every preset makes its cron", () => {
    expect(scheduleToCron(sched({ preset: "hourly", minute: "15" }))).toBe("15 * * * *");
    expect(scheduleToCron(sched({ preset: "hourly", minute: "00" }))).toBe("0 * * * *");
    expect(scheduleToCron(sched({ preset: "daily", time: "08:30" }))).toBe("30 8 * * *");
    expect(scheduleToCron(sched({ preset: "weekdays", time: "09:00" }))).toBe("0 9 * * 1-5");
    expect(scheduleToCron(sched({ preset: "weekly", time: "17:00", days: [5] }))).toBe("0 17 * * 5");
    expect(scheduleToCron(sched({ preset: "weekly", time: "09:00", days: [4, 1, 4] }))).toBe("0 9 * * 1,4");
    expect(scheduleToCron(sched({ preset: "weekly", time: "12:00", days: [0, 6] }))).toBe("0 12 * * 0,6");
    expect(scheduleToCron(sched({ preset: "monthly", time: "18:00", monthDay: "3" }))).toBe("0 18 3 * *");
    expect(scheduleToCron(sched({ preset: "monthly", time: "23:45", monthDay: "L" }))).toBe("45 23 L * *");
    expect(scheduleToCron(sched({ preset: "custom", cron: " */30 9-17 * * 1-5 " }))).toBe(
      "*/30 9-17 * * 1-5",
    );
  });

  it("a missing day or time makes no cron (the editor says which)", () => {
    expect(scheduleToCron(sched({ preset: "weekly", days: [] }))).toBe(null);
    expect(scheduleToCron(sched({ preset: "daily", time: "" }))).toBe(null);
    expect(scheduleToCron(sched({ preset: "custom", cron: "  " }))).toBe(null);
  });

  it("every preset's cron opens as that preset again", () => {
    const cases: Array<[string, Partial<ScheduleValue>]> = [
      ["15 * * * *", { preset: "hourly", minute: "15" }],
      ["30 8 * * *", { preset: "daily", time: "08:30" }],
      ["0 9 * * 1-5", { preset: "weekdays", time: "09:00" }],
      ["0 17 * * 5", { preset: "weekly", time: "17:00", days: [5] }],
      ["0 9 * * 1,4", { preset: "weekly", time: "09:00", days: [1, 4] }],
      ["0 0 * * 7", { preset: "weekly", time: "00:00", days: [0] }],
      ["0 18 3 * *", { preset: "monthly", time: "18:00", monthDay: "3" }],
      ["45 23 L * *", { preset: "monthly", time: "23:45", monthDay: "L" }],
    ];
    for (const [cron, expected] of cases) {
      const v = cronToSchedule(cron, "Europe/Madrid");
      expect(v, cron).toMatchObject({ ...expected, timeZone: "Europe/Madrid" });
      if (cron !== "0 0 * * 7") expect(scheduleToCron(v), cron).toBe(cron);
    }
  });

  it("a cron no preset makes (a bot's proposal may carry one) opens as Custom with that cron", () => {
    for (const cron of [
      "*/20 * * * *",
      "7 * * * *",
      "0 9 29 * *",
      "0 9 * 1 *",
      "0 9-17 * * 1-5",
      "nonsense",
    ]) {
      const v = cronToSchedule(cron, "UTC");
      expect(v.preset, cron).toBe("custom");
      expect(v.cron, cron).toBe(cron);
      expect(scheduleToCron(v), cron).toBe(cron);
    }
  });

  it("a new automation starts every week on Friday at 17:00 in the browser's zone", () => {
    const v = defaultSchedule("Europe/Madrid");
    expect(scheduleToCron(v)).toBe("0 17 * * 5");
    expect(v.timeZone).toBe("Europe/Madrid");
  });
});

describe("every few minutes (07.17, D-01, PD-04, PD-19)", () => {
  it("the preset list starts with Every few minutes; the intervals are 5, 10, 15 and 30", () => {
    expect(SCHEDULE_PRESETS[0]).toEqual({ value: "every_minutes", label: "Every few minutes" });
    expect(SCHEDULE_PRESETS.map((p) => p.value)).toEqual([
      "every_minutes",
      "hourly",
      "daily",
      "weekdays",
      "weekly",
      "monthly",
      "custom",
    ]);
    expect([...INTERVAL_MINUTES]).toEqual([5, 10, 15, 30]);
  });

  it("every N minutes makes */N and a stored */N opens as that preset; */7 and */20 stay Custom", () => {
    expect(scheduleToCron(sched({ preset: "every_minutes", everyMinutes: 10 }))).toBe("*/10 * * * *");
    for (const n of INTERVAL_MINUTES) {
      const v = cronToSchedule(`*/${n} * * * *`, "Europe/Madrid");
      expect(v, String(n)).toMatchObject({
        preset: "every_minutes",
        everyMinutes: n,
        timeZone: "Europe/Madrid",
      });
      expect(scheduleToCron(v)).toBe(`*/${n} * * * *`);
    }
    for (const cron of ["*/7 * * * *", "*/20 * * * *", "*/10 9-17 * * *", "*/10 * * * 1-5"]) {
      expect(cronToSchedule(cron, "UTC").preset, cron).toBe("custom");
    }
    // A new automation keeps its weekly default; 10 minutes is the interval the preset starts with.
    expect(defaultSchedule("UTC")).toMatchObject({ preset: "weekly", everyMinutes: 10 });
  });

  it("intervals below the workspace minimum are disabled and say why", () => {
    expect(intervalOptions(10)).toEqual([
      { value: 5, label: "Every 5 minutes · Below your workspace's minimum (10 min)", disabled: true },
      { value: 10, label: "Every 10 minutes", disabled: false },
      { value: 15, label: "Every 15 minutes", disabled: false },
      { value: 30, label: "Every 30 minutes", disabled: false },
    ]);
    expect(intervalOptions(undefined).filter((o) => o.disabled)).toEqual([]);
  });

  it("the schedule builder shows the interval select for Every few minutes, and no time field", () => {
    const html = render(
      <TriggerStep
        form={{
          triggerKind: "schedule",
          schedule: sched({ preset: "every_minutes", everyMinutes: 10 }),
          setTriggerKind: () => undefined,
          setSchedule: () => undefined,
          scheduleErrors: {},
          preview: { state: "idle" },
          disabled: false,
          minMinutes: 10,
        }}
        canWebhook
        lastSave={null}
        mode="new"
      />,
    );
    expect(html).toContain('data-testid="schedule-interval"');
    expect(text(/data-testid="schedule-interval"[\s\S]*?<\/button>/.exec(html)?.[0] ?? "")).toContain(
      "Every 10 minutes",
    );
    expect(html).not.toContain('data-testid="schedule-time"');
  });

  it("runs a day of each schedule; picking an interval pre-fills min(cap, floor(1440 / N)), never otherwise", () => {
    expect(runsPerDayOfSchedule(sched({ preset: "every_minutes", everyMinutes: 10 }))).toBe(144);
    expect(runsPerDayOfSchedule(sched({ preset: "every_minutes", everyMinutes: 5 }))).toBe(288);
    expect(runsPerDayOfSchedule(sched({ preset: "hourly" }))).toBe(24);
    for (const preset of ["daily", "weekdays", "weekly", "monthly"] as const) {
      expect(runsPerDayOfSchedule(sched({ preset })), preset).toBe(1);
    }
    expect(runsPerDayOfSchedule(sched({ preset: "custom", cron: "*/7 * * * *" }))).toBeNull();

    const weekly = sched({ preset: "weekly" });
    const ten = sched({ preset: "every_minutes", everyMinutes: 10 });
    expect(runsPerDayPrefill(weekly, ten, 288)).toBe(144);
    expect(runsPerDayPrefill(weekly, ten, 96)).toBe(96);
    expect(runsPerDayPrefill(ten, { ...ten, everyMinutes: 30 }, 288)).toBe(48);
    // Same interval (the zone changed), or a preset that is not an interval: the stored runs a day stay.
    expect(runsPerDayPrefill(ten, { ...ten, timeZone: "UTC" }, 288)).toBeNull();
    expect(runsPerDayPrefill(ten, weekly, 288)).toBeNull();
  });

  it("the frequency message reads the workspace's minimum, with 5 minutes as the only fallback", () => {
    expect(AUTOMATION_LIMITS.minScheduleMinutesDefault).toBe(5);
    const msg = (minMinutes?: number) =>
      text(
        render(
          <NextRuns
            preview={{ state: "error", code: "schedule_too_frequent" }}
            timeZone="UTC"
            {...(minMinutes !== undefined ? { minMinutes } : {})}
          />,
        ),
      );
    expect(msg()).toContain("Runs can be at most every 5 minutes in this workspace.");
    expect(msg(20)).toContain("Runs can be at most every 20 minutes in this workspace.");
    const ctx = { bot: "Scout", conversation: "#sales" };
    expect(automationErrorText(new ApiRequestError(400, "schedule_too_frequent", "x"), ctx)).toBe(
      "Runs can be at most every 5 minutes in this workspace.",
    );
  });
});

describe("the bot's daily limit before saving (07.17, D-11, PD-19)", () => {
  const ten = sched({ preset: "every_minutes", everyMinutes: 10 });

  it("expected turns a day: the schedule's runs within runs a day, plus the fan-out", () => {
    expect(expectedTurnsPerDay({ schedule: ten, maxRunsPerDay: 144, fanOutPerDay: 0 })).toBe(144);
    expect(expectedTurnsPerDay({ schedule: ten, maxRunsPerDay: 96, fanOutPerDay: 0 })).toBe(96);
    expect(
      expectedTurnsPerDay({ schedule: sched({ preset: "weekly" }), maxRunsPerDay: 24, fanOutPerDay: 0 }),
    ).toBe(1);
    const custom = sched({ preset: "custom", cron: "*/7 * * * *" });
    expect(expectedTurnsPerDay({ schedule: custom, maxRunsPerDay: 50, fanOutPerDay: 0 })).toBe(50);
    expect(expectedTurnsPerDay({ schedule: ten, maxRunsPerDay: 144, fanOutPerDay: 100 })).toBe(244);
    // A webhook or mail trigger has no schedule: runs a day is the bound.
    expect(expectedTurnsPerDay({ schedule: null, maxRunsPerDay: 30, fanOutPerDay: 0 })).toBe(30);
  });

  it("over the bot's limit: an amber status callout naming the bot, its limit and the expected turns", () => {
    const html = render(<DailyLimitWarning botName="Scout" dailyLimit={100} expected={144} />);
    expect(html).toContain('data-testid="automation-daily-limit-warning"');
    expect(html).toContain('role="status"');
    expect(html).toMatch(/dark:text-amber-/);
    expect(text(html)).toBe(
      "Scout can take 100 turns a day. This automation can use up to 144. Raise the bot's daily limit in its sheet, or runs stop when it is reached.",
    );
  });

  it("within the limit, or a bot with no limit: no callout", () => {
    expect(render(<DailyLimitWarning botName="Scout" dailyLimit={200} expected={144} />)).toBe("");
    expect(render(<DailyLimitWarning botName="Scout" dailyLimit={144} expected={144} />)).toBe("");
    expect(render(<DailyLimitWarning botName="Scout" dailyLimit={null} expected={144} />)).toBe("");
    expect(render(<DailyLimitWarning botName="Scout" dailyLimit={undefined} expected={144} />)).toBe("");
    expect(render(<DailyLimitWarning botName="Scout" dailyLimit={100} expected={null} />)).toBe("");
  });
});

describe("scheduleSummary (UI-SPEC § Copy › Trigger summaries)", () => {
  it("words every preset as the list, the card and the editor show it", () => {
    expect(scheduleSummary("15 * * * *")).toBe("Every hour at :15");
    expect(scheduleSummary("30 8 * * *")).toBe("Every day at 8:30 AM");
    expect(scheduleSummary("0 9 * * 1-5")).toBe("Weekdays at 9:00 AM");
    expect(scheduleSummary("0 17 * * 5")).toBe("Fridays at 5:00 PM");
    expect(scheduleSummary("0 9 * * 1,4")).toBe("Mondays and Thursdays at 9:00 AM");
    expect(scheduleSummary("0 18 3 * *")).toBe("Monthly on day 3 at 6:00 PM");
    expect(scheduleSummary("45 23 L * *")).toBe("Monthly on the last day at 11:45 PM");
    expect(scheduleSummary("*/7 * * * *")).toBe("Custom schedule (*/7 * * * *)");
  });
});

describe("NextRuns: the API preview in the automation's zone (DST, R13)", () => {
  const runs = (next: string[], timeZone: string, browserZone: string) =>
    text(render(<NextRuns preview={{ state: "ok", next }} timeZone={timeZone} browserZone={browserZone} />));

  it("Europe/Madrid across 2026-03-29: 02:30 does not exist that day, so the run is at 03:30", () => {
    const html = runs(
      ["2026-03-28T01:30:00.000Z", "2026-03-29T01:30:00.000Z", "2026-03-30T00:30:00.000Z"],
      "Europe/Madrid",
      "Europe/Madrid",
    );
    expect(html).toContain("Sat, Mar 28, 2:30 AM");
    expect(html).toContain("Sun, Mar 29, 3:30 AM");
    expect(html).toContain("Mon, Mar 30, 2:30 AM");
    expect(html).not.toContain("your time");
  });

  it("Europe/Madrid across 2026-10-25: Fridays at 5:00 PM keep their wall time when the offset changes", () => {
    const html = runs(
      ["2026-10-23T15:00:00.000Z", "2026-10-30T16:00:00.000Z", "2026-11-06T16:00:00.000Z"],
      "Europe/Madrid",
      "Europe/Madrid",
    );
    expect(html).toContain("Fri, Oct 23, 5:00 PM");
    expect(html).toContain("Fri, Oct 30, 5:00 PM");
    expect(html).toContain("Fri, Nov 6, 5:00 PM");
  });

  it("Australia/Sydney (DST ends 2026-04-05) seen from Madrid and New York adds the browser's time", () => {
    const next = ["2026-04-02T22:00:00.000Z", "2026-04-05T23:00:00.000Z", "2026-04-06T23:00:00.000Z"];
    // 09:00 in Sydney: +11 before 2026-04-05, +10 after; Madrid is on the same day, New York on the day before.
    const madrid = runs(next, "Australia/Sydney", "Europe/Madrid");
    expect(madrid).toContain("Fri, Apr 3, 9:00 AM (12:00 AM your time)");
    expect(madrid).toContain("Mon, Apr 6, 9:00 AM (1:00 AM your time)");
    expect(madrid).toContain("Tue, Apr 7, 9:00 AM (1:00 AM your time)");
    const newYork = runs(next, "Australia/Sydney", "America/New_York");
    expect(newYork).toContain("Fri, Apr 3, 9:00 AM (Thu, 6:00 PM your time)");
    expect(newYork).toContain("Mon, Apr 6, 9:00 AM (Sun, 7:00 PM your time)");
  });

  it("the browser's time is the wall time when the day is the same, with the weekday when it is not", () => {
    expect(yourTimeSuffix("2026-10-23T15:00:00.000Z", "Europe/Madrid", "Europe/London")).toBe(
      " (4:00 PM your time)",
    );
    expect(yourTimeSuffix("2026-10-23T15:00:00.000Z", "Europe/Madrid", "Europe/Madrid")).toBe("");
    expect(yourTimeSuffix("2026-10-23T23:30:00.000Z", "Europe/Madrid", "America/New_York")).toBe(
      " (Fri, 7:30 PM your time)",
    );
  });

  it("loading shows three skeleton chips; a refused schedule shows its sentence", () => {
    const loading = render(<NextRuns preview={{ state: "loading" }} timeZone="UTC" />);
    expect(loading.match(/data-slot="skeleton"/g) ?? []).toHaveLength(3);
    const often = text(
      render(
        <NextRuns
          preview={{ state: "error", code: "schedule_too_frequent", minMinutes: 5 }}
          timeZone="UTC"
          minMinutes={10}
        />,
      ),
    );
    // The preview's own answer wins over the options' minimum.
    expect(often).toContain("Runs can be at most every 5 minutes in this workspace.");
    const invalid = text(
      render(<NextRuns preview={{ state: "error", code: "invalid_cron" }} timeZone="UTC" />),
    );
    expect(invalid).toContain("That schedule isn't valid");
  });

  it("the list's next run: minutes, hours, a weekday within the week, a date later", () => {
    const now = Date.parse("2026-10-20T10:00:00.000Z");
    expect(nextRelative("2026-10-20T10:12:00.000Z", "Europe/Madrid", now)).toBe("in 12 min");
    expect(nextRelative("2026-10-20T13:00:00.000Z", "Europe/Madrid", now)).toBe("in 3 h");
    expect(nextRelative("2026-10-23T15:00:00.000Z", "Europe/Madrid", now)).toBe("Fri");
    expect(nextRelative("2026-11-23T15:00:00.000Z", "Europe/Madrid", now)).toBe("Nov 23");
  });
});

describe("targets (D-07, R2): disabled options keep their reason in their text", () => {
  const conv = (
    disabledReason: "agent_not_member" | "target_not_postable" | null,
    layout: "text" | "board" = "text",
  ) => ({
    conversationId: CONV,
    name: layout === "board" ? "orders" : "sales",
    layout,
    disabledReason,
    columns: [],
  });

  it("names the channel, and why the bot or the person cannot use it", () => {
    expect(conversationOptionLabel(conv(null), "Scout")).toBe("#sales");
    expect(conversationOptionLabel(conv("agent_not_member"), "Scout")).toBe("#sales · Scout isn't a member");
    expect(conversationOptionLabel(conv("target_not_postable"), "Scout")).toBe(
      "#sales · you can't post here",
    );
    expect(conversationOptionLabel(conv(null, "board"), "Scout")).toBe("orders");
  });

  it("a personal bot offers only the DM: Channel and Board are disabled and say why", () => {
    const html = render(
      <TargetPicker
        agent={{ id: ID, displayName: "Víctor's bot", personal: true }}
        value={{ ...EMPTY_TARGET, kind: "dm" }}
        onChange={() => undefined}
        errors={{}}
      />,
    );
    for (const kind of ["channel", "board"]) {
      const card = new RegExp(`data-testid="target-kind-${kind}"[\\s\\S]*?</label>`).exec(html)?.[0] ?? "";
      expect(card, kind).toContain("disabled");
      expect(text(card), kind).toContain("Personal bots deliver only to your DMs.");
    }
    const dm = /data-testid="target-kind-dm"[\s\S]*?<\/label>/.exec(html)?.[0] ?? "";
    expect(dm).not.toMatch(/<input[^>]*disabled/);
    expect(text(html)).toContain("Delivered in your direct messages with Víctor's bot.");
  });

  it("a team bot offers all three", () => {
    const html = render(
      <TargetPicker
        agent={{ id: ID, displayName: "Scout", personal: false }}
        value={{ ...EMPTY_TARGET, kind: "channel" }}
        onChange={() => undefined}
        errors={{}}
      />,
    );
    expect(html.match(/<input[^>]*type="radio"[^>]*disabled/g) ?? []).toHaveLength(0);
    expect(text(html)).toContain("Each run starts a thread; Scout answers in it.");
  });
});

describe("TriggerStep (D-02, D-07)", () => {
  const form = {
    triggerKind: "schedule" as const,
    schedule: defaultSchedule("Europe/Madrid"),
    setTriggerKind: () => undefined,
    setSchedule: () => undefined,
    scheduleErrors: {},
    preview: { state: "idle" as const },
    disabled: false,
  };

  it("Webhook is disabled with its reason without automation.webhook; Schedule and Mail are offered", () => {
    const html = render(<TriggerStep form={form} canWebhook={false} lastSave={null} mode="new" />);
    const webhook = /data-testid="trigger-kind-webhook"[\s\S]*?<\/label>/.exec(html)?.[0] ?? "";
    expect(webhook).toMatch(/<input[^>]*disabled/);
    expect(text(webhook)).toContain("Only team leads and admins can create webhooks.");
    const schedule = /data-testid="trigger-kind-schedule"[\s\S]*?<\/label>/.exec(html)?.[0] ?? "";
    expect(schedule).not.toMatch(/<input[^>]*disabled/);
    expect(html).toContain('data-testid="schedule-builder"');
  });

  it("with the right, Webhook is offered with its hint", () => {
    const html = render(<TriggerStep form={form} canWebhook lastSave={null} mode="new" />);
    const webhook = /data-testid="trigger-kind-webhook"[\s\S]*?<\/label>/.exec(html)?.[0] ?? "";
    expect(webhook).not.toMatch(/<input[^>]*disabled/);
    expect(text(webhook)).toContain("When another app sends an event");
  });

  it("the day chips are native checkboxes named with the full day", () => {
    const html = render(<TriggerStep form={form} canWebhook lastSave={null} mode="new" />);
    for (const day of ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]) {
      expect(html).toContain(`aria-label="${day}"`);
    }
    expect(html).toMatch(/aria-label="Friday"[^>]*checked=""|checked=""[^>]*aria-label="Friday"/);
  });
});

describe("refusals in words (UI-SPEC § Copy › API errors)", () => {
  const ctx = { bot: "Scout", conversation: "#sales" };
  const err = (code: string, details?: unknown) => new ApiRequestError(400, code, "x", details);
  it("every code has its fixed sentence; unknown codes never show the code", () => {
    expect(automationErrorText(err("automation_cap", { max: 10 }), ctx)).toBe(
      "You've reached 10 automations. Delete one to add another.",
    );
    expect(automationErrorText(err("schedule_too_frequent", { minMinutes: 5 }), ctx)).toBe(
      "Runs can be at most every 5 minutes in this workspace.",
    );
    expect(automationErrorText(err("agent_not_member"), ctx)).toBe(
      "Scout isn't a member of #sales. Add it from Bots first.",
    );
    expect(automationErrorText(err("target_not_postable"), ctx)).toBe("You can't post in #sales.");
    expect(automationErrorText(err("personal_bot_target"), ctx)).toBe(
      "Personal bots deliver only to your DMs.",
    );
    expect(automationErrorText(err("agent_unavailable"), ctx)).toBe(
      "Scout isn't available right now. Pick another bot.",
    );
    expect(automationErrorText(err("not_allowed"), ctx)).toBe("You can't create automations. Ask an admin.");
    expect(automationErrorText(err("webhook_not_allowed"), ctx)).toBe(
      "Only team leads and admins can create webhooks.",
    );
    expect(automationErrorText(err("something_new"), ctx)).toBe("Couldn't save the automation. Try again.");
  });
});

// ---------------------------------------------------------------- run history

function automation(over: Partial<Automation> = {}): Automation {
  return {
    id: ID,
    name: "Weekly sales report",
    actionKind: "agent_turn",
    agent: { id: ID, displayName: "Scout", personal: false },
    runAs: { id: ME, displayName: "Víctor Ruiz" },
    instructions: "Summarise the week.",
    trigger: {
      kind: "schedule",
      schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" },
      webhook: null,
      mailbox: null,
    },
    target: { kind: "channel", conversationId: CONV, label: "#sales" },
    inbound: null,
    maxRunsPerDay: 24,
    status: "active",
    pausedBy: null,
    pausedAt: null,
    consecutiveFailures: 0,
    nextRunAt: "2026-10-30T16:00:00.000Z",
    lastRun: null,
    inboundToday: 0,
    version: 1,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    viewerCan: ["edit", "run", "pause", "delete"],
    ...over,
  };
}

const runId = (n: number) => `0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4${String(n).padStart(3, "0")}`;

function run(n: number, over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: runId(n),
    trigger: "schedule",
    status: "answered",
    reason: null,
    scheduledFor: "2026-10-23T15:00:00.000Z",
    createdAt: "2026-10-23T15:00:01.000Z",
    answeredAt: "2026-10-23T15:00:41.000Z",
    tainted: false,
    anchor: { conversationId: CONV, messageId: runId(900 + n), threadRootId: runId(900 + n) },
    ...over,
  };
}

function renderRuns(runs: AutomationRun[], highlight: string | null = null, a = automation()) {
  return render(<RunHistory automation={a} highlight={highlight} />, (qc) =>
    qc.setQueryData(automationKeys.runs(a.id), { pages: [{ runs, nextCursor: null }], pageParams: [null] }),
  );
}

describe("RunHistory (UI-SPEC Surface 2 › Runs tab)", () => {
  it("each run: time in the automation's zone, trigger, result and how long the bot took, with Open to the anchor", () => {
    const html = renderRuns([run(1)]);
    const t = text(html);
    expect(t).toContain("Fri, Oct 23, 5:00 PM");
    expect(t).toContain("Scheduled");
    expect(t).toContain("Done");
    expect(t).toContain("Answered in 40 s");
    expect(html).toContain(`href="/chat/${CONV}?thread=${runId(901)}&amp;m=${runId(901)}"`);
    expect(html).toContain('aria-label="Open run in #sales"');
    expect(html).toContain('aria-label="Run history"');
  });

  it("webhook and mail runs carry the Outside content badge; skipped runs have no Open", () => {
    const html = renderRuns([
      run(1, { trigger: "webhook", status: "no_reply", reason: "no_reply", answeredAt: null, tainted: true }),
      run(2, { trigger: "mail", status: "answered" }),
      run(3, {
        trigger: "manual",
        status: "skipped",
        reason: "agent_not_member",
        anchor: null,
        answeredAt: null,
      }),
    ]);
    expect(html.match(/data-testid="run-outside"/g) ?? []).toHaveLength(2);
    expect(text(html)).toContain("Scout didn't answer within 15 minutes.");
    expect(text(html)).toContain("Scout isn't a member of #sales any more.");
    expect(text(html)).toContain("Run now");
    expect(html.match(/data-testid="run-open"/g) ?? []).toHaveLength(2);
  });

  it("every run reason has a sentence, without a code", () => {
    const runs = AutomationRunReason.options.map((reason, i) =>
      run(i + 1, { status: "failed", reason, answeredAt: null }),
    );
    const t = text(renderRuns(runs));
    for (const reason of AutomationRunReason.options) {
      const sentence = runReasonSentence(reason, { bot: "Scout", conversation: "#sales", maxRunsPerDay: 24 });
      expect(sentence, reason).not.toContain("_");
      expect(sentence.length, reason).toBeGreaterThan(5);
      expect(t, reason).toContain(sentence);
    }
    expect(
      runReasonSentence("nothing_new", { bot: "Scout", conversation: "your DM", maxRunsPerDay: 1 }),
    ).toBe("Nothing new.");
  });

  it("?run= rings and makes focusable the run it names", () => {
    const html = renderRuns([run(1), run(2)], runId(2));
    const row = new RegExp(`<li[^>]*data-run-id="${runId(2)}"[^>]*>`).exec(html)?.[0] ?? "";
    expect(row).toContain("data-highlighted");
    expect(row).toContain("ring-2");
    expect(row).toContain('tabindex="-1"');
    const other = new RegExp(`<li[^>]*data-run-id="${runId(1)}"[^>]*>`).exec(html)?.[0] ?? "";
    expect(other).not.toContain("data-highlighted");
  });

  it("no runs: when the first one is, or that inbound runs start when something arrives", () => {
    expect(text(renderRuns([]))).toContain("No runs yet. The first one is Fri, Oct 30, 5:00 PM.");
    const hook = automation({
      trigger: { kind: "webhook", schedule: null, webhook: null, mailbox: null },
      nextRunAt: null,
    });
    expect(text(renderRuns([], null, hook))).toContain("No runs yet. They start when something arrives.");
  });

  it("a DM run opens the DM", () => {
    const dm = automation({ target: { kind: "dm", label: "Your DM with Scout" } });
    expect(runOpenHref(run(1), dm)).toBe(`/chat/dm/${CONV}?m=${runId(901)}`);
  });
});
