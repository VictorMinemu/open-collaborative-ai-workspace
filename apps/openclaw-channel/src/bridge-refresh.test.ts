import { describe, expect, it } from "vitest";
import type { CellSnapshot } from "./agent-channel-protocol.js";
import type { AgentChannelClient } from "./api-client.js";
import { type BridgeOptions, createBridge } from "./bridge.js";

/**
 * 07.8-08 (found by the full-stack sandbox proof): a `cell.config.changed` that arrives while a refresh is in flight
 * must not be folded into that refresh, whose `GET /cell` may predate the change (a bot created then stayed
 * `provisioning`). Callers during a flight share exactly one follow-up refresh that starts after it.
 */

function snapshot(n: number): CellSnapshot {
  return {
    protocolVersion: 1,
    cellId: "c1",
    organizationId: "o1",
    topic: "cell:o1",
    lastSeq: n,
    agents: [],
    providers: [],
  } as unknown as CellSnapshot;
}

function harness() {
  const releases: Array<() => void> = [];
  let calls = 0;
  const client = {
    async getCell() {
      calls += 1;
      const n = calls;
      await new Promise<void>((resolve) => releases.push(resolve));
      return snapshot(n);
    },
    async reportStatus() {},
  } as unknown as AgentChannelClient;
  const port = {
    async dispatchMention() {},
    async reconcile() {
      return { changed: false, results: [] };
    },
  } as unknown as BridgeOptions["port"];
  const bridge = createBridge({ client, port, signal: new AbortController().signal });
  const releaseNext = async () => {
    await expect.poll(() => releases.length).toBeGreaterThan(0);
    releases.shift()?.();
  };
  return { bridge, releaseNext, calls: () => calls };
}

describe("refreshCell", () => {
  it("a refresh asked during a flight runs once more after it and sees the newer snapshot", async () => {
    const h = harness();
    const first = h.bridge.refreshCell();
    const second = h.bridge.refreshCell();
    const third = h.bridge.refreshCell();
    await h.releaseNext();
    expect((await first).lastSeq).toBe(1);
    await h.releaseNext();
    expect((await second).lastSeq).toBe(2);
    expect((await third).lastSeq).toBe(2);
    expect(h.calls()).toBe(2);
  });

  it("without a flight, one call is one GET /cell", async () => {
    const h = harness();
    const only = h.bridge.refreshCell();
    await h.releaseNext();
    expect((await only).lastSeq).toBe(1);
    expect(h.calls()).toBe(1);
  });
});
