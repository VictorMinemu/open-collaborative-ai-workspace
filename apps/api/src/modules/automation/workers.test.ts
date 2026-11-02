import { describe, expect, it } from "vitest";
import type { Core } from "../../core";
import type { AutomationSeamDeps } from "./actions";
import { registerInbound } from "./inbound";
import { registerRunner } from "./runner";

/**
 * 07.6 review A MD-06 (the runner's side): fires and inbound items are worked a few at a time per worker, so one slow
 * fire (a digest's model call, a slow post) no longer queues every other organization's runs behind it. Rows stay
 * serialised per automation by their row locks, so running jobs side by side never fires one run twice.
 */

function captureWorkers() {
  const options = new Map<string, { localConcurrency?: number } | undefined>();
  const core = {
    jobs: {
      work: (queue: string, _handler: unknown, opts?: { localConcurrency?: number }) => {
        options.set(queue, opts);
      },
      schedule: () => {},
    },
  } as unknown as Core;
  const deps = { service: { registerActionKind: () => {} } } as unknown as AutomationSeamDeps;
  return { core, deps, options };
}

describe("automation workers run a bounded number of jobs at once (07.6 review A MD-06)", () => {
  it("automation.fire and automation.inbound each run more than one job at a time, and a bounded number", () => {
    const { core, deps, options } = captureWorkers();
    registerRunner(core, deps);
    registerInbound(core, deps);
    for (const queue of ["automation.fire", "automation.inbound"]) {
      const n = options.get(queue)?.localConcurrency ?? 1;
      expect(n, queue).toBeGreaterThan(1);
      // The tenant pool has 10 connections and a fire holds one for its transaction.
      expect(n, queue).toBeLessThanOrEqual(4);
    }
  });
});
