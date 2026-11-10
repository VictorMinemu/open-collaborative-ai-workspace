import {
  type Automation,
  type AutomationRun,
  type EscalationTargetView,
  FAN_OUT_LIMITS,
  type Member,
  type OrgUnit,
} from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/api";
import {
  automationErrorText,
  automationKeys,
  defaultSchedule,
  expectedTurnsPerDay,
} from "@/lib/automation-queries";
import { targetNamesOf } from "./automation-editor-sheet";
import {
  EscalationOptionList,
  EscalationPicker,
  escalationForSave,
  escalationOptions,
} from "./escalation-picker";
import {
  FAN_OUT_DEFAULT,
  FanOutSection,
  type FanOutValue,
  fanOutAllowed,
  fanOutForSave,
  fanOutPayload,
  fanOutPerDayOf,
  fanOutValueOf,
} from "./fan-out-section";

/**
 * The automation editor's fan-out (07.17, D-02, D-11, D-16, PD-05, PD-19): where "For each new item" shows, what it
 * says, what the save sends, and the daily-limit count. Static markup in node; the browser journey is 18's.
 */

const render = (node: ReactNode) => renderToStaticMarkup(node);

/** Visible text of the markup (tags removed, entities decoded for the few we use). */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const on = (patch: Partial<FanOutValue> = {}): FanOutValue => ({
  ...FAN_OUT_DEFAULT,
  enabled: true,
  ...patch,
});

describe("where fan-out is offered (D-02, D-16, PD-05)", () => {
  it("only agent-turn schedules into a channel or a board", () => {
    expect(fanOutAllowed({ actionKind: "agent_turn", triggerKind: "schedule", targetKind: "channel" })).toBe(
      true,
    );
    expect(fanOutAllowed({ actionKind: "agent_turn", triggerKind: "schedule", targetKind: "board" })).toBe(
      true,
    );
    expect(fanOutAllowed({ actionKind: "agent_turn", triggerKind: "webhook", targetKind: "board" })).toBe(
      false,
    );
    expect(fanOutAllowed({ actionKind: "agent_turn", triggerKind: "mail", targetKind: "channel" })).toBe(
      false,
    );
    expect(fanOutAllowed({ actionKind: "digest", triggerKind: "schedule", targetKind: "channel" })).toBe(
      false,
    );
    expect(fanOutAllowed({ actionKind: "agent_turn", triggerKind: "schedule", targetKind: "dm" })).toBe(
      false,
    );
    expect(fanOutAllowed({ actionKind: "agent_turn", triggerKind: "schedule", targetKind: "thread" })).toBe(
      false,
    );
  });
});

