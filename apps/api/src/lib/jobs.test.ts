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
  it("is the catalog's newest queue, in both catalogs", () => {
    expect(JOB_QUEUE_NAMES.at(-1)).toBe("automation.item");
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
