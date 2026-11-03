import type { FastifyRateLimitStoreCtor } from "@fastify/rate-limit";
import type { RedisClient } from "./redis";

type Callback = (err: Error | null, res: { current: number; ttl: number }) => void;

/** What `@fastify/rate-limit` hands a store's `child` (the route's merged options). */
interface ChildOptions {
  timeWindow?: unknown;
  routeInfo?: { method?: unknown; url?: unknown };
}

/** Every counter's key prefix in Redis (`ocw:rl:<route namespace>:<key>`). */
export const RATE_LIMIT_PREFIX = "ocw:rl:";

/** How long a hit waits for Redis before it is counted in this instance's memory instead (07.6 review A HI-02). */
export const RATE_LIMIT_REDIS_TIMEOUT_MS = 250;

/** Counters the memory fallback keeps before it drops the expired ones. */
const MEMORY_SWEEP_AT = 10_000;

/**
 * Fixed-window counters in this process, the same semantics as the Redis ones: the fallback while Redis cannot answer.
 * A limit then holds per API instance (as it did before 07.6-10) instead of failing open or locking people out.
 */
class MemoryWindows {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  incr(key: string, window: number, now = Date.now()): { current: number; ttl: number } {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size >= MEMORY_SWEEP_AT) this.sweep(now);
      entry = { count: 0, resetAt: now + window };
      this.hits.set(key, entry);
    }
    entry.count++;
    return { current: entry.count, ttl: entry.resetAt - now };
  }

  read(key: string, now = Date.now()): { current: number; ttl: number } {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) return { current: 0, ttl: 0 };
    return { current: entry.count, ttl: entry.resetAt - now };
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}

/** Resolves with Redis' answer, or rejects when the client is not connected or does not answer within `ms`. */
function answered<T>(client: RedisClient, ms: number, run: () => Promise<T>): Promise<T> {
  // A client that is reconnecting would queue the command until Redis is back: never wait for that.
  if (!client.isReady) return Promise.reject(new Error("redis not ready"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("redis timeout")), ms);
    run().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/**
 * `@fastify/rate-limit`'s store over the API's existing node-redis client (07.6-10, T-07.6-10-03): counters live in
 * Redis, so a limit holds across API replicas instead of per process. One MULTI per hit: `INCR`, `PEXPIRE … NX` (the
 * window starts with the first hit and is never extended by later ones) and `PTTL`, the same fixed-window semantics
 * as the plugin's in-memory store. Each route gets its own namespace (`<METHOD><url>`); limiters made with
 * `app.rateLimit()` / `createRateLimit()` share the `fn` namespace and rely on their key generator's prefix
 * (`search:`, `ai-send:`, …), exactly as their in-memory counters did. No new dependency (the plugin's bundled
 * `RedisStore` expects ioredis).
 *
 * Redis is a hint here too (07.6 review A HI-02): sign-in, password reset, `/devices/token` and pairing must not hang or
 * fail when it is gone. A hit that Redis cannot answer at once (not connected, or no answer within 250 ms) is counted
 * in this instance's memory, so the limit still applies (per instance) and the request is never let through unlimited.
 */
export class RedisRateLimitStore {
  private readonly memory: MemoryWindows;

  constructor(
    private readonly opts: {
      client: RedisClient;
      /** The full key prefix of this store's counters. */
      prefix: string;
      /** The window in ms when the plugin passes none. */
      timeWindow: number;
      /** How long a hit waits for Redis (default `RATE_LIMIT_REDIS_TIMEOUT_MS`). */
      timeoutMs?: number;
      /** Shared by a root store and its children (keys carry their namespace). */
      memory?: MemoryWindows;
    },
  ) {
    this.memory = opts.memory ?? new MemoryWindows();
  }

  private get timeoutMs() {
    return this.opts.timeoutMs ?? RATE_LIMIT_REDIS_TIMEOUT_MS;
  }

  incr(key: string, cb: Callback, timeWindow?: number): void {
    const window = typeof timeWindow === "number" && timeWindow > 0 ? timeWindow : this.opts.timeWindow;
    const k = this.opts.prefix + key;
    const { client } = this.opts;
    answered(client, this.timeoutMs, () =>
      client.multi().incr(k).pExpire(k, window, "NX").pTTL(k).exec(),
    ).then(
      (replies) => cb(null, { current: Number(replies[0]), ttl: Math.max(0, Number(replies[2])) }),
      () => cb(null, this.memory.incr(k, window)),
    );
  }

  /** The counter without counting a hit (`createRateLimit()(req, { increment: false })`). */
  read(key: string, cb: Callback): void {
    const k = this.opts.prefix + key;
    const { client } = this.opts;
    answered(client, this.timeoutMs, () => client.multi().get(k).pTTL(k).exec()).then(
      (replies) => cb(null, { current: Number(replies[0] ?? 0), ttl: Math.max(0, Number(replies[1])) }),
      () => cb(null, this.memory.read(k)),
    );
  }

  child(routeOptions: ChildOptions): RedisRateLimitStore {
    const method = routeOptions.routeInfo?.method;
    const url = routeOptions.routeInfo?.url;
    const namespace =
      typeof url === "string"
        ? `${Array.isArray(method) ? method.join(",") : String(method ?? "")}${url}`
        : "fn";
    return new RedisRateLimitStore({
      ...this.opts,
      memory: this.memory,
      prefix: `${this.opts.prefix}${namespace}:`,
      timeWindow:
        typeof routeOptions.timeWindow === "number" ? routeOptions.timeWindow : this.opts.timeWindow,
    });
  }
}

/**
 * The store class for `app.register(rateLimit, { store })`: the plugin constructs it with its global options, so the
 * client and prefix are bound here.
 */
export function redisRateLimitStore(
  client: RedisClient,
  prefix = RATE_LIMIT_PREFIX,
): FastifyRateLimitStoreCtor {
  class BoundRedisRateLimitStore extends RedisRateLimitStore {
    constructor(options: { timeWindow?: unknown }) {
      super({
        client,
        prefix,
        timeWindow: typeof options.timeWindow === "number" ? options.timeWindow : 60_000,
      });
    }
  }
  // The plugin's types declare `child(RouteOptions)`, but at runtime it passes the route's merged limit options
  // (`timeWindow`, `routeInfo`), which is what `child` reads; the shapes differ only in the declaration.
  return BoundRedisRateLimitStore as unknown as FastifyRateLimitStoreCtor;
}
