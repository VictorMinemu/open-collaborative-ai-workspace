import { describe, expect, it } from "vitest";
import { KeyedLock } from "./slot-lock.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("KeyedLock (07.18-19 R1.7)", () => {
  it("one holder per key, in arrival order; other keys never wait", async () => {
    const lock = new KeyedLock();
    const order: string[] = [];
    const releaseA1 = await lock.acquire("a");
    const a2 = lock.acquire("a").then((release) => {
      order.push("a2");
      return release;
    });
    const a3 = lock.acquire("a").then((release) => {
      order.push("a3");
      return release;
    });
    const releaseB = await lock.acquire("b");
    order.push("b");
    await tick();
    expect(order).toEqual(["b"]);
    releaseA1();
    const releaseA2 = await a2;
    await tick();
    expect(order).toEqual(["b", "a2"]);
    releaseA2();
    releaseA2(); // idempotent
    (await a3)();
    releaseB();
    expect(order).toEqual(["b", "a2", "a3"]);
    expect(lock.busy("a")).toBe(false);
    expect(lock.busy("b")).toBe(false);
  });
});
