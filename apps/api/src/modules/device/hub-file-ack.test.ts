// 07.17.1.1 review WR-02: a file command's ack waiter is subscribed before the command can be enqueued.

import { describe, expect, it } from "vitest";
import { DeviceHub, type DeviceHubOptions, fileAckChannel } from "./hub";

/** A bus whose SUBSCRIBE takes a round trip (`delayMs`) before a listener receives anything, like Redis. */
function slowBus(delayMs: number) {
  const listeners = new Map<string, Set<(m: string) => void>>();
  let active = 0;
  return {
    get active() {
      return active;
    },
    async publish(channel: string, message: string) {
      for (const l of listeners.get(channel) ?? []) l(message);
    },
    async subscribe(channel: string, listener: (m: string) => void) {
      await new Promise((r) => setTimeout(r, delayMs));
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      active += 1;
      return async () => {
        if (set.delete(listener)) active -= 1;
      };
    },
  };
}

function hubWith(bus: ReturnType<typeof slowBus>): DeviceHub {
  return new DeviceHub({ bus } as unknown as DeviceHubOptions);
}

const ack = (ok: boolean, error: string | null = null) => JSON.stringify({ ok, error });

describe("subscribeFileAck (review WR-02)", () => {
  it("resolves once the subscription is live: an ack published right after is never missed", async () => {
    const bus = slowBus(30);
    const hub = hubWith(bus);
    const waiter = await hub.subscribeFileAck("t-1");
    // The device refuses at once, before the route even starts waiting.
    await bus.publish(fileAckChannel("t-1"), ack(false, "path_not_allowed"));
    const started = Date.now();
    expect(await waiter.wait(10_000)).toEqual({ ok: false, error: "path_not_allowed" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(bus.active).toBe(0);
  });

  it("an abort before the wait releases the subscription; the wait then answers null at once", async () => {
    const bus = slowBus(5);
    const hub = hubWith(bus);
    const ac = new AbortController();
    const waiter = await hub.subscribeFileAck("t-2", ac.signal);
    expect(bus.active).toBe(1);
    ac.abort();
    await new Promise((r) => setTimeout(r, 10));
    expect(bus.active).toBe(0);
    expect(await waiter.wait(10_000)).toBeNull();
  });

  it("times out with null and releases the subscription", async () => {
    const bus = slowBus(5);
    const hub = hubWith(bus);
    const waiter = await hub.subscribeFileAck("t-3");
    expect(await waiter.wait(50)).toBeNull();
    expect(bus.active).toBe(0);
  });

  it("waitForFileAck still answers the first well-formed ack", async () => {
    const bus = slowBus(5);
    const hub = hubWith(bus);
    const waiting = hub.waitForFileAck("t-4", 10_000);
    await new Promise((r) => setTimeout(r, 30));
    await bus.publish(fileAckChannel("t-4"), "not json");
    await bus.publish(fileAckChannel("t-4"), ack(true));
    expect(await waiting).toEqual({ ok: true, error: null });
    expect(bus.active).toBe(0);
  });
});
