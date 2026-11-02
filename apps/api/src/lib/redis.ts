import { createClient } from "redis";

const makeClient = (url: string) => createClient({ url });
export type RedisClient = ReturnType<typeof makeClient>;

/**
 * Redis pub/sub fan-out. One publisher and one duplicate() subscriber per process; a Redis channel is
 * subscribed on the first local listener and unsubscribed on the last. Redis is a hint: durable events are
 * in PostgreSQL and clients recover gaps by seq replay.
 */
export class RedisBus {
  /**
   * One entry per subscribed channel: its local listeners and the single dispatcher registered with node-redis.
   * The dispatcher is passed back on unsubscribe so node-redis marks the channel as unsubscribing; a subscribe that
   * arrives before the UNSUBSCRIBE reply then issues its own SUBSCRIBE. A bare `unsubscribe(channel)` would instead
   * let that subscribe join the leaving channel and lose its listener when the reply arrives (06.1-05).
   */
  private readonly channels = new Map<
    string,
    { listeners: Set<(message: string) => void>; dispatch: (message: string) => void }
  >();
  private constructor(
    readonly pub: RedisClient,
    private readonly sub: RedisClient,
  ) {}

  static async connect(url: string): Promise<RedisBus> {
    const pub = makeClient(url);
    pub.on("error", (err) => console.error("redis error", err));
    await pub.connect();
    const sub = pub.duplicate();
    sub.on("error", (err) => console.error("redis subscriber error", err));
    await sub.connect();
    return new RedisBus(pub, sub);
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.pub.publish(channel, message);
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<() => Promise<void>> {
    let entry = this.channels.get(channel);
    const created = !entry;
    if (!entry) {
      const listeners = new Set<(message: string) => void>();
      entry = {
        listeners,
        dispatch: (msg) => {
          for (const l of listeners) l(msg);
        },
      };
      this.channels.set(channel, entry);
    }
    // Added before the SUBSCRIBE round trip, so the entry is never empty while it is live.
    entry.listeners.add(listener);
    const mine = entry;
    if (created) {
      try {
        await this.sub.subscribe(channel, mine.dispatch);
      } catch (err) {
        // A failed SUBSCRIBE must not leave an entry that later subscribers would join without a subscription.
        if (this.channels.get(channel) === mine) this.channels.delete(channel);
        throw err;
      }
    }
    return async () => {
      if (!mine.listeners.delete(listener)) return; // already stopped
      if (mine.listeners.size > 0 || this.channels.get(channel) !== mine) return;
      this.channels.delete(channel);
      await this.sub.unsubscribe(channel, mine.dispatch).catch(() => {});
    };
  }

  async ping(): Promise<void> {
    await this.pub.ping();
  }

  /** Graceful when Redis answers; a client that is down (or does not answer in 2 s) is dropped, never waited for. */
  async close(): Promise<void> {
    await Promise.allSettled([endClient(this.sub), endClient(this.pub)]);
  }
}

async function endClient(client: RedisClient): Promise<void> {
  if (client.isReady) {
    await Promise.race([client.close(), new Promise((r) => setTimeout(r, 2_000))]).catch(() => {});
  }
  if (client.isOpen) client.destroy();
}
