import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeModelServer } from "../../infra/fake-model/server.mjs";
import { fakeSandboxd } from "./sandbox";

/** 07.8-08: the e2e helpers for the fake sandboxd, against the fake server's `/__sandboxd` mount (no Docker). */

const TOKEN = "e2e-sandbox-token-test-0123456789abcdef";
const target = { orgId: crypto.randomUUID(), agentId: crypto.randomUUID() };
let server: ReturnType<typeof createFakeModelServer>;
let env: Record<string, string>;

beforeAll(async () => {
  server = createFakeModelServer({ sandboxToken: TOKEN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  env = {
    OCW_SANDBOX_URL: `http://127.0.0.1:${port}/__sandboxd`,
    OCW_SANDBOX_TOKEN: TOKEN,
    OCW_E2E_SANDBOX: "fake",
  };
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const exec = async (argv: string[]) => {
  const res = await fetch(`${env.OCW_SANDBOX_URL}/v1/sandboxes/exec`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ target, argv, cwd: "", timeoutMs: 5000, yieldMs: 5000 }),
  });
  return (await res.json()) as { stdout?: string; error?: { code: string } };
};

describe("fakeSandboxd()", () => {
  it("seeds a file the bot's shell then reads, and counts the calls", async () => {
    const fake = fakeSandboxd(env);
    await fake.reset();
    await fake.seedFile(target, "reports/q3.csv", "a,b\n");
    expect((await exec(["cat", "reports/q3.csv"])).stdout).toBe("a,b\n");
    const stats = await fake.stats();
    expect(stats.calls).toMatchObject({ ensure: 1, filesWrite: 1, exec: 1 });
  });

  it("seeds a signed-in, site-locked browser context and emits its events", async () => {
    const fake = fakeSandboxd(env);
    const contextId = await fake.seedContext(target, {
      url: "https://panel.fake.test/app",
      signedIn: true,
      siteLock: "panel.fake.test",
    });
    const ctx = ((await fake.stats()).browser as { contexts: Array<Record<string, unknown>> }).contexts.find(
      (c) => c.contextId === contextId,
    );
    expect(ctx).toMatchObject({ host: "panel.fake.test", signedIn: true, siteLock: "panel.fake.test" });
    await fake.browserEvent(target, contextId, "focus_sensitive");
    const seq = await fake.emit({ type: "usage", target, cpuMs: 5, diskBytes: 4 });
    expect(seq).toBeGreaterThan(1);
  });

  it("down and up switch the service off and on; reset forgets everything", async () => {
    const fake = fakeSandboxd(env);
    await fake.down();
    expect((await exec(["true"])).error?.code).toBe("docker_unavailable");
    await fake.up();
    await fake.reset();
    expect((await exec(["true"])).error?.code).toBe("not_found");
  });

  it("refuses the real broker and an environment that does not name the fake", () => {
    expect(() => fakeSandboxd({ ...env, OCW_E2E_SANDBOX: "real" })).toThrow(/real sandboxd/u);
    expect(() => fakeSandboxd({ ...env, OCW_SANDBOX_URL: "http://127.0.0.1:4293" })).toThrow(
      /do not name the fake/u,
    );
  });
});
