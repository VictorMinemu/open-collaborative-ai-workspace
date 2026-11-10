import { FAN_OUT_LIMITS } from "@ocw/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { defaultSchedule, expectedTurnsPerDay } from "@/lib/automation-queries";
import { targetNamesOf } from "./automation-editor-sheet";
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
