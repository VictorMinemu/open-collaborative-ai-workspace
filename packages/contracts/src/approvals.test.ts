import { describe, expect, it } from "vitest";
import { AgentCard, AgentCardDecisionRequest, AgentCardRoute, isAgentCardRoute } from "./agent-cards";
import {
  APPROVAL_NOTE_MAX,
  ApprovalDecisionRequest,
  ApprovalDetail,
  ApprovalErrorCode,
  ApprovalKindId,
  ApprovalList,
  ApprovalListQuery,
  ApprovalMode,
  ApprovalRequestStatus,
  ApprovalRequestUpdatedEvent,
  KNOWN_APPROVAL_KINDS,
} from "./approvals";
import { EventTypes } from "./realtime";
import { ApprovalStatus as WorkZoneApprovalStatus } from "./work-session";

const id = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";
const now = "2026-10-12T10:00:00.000Z";
const hash = "a".repeat(64);

const summary = {
  id,
  kind: "memory.write",
  mode: "server_apply",
  status: "pending",
  actionHash: hash,
  requestedBy: { agentId: id, userId: id, displayName: "Scout" },
  createdAt: now,
  expiresAt: now,
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  resultCode: null,
  viewerCan: ["decide"],
};

const proposal = {
  proposalId: id,
  scope: { id, kind: "unit", label: "Backend" },
  path: "clients/acme.md",
  op: "replace",
  baseVersion: 2,
  currentVersion: 2,
  base: "# Acme\n",
  proposed: "# Acme\nIBAN ES91 2100 0418 4502 0005 1332\n",
  linesAdded: 1,
  linesRemoved: 0,
  findings: [
    { kind: "iban", severity: "warn", source: "builtin", count: 1, samples: ["ES91 •••• 1332"], lines: [2] },
  ],
  spans: [{ kind: "iban", start: 12, end: 41 }],
  readerCount: 7,
  tainted: false,
  reason: "Saving Acme's bank details for invoicing",
  requestedBy: { agent: { id, displayName: "Scout" }, forUser: { id, displayName: "Sam Lee" } },
};

describe("approval contract (MEM-06, D-05, D-08)", () => {
  it("has the fixed statuses and modes", () => {
    expect(ApprovalRequestStatus.options).toEqual([
      "pending",
      "approved",
      "denied",
      "applied",
      "failed",
      "expired",
    ]);
    expect(ApprovalMode.options).toEqual(["server_apply", "grant"]);
    // The Work Zone approval status keeps its name and values (never renamed, D-09).
    expect(WorkZoneApprovalStatus.options).toEqual(["pending", "approved", "denied", "expired"]);
    expect(ApprovalErrorCode.options).toEqual([
      "approval_not_found",
      "approval_expired",
      "not_approver",
      "approval_action_changed",
      "approval_already_decided",
      "action_hash_required",
    ]);
  });

  it("a decision always names the 64-hex action hash the approver saw", () => {
    expect(ApprovalDecisionRequest.parse({ outcome: "approved", actionHash: hash })).toEqual({
      outcome: "approved",
      actionHash: hash,
    });
    for (const bad of ["a".repeat(63), "A".repeat(64), `${"a".repeat(63)}g`, ""]) {
      expect(ApprovalDecisionRequest.safeParse({ outcome: "denied", actionHash: bad }).success, bad).toBe(
        false,
      );
    }
    expect(ApprovalDecisionRequest.safeParse({ outcome: "approved" }).success).toBe(false);
    expect(ApprovalDecisionRequest.safeParse({ outcome: "maybe", actionHash: hash }).success).toBe(false);
  });

  it("an optional note is trimmed plain text of 1-280 characters (UI-SPEC R4)", () => {
    expect(APPROVAL_NOTE_MAX).toBe(280);
    const ok = (note: string) =>
      ApprovalDecisionRequest.safeParse({ outcome: "denied", actionHash: hash, note }).success;
    expect(ok("x".repeat(280))).toBe(true);
    expect(ok("x".repeat(281))).toBe(false);
    expect(ok("   ")).toBe(false);
    expect(ok("Two lines\nare fine")).toBe(true);
    expect(ok("no\u0000control")).toBe(false);
    expect(
      ApprovalDecisionRequest.parse({ outcome: "denied", actionHash: hash, note: "  not this file  " }).note,
    ).toBe("not this file");
  });

  it("kind ids are an open set of dotted ids; memory.write is known", () => {
    for (const k of ["memory.write", "tool.call", "work_zone.start", "a.b.c"]) {
      expect(ApprovalKindId.safeParse(k).success, k).toBe(true);
    }
    for (const k of ["Memory.Write", "memory", "memory.", ".write", "memory..write", "memory.wr-ite"]) {
      expect(ApprovalKindId.safeParse(k).success, k).toBe(false);
    }
    expect(KNOWN_APPROVAL_KINDS).toContain("memory.write");
    for (const k of KNOWN_APPROVAL_KINDS) expect(ApprovalKindId.safeParse(k).success, k).toBe(true);
  });

  it("a detail carries a memory-proposal view or the generic fields view; unknown views fail", () => {
    const memory = { ...summary, view: { type: "memory_proposal", proposal } };
    expect(ApprovalDetail.parse(memory)).toEqual(memory);
    const generic = {
      ...summary,
      kind: "tool.call",
      mode: "grant",
      view: { type: "fields", title: "Run deploy", fields: [{ label: "Tool", value: "deploy" }] },
    };
    expect(ApprovalDetail.parse(generic)).toEqual(generic);
    expect(ApprovalDetail.safeParse({ ...summary, view: { type: "html", body: "<b>x</b>" } }).success).toBe(
      false,
    );
    expect(
      ApprovalDetail.safeParse({
        ...summary,
        view: { type: "fields", title: "x", fields: Array(13).fill({ label: "a", value: "b" }) },
      }).success,
    ).toBe(false);
    // A memory proposal view must carry the highlighted spans (UI-SPEC R5).
    const { spans: _spans, ...noSpans } = proposal;
    expect(
      ApprovalDetail.safeParse({ ...summary, view: { type: "memory_proposal", proposal: noSpans } }).success,
    ).toBe(false);
  });

  it("decided summaries carry who decided, when, the note and the result", () => {
    const decided = {
      ...summary,
      status: "applied",
      decidedAt: now,
      decidedBy: { id, displayName: "Ana Pérez" },
      decisionNote: "Looks right",
      resultCode: null,
      viewerCan: [],
    };
    expect(ApprovalList.parse({ items: [decided], nextCursor: null }).items[0]).toEqual(decided);
    expect(
      ApprovalList.safeParse({ items: [{ ...decided, viewerCan: ["approve"] }], nextCursor: null }).success,
    ).toBe(false);
  });

  it("list queries require a role", () => {
    expect(ApprovalListQuery.safeParse({}).success).toBe(false);
    expect(ApprovalListQuery.parse({ role: "decider", status: "pending", kind: "memory.write" })).toEqual({
      role: "decider",
      status: "pending",
      kind: "memory.write",
    });
    expect(ApprovalListQuery.safeParse({ role: "admin" }).success).toBe(false);
  });

  it("approval_request.updated carries ids and status only", () => {
    expect(EventTypes.approvalRequestUpdated).toBe("approval_request.updated");
    // The Work Zone event keeps its name (never renamed).
    expect(EventTypes.approvalUpdated).toBe("approval.updated");
    expect(ApprovalRequestUpdatedEvent.parse({ id, status: "applied" })).toEqual({ id, status: "applied" });
    expect(ApprovalRequestUpdatedEvent.safeParse({ id, status: "done" }).success).toBe(false);
  });
});

