import { AGENT_CARD_FIELDS_MAX, AgentCardInput } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import {
  beforeAfter,
  type ChangeCardInput,
  changeCard,
  conflictCard,
  displayValue,
  previewOf,
} from "./cards";

/** 07.6-07 (UI-SPEC Surface 8c, R9): the server-composed watched-record cards and the link dialog's preview. */

const CONV = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";
const CARD = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e60";
const AT = new Date("2026-10-08T09:20:00.000Z");

const base = (over: Partial<ChangeCardInput> = {}): ChangeCardInput => ({
  recordId: "SO-10442",
  connectorName: "ERP",
  fields: [
    { pointer: "/status", label: "Status" },
    { pointer: "/delivery_date", label: "Delivery date" },
    { pointer: "/total", label: "Total" },
  ],
  before: { "/status": "Confirmed", "/delivery_date": "2026-10-14", "/total": "1250.00" },
  after: { "/status": "Shipped", "/delivery_date": "2026-10-16", "/total": "1300.00" },
  source: "schedule",
  detectedAt: AT,
  timeZone: "UTC",
  conversationId: CONV,
  cardMessageId: CARD,
  ...over,
});

describe("changeCard (8c, Changed elsewhere)", () => {
  it("3 changed fields → 3 rows + Detected; report, info, Changed, platform words, Open card", () => {
    const card = changeCard(base());
    expect(AgentCardInput.safeParse(card).success).toBe(true);
    expect(card).toMatchObject({
      kind: "report",
      status: "info",
      statusLabel: "Changed",
      title: "SO-10442 changed in ERP",
      summary: "SO-10442 changed in ERP: Status, Delivery date, Total.",
      actions: [{ kind: "open", label: "Open card", target: `/chat/${CONV}?thread=${CARD}` }],
    });
    expect(card.fields).toEqual([
      { label: "Status", value: "Confirmed → Shipped" },
      { label: "Delivery date", value: "2026-10-14 → 2026-10-16" },
      { label: "Total", value: "1250.00 → 1300.00" },
      { label: "Detected", value: "Oct 8, 9:20 AM UTC · on schedule" },
    ]);
  });

  it("only changed fields become rows; key order inside a value is not a change", () => {
    const card = changeCard(
      base({
        fields: [
          { pointer: "/status", label: "Status" },
          { pointer: "/meta", label: "Meta" },
        ],
        before: { "/status": "Confirmed", "/meta": { a: 1, b: 2 } },
        after: { "/status": "Shipped", "/meta": { b: 2, a: 1 } },
      }),
    );
    expect(card.fields.map((f) => f.label)).toEqual(["Status", "Detected"]);
  });

  it("12 changed fields → 10 rows + More: 2 more fields changed + Detected (12 in total)", () => {
    const fields = Array.from({ length: 12 }, (_, i) => ({ pointer: `/f${i}`, label: `Field ${i}` }));
    const before = Object.fromEntries(fields.map((f) => [f.pointer, "a"]));
    const after = Object.fromEntries(fields.map((f) => [f.pointer, "b"]));
    const card = changeCard(base({ fields, before, after }));
    expect(card.fields).toHaveLength(AGENT_CARD_FIELDS_MAX);
    expect(card.fields.slice(0, 10).map((f) => f.label)).toEqual(fields.slice(0, 10).map((f) => f.label));
    expect(card.fields[10]).toEqual({ label: "More", value: "2 more fields changed" });
    expect(card.fields[11]?.label).toBe("Detected");
    expect(AgentCardInput.safeParse(card).success).toBe(true);
  });

  it("an empty before (null, missing or blank) reads (empty) → x", () => {
    const card = changeCard(
      base({
        before: { "/status": null, "/delivery_date": "  " },
        after: { "/status": "Shipped", "/delivery_date": "2026-10-16" },
        fields: [
          { pointer: "/status", label: "Status" },
          { pointer: "/delivery_date", label: "Delivery date" },
          { pointer: "/total", label: "Total" },
        ],
      }),
    );
    expect(card.fields.slice(0, 2)).toEqual([
      { label: "Status", value: "(empty) → Shipped" },
      { label: "Delivery date", value: "(empty) → 2026-10-16" },
    ]);
    expect(beforeAfter("x", undefined)).toBe("x → (empty)");
  });

  it("a 600-character value is cut so the field stays within 500 characters", () => {
    const long = "x".repeat(600);
    const value = beforeAfter(long, "y");
    expect(value.length).toBeLessThanOrEqual(500);
    expect(value).toMatch(/^x+… → y$/u);
    const both = beforeAfter(long, "z".repeat(600));
    expect(both.length).toBeLessThanOrEqual(500);
    expect(both).toMatch(/^x+… → z+…$/u);
    const card = changeCard(base({ before: { "/status": long }, after: { "/status": "Shipped" } }));
    expect(AgentCardInput.safeParse(card).success).toBe(true);
  });

  it("values are plain text: numbers, booleans and objects as text, control characters removed", () => {
    expect(displayValue(10.5)).toBe("10.5");
    expect(displayValue(false)).toBe("false");
    expect(displayValue({ a: 1 })).toBe('{"a":1}');
    expect(displayValue("ok\u0007\u001b[31m")).toBe("ok[31m");
  });

  it("says how it was detected: on schedule, when the thread was opened, before an update", () => {
    const detected = (source: ChangeCardInput["source"]) => changeCard(base({ source })).fields.at(-1)?.value;
    expect(detected("schedule")).toMatch(/ · on schedule$/u);
    expect(detected("access")).toMatch(/ · when the thread was opened$/u);
    expect(detected("write")).toMatch(/ · before an update$/u);
    expect(changeCard(base({ timeZone: "Europe/Madrid" })).fields.at(-1)?.value).toBe(
      "Oct 8, 11:20 AM GMT+2 · on schedule",
    );
  });
});

