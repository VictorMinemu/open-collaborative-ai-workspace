import { randomUUID } from "node:crypto";
import { JOB_QUEUE_NAMES } from "@ocw/db/migrate";
import { describe, expect, it } from "vitest";
import { JOB_QUEUES } from "./jobs";

/**
 * Phase 07.16 (D-09, PD-16, ADR-0028): the bot session wake queue is in the migrator's catalog and the API's, with an
 * ids-only payload (job tables live outside RLS: never a prompt, an output or a title).
 */
describe("work_session.bot_sync queue", () => {
  it("is in the migrator's catalog (07.17 appended automation.item after it)", () => {
    expect(JOB_QUEUE_NAMES).toContain("work_session.bot_sync");
  });

  it("carries the organization and session ids only", () => {
    const schema = JOB_QUEUES["work_session.bot_sync"];
    const ids = { organizationId: randomUUID(), workSessionId: randomUUID() };
    expect(schema.parse(ids)).toEqual(ids);
    expect(schema.safeParse({ ...ids, text: "Done: all tests pass" }).success).toBe(false);
    expect(schema.safeParse({ organizationId: ids.organizationId }).success).toBe(false);
    expect(schema.safeParse({ ...ids, workSessionId: "not-an-id" }).success).toBe(false);
  });
});

/**
 * Phase 07.17 (D-04, PD-09, ADR-0028): one opened item's own bot turn is an ids-only job. The item row holds the rest;
 * the external key, its title and its body never enter a job (job tables live outside RLS).
 */
describe("automation.item queue", () => {
  it("is in both catalogs (07.17.1.1.2 appended the bot task queues after it)", () => {
    expect(JOB_QUEUE_NAMES).toContain("automation.item");
    expect(Object.keys(JOB_QUEUES)).toContain("automation.item");
  });

  it("carries the organization and item ids only", () => {
    const schema = JOB_QUEUES["automation.item"];
    const ids = { organizationId: randomUUID(), itemId: randomUUID() };
    expect(schema.parse(ids)).toEqual(ids);
    expect(schema.safeParse({ ...ids, externalKey: "SO-1001" }).success).toBe(false);
    expect(schema.safeParse({ organizationId: ids.organizationId }).success).toBe(false);
    expect(schema.safeParse({ ...ids, itemId: "not-an-id" }).success).toBe(false);
  });
});

/**
 * Phase 07.17.1.1.2 (D-02, D-03, PD-06, ADR-0042): a long task's next turn and the minute tick that finds lost wakes are
 * ids-only jobs. The task row holds the goal, progress and wait; none of it ever enters a job (job tables live outside
 * RLS).
 */
describe("bot task queues", () => {
  it("are the catalog's newest queues, in both catalogs", () => {
    expect(JOB_QUEUE_NAMES.slice(-2)).toEqual(["bot_task.continue", "bot_task.tick"]);
    expect(Object.keys(JOB_QUEUES)).toEqual(expect.arrayContaining(["bot_task.continue", "bot_task.tick"]));
  });

  it("bot_task.continue carries the organization and task ids only", () => {
    const schema = JOB_QUEUES["bot_task.continue"];
    const ids = { organizationId: randomUUID(), taskId: randomUUID() };
    expect(schema.parse(ids)).toEqual(ids);
    expect(schema.safeParse({ ...ids, goal: "Read the knowledge pack" }).success).toBe(false);
    expect(schema.safeParse({ organizationId: ids.organizationId }).success).toBe(false);
    expect(schema.safeParse({ ...ids, taskId: "not-an-id" }).success).toBe(false);
  });

  it("bot_task.tick carries nothing", () => {
    const schema = JOB_QUEUES["bot_task.tick"];
    expect(schema.parse({})).toEqual({});
    expect(schema.safeParse({ taskId: randomUUID() }).success).toBe(false);
  });
});
