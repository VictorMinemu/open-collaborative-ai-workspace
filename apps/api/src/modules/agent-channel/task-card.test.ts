import { AGENT_CARD_TITLE_MAX, AgentCardInput } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { composeTaskCard, type TaskCardFacts, taskMaxHours } from "./task-card";

/**
 * Phase 07.17.1.1.2-08 (D-05, PD-11): the platform-owned task card, composed from the task row alone (never by the
 * bot): the goal as its title, the bot's last progress note and next step as fields, the pill word and the generic
 * status from the contract helpers, and a notice for how it ended.
 */

const started = new Date("2026-11-12T10:00:00.000Z");
const base: TaskCardFacts = {
  goal: "Read the knowledge pack and summarise it",
  status: "running",
  outcome: null,
  progress: null,
  nextStep: null,
  maxTurns: 40,
  startedAt: started.toISOString(),
  deadlineAt: new Date(started.getTime() + 8 * 3_600_000).toISOString(),
};

describe("composeTaskCard", () => {
  it("a running task without notes: the goal, Working, running, no field and no notice", () => {
    const card = composeTaskCard(base);
    expect(card).toEqual({
      title: base.goal,
      summary: base.goal,
      status: "running",
      statusLabel: "Working",
      fields: [],
      notices: [],
    });
  });

  it("a waiting task with progress and next step: the two fields, Waiting, still running", () => {
    const card = composeTaskCard({
      ...base,
      status: "waiting",
      progress: "Read 120 of 3030 files",
      nextStep: "Read the next 200 files",
    });
    expect(card.statusLabel).toBe("Waiting");
    expect(card.status).toBe("running");
    expect(card.fields).toEqual([
      { label: "Progress", value: "Read 120 of 3030 files" },
      { label: "Next step", value: "Read the next 200 files" },
    ]);
    expect(card.notices).toEqual([]);
  });

  it("a task stopped at its turn budget: Stopped, cancelled and the notice", () => {
    const card = composeTaskCard({ ...base, status: "stopped", outcome: "budget_turns" });
    expect(card.statusLabel).toBe("Stopped");
    expect(card.status).toBe("cancelled");
    expect(card.notices).toEqual([{ tone: "neutral", text: "Stopped: it used its 40 turns." }]);
  });

  it("a task stopped at its deadline names the hours it had; a person's stop names them", () => {
    expect(composeTaskCard({ ...base, status: "stopped", outcome: "budget_time" }).notices).toEqual([
      { tone: "neutral", text: "Stopped: it ran for 8 h." },
    ]);
    expect(
      composeTaskCard(
        { ...base, status: "stopped", outcome: "stopped_by_person" },
        { stoppedByName: "Sam Lee" },
      ).notices,
    ).toEqual([{ tone: "neutral", text: "Stopped by Sam Lee." }]);
    expect(
      composeTaskCard({ ...base, status: "stopped", outcome: "stopped_by_person" }, { stoppedByName: null })
        .notices,
    ).toEqual([{ tone: "neutral", text: "Stopped." }]);
  });

  it("done is succeeded without a notice; blocked is failed and reads Blocked", () => {
    const done = composeTaskCard({ ...base, status: "done", outcome: "done" });
    expect(done).toMatchObject({ status: "succeeded", statusLabel: "Done", notices: [] });
    const blocked = composeTaskCard({ ...base, status: "failed", outcome: "blocked" });
    expect(blocked).toMatchObject({ status: "failed", statusLabel: "Blocked", notices: [] });
  });

  it("a goal over the card title bound is cut, never rejected; the card is a valid card input", () => {
    const card = composeTaskCard({ ...base, goal: `${"x".repeat(AGENT_CARD_TITLE_MAX)}yz` });
    expect(card.title).toHaveLength(AGENT_CARD_TITLE_MAX);
    const parsed = AgentCardInput.safeParse({
      kind: "work_zone",
      title: card.title,
      summary: card.summary,
      status: card.status,
      statusLabel: card.statusLabel,
      fields: card.fields,
      notices: card.notices,
      actions: [{ kind: "follow", label: "Follow" }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("taskMaxHours", () => {
  it("is the task's own hour budget (deadline minus start), at least one", () => {
    expect(taskMaxHours(base)).toBe(8);
    expect(taskMaxHours({ ...base, deadlineAt: started.toISOString() })).toBe(1);
  });
});
