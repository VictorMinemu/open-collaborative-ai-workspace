import { randomUUID } from "node:crypto";
import { JOB_QUEUE_NAMES } from "@ocw/db/migrate";
import { describe, expect, it } from "vitest";
import { JOB_QUEUES } from "./jobs";

/**
 * Phase 07.16 (D-09, PD-16, ADR-0028): the bot session wake queue is in the migrator's catalog and the API's, with an
 * ids-only payload (job tables live outside RLS: never a prompt, an output or a title).
 */
describe("work_session.bot_sync queue", () => {
  it("is the catalog's newest queue", () => {
    expect(JOB_QUEUE_NAMES.at(-1)).toBe("work_session.bot_sync");
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
