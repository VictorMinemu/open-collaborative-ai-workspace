import type { AddressInfo } from "node:net";
import { SANDBOXD_ROUTES, type SandboxdOp, type SandboxdOrgPolicy } from "@ocw/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createEvents } from "./events";
import { createFiles } from "./files";
import { createQuota } from "./quota";
import { createSandboxes, type SandboxdEventInput } from "./sandboxes";
import { createServer, POLICY_GATE } from "./server";
import { nameFor } from "./spec";
import { createSweeper } from "./sweeper";
import { FakeDocker } from "./testing/fake-docker";

/**
 * Fail closed on a missing policy (07.8 policy fix; D-09, the kill switch). sandboxd holds each organization's policy
 * (limits, quota, idle, egress, kill state) in memory only. After a restart (a new boot id) it has none, and it has no
 * default either: until the API pushes the organization's policy again, every op that would create, start or run a
 * container answers 409 `policy_missing` and touches nothing. People's reads and deletes keep working through the
 * network-none files helper. Once pushed, a killed organization is still refused (`killed`).
 */

const ORG = "0199f0a0-0000-7000-8000-00000000000a";
const AGENT = "0199f0a0-1111-7000-8000-00000000000b";
const NS = "ocw-unit";
const TOKEN = "t".repeat(40);
const target = { orgId: ORG, agentId: AGENT };
const MiB = 1024 * 1024;

const policy = (over: Partial<SandboxdOrgPolicy> = {}): SandboxdOrgPolicy => ({
  orgId: ORG,
  sandboxEgress: "allowlist",
  browserEgress: "public",
  allowHosts: [],
  privateHosts: [],
  limits: { nanoCpus: 1e9, memoryBytes: 1024 * MiB, pids: 256, diskQuotaBytes: 64 * MiB, idleStopMs: 30_000 },
  browserLimits: {
    nanoCpus: 1e9,
    memoryBytes: 2048 * MiB,
    pids: 512,
    diskQuotaBytes: 64 * MiB,
    idleStopMs: 300_000,
  },
  killed: false,
  version: 1,
  ...over,
});

/** One sandboxd process on a shared Docker double; `boot()` again is a sandboxd restart (memory gone, Docker kept). */
function boot(docker = new FakeDocker()) {
  docker.onExec = (call) => {
    const sub = call.cmd[1];
    if (sub === "du") return { exitCode: 0, stdout: "1000\n" };
    if (sub === "list") return { exitCode: 0, stdout: "" };
    if (sub === "write") return { exitCode: 0, stdout: String(call.stdin.length) };
    return { exitCode: 0 };
  };
  let now = 1_760_500_000_000;
  const clock = { now: () => now };
  const emitted: SandboxdEventInput[] = [];
  const events = createEvents();
  const sandboxes = createSandboxes({
    docker,
    ns: NS,
    runtime: "auto",
    image: "sbx:test",
    clock,
    onEvent: (e) => {
      emitted.push(e);
      events.emit(e);
    },
  });
  const quota = createQuota({ sandboxes });
  const files = createFiles({ sandboxes, quota });
  const sweeper = createSweeper({ sandboxes, quota, clock, intervalMs: 60_000 });
  return {
    docker,
    sandboxes,
    files,
    sweeper,
    events,
    emitted,
    advance: (ms: number) => {
      now += ms;
    },
    sbx: () => docker.container(nameFor("sbx", NS, AGENT)),
  };
}

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (err) {
    return err as { code: string; status: number };
  }
  throw new Error("expected a refusal");
}

const starts = (docker: FakeDocker) =>
  docker.calls.filter((c) => c.method === "POST" && /\/(start|restart)(\?|$)/.test(c.path)).length;

