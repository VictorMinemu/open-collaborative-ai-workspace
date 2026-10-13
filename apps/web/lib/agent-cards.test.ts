import type { AgentCard } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { mergeCard, openTargetOf, shownCard } from "./agent-cards";

/** Pure Agent Card helpers (06-15): viewer fields survive realtime updates; Open only to internal routes. */

const AT = "2026-10-07T09:00:00.000Z";
const LATER = "2026-10-07T09:05:00.000Z";

function card(over: Partial<AgentCard> = {}): AgentCard {
  return {
    kind: "approval",
    title: "Deploy api v2.3",
    fields: [],
    status: "pending",
    actions: [
      { kind: "open", label: "Open", target: "/work-zone" },
      { kind: "approve", label: "Approve" },
    ],
    version: 1,
    decision: null,
    updatedAt: AT,
    ...over,
  };
}

const decision = {
  outcome: "approved" as const,
  by: { kind: "user" as const, id: "01a11635-d6e7-7c87-9f17-b6b1dc048942", displayName: "Sam Lee" },
  at: LATER,
};

describe("mergeCard", () => {
  it("keeps the cached viewer fields when the update carries none (realtime, P-04)", () => {
    const prev = card({ following: true, viewerCan: ["follow", "decide"] });
    expect(mergeCard(prev, card({ status: "running", version: 2 }))).toMatchObject({
      status: "running",
      version: 2,
      following: true,
      viewerCan: ["follow", "decide"],
    });
  });

  it("drops decide once the card is decided", () => {
    const prev = card({ following: false, viewerCan: ["follow", "decide"] });
    expect(mergeCard(prev, card({ decision, updatedAt: LATER })).viewerCan).toEqual(["follow"]);
  });

  it("takes the update's own viewer fields when it has them (REST)", () => {
    const prev = card({ following: true, viewerCan: ["follow", "decide"] });
    expect(mergeCard(prev, card({ following: false, viewerCan: ["follow"] }))).toMatchObject({
      following: false,
      viewerCan: ["follow"],
    });
  });

  it("without a cached card the viewer fields stay unknown", () => {
    const merged = mergeCard(undefined, card());
    expect(merged.viewerCan).toBeUndefined();
    expect(merged.following).toBeUndefined();
  });
});

describe("shownCard", () => {
  it("the newer content wins (a decision response before its realtime event); viewer fields from the viewer read", () => {
    const fromList = card({ following: false, viewerCan: ["follow", "decide"] });
    const fromViewer = card({ decision, updatedAt: LATER, following: true, viewerCan: ["follow"] });
    expect(shownCard(fromList, fromViewer)).toMatchObject({
      decision: { outcome: "approved" },
      following: true,
      viewerCan: ["follow"],
    });
  });

  it("a newer list card (agent update) keeps the viewer read's fields and never offers decide after a decision", () => {
    const fromViewer = card({ following: true, viewerCan: ["follow", "decide"] });
    const fromList = card({ status: "succeeded", version: 2, updatedAt: LATER, decision });
    expect(shownCard(fromList, fromViewer)).toMatchObject({
      status: "succeeded",
      following: true,
      viewerCan: ["follow"],
    });
  });

  it("without a viewer read the list card is shown as is", () => {
    expect(shownCard(card({ viewerCan: ["follow"] }), undefined).viewerCan).toEqual(["follow"]);
  });

  it("at the same version the single-card read wins: a mirror card that arrived live before its approval link keeps the link (07.2-17)", () => {
    const approval = {
      id: "01a11635-d6e7-7c87-9f17-b6b1dc048943",
      actionHash: "a".repeat(64),
      status: "pending" as const,
      requestedForUserId: null,
      warnings: ["Scout read web or tool content in this turn."],
    };
    const live = card({ platformOwned: true });
    const read = card({ platformOwned: true, approval, following: false, viewerCan: ["follow", "decide"] });
    expect(shownCard(live, read)).toMatchObject({
      platformOwned: true,
      approval,
      viewerCan: ["follow", "decide"],
    });
    // A newer live update still wins over an older read.
    const decided = card({
      platformOwned: true,
      approval: { ...approval, status: "applied" },
      decision,
      version: 2,
      updatedAt: LATER,
    });
    expect(shownCard(decided, read)).toMatchObject({ version: 2, approval: { status: "applied" } });
  });
});

describe("openTargetOf", () => {
  it("returns an internal route and refuses anything else (client re-check of AgentCardRoute)", () => {
    expect(openTargetOf(card())).toBe("/work-zone");
    for (const target of [
      "https://evil.example",
      "//evil.example",
      "/chat/../..",
      "/elsewhere",
      "javascript:x",
    ]) {
      expect(openTargetOf(card({ actions: [{ kind: "open", label: "Open", target }] })), target).toBeNull();
    }
    expect(openTargetOf(card({ actions: [] }))).toBeNull();
  });
});
