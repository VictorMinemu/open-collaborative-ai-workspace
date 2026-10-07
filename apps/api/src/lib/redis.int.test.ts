import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RedisBus } from "./redis";

/**
 * RedisBus fan-out against a real Redis 8. The regression (06.1-05 gate): the last local listener of a channel
 * leaving and a new one joining in the same moment (a page reload: the old socket closes while the new one
 * subscribes the same conversation) left the new listener attached to a channel Redis had just unsubscribed, so it
 * never received another frame.
 */
describe("RedisBus", () => {
  let redis: StartedRedisContainer;
  let bus: RedisBus;

  beforeAll(async () => {
    redis = await new RedisContainer("redis:8").start();
    bus = await RedisBus.connect(redis.getConnectionUrl());
  }, 120_000);

  afterAll(async () => {
    await bus?.close();
    await redis?.stop();
  });

  /** Publishes until `got` has a message or the deadline passes (a SUBSCRIBE reply may still be in flight). */
  const deliver = async (channel: string, got: string[], ms = 1500) => {
    const until = Date.now() + ms;
    while (got.length === 0 && Date.now() < until) {
      await bus.publish(channel, "hello");
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it("fans one Redis subscription out to every local listener and unsubscribes on the last", async () => {
    const a: string[] = [];
    const b: string[] = [];
    const stopA = await bus.subscribe("t:fanout", (m) => a.push(m));
    const stopB = await bus.subscribe("t:fanout", (m) => b.push(m));
    await deliver("t:fanout", a);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    await stopA();
    await stopB();
    expect(await bus.pub.pubSubNumSub("t:fanout")).toEqual({ "t:fanout": 0 });
  });

  it("a listener that subscribes while the last one is leaving still receives frames", async () => {
    const old: string[] = [];
    const stopOld = await bus.subscribe("t:reload", (m) => old.push(m));
    // The old socket closes (not awaited, like the gateway's close handler) and the new one subscribes at once.
    const leaving = stopOld();
    const fresh: string[] = [];
    const stopFresh = await bus.subscribe("t:reload", (m) => fresh.push(m));
    await leaving;
    await deliver("t:reload", fresh);
    expect(fresh).toContain("hello");
    expect(await bus.pub.pubSubNumSub("t:reload")).toEqual({ "t:reload": 1 });
    await stopFresh();
  });

  it("a stale stop never removes a newer subscription of the same channel", async () => {
    const stopFirst = await bus.subscribe("t:stale", () => {});
    await stopFirst();
    const got: string[] = [];
    const stopSecond = await bus.subscribe("t:stale", (m) => got.push(m));
    await stopFirst(); // called twice: must be a no-op now
    await deliver("t:stale", got);
    expect(got).toContain("hello");
    await stopSecond();
  });
});