describe("no default policy: a fresh sandboxd refuses to start anything for an organization it has no policy for", () => {
  it("ensure → 409 policy_missing and no network, volume or container is created; after the policy op it runs", async () => {
    const t = boot();
    expect(await refusal(t.sandboxes.ensure(target))).toMatchObject({ code: "policy_missing", status: 409 });
    expect(t.docker.containerCreates).toHaveLength(0);
    expect(t.docker.containers.size + t.docker.volumes.size + t.docker.networks.size).toBe(0);
    expect(t.sandboxes.limitsFor(ORG)).toBeNull();

    t.sandboxes.setPolicy(policy());
    await expect(t.sandboxes.ensure(target)).resolves.toMatchObject({ state: "running" });
    expect(t.docker.containerCreates).toHaveLength(1);
  });

  it("with killed: true pushed, ensure, restart and exec are still refused (killed) and nothing starts", async () => {
    const t = boot();
    t.sandboxes.setPolicy(policy({ killed: true }));
    expect(await refusal(t.sandboxes.ensure(target))).toMatchObject({ code: "killed", status: 409 });
    expect(t.docker.containerCreates).toHaveLength(0);
    expect(
      await refusal(t.sandboxes.exec({ target, argv: ["true"], cwd: "", timeoutMs: 1000, yieldMs: 0 })),
    ).toMatchObject({ code: "killed", status: 409 });
    expect(t.docker.execCreates).toHaveLength(0);
  });

  it("after a restart (new boot) a killed organization's stopped sandbox stays stopped until and after the re-push", async () => {
    // Boot 1: the bot ran, then the admin killed the organization.
    const first = boot();
    first.sandboxes.setPolicy(policy());
    await first.sandboxes.ensure(target);
    await first.sandboxes.killOrg(ORG);
    first.sandboxes.setPolicy(policy({ killed: true, version: 2 }));
    expect(first.sbx()?.Running).toBe(false);

    // Boot 2: same Docker, memory gone. No default lets the bot back in.
    const t = boot(first.docker);
    expect(t.events.bootId).not.toBe(first.events.bootId);
    const before = starts(t.docker);
    expect(await refusal(t.sandboxes.ensure(target))).toMatchObject({ code: "policy_missing", status: 409 });
    expect(await refusal(t.sandboxes.restart(target))).toMatchObject({ code: "policy_missing", status: 409 });
    expect(starts(t.docker)).toBe(before);
    expect(t.sbx()?.Running).toBe(false);

    // People still read their files through the network-none helper; the bot's sbx stays stopped.
    await expect(t.files.list({ target, path: "", hidden: true })).resolves.toBeDefined();
    expect(t.sbx()?.Running).toBe(false);

    // The API pushes the current policy: still killed.
    t.sandboxes.setPolicy(policy({ killed: true, version: 2 }));
    expect(await refusal(t.sandboxes.ensure(target))).toMatchObject({ code: "killed", status: 409 });
    expect(await refusal(t.sandboxes.restart(target))).toMatchObject({ code: "killed", status: 409 });
    expect(t.sbx()?.Running).toBe(false);
  });

  it("exec into a sandbox still running from the previous boot → policy_missing, no exec created", async () => {
    const first = boot();
    first.sandboxes.setPolicy(policy());
    await first.sandboxes.ensure(target);
    const t = boot(first.docker);
    const execs = t.docker.execCreates.length;
    expect(
      await refusal(t.sandboxes.exec({ target, argv: ["true"], cwd: "", timeoutMs: 1000, yieldMs: 0 })),
    ).toMatchObject({ code: "policy_missing", status: 409 });
    expect(t.docker.execCreates).toHaveLength(execs);
    t.sandboxes.setPolicy(policy());
    await expect(
      t.sandboxes.exec({ target, argv: ["true"], cwd: "", timeoutMs: 1000, yieldMs: 0 }),
    ).resolves.toBeDefined();
  });

  it("writes and uploads need the quota, so they answer policy_missing and write nothing; deletes keep working", async () => {
    const first = boot();
    first.sandboxes.setPolicy(policy());
    await first.sandboxes.ensure(target);
    const t = boot(first.docker);
    const writes = () =>
      t.docker.execCreates.filter((c) => JSON.stringify(c.body).includes('"write"')).length;
    expect(
      await refusal(
        t.files.write({ target, path: "a.txt", content: "x", encoding: "utf8", mode: "overwrite" }),
      ),
    ).toMatchObject({ code: "policy_missing", status: 409 });
    expect(
      await refusal(
        t.files.upload({
          target,
          path: "b.bin",
          data: Buffer.from("x").toString("base64"),
          overwrite: false,
        }),
      ),
    ).toMatchObject({ code: "policy_missing", status: 409 });
    expect(writes()).toBe(0);
    await expect(t.files.remove({ target, path: "a.txt", recursive: false })).resolves.toBeDefined();
  });

  it("the sweeper makes no limit decision without a policy: a running sandbox is not stopped as idle or full", async () => {
    const first = boot();
    first.sandboxes.setPolicy(policy({ limits: { ...policy().limits, idleStopMs: 1_000 } }));
    await first.sandboxes.ensure(target);
    const t = boot(first.docker);
    t.advance(60 * 60_000);
    await t.sweeper.tick();
    expect(t.sbx()?.Running).toBe(true);
    expect(t.emitted.some((e) => e.type === "state" && e.state !== "running")).toBe(false);
  });

  it("a stale push (lower version) never replaces a newer policy, so a late re-push cannot undo a kill", async () => {
    const t = boot();
    t.sandboxes.setPolicy(policy({ killed: true, version: 5 }));
    t.sandboxes.setPolicy(policy({ killed: false, version: 4 }));
    expect(t.sandboxes.limitsFor(ORG)?.killed).toBe(true);
    t.sandboxes.setPolicy(policy({ killed: false, version: 6 }));
    expect(t.sandboxes.limitsFor(ORG)?.killed).toBe(false);
  });
});

