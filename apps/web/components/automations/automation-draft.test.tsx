import type { ApprovalDetail, AutomationDraftView } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { automationDraftOf, draftConversationName } from "@/lib/automation-queries";
import { DraftBanner, DraftGone } from "./automation-editor-sheet";

/**
 * The editor's `?draft=<approvalId>` mode (07.6-23, AUTO-03, D-07, UI-SPEC Surface 5, R5): a bot's proposal, read
 * through the approval view, opens as the editor's form (presets where the cron is one, Custom otherwise) with the
 * brand-soft banner naming the bot and the conversation; a proposal that is no longer pending opens as gone. The browser
 * flow is in e2e/tests/automation-proposals.spec.ts.
 */

const APPROVAL = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e50";
const BOT = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e51";
const ANA = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e52";
const SALES = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e53";
const ROOT = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e54";
const AUTOMATION = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e55";

type Draft = AutomationDraftView["draft"];

function detailOf(
  draft: Partial<Draft> = {},
  over: Partial<Omit<ApprovalDetail, "view">> = {},
): ApprovalDetail {
  return {
    id: APPROVAL,
    kind: "automation.create",
    mode: "server_apply",
    status: "pending",
    actionHash: "a".repeat(64),
    requestedBy: { agentId: BOT, userId: ANA, displayName: "Scout" },
    createdAt: "2026-11-02T10:00:00.000Z",
    expiresAt: "2026-11-03T10:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    resultCode: null,
    viewerCan: ["decide"],
    ...over,
    view: {
      type: "automation_draft",
      title: "Create “Weekly sales report”",
      fields: [{ label: "Bot", value: "Scout" }],
      draft: {
        name: "Weekly sales report",
        agent: { id: BOT, displayName: "Scout" },
        runAs: { id: ANA, displayName: "Ana Pérez" },
        instructions: "Every Friday, summarise this week's closed deals in #sales.",
        schedule: { cron: "0 17 * * 5", timeZone: "Europe/Madrid" },
        target: { kind: "channel", conversationId: SALES, label: "#sales" },
        maxRunsPerDay: 24,
        status: "pending",
        automationId: null,
        edited: false,
        ...draft,
      },
    },
  } as ApprovalDetail;
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/ ([.,])/g, "$1")
    .trim();

describe("automationDraftOf: a proposal's approval view as the editor's form (R5)", () => {
  it("Fridays at 17:00 in Madrid opens as Every week · Fri · 17:00, with the proposal's other values", () => {
    const d = automationDraftOf(detailOf());
    expect(d.state).toBe("ready");
    if (d.state !== "ready") return;
    expect(d.defaults).toMatchObject({
      name: "Weekly sales report",
      agentId: BOT,
      instructions: "Every Friday, summarise this week's closed deals in #sales.",
      maxRunsPerDay: "24",
      target: {
        kind: "channel",
        conversationId: SALES,
        threadRootMessageId: "",
        columnId: "",
        label: "#sales",
      },
    });
    expect(d.defaults.schedule).toMatchObject({
      preset: "weekly",
      days: [5],
      time: "17:00",
      timeZone: "Europe/Madrid",
    });
    expect(d.bot).toEqual({ id: BOT, displayName: "Scout" });
    expect(d.botName).toBe("Scout");
    expect(d.conversationName).toBe("#sales");
  });

  it("a cron no preset makes opens as Custom with that cron, in the proposal's zone", () => {
    const d = automationDraftOf(
      detailOf({ schedule: { cron: "*/30 9-17 * * 1-5", timeZone: "America/New_York" } }),
    );
    expect(d.state).toBe("ready");
    if (d.state !== "ready") return;
    expect(d.defaults.schedule).toMatchObject({
      preset: "custom",
      cron: "*/30 9-17 * * 1-5",
      timeZone: "America/New_York",
    });
  });

  it("a thread keeps its root; the DM keeps the bot's DM", () => {
    const thread = automationDraftOf(
      detailOf({
        target: {
          kind: "thread",
          conversationId: SALES,
          threadRootMessageId: ROOT,
          label: "Thread in #sales",
        },
      }),
    );
    expect(thread.state === "ready" && thread.defaults.target).toEqual({
      kind: "thread",
      conversationId: SALES,
      threadRootMessageId: ROOT,
      columnId: "",
      label: "Thread in #sales",
    });
    const dm = automationDraftOf(detailOf({ target: { kind: "dm", label: "Your DM with Scout" } }));
    expect(dm.state === "ready" && dm.defaults.target).toEqual({
      kind: "dm",
      conversationId: "",
      threadRootMessageId: "",
      columnId: "",
      label: "Your DM with Scout",
    });
  });

  it("a proposal that is no longer pending is gone (the approval is the one truth), with what it created", () => {
    expect(automationDraftOf(detailOf({}, { status: "denied" })).state).toBe("gone");
    expect(automationDraftOf(detailOf({}, { status: "expired" })).state).toBe("gone");
    expect(automationDraftOf(detailOf({}, { status: "failed" })).state).toBe("gone");
    // A discarded or expired draft stays `pending` in its own table: only the approval's status counts.
    expect(automationDraftOf(detailOf({ status: "pending" }, { status: "denied" })).state).toBe("gone");
    expect(
      automationDraftOf(detailOf({ status: "applied", automationId: AUTOMATION }, { status: "applied" })),
    ).toEqual({ state: "gone", automationId: AUTOMATION });
    // Another kind's view never opens as a draft.
    const other = {
      ...detailOf(),
      view: { type: "fields", title: "Run a tool", fields: [] },
    } as ApprovalDetail;
    expect(automationDraftOf(other)).toEqual({ state: "gone", automationId: null });
  });
});

describe("the draft banner (UI-SPEC § Copy › Editor banners)", () => {
  it("names where it was proposed: the channel, the thread's channel, or the DM", () => {
    expect(draftConversationName({ kind: "channel", conversationId: SALES, label: "#sales" })).toBe("#sales");
    expect(
      draftConversationName({
        kind: "thread",
        conversationId: SALES,
        threadRootMessageId: ROOT,
        label: "Thread in #sales",
      }),
    ).toBe("#sales");
    expect(draftConversationName({ kind: "dm", label: "Your DM with Scout" })).toBe("your DM");
  });

  it("says who proposed it, where, and that saving closes the proposal, on the brand-soft surface", () => {
    const html = renderToStaticMarkup(<DraftBanner bot="Scout" conversation="#sales" />);
    expect(text(html)).toBe("From Scout's proposal in #sales. Saving creates it and closes the proposal.");
    expect(html).toContain("bg-brand-soft");
    expect(html).toContain("text-brand-soft-foreground");
    expect(html).toContain('data-testid="automation-draft-banner"');
  });

  it("a gone proposal says so, and links to what it created when it was confirmed", () => {
    const gone = text(renderToStaticMarkup(<DraftGone automationId={null} onClose={() => undefined} />));
    expect(gone).toContain("This proposal is no longer open");
    expect(gone).toContain("It was confirmed, discarded or it expired.");
    expect(gone).toContain("Back to automations");
    expect(gone).not.toContain("Open automation");
    const created = renderToStaticMarkup(<DraftGone automationId={AUTOMATION} onClose={() => undefined} />);
    expect(text(created)).toContain("Open automation");
    expect(created).toContain(`href="/bots/automations?edit=${AUTOMATION}"`);
  });
});
