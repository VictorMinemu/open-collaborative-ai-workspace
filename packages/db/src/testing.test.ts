import { describe, expect, it } from "vitest";
import { startAllOrNone } from "./testing";

/**
 * WINDOWS #213 / #225: test containers started together must never outlive a failed start. The shared Ryuk reaper only
 * prunes once every process on the host has disconnected from it, which parallel `pnpm verify` runs never allow, so a
 * container our helpers forget keeps running for hours.
 */

function fake(name: string, log: string[]) {
  return {
    name,
    async stop() {
      log.push(`stop ${name}`);
    },
  };
}

describe("startAllOrNone", () => {
  it("returns every started value, in order, when all start", async () => {
    const log: string[] = [];
    const [a, b] = await startAllOrNone([
      Promise.resolve(fake("db", log)),
      Promise.resolve(fake("redis", log)),
    ]);
    expect([a.name, b.name]).toEqual(["db", "redis"]);
    expect(log).toEqual([]);
  });

  it("stops the ones that started when another fails, then rethrows that failure", async () => {
    const log: string[] = [];
    const failure = new Error("Timed out waiting for container ports to be bound");
    await expect(startAllOrNone([Promise.reject(failure), Promise.resolve(fake("redis", log))])).rejects.toBe(
      failure,
    );
    expect(log).toEqual(["stop redis"]);
  });

  it("a stop that throws during that cleanup never hides the start failure", async () => {
    const failure = new Error("no space left on device");
    const stuck = {
      async stop() {
        throw new Error("container already gone");
      },
    };
    await expect(startAllOrNone([Promise.resolve(stuck), Promise.reject(failure)])).rejects.toBe(failure);
  });
});