describe("the server's policy gate covers every op", () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  it("classifies every contract op; ops that start or run a container need a policy, reads do not", () => {
    expect(Object.keys(POLICY_GATE).sort()).toEqual(Object.keys(SANDBOXD_ROUTES).sort());
    const run = Object.entries(POLICY_GATE)
      .filter(([, g]) => g === "run")
      .map(([op]) => op as SandboxdOp);
    for (const op of [
      "ensure",
      "restart",
      "exec",
      "browserEnsure",
      "contextOpen",
      "packageInstall",
    ] as const) {
      expect(run, op).toContain(op);
    }
    for (const op of ["filesWrite", "filesUpload", "filesImport"] as const)
      expect(POLICY_GATE[op]).toBe("policy");
    for (const op of [
      "info",
      "policy",
      "events",
      "usage",
      "stop",
      "kill",
      "killOrg",
      "purge",
      "filesList",
      "filesRead",
      "filesDelete",
    ] as const) {
      expect(POLICY_GATE[op], op).toBe("none");
    }
  });

  it("over HTTP: ensure → 409 policy_missing before the policy op, running after it, killed with killed: true", async () => {
    const t = boot();
    const server = createServer({ token: TOKEN, sandboxes: t.sandboxes, files: t.files, events: t.events });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    const port = (server.address() as AddressInfo).port;
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as { error?: { code: string }; state?: string } };
    };
    const missing = await post("/v1/sandboxes/ensure", { target });
    expect(missing).toMatchObject({ status: 409, body: { error: { code: "policy_missing" } } });
    expect(t.docker.containerCreates).toHaveLength(0);
    expect((await post("/v1/policy", policy({ killed: true }))).status).toBe(200);
    expect(await post("/v1/sandboxes/ensure", { target })).toMatchObject({
      status: 409,
      body: { error: { code: "killed" } },
    });
    expect((await post("/v1/policy", policy({ version: 2 }))).status).toBe(200);
    expect(await post("/v1/sandboxes/ensure", { target })).toMatchObject({
      status: 200,
      body: { state: "running" },
    });
  });
});
