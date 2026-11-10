import { describe, expect, it } from "vitest";
import {
  MENTION_KINDS,
  Mention,
  MessageMention,
  NOTIFICATION_KIND_RANK,
  Notification,
  NotificationKind,
  OrgUnit,
  principalMentions,
  TEAM_MENTION_LIMITS,
  UNIT_HANDLE_MAX,
  UNIT_HANDLE_RE,
  unitHandle,
} from "./index";

const USER = "0199b1c2-d3e4-7f5a-8b9c-0d1e2f3a4d01";
const AGENT = "0199b1c2-d3e4-7f5a-8b9c-0d1e2f3a4d02";
const UNIT = "0199b1c2-d3e4-7f5a-8b9c-0d1e2f3a4d03";
const CONV = "0199b1c2-d3e4-7f5a-8b9c-0d1e2f3a4d04";
const NOW = "2026-11-10T08:00:00.000Z";

describe("unit mentions in a message (07.17 D-07, PD-13, P4)", () => {
  it("a message's own mentions admit units; the cell's mention type does not", () => {
    expect(MessageMention.parse({ kind: "unit", id: UNIT })).toEqual({ kind: "unit", id: UNIT });
    expect(MessageMention.parse({ kind: "user", id: USER })).toEqual({ kind: "user", id: USER });
    expect(MessageMention.safeParse({ kind: "channel", id: UNIT }).success).toBe(false);
    expect(Mention.safeParse({ kind: "unit", id: UNIT }).success).toBe(false);
  });

  it("principalMentions keeps people and bots, in order, and drops units", () => {
    const user = { kind: "user", id: USER } as const;
    const unit = { kind: "unit", id: UNIT } as const;
    const agent = { kind: "agent", id: AGENT } as const;
    const principals = principalMentions([user, unit, agent]);
    expect(principals).toEqual([user, agent]);
    for (const m of principals) expect(Mention.parse(m)).toEqual(m);
    expect(principalMentions([unit])).toEqual([]);
  });
});

describe("unit handles (07.17 D-14, PD-12)", () => {
  it("derives a mention handle from the name", () => {
    expect(unitHandle("Logística Norte")).toBe("logistica-norte");
    expect(unitHandle("  Ops  ")).toBe("ops");
    expect(unitHandle("R&D / Labs")).toBe("rd-labs");
    expect(unitHandle("here")).toBe("here-1");
    expect(unitHandle("Channel")).toBe("channel-1");
    expect(unitHandle("🙂🙂")).toBe("team");
    expect(unitHandle("")).toBe("team");
    expect(unitHandle("x".repeat(60)).length).toBeLessThanOrEqual(40);
    expect(unitHandle(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
  });

  it("every handle of a varied fixture matches the handle pattern", () => {
    const names = [
      "Logística Norte",
      "  Ops  ",
      "R&D / Labs",
      "here",
      "everyone",
      "🙂🙂",
      "Sales",
      "Customer Success EMEA",
      "Ñandú Producciones",
      "Équipe Paris",
      "Straße & Söhne",
      "Ops.",
      ".hidden",
      "__init__",
      "a--b",
      "Back-end",
      "Front_end",
      "Data.Science",
      "QA (manual)",
      "Finance: Payables",
      "Team #1",
      "日本チーム",
      "Команда",
      "   ",
      "x".repeat(60),
      "Very long department name that keeps going and going",
      "1st line support",
      "--",
      "Ops 🙂 Night",
      "Ventas – Sur",
    ];
    expect(names).toHaveLength(30);
    for (const name of names) {
      const handle = unitHandle(name);
      expect(handle, name).toMatch(UNIT_HANDLE_RE);
      expect(handle.length, name).toBeLessThanOrEqual(UNIT_HANDLE_MAX);
    }
    expect(UNIT_HANDLE_MAX).toBe(48);
    // The pattern leaves room for allocation suffixes ("-2", "-3", …) up to 48 characters.
    expect(UNIT_HANDLE_RE.test(`${"a".repeat(46)}-2`)).toBe(true);
    expect(UNIT_HANDLE_RE.test("a".repeat(49))).toBe(false);
    expect(UNIT_HANDLE_RE.test("-ops")).toBe(false);
    expect(UNIT_HANDLE_RE.test("Ops")).toBe(false);
  });
});

describe("team_mention notifications (07.17 D-07, D-13, D-17, D-18, PD-14)", () => {
  it("a new kind ranked between a direct mention and a DM, counted as a mention", () => {
    expect(NotificationKind.parse("team_mention")).toBe("team_mention");
    expect(NOTIFICATION_KIND_RANK.team_mention).toBeGreaterThan(NOTIFICATION_KIND_RANK.dm);
    expect(NOTIFICATION_KIND_RANK.team_mention).toBeLessThan(NOTIFICATION_KIND_RANK.mention);
    expect(MENTION_KINDS).toContain("team_mention");
    expect(TEAM_MENTION_LIMITS).toEqual({
      botUnitsPerMessage: 3,
      recipientsPerMessage: 200,
      confirmAbove: 20,
    });
  });

  it("a notification may name the unit that reached the reader", () => {
    const base = {
      id: USER,
      kind: "team_mention",
      conversation: {
        id: CONV,
        kind: "channel",
        name: "fleet",
        label: "#fleet",
        visibility: "public",
        archived: false,
      },
      messageId: AGENT,
      threadRootId: null,
      actor: { kind: "agent", id: AGENT, displayName: "Atlas" },
      snippet: "@logistics order 1042 is ready",
      createdAt: NOW,
      readAt: null,
    };
    const unit = { id: UNIT, handle: "logistics", name: "Logistics" };
    expect(Notification.parse({ ...base, unit }).unit).toEqual(unit);
    expect(Notification.parse({ ...base, unit: null }).unit).toBeNull();
    expect(Notification.parse(base).unit).toBeUndefined();
    expect(Notification.safeParse({ ...base, unit: { ...unit, handle: "h".repeat(65) } }).success).toBe(
      false,
    );
  });
});

describe("unit handles and reach on the organization DTO (07.17 D-14, PD-16)", () => {
  const unit = {
    id: UNIT,
    parentId: null,
    kind: "team",
    name: "Logistics",
    path: [UNIT],
    memberCount: 6,
    leadCount: 1,
    viewerCan: [],
    createdAt: NOW,
    updatedAt: NOW,
  };

  it("a 07.16 unit parses unchanged; a 07.17 one carries its handle and reach", () => {
    const legacy = OrgUnit.parse(unit);
    expect(legacy.handle).toBeUndefined();
    expect(legacy.reach).toBeUndefined();
    expect(legacy.viewerInReach).toBeUndefined();
    const full = { ...unit, handle: "logistics", reach: 6, viewerInReach: true };
    expect(OrgUnit.parse(full)).toEqual(full);
    expect(OrgUnit.safeParse({ ...full, reach: -1 }).success).toBe(false);
    expect(OrgUnit.safeParse({ ...full, handle: "h".repeat(49) }).success).toBe(false);
  });
});
