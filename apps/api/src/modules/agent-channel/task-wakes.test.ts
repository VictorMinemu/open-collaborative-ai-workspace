import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { taskEventId } from "./task-wakes";
import { wakeEventId } from "./work-session-wakes";

/**
 * Phase 07.17.1.1.2-09 (PD-05, PD-06): a continuation's event id is derived from the task and the wait it ends, so the
 * same wait can never produce two turns (`agent_turns.event_id` is the turn's key), whatever retries, duplicate jobs or
 * ticks do. The recipe is `wakeEventId`'s: SHA-256 shaped as a UUID of version 8 (RFC 9562, custom).
 */

const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("taskEventId", () => {
  const task = randomUUID();

  it("is a version 8 UUID with the RFC 9562 variant bits", () => {
    expect(taskEventId(task, 1)).toMatch(UUID_V8);
  });

  it("is stable: the same task and wait give the same id", () => {
    expect(taskEventId(task, 1)).toBe(taskEventId(task, 1));
  });

  it("differs for another wait of the same task and for another task", () => {
    expect(taskEventId(task, 2)).not.toBe(taskEventId(task, 1));
    expect(taskEventId(randomUUID(), 1)).not.toBe(taskEventId(task, 1));
  });

  it("never collides with a Work Zone wake id built from the same parts (its own domain prefix)", () => {
    expect(taskEventId(task, 1)).not.toBe(wakeEventId(task, "1", null));
  });
});
