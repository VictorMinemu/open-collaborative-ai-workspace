import { createClient } from "redis";

const makeClient = (url: string) => createClient({ url });
export type RedisClient = ReturnType<typeof makeClient>;

/**
 * Redis pub/sub fan-out. One publisher and one duplicate() subscriber per process; a Redis channel is
 * subscribed on the first local listener and unsubscribed on the last. Redis is a hint: durable events are
 * in PostgreSQL and clients recover gaps by seq replay.
 */
export class RedisBus {
  private readonly listeners = new Map<string, Set<(message: string) => void>>();
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
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      const current = set;
      await this.sub.subscribe(channel, (msg) => {
        for (const l of current) l(msg);
      });
    }
    set.add(listener);
    return async () => {
      const s = this.listeners.get(channel);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) {
        this.listeners.delete(channel);
        await this.sub.unsubscribe(channel).catch(() => {});
      }
    };
  }

  async ping(): Promise<void> {
    await this.pub.ping();
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.sub.quit(), this.pub.quit()]);
  }
}
