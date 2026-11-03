import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RATE_LIMIT_PREFIX, RedisRateLimitStore, redisRateLimitStore } from "./rate-limit-store";
import type { RedisClient } from "./redis";

/**
 * 07.6-10 (T-07.6-10-03): `@fastify/rate-limit`'s store over node-redis. Counters are atomic, the window starts at the
 * first hit and is never extended, it resets after the window, routes are namespaced and two API replicas (two stores
 * on one Redis) share one counter. Real Redis 8 (testcontainers).
 */

let redis: StartedRedisContainer;
let client: RedisClient;

beforeAll(async () => {
  redis = await new RedisContainer("redis:8").start();
  client = createClient({ url: redis.getConnectionUrl() });
  await client.connect();
}, 120_000);

afterAll(async () => {
  await client?.quit();
  await redis?.stop();
});

/** One replica's root store, as the plugin builds it from its global options. */
const replica = (timeWindow = 60_000) =>
  new RedisRateLimitStore({ client, prefix: RATE_LIMIT_PREFIX, timeWindow });

const incr = (store: RedisRateLimitStore, key: string, window?: number) =>
  new Promise<{ current: number; ttl: number }>((resolve, reject) =>
    store.incr(key, (err, res) => (err ? reject(err) : resolve(res)), window),
  );

const read = (store: RedisRateLimitStore, key: string) =>
  new Promise<{ current: number; ttl: number }>((resolve, reject) =>
    store.read(key, (err, res) => (err ? reject(err) : resolve(res))),
  );

const route = (url: string, timeWindow = 60_000) => ({ timeWindow, routeInfo: { method: "POST", url } });

describe("RedisRateLimitStore", () => {
  it("is what the plugin constructs from the factory, bound to the API's client", () => {
    const Store = redisRateLimitStore(client);
    expect(new Store({ timeWindow: 60_000 })).toBeInstanceOf(RedisRateLimitStore);
  });

  it("counts 100 concurrent hits atomically and sets the window once", async () => {
    const store = replica().child(route("/api/v1/hooks/:publicId"));
    const results = await Promise.all(Array.from({ length: 100 }, () => incr(store, "hook:A")));
    expect(results.map((r) => r.current).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 100 }, (_, i) => i + 1),
    );
    for (const r of results) {
      expect(r.ttl).toBeGreaterThan(55_000);
      expect(r.ttl).toBeLessThanOrEqual(60_000);
    }
    const key = `${RATE_LIMIT_PREFIX}POST/api/v1/hooks/:publicId:hook:A`;
    expect(await client.get(key)).toBe("100");
    const ttl = await client.pTTL(key);
    expect(ttl).toBeGreaterThan(55_000);
    expect(ttl).toBeLessThanOrEqual(60_000);
    expect(await read(store, "hook:A")).toMatchObject({ current: 100 });
  });

  it("never extends the window and resets after it", async () => {
    const store = replica(400).child(route("/short", 400));
    const first = await incr(store, "k", 400);
    expect(first.current).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    const second = await incr(store, "k", 400);
    expect(second.current).toBe(2);
    expect(second.ttl).toBeLessThanOrEqual(first.ttl - 150);
    await new Promise((r) => setTimeout(r, 300));
    expect((await incr(store, "k", 400)).current).toBe(1);
    expect(await read(store, "missing")).toEqual({ current: 0, ttl: 0 });
  });

  it("keeps routes apart and shares one counter across replicas", async () => {
    const replicaA = replica();
    const replicaB = replica();
    const hookA = replicaA.child(route("/api/v1/hooks/:publicId"));
    const hookB = replicaB.child(route("/api/v1/hooks/:publicId"));
    const signIn = replicaA.child(route("/api/auth/sign-in/email"));
    for (let i = 0; i < 40; i++) await incr(hookA, "hook:SHARED");
    let last = { current: 0, ttl: 0 };
    for (let i = 0; i < 21; i++) last = await incr(hookB, "hook:SHARED");
    expect(last.current).toBe(61);
    expect((await incr(signIn, "hook:SHARED")).current).toBe(1);
    // Limiters made with app.rateLimit() carry no route: they share a namespace and keep their key prefixes apart.
    const fnA = replicaA.child({ timeWindow: 60_000, routeInfo: {} });
    expect((await incr(fnA, "search:u1")).current).toBe(1);
    expect(await client.exists(`${RATE_LIMIT_PREFIX}fn:search:u1`)).toBe(1);
  });
});

describe("RedisRateLimitStore without Redis (07.6 review A HI-02)", () => {
  it("a client that is gone counts in this instance's memory: the limit still holds, nothing hangs or throws", async () => {
    const gone = createClient({ url: redis.getConnectionUrl() });
    await gone.connect();
    gone.destroy();
    const store = new RedisRateLimitStore({ client: gone, prefix: RATE_LIMIT_PREFIX, timeWindow: 400 }).child(
      route("/api/auth/sign-in/email", 400),
    );
    const started = Date.now();
    const hits = [];
    for (let i = 0; i < 4; i++) hits.push(await incr(store, "ip:1", 400));
    expect(hits.map((h) => h.current)).toEqual([1, 2, 3, 4]);
    expect(hits[0]?.ttl).toBeGreaterThan(300);
    expect(await read(store, "ip:1")).toMatchObject({ current: 4 });
    expect((await incr(store, "ip:2", 400)).current).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
    // The window still ends.
    await new Promise((r) => setTimeout(r, 450));
    expect((await incr(store, "ip:1", 400)).current).toBe(1);
  });

  it("a Redis that stops answering is given a short time, then the hit is counted in memory", async () => {
    const admin = createClient({ url: redis.getConnectionUrl() });
    await admin.connect();
    const store = replica().child(route("/api/v1/devices/token"));
    try {
      // Writes held for 3 s (every hit is an INCR): what a stalled or overloaded Redis looks like to the API.
      await admin.sendCommand(["CLIENT", "PAUSE", "3000", "WRITE"]);
      const started = Date.now();
      const first = await incr(store, "dev:1");
      const second = await incr(store, "dev:1");
      expect([first.current, second.current]).toEqual([1, 2]);
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      await admin.sendCommand(["CLIENT", "UNPAUSE"]);
      await admin.quit();
    }
  });
});
