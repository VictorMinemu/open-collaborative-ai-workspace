import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startTestStack } from "./testing";
import { startConnectorsStack } from "./testing-connectors";

/**
 * WINDOWS #213 / #225: the test stacks never leave containers running, whatever fails.
 *
 * Why Ryuk did not reap the ~200 leaked `redis:8` containers: testcontainers-node (12.1) reuses the newest running Ryuk
 * container on the host, across processes, and Ryuk prunes only once every client has disconnected from it. Parallel
 * `pnpm verify` runs in several worktrees kept at least one client connected for hours, so nothing was ever reaped.
 * That is testcontainers' design, not our configuration (no `TESTCONTAINERS_*` or `.testcontainers.properties` is set
 * here); the fix is that our stacks stop what they start themselves, in `finally`, and clean up a half-built start.
 */

const run = promisify(execFile);

/** Whether a container still runs (testcontainers removes a stopped one, so "missing" counts as stopped). */
async function running(id: string): Promise<boolean> {
  try {
    const { stdout } = await run("docker", ["inspect", "-f", "{{.State.Running}}", id]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** Records the id of every Postgres and Redis container this test starts. */
function recordStarts(): string[] {
  const ids: string[] = [];
  const pgStart = PostgreSqlContainer.prototype.start;
  vi.spyOn(PostgreSqlContainer.prototype, "start").mockImplementation(async function (
    this: PostgreSqlContainer,
  ) {
    const started = await pgStart.call(this);
    ids.push(started.getId());
    return started;
  });
  const redisStart = RedisContainer.prototype.start;
  vi.spyOn(RedisContainer.prototype, "start").mockImplementation(async function (this: RedisContainer) {
    const started = await redisStart.call(this);
    ids.push(started.getId());
    return started;
  });
  return ids;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TestStack (WINDOWS #213)", () => {
  it("stop() stops both containers even when the app's close throws, and still reports the failure", async () => {
    const stack = await startTestStack();
    const ids = [stack.db.container.getId(), stack.redis.getId()];
    expect(await Promise.all(ids.map(running))).toEqual([true, true]);
    const close = stack.built.close;
    stack.built.close = async () => {
      await close();
      throw new Error("close failed");
    };
    await expect(stack.stop()).rejects.toThrow("close failed");
    expect(await Promise.all(ids.map(running))).toEqual([false, false]);
  });

  it("a start that fails after its containers are up stops them before it throws", async () => {
    const ids = recordStarts();
    // An invalid environment fails in loadEnv, after both containers started.
    await expect(startTestStack({ env: { OCW_ENCRYPTION_KEY: "too-short" } })).rejects.toThrow();
    expect(ids).toHaveLength(2);
    expect(await Promise.all(ids.map(running))).toEqual([false, false]);
  });
});

describe("ConnectorsStack (WINDOWS #225)", () => {
  it("stop() closes the fake MCP server even when the stack's stop throws", async () => {
    const s = await startConnectorsStack();
    const stopStack = s.stack.stop;
    s.stack.stop = async () => {
      await stopStack();
      throw new Error("stack stop failed");
    };
    await expect(s.stop()).rejects.toThrow("stack stop failed");
    await expect(fetch(`http://127.0.0.1:${s.fakePort}/`)).rejects.toThrow();
    expect(await Promise.all([s.stack.db.container.getId(), s.stack.redis.getId()].map(running))).toEqual([
      false,
      false,
    ]);
  });

  it("a start that fails after the stack is up stops its containers and restores the global fetch", async () => {
    const realFetch = globalThis.fetch;
    const ids = recordStarts();
    // The organization setup is refused with another setup token: startConnectorsStack throws after its stack started.
    await expect(
      startConnectorsStack({ env: { OCW_SETUP_TOKEN: "another-setup-token-0123456789" } }),
    ).rejects.toThrow();
    expect(ids).toHaveLength(2);
    expect(await Promise.all(ids.map(running))).toEqual([false, false]);
    expect(globalThis.fetch).toBe(realFetch);
  });
});