describe("conflictCard (8c, Not saved; used by 07.6-14)", () => {
  it("title, Not saved pill, failed tone, the neutral notice and the ask-again line", () => {
    const card = conflictCard({ ...base({ source: "write" }), botName: "Scout" });
    expect(AgentCardInput.safeParse(card).success).toBe(true);
    expect(card).toMatchObject({
      kind: "report",
      status: "failed",
      statusLabel: "Not saved",
      title: "SO-10442 changed in ERP, so Scout's update wasn't saved",
      summary: "Scout's update to SO-10442 wasn't saved because it changed in ERP.",
    });
    expect(card.notices).toEqual([
      { tone: "neutral", text: "Someone changed it in ERP after the last check. Nothing was overwritten." },
      { tone: "neutral", text: "Ask Scout again with the new values." },
    ]);
    expect(card.fields.at(-1)?.value).toMatch(/ · before an update$/u);
  });
});

describe("previewOf (R9)", () => {
  it("every top-level field with a suggested label; numberHints only for JSON numbers; a label when given", () => {
    const p = previewOf({
      id: "SO-10442",
      status: "Confirmed",
      delivery_date: "2026-10-14",
      total: "1250.00",
      amount: 10.1,
      customerName: "Globex S.L.",
      notes: null,
      "a/b": true,
      name: "Sales order SO-10442",
    });
    expect(p.label).toBe("Sales order SO-10442");
    expect(p.values).toContainEqual({
      pointer: "/delivery_date",
      value: "2026-10-14",
      suggestedLabel: "Delivery date",
    });
    expect(p.values).toContainEqual({
      pointer: "/customerName",
      value: "Globex S.L.",
      suggestedLabel: "Customer name",
    });
    expect(p.values).toContainEqual({ pointer: "/notes", value: null, suggestedLabel: "Notes" });
    expect(p.values).toContainEqual({ pointer: "/a~1b", value: "true", suggestedLabel: "A/b" });
    expect(p.numberHints).toEqual(["/amount"]);
  });

  it("a record that is not an object previews as nothing", () => {
    expect(previewOf([1, 2])).toEqual({ label: null, values: [], numberHints: [] });
    expect(previewOf("x")).toEqual({ label: null, values: [], numberHints: [] });
  });
});