describe("the For each new item section (PD-19)", () => {
  const section = (value: FanOutValue, over: { columnName?: string | null; name?: string } = {}) =>
    render(
      <FanOutSection
        value={value}
        onChange={() => {}}
        targetKind={over.columnName === null ? "channel" : "board"}
        conversationName="#orders"
        columnName={over.columnName === null ? null : (over.columnName ?? "Backlog")}
        automationName={over.name ?? "Orders"}
        errors={{}}
      />,
    );

  it("off: the 44 px switch row and the helper naming the board column; no inputs", () => {
    const html = section(FAN_OUT_DEFAULT);
    expect(html).toContain('data-testid="automation-fan-out"');
    expect(html).toMatch(/<label[^>]*min-h-11[^>]*>/);
    const t = text(html);
    expect(t).toContain("Open a conversation for each new item");
    expect(t).toContain("The bot opens a card in Backlog for every item");
    expect(t).toContain("for every item it has not opened before, and works each one on its own.");
    expect(html).not.toContain('data-testid="automation-fan-out-per-run"');
    expect(html).not.toContain('data-testid="automation-fan-out-per-day"');
  });

  it("on: both caps, one column below sm, the dedupe line and the runs thread", () => {
    const html = section(on());
    expect(html).toContain('data-testid="automation-fan-out-per-run"');
    expect(html).toContain('data-testid="automation-fan-out-per-day"');
    expect(html).toMatch(/class="[^"]*grid[^"]*sm:grid-cols-2[^"]*"/);
    expect(html).not.toMatch(/class="grid-cols-2/);
    const t = text(html);
    expect(t).toContain("At most per run");
    expect(t).toContain("At most per day");
    expect(t).toContain("Items already opened are skipped, never opened twice.");
    expect(t).toContain("Runs are listed in one “Orders · Runs” thread.");
    // Every input is 44 px tall on phones.
    expect(html.match(/<input[^>]*max-md:h-11[^>]*>/g) ?? []).toHaveLength(2);
  });

  it("a channel target speaks of threads in the channel, with no column", () => {
    const t = text(section(FAN_OUT_DEFAULT, { columnName: null }));
    expect(t).toContain("The bot opens a thread in #orders for every item");
    expect(t).not.toContain("card");
  });

  it("an inline error sits under its input", () => {
    const html = render(
      <FanOutSection
        value={on({ perRun: "30" })}
        onChange={() => {}}
        targetKind="board"
        conversationName="#orders"
        columnName="Backlog"
        automationName="Orders"
        errors={{ perRun: "Use a whole number from 1 to 25" }}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("Use a whole number from 1 to 25");
    expect(html).toMatch(
      /data-testid="automation-fan-out-per-run"[^>]*aria-invalid="true"|aria-invalid="true"[^>]*data-testid="automation-fan-out-per-run"/,
    );
  });
});

describe("what the save sends (PD-05)", () => {
  it("the defaults: { enabled: true, perRun: 10, perDay: 100 }", () => {
    expect(fanOutPayload(on())).toEqual({ ok: true, fanOut: { enabled: true, perRun: 10, perDay: 100 } });
    expect(FAN_OUT_DEFAULT).toEqual({
      enabled: false,
      perRun: String(FAN_OUT_LIMITS.perRunDefault),
      perDay: String(FAN_OUT_LIMITS.perDayDefault),
    });
  });

  it("per run above per day, and out-of-range values, are inline errors", () => {
    expect(fanOutPayload(on({ perRun: "20", perDay: "5" }))).toEqual({
      ok: false,
      errors: { perDay: "At most per day must be at least per run" },
    });
    expect(fanOutPayload(on({ perRun: "26" }))).toEqual({
      ok: false,
      errors: { perRun: "Use a whole number from 1 to 25" },
    });
    expect(fanOutPayload(on({ perRun: "0", perDay: "501" }))).toEqual({
      ok: false,
      errors: { perRun: "Use a whole number from 1 to 25", perDay: "Use a whole number from 1 to 500" },
    });
    expect(fanOutPayload(on({ perDay: "1.5" }))).toMatchObject({ ok: false });
  });

  it("off with hidden values that don't parse: the stored or default caps, never an error", () => {
    expect(fanOutPayload({ enabled: false, perRun: "", perDay: "x" })).toEqual({
      ok: true,
      fanOut: { enabled: false, perRun: 10, perDay: 100 },
    });
  });

  it("a new automation sends fanOut only when it is on and allowed", () => {
    expect(fanOutForSave({ allowed: true, value: FAN_OUT_DEFAULT, initial: null })).toEqual({
      ok: true,
      fanOut: undefined,
    });
    expect(fanOutForSave({ allowed: false, value: on(), initial: null })).toEqual({
      ok: true,
      fanOut: undefined,
    });
    expect(fanOutForSave({ allowed: true, value: on({ perRun: "5" }), initial: null })).toEqual({
      ok: true,
      fanOut: { enabled: true, perRun: 5, perDay: 100 },
    });
  });

  it("an existing automation without fan-out opens off and saves without a fanOut key unless the section changed", () => {
    const start = fanOutValueOf(undefined);
    expect(start).toEqual(FAN_OUT_DEFAULT);
    expect(fanOutValueOf({ enabled: false, perRun: 10, perDay: 100 })).toEqual(FAN_OUT_DEFAULT);
    expect(fanOutForSave({ allowed: true, value: start, initial: start })).toEqual({
      ok: true,
      fanOut: undefined,
    });
    expect(fanOutForSave({ allowed: true, value: on(), initial: start })).toEqual({
      ok: true,
      fanOut: { enabled: true, perRun: 10, perDay: 100 },
    });
  });

  it("turning it off, or moving to a target where it isn't allowed, sends enabled: false with the stored caps", () => {
    const stored = fanOutValueOf({ enabled: true, perRun: 4, perDay: 40 });
    expect(stored).toEqual({ enabled: true, perRun: "4", perDay: "40" });
    expect(fanOutForSave({ allowed: true, value: { ...stored, enabled: false }, initial: stored })).toEqual({
      ok: true,
      fanOut: { enabled: false, perRun: 4, perDay: 40 },
    });
    expect(fanOutForSave({ allowed: false, value: stored, initial: stored })).toEqual({
      ok: true,
      fanOut: { enabled: false, perRun: 4, perDay: 40 },
    });
    // Off already and moved elsewhere: nothing to send.
    expect(fanOutForSave({ allowed: false, value: FAN_OUT_DEFAULT, initial: FAN_OUT_DEFAULT })).toEqual({
      ok: true,
      fanOut: undefined,
    });
  });
});

describe("the daily-limit callout counts the fan-out (D-11)", () => {
  const ten = { ...defaultSchedule("Europe/Madrid"), preset: "every_minutes" as const, everyMinutes: 10 };

  it("per day when fan-out is on and allowed, else 0", () => {
    expect(fanOutPerDayOf(true, on())).toBe(100);
    expect(fanOutPerDayOf(true, on({ perDay: "40" }))).toBe(40);
    expect(fanOutPerDayOf(true, FAN_OUT_DEFAULT)).toBe(0);
    expect(fanOutPerDayOf(false, on())).toBe(0);
    expect(fanOutPerDayOf(true, on({ perDay: "abc" }))).toBe(0);
    expect(
      expectedTurnsPerDay({ schedule: ten, maxRunsPerDay: 144, fanOutPerDay: fanOutPerDayOf(true, on()) }),
    ).toBe(244);
  });
});

describe("the target's names in the section's copy", () => {
  const BOARD = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e70";
  const COL = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e71";
  const conversations = [
    {
      conversationId: BOARD,
      name: "Fleet",
      layout: "board" as const,
      disabledReason: null,
      columns: [{ id: COL, name: "Backlog", category: "backlog" as const }],
    },
  ];
  const board = {
    kind: "board" as const,
    conversationId: BOARD,
    columnId: COL,
    threadRootMessageId: "",
    label: "",
  };

  it("from the bot's target options, else from the stored label", () => {
    expect(targetNamesOf(board, conversations)).toEqual({ conversation: "Fleet", column: "Backlog" });
    expect(targetNamesOf({ ...board, label: "Fleet · Doing" }, undefined)).toEqual({
      conversation: "Fleet",
      column: "Doing",
    });
    expect(targetNamesOf({ ...board, kind: "channel", columnId: "", label: "#orders" }, undefined)).toEqual({
      conversation: "#orders",
      column: null,
    });
    expect(targetNamesOf({ ...board, kind: "channel", label: "" }, undefined)).toEqual({
      conversation: null,
      column: null,
    });
  });
});

// ---------------------------------------------------------------- escalation (D-08, PD-15, PD-19)

const uid = (n: number) => `0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d5${String(n).padStart(3, "0")}`;

function member(n: number, name: string, email: string, over: Partial<Member> = {}): Member {
  return {
    userId: uid(n),
    displayName: name,
    email,
    avatarUrl: null,
    role: "standard",
    status: "active",
    statusEmoji: null,
    statusText: null,
    joinedAt: "2026-10-01T10:00:00.000Z",
    ...over,
  };
}

function unit(n: number, name: string, kind: OrgUnit["kind"], over: Partial<OrgUnit> = {}): OrgUnit {
  return {
    id: uid(100 + n),
    parentId: null,
    kind,
    name,
    path: [uid(100 + n)],
    memberCount: 2,
    leadCount: 0,
    viewerCan: [],
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    handle: name.toLowerCase(),
    reach: 6,
    ...over,
  };
}

const MEMBERS = [
  member(1, "Cam Ortega", "cam@acme.test"),
  member(2, "Dan Ruiz", "dan@acme.test"),
  member(3, "Eva Left", "eva@acme.test", { status: "deactivated" }),
];
const UNITS = [
  unit(1, "Logistics", "team"),
  unit(2, "Operations", "department", { reach: 24 }),
  unit(3, "Portal", "project"),
];

const view = (
  kind: "user" | "unit",
  n: number,
  handle: string,
  displayName: string,
): EscalationTargetView => ({
  kind,
  id: kind === "user" ? uid(n) : uid(100 + n),
  handle,
  displayName,
});

describe("escalationOptions: People and Teams (PD-19)", () => {
  it("active members with @handle; teams and departments with @handle and their reach; never projects", () => {
    const o = escalationOptions(MEMBERS, UNITS);
    expect(o.people.map((p) => [p.displayName, p.handle])).toEqual([
      ["Cam Ortega", "cam"],
      ["Dan Ruiz", "dan"],
    ]);
    expect(o.teams.map((t) => [t.displayName, t.handle, t.caption])).toEqual([
      ["Logistics", "logistics", "Team · 6"],
      ["Operations", "operations", "Department · 24"],
    ]);
    expect(o.teams.some((t) => t.displayName === "Portal")).toBe(false);
  });

  it("filters by name or handle and leaves out who is already chosen", () => {
    const o = escalationOptions(MEMBERS, UNITS, { q: "log", exclude: [] });
    expect(o.people).toEqual([]);
    expect(o.teams.map((t) => t.displayName)).toEqual(["Logistics"]);
    const left = escalationOptions(MEMBERS, UNITS, { exclude: [{ kind: "user", id: uid(1) }] });
    expect(left.people.map((p) => p.displayName)).toEqual(["Dan Ruiz"]);
  });

  it("the list is grouped People / Teams with handles and the team's caption", () => {
    const o = escalationOptions(MEMBERS, UNITS);
    const html = render(
      <EscalationOptionList listId="x" options={o} active={0} onPick={() => {}} onActive={() => {}} />,
    );
    expect(html).toContain('role="listbox"');
    const t = text(html);
    expect(t.indexOf("People")).toBeLessThan(t.indexOf("Cam Ortega"));
    expect(t.indexOf("Teams")).toBeGreaterThan(t.indexOf("Dan Ruiz"));
    expect(t).toContain("@logistics");
    expect(t).toContain("Team · 6");
    expect(t).toContain("Department · 24");
    expect(html.match(/role="option"/g) ?? []).toHaveLength(4);
    expect(
      html.match(/<button[^>]*role="option"[^>]*min-h-11|<button[^>]*min-h-11[^>]*role="option"/g) ?? [],
    ).toHaveLength(4);
  });
});

describe("EscalationPicker (D-08, PD-15)", () => {
  const picker = (value: EscalationTargetView[], error?: string) =>
    render(
      <EscalationPicker
        value={value}
        onChange={() => {}}
        members={MEMBERS}
        units={UNITS}
        targetName="#orders"
        error={error}
      />,
    );

  it("two chosen: two wrapping chips, each with a 44 px remove button naming who", () => {
    const html = picker([view("unit", 1, "logistics", "Logistics"), view("user", 1, "cam", "Cam Ortega")]);
    expect(html.match(/data-testid="escalation-chip"/g) ?? []).toHaveLength(2);
    expect(html).toContain('aria-label="Remove Logistics"');
    expect(html).toContain('aria-label="Remove Cam Ortega"');
    expect(
      html.match(/aria-label="Remove [^"]+"[^>]*max-md:size-11|max-md:size-11[^>]*aria-label="Remove /g) ??
        [],
    ).toHaveLength(2);
    expect(html).toMatch(/class="[^"]*flex-wrap[^"]*"/);
    const t = text(html);
    expect(t).toContain("Mention when it finishes or needs help");
    expect(t).toContain("They get a notification only if they can read #orders.");
    expect(html).toContain('aria-label="Add a person or team"');
    const add = /<input[^>]*data-testid="escalation-add"[^>]*>/.exec(html)?.[0] ?? "";
    expect(add).not.toContain('disabled=""');
    expect(add).toContain('placeholder="Add a person or team"');
  });

  it("five chosen: the add field is disabled and says Up to 5", () => {
    const five = [
      view("user", 1, "cam", "Cam Ortega"),
      view("user", 2, "dan", "Dan Ruiz"),
      view("unit", 1, "logistics", "Logistics"),
      view("unit", 2, "operations", "Operations"),
      view("user", 9, "zoe", "Zoe"),
    ];
    const html = picker(five);
    const add = /<input[^>]*data-testid="escalation-add"[^>]*>/.exec(html)?.[0] ?? "";
    expect(add).toContain('disabled=""');
    expect(add).toContain('placeholder="Up to 5"');
  });

  it("escalation_not_allowed: the sentence under the picker, in place of the hint", () => {
    const sentence = automationErrorText(new ApiRequestError(400, "escalation_not_allowed", "x"), {
      bot: "Atlas",
      conversation: "#orders",
    });
    expect(sentence).toBe("Someone here can't read #orders or left the workspace.");
    const html = picker([view("user", 1, "cam", "Cam Ortega")], sentence);
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain("Someone here can't read #orders or left the workspace.");
    expect(text(html)).not.toContain("They get a notification only if");
  });

  it("fan_out_not_allowed has its own sentence", () => {
    expect(
      automationErrorText(new ApiRequestError(400, "fan_out_not_allowed", "x"), {
        bot: "A",
        conversation: "#o",
      }),
    ).toBe("This automation can't open a conversation per item with this trigger or target.");
  });
});

describe("what the save sends for escalation (PD-15)", () => {
  const a = [view("unit", 1, "logistics", "Logistics"), view("user", 1, "cam", "Cam Ortega")];

  it("ids in chip order; a new automation without any sends nothing", () => {
    expect(escalationForSave({ value: a, initial: null })).toEqual([
      { kind: "unit", id: uid(101) },
      { kind: "user", id: uid(1) },
    ]);
    expect(escalationForSave({ value: [], initial: null })).toBeUndefined();
  });

  it("an existing automation sends it only when it changed ([] clears)", () => {
    expect(escalationForSave({ value: a, initial: a })).toBeUndefined();
    expect(escalationForSave({ value: [], initial: a })).toEqual([]);
    expect(escalationForSave({ value: [...a].reverse(), initial: a })).toEqual([
      { kind: "user", id: uid(1) },
      { kind: "unit", id: uid(101) },
    ]);
  });
});

// ---------------------------------------------------------------- run history (D-10)

describe("run history: what each fan-out run opened", () => {
  const AID = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";
  const CONV = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e60";
  const automation = {
    id: AID,
    name: "Orders",
    actionKind: "agent_turn",
    agent: { id: AID, displayName: "Atlas", personal: false },
    runAs: { id: uid(1), displayName: "Cam Ortega" },
    instructions: "Check the orders.",
    trigger: {
      kind: "schedule",
      schedule: { cron: "*/10 * * * *", timeZone: "Europe/Madrid" },
      webhook: null,
      mailbox: null,
    },
    target: { kind: "channel", conversationId: CONV, label: "#orders" },
    inbound: null,
    maxRunsPerDay: 144,
    status: "active",
    pausedBy: null,
    pausedAt: null,
    consecutiveFailures: 0,
    nextRunAt: null,
    lastRun: null,
    inboundToday: 0,
    version: 1,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    viewerCan: ["edit", "run", "pause", "delete"],
  } satisfies Automation;
  const run = (n: number, opened: number | null | undefined): AutomationRun => ({
    id: uid(500 + n),
    trigger: "schedule",
    status: "answered",
    reason: null,
    scheduledFor: "2026-10-23T15:00:00.000Z",
    createdAt: "2026-10-23T15:00:01.000Z",
    answeredAt: "2026-10-23T15:00:41.000Z",
    tainted: false,
    anchor: { conversationId: CONV, messageId: uid(600 + n), threadRootId: uid(600 + n) },
    ...(opened === undefined ? {} : { opened }),
  });

  it("Opened 2 conversations, Nothing new, and no chip without fan-out", async () => {
    const { RunHistory } = await import("./run-history");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["me"], { user: { id: uid(1), name: "Cam Ortega" }, organization: { id: AID } });
    qc.setQueryData(automationKeys.runs(AID), {
      pages: [{ runs: [run(1, 2), run(2, 0), run(3, null), run(4, undefined), run(5, 1)], nextCursor: null }],
      pageParams: [null],
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <RunHistory automation={automation} highlight={null} />
      </QueryClientProvider>,
    );
    const chips = [...html.matchAll(/data-testid="run-opened"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(chips).toEqual(["Opened 2 conversations", "Nothing new", "Opened 1 conversation"]);
    const chip = /<span[^>]*data-testid="run-opened"[^>]*>/.exec(html)?.[0] ?? "";
    expect(chip).toContain("bg-secondary");
  });

  it("WR-02: a run with items waiting for a free session says how many; none waiting shows nothing", async () => {
    const { RunHistory } = await import("./run-history");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["me"], { user: { id: uid(1), name: "Cam Ortega" }, organization: { id: AID } });
    qc.setQueryData(automationKeys.runs(AID), {
      pages: [
        {
          runs: [{ ...run(1, 3), waiting: 2 }, { ...run(2, 1), waiting: 0 }, run(3, null)],
          nextCursor: null,
        },
      ],
      pageParams: [null],
    });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <RunHistory automation={automation} highlight={null} />
      </QueryClientProvider>,
    );
    const chips = [...html.matchAll(/data-testid="run-waiting"[^>]*>([^<]*)</g)].map((m) => m[1]);
    expect(chips).toEqual(["2 waiting"]);
  });
});
