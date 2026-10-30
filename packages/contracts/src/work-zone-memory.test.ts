import { describe, expect, it } from "vitest";
import * as contracts from "./index";
import {
  MemoryPreferences,
  SessionMemoryStatus,
  SessionMemorySummary,
  WorkSessionMemoryUpdatedEvent,
} from "./work-zone-memory";

const ID = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";

const base = {
  proposalId: null,
  auto: false,
  nothingNew: false,
  decidedBy: null,
  decisionNote: null,
  canPropose: true,
  canMap: false,
  model: null,
};

describe("Work Zone session memory (AUTO-06, D-06, D-10, D-11)", () => {
  it("an unmapped session has no unit; the viewer may be sent to 07.9's linking flow", () => {
    const summary = SessionMemorySummary.parse({ ...base, status: "unmapped", unit: null, canMap: true });
    expect(summary.unit).toBe(null);
    expect(summary.canMap).toBe(true);
  });

  it("a pending proposal names the linked team project and the proposal", () => {
    const summary = SessionMemorySummary.parse({
      ...base,
      status: "pending",
      unit: { id: ID, name: "Billing" },
      proposalId: ID,
      canPropose: false,
      model: { label: "GPT-5 mini", metered: true, plan: false },
    });
    expect(summary.unit?.name).toBe("Billing");
    expect(summary.model?.metered).toBe(true);
  });

  it("refuses an unknown status; the statuses are the agreed set", () => {
    expect(SessionMemorySummary.safeParse({ ...base, status: "queued", unit: null }).success).toBe(false);
    expect(SessionMemoryStatus.options).toEqual([
      "none",
      "unmapped",
      "writing",
      "pending",
      "applied",
      "denied",
      "failed",
    ]);
  });

  it("the automatic preference is off by default", () => {
    expect(MemoryPreferences.parse({})).toEqual({ autoProposeSessionSummaries: false });
    expect(MemoryPreferences.parse({ autoProposeSessionSummaries: true }).autoProposeSessionSummaries).toBe(
      true,
    );
  });

  it("the realtime payload is the session id only (strict)", () => {
    expect(WorkSessionMemoryUpdatedEvent.parse({ workSessionId: ID })).toEqual({ workSessionId: ID });
    expect(WorkSessionMemoryUpdatedEvent.safeParse({ workSessionId: ID, status: "pending" }).success).toBe(
      false,
    );
    expect(WorkSessionMemoryUpdatedEvent.safeParse({ workSessionId: ID, unitId: ID }).success).toBe(false);
  });

  it("adds no repository mapping contract of its own (D-10: 07.9's work-projects.ts owns linking)", () => {
    const names = Object.keys(contracts);
    expect(names.filter((n) => /RepoMapping|RepositoryMapping|MapRepo|MappingCandidate/i.test(n))).toEqual(
      [],
    );
    expect("WorkProjectRepo" in contracts).toBe(true);
    expect(Object.keys(SessionMemorySummary.shape)).not.toContain("repoKey");
  });
});
