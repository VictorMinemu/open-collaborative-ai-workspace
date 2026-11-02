import { describe, expect, it } from "vitest";
import { AgentCardApprovalLink } from "./agent-cards";
import { ApprovalView } from "./approvals";
import { AutomationDraftView } from "./automations";

/** 07.6-12 (R5): a bot's automation proposal as the review and the editor's `?draft=` read it, and its card link. */
const ID = "01928d9e-3c4b-7f00-8a00-000000000001";
const BOT = "01928d9e-3c4b-7f00-8a00-000000000002";
const ANA = "01928d9e-3c4b-7f00-8a00-000000000003";

const view = {
  type: "automation_draft",
  title: "Create “Weekly sales report”",
  fields: [{ label: "Bot", value: "Scout" }],
  draft: {
    name: "Weekly sales report",
    agent: { id: BOT, displayName: "Scout" },
    runAs: { id: ANA, displayName: "Ana Pérez" },
    instructions: "Summarise the week's closed deals.",
    schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" },
    target: { kind: "channel", conversationId: ID, label: "#sales" },
    maxRunsPerDay: 24,
    status: "pending",
    automationId: null,
    edited: false,
  },
};

describe("AutomationDraftView (07.6-12)", () => {
  it("is one of the approval views and carries the draft in request form", () => {
    const parsed = ApprovalView.parse(view);
    expect(parsed.type).toBe("automation_draft");
    expect(AutomationDraftView.parse(view).draft.schedule).toEqual({
      cron: "0 17 * * 5",
      timeZone: "Europe/Madrid",
    });
    expect(
      AutomationDraftView.parse({
        ...view,
        draft: { ...view.draft, target: { kind: "dm", label: "Your DM with Scout" } },
      }).draft.target.kind,
    ).toBe("dm");
  });

  it("refuses an unknown status and a draft without its schedule", () => {
    expect(
      AutomationDraftView.safeParse({ ...view, draft: { ...view.draft, status: "approved" } }).success,
    ).toBe(false);
    const { schedule: _schedule, ...noSchedule } = view.draft;
    expect(AutomationDraftView.safeParse({ ...view, draft: noSchedule }).success).toBe(false);
  });

  it("a card's approval link may say the proposal was created with changes; older links still parse", () => {
    const link = {
      id: ID,
      actionHash: "a".repeat(64),
      status: "applied",
      requestedForUserId: ANA,
      warnings: [],
    };
    expect(AgentCardApprovalLink.parse(link).edited).toBeUndefined();
    expect(AgentCardApprovalLink.parse({ ...link, edited: true }).edited).toBe(true);
  });
});