describe("Agent Cards for platform-owned approvals (D-08, UI-SPEC R4/R6)", () => {
  const legacy = {
    kind: "approval",
    title: "Deploy to staging?",
    fields: [{ label: "Branch", value: "main" }],
    status: "pending",
    actions: [{ kind: "approve", label: "Approve" }],
    version: 1,
    decision: {
      outcome: "approved",
      by: { kind: "user", id, displayName: "Ana Pérez" },
      at: now,
    },
    updatedAt: now,
  };

  it("an old card payload still parses", () => {
    expect(AgentCard.parse(legacy)).toEqual(legacy);
  });

  it("a platform-owned card links its approval and shows the decision note", () => {
    const card = {
      ...legacy,
      platformOwned: true,
      approval: {
        id,
        actionHash: hash,
        status: "pending",
        requestedForUserId: id,
        warnings: ["Read web or tool content this turn"],
      },
      decision: { ...legacy.decision, note: "Only the invoicing part" },
    };
    expect(AgentCard.parse(card)).toEqual(card);
    expect(AgentCard.parse({ ...card, approval: null }).approval).toBeNull();
    expect(
      AgentCard.parse({ ...card, approval: { ...card.approval, requestedForUserId: null } }).approval,
    ).toEqual({
      ...card.approval,
      requestedForUserId: null,
    });
    expect(
      AgentCard.safeParse({ ...card, approval: { ...card.approval, warnings: ["a", "b", "c", "d"] } })
        .success,
    ).toBe(false);
    expect(
      AgentCard.safeParse({ ...card, approval: { ...card.approval, warnings: ["x".repeat(201)] } }).success,
    ).toBe(false);
    expect(AgentCard.safeParse({ ...card, approval: { ...card.approval, actionHash: "nope" } }).success).toBe(
      false,
    );
    expect(
      AgentCard.safeParse({ ...card, decision: { ...card.decision, note: "x".repeat(281) } }).success,
    ).toBe(false);
  });

  it("card decisions may carry the action hash and a note", () => {
    expect(AgentCardDecisionRequest.parse({ outcome: "approved" })).toEqual({ outcome: "approved" });
    expect(AgentCardDecisionRequest.parse({ outcome: "approved", actionHash: hash })).toEqual({
      outcome: "approved",
      actionHash: hash,
    });
    expect(AgentCardDecisionRequest.parse({ outcome: "denied", actionHash: hash, note: " no " })).toEqual({
      outcome: "denied",
      actionHash: hash,
      note: "no",
    });
    expect(AgentCardDecisionRequest.safeParse({ outcome: "denied", actionHash: "x" }).success).toBe(false);
    expect(AgentCardDecisionRequest.safeParse({ outcome: "denied", note: "" }).success).toBe(false);
  });

  it("/memory is an internal card route; external URLs stay refused", () => {
    expect(AgentCardRoute.safeParse(`/memory/proposals/${id}`).success).toBe(true);
    expect(isAgentCardRoute("/memory")).toBe(true);
    for (const bad of ["https://evil.example/memory", "//evil.example", "/memoryx", "/memory/../settings"]) {
      expect(isAgentCardRoute(bad), bad).toBe(false);
    }
  });
});
