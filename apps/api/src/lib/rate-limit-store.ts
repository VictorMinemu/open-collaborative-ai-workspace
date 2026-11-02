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

/**
 * `@fastify/rate-limit`'s store over the API's existing node-redis client (07.6-10, T-07.6-10-03): counters live in
 * Redis, so a limit holds across API replicas instead of per process. One MULTI per hit: `INCR`, `PEXPIRE … NX` (the
 * window starts with the first hit and is never extended by later ones) and `PTTL`, the same fixed-window semantics
 * as the plugin's in-memory store. Each route gets its own namespace (`<METHOD><url>`); limiters made with
 * `app.rateLimit()` / `createRateLimit()` share the `fn` namespace and rely on their key generator's prefix
 * (`search:`, `ai-send:`, …), exactly as their in-memory counters did. No new dependency (the plugin's bundled
 * `RedisStore` expects ioredis). A Redis error fails the request (the plugin's `skipOnError` stays false).
 */
export class RedisRateLimitStore {
  constructor(
    private readonly opts: {
      client: RedisClient;
      /** The full key prefix of this store's counters. */
      prefix: string;
      /** The window in ms when the plugin passes none. */
      timeWindow: number;
    },
  ) {}

  incr(key: string, cb: Callback, timeWindow?: number): void {
    const window = typeof timeWindow === "number" && timeWindow > 0 ? timeWindow : this.opts.timeWindow;
    const k = this.opts.prefix + key;
    this.opts.client
      .multi()
      .incr(k)
      .pExpire(k, window, "NX")
      .pTTL(k)
      .exec()
      .then(
        (replies) => cb(null, { current: Number(replies[0]), ttl: Math.max(0, Number(replies[2])) }),
        (err: Error) => cb(err, { current: 0, ttl: 0 }),
      );
  }

  /** The counter without counting a hit (`createRateLimit()(req, { increment: false })`). */
  read(key: string, cb: Callback): void {
    const k = this.opts.prefix + key;
    this.opts.client
      .multi()
      .get(k)
      .pTTL(k)
      .exec()
      .then(
        (replies) => cb(null, { current: Number(replies[0] ?? 0), ttl: Math.max(0, Number(replies[1])) }),
        (err: Error) => cb(err, { current: 0, ttl: 0 }),
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
