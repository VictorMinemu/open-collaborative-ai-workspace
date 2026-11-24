import { describe, expect, it } from "vitest";
import { AgentMentionEvent, type CellSnapshot } from "./agent-channel-protocol.js";
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

describe("07.18-19 R2.2: the pool tokens' health is checked after each cell sync and each bot turn", () => {
  const U = (n: number) => `0199b1c2-d3e4-7f5a-8b9c-${String(n).padStart(12, "0")}`;
  const agent = {
    id: U(1),
    handle: "atlas",
    displayName: "Atlas",
    avatarUrl: null,
    description: null,
    instructions: "",
    status: "ready",
    modelRef: "anthropic/claude-sonnet-5-5",
    model: { provider: "anthropic", providerId: "anthropic", id: "claude-sonnet-5-5" },
    capabilities: { tools: [] },
  };

  it("a sync and a turn (answered or failed) each ask for one check", async () => {
    const checks: string[] = [];
    let fail = false;
    const client = {
      async getCell() {
        return { ...snapshot(1), agents: [agent] };
      },
      async reportStatus() {},
      async postMessage() {
        return { id: U(99) };
      },
      async postTyping() {},
      async reportTurnDone() {},
    } as unknown as AgentChannelClient;
    const port = {
      async dispatchMention(_m: unknown, deliver: (t: string) => Promise<void>) {
        checks.push("turn");
        if (fail) throw new Error("model provider refused");
        await deliver("Hello");
        return undefined;
      },
      async reconcile() {
        checks.push("reconcile");
        return { changed: false, results: [] };
      },
    } as unknown as BridgeOptions["port"];
    const bridge = createBridge({
      client,
      port,
      signal: new AbortController().signal,
      dispatchAttempts: 1,
      poolHealth: {
        async check() {
          checks.push("check");
        },
      },
    });
    await bridge.refreshCell();
    expect(checks).toEqual(["reconcile", "check"]);

    const mention = (n: number) =>
      AgentMentionEvent.parse({
        eventId: U(10 + n),
        seq: n,
        type: "agent.mention.v1",
        organizationId: U(2),
        cellId: U(3),
        agent: { id: agent.id, handle: agent.handle, displayName: agent.displayName },
        conversation: { id: U(4), kind: "channel", name: "eng" },
        thread: { rootMessageId: U(5) },
        message: {
          id: U(6),
          text: "@atlas hi",
          createdAt: "2026-11-24T12:00:00.000Z",
          author: { kind: "user", id: U(7), displayName: "Ana" },
          mentions: [{ kind: "agent", id: agent.id }],
        },
        threadHistory: [],
        roster: [],
      });
    await bridge.handleMention(mention(1));
    await expect.poll(() => checks.filter((c) => c === "check").length).toBe(2);
    fail = true;
    await bridge.handleMention(mention(2));
    await expect.poll(() => checks.filter((c) => c === "check").length).toBe(3);
    expect(checks.filter((c) => c === "turn")).toHaveLength(2);
  });
});
