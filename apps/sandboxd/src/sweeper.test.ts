import { SandboxdUsage } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { createFiles } from "./files";
import { createQuota } from "./quota";
import { createSandboxes, type SandboxdEventInput } from "./sandboxes";
import { nameFor } from "./spec";
import { createSweeper } from "./sweeper";
import { FakeDocker } from "./testing/fake-docker";

const ORG = "0199f0a0-0000-7000-8000-00000000000a";
const AGENT = "0199f0a0-1111-7000-8000-00000000000b";
const NS = "ocw-unit";
const target = { orgId: ORG, agentId: AGENT };
const MiB = 1024 * 1024;

const policy = (over: { diskQuotaBytes?: number; idleStopMs?: number; killed?: boolean } = {}) => ({
  orgId: ORG,
  sandboxEgress: "allowlist" as const,
  browserEgress: "public" as const,
  allowHosts: [],
  privateHosts: [],
  limits: {
    nanoCpus: 1_000_000_000,
    memoryBytes: 1024 * MiB,
    pids: 256,
    diskQuotaBytes: over.diskQuotaBytes ?? 64 * MiB,
    idleStopMs: over.idleStopMs ?? 30_000,
  },
  browserLimits: {
    nanoCpus: 1_000_000_000,
    memoryBytes: 2048 * MiB,
    pids: 512,
    diskQuotaBytes: 64 * MiB,
    idleStopMs: 300_000,
  },
  killed: over.killed ?? false,
});

/** A workspace whose `du` answers `disk` bytes; `rm` frees what the test says. */
function setup(opts: { disk?: number } = {}) {
  const docker = new FakeDocker();
  const state = { disk: opts.disk ?? 1000, afterRm: 1000 };
  docker.onExec = (call) => {
    const sub = call.cmd[1];
    if (sub === "du") return { exitCode: 0, stdout: `${state.disk}\n` };
    if (sub === "rm") {
      state.disk = state.afterRm;
      return { exitCode: 0, stdout: "1" };
    }
    if (sub === "write") return { exitCode: 0, stdout: String(call.stdin.length) };
    return { exitCode: 0 };
  };
  let now = 1_760_500_000_000;
  const clock = { now: () => now };
  const events: SandboxdEventInput[] = [];
  const sandboxes = createSandboxes({
    docker,
    ns: NS,
    runtime: "auto",
    image: "sbx:test",
    clock,
    onEvent: (e) => events.push(e),
  });
  const quota = createQuota({ sandboxes });
  const files = createFiles({ sandboxes, quota });
  const sweeper = createSweeper({ sandboxes, quota, clock, intervalMs: 60_000 });
  return {
    docker,
    state,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
    events,
    sandboxes,
    quota,
    files,
    sweeper,
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

describe("policy: the organization's limits reach new containers (D-09)", () => {
  it("ensure builds the container with the pushed CPU, memory and pids", async () => {
    const t = setup();
    t.sandboxes.setPolicy({
      ...policy(),
      limits: { ...policy().limits, nanoCpus: 2_000_000_000, memoryBytes: 512 * MiB, pids: 128 },
    });
    await t.sandboxes.ensure(target);
    const spec = t.sbx()?.Spec as { HostConfig: Record<string, number> };
    expect(spec.HostConfig.NanoCpus).toBe(2_000_000_000);
    expect(spec.HostConfig.Memory).toBe(512 * MiB);
    expect(spec.HostConfig.PidsLimit).toBe(128);
  });

  it("a killed organization's ensure answers 409 killed and creates nothing; people's files still work", async () => {
    const t = setup();
    await t.sandboxes.ensure(target);
    await t.sandboxes.stop({ target, reason: "kill_switch" });
    t.sandboxes.setPolicy(policy({ killed: true }));
    expect(await refusal(t.sandboxes.ensure(target))).toMatchObject({ code: "killed", status: 409 });
    expect(t.sbx()?.Running).toBe(false);
    await expect(t.files.list({ target, path: "", hidden: true })).resolves.toBeDefined();
    t.sandboxes.setPolicy(policy({ killed: false }));
    await expect(t.sandboxes.ensure(target)).resolves.toMatchObject({ state: "running" });
  });
});

describe("soft quota (D-01, F-9, T-07.8-09-03)", () => {
  it("refuses an upload that does not fit before writing; the sandbox keeps running when under quota", async () => {
    const t = setup({ disk: 50 * MiB });
    t.sandboxes.setPolicy(policy());
    await t.sandboxes.ensure(target);
    const data = Buffer.alloc(20 * MiB).toString("base64");
    expect(await refusal(t.files.upload({ target, path: "more.bin", data, overwrite: false }))).toMatchObject(
      {
        code: "disk_full",
        status: 409,
      },
    );
    expect(t.docker.execCreates.filter((c) => (c.body as { Cmd: string[] }).Cmd[1] === "write")).toHaveLength(
      0,
    );
    expect(t.sbx()?.Running).toBe(true);
    const small = Buffer.alloc(MiB).toString("base64");
    await expect(t.files.upload({ target, path: "ok.bin", data: small, overwrite: false })).resolves.toEqual({
      path: "ok.bin",
      size: MiB,
    });
    // The usage report includes the write at once (measured + written), before the next measurement.
    expect((await t.sandboxes.usage(ORG)).items[0]?.diskBytes).toBe(51 * MiB);
  });

  it("a measurement over quota marks disk_full, stops the sandbox with that reason, and ensure refuses until a delete clears it", async () => {
    const t = setup({ disk: 130 * MiB });
    t.sandboxes.setPolicy(policy());
    await t.sandboxes.ensure(target);
    await t.sweeper.tick();
    expect(t.sbx()?.Running).toBe(false);
    expect(t.events.filter((e) => e.type === "state").at(-1)).toMatchObject({
      type: "state",
      target,
      kind: "sbx",
      state: "disk_full",
      reason: "disk_full",
    });
    expect(await refusal(t.sandboxes.ensure(target))).toMatchObject({ code: "disk_full", status: 409 });
    expect(t.sbx()?.Running).toBe(false);
    expect((await t.sandboxes.status(target)).state).toBe("disk_full");
    expect((await t.sandboxes.status(target)).diskBytes).toBe(130 * MiB);

    // Writes stay refused while full; a delete through the files helper re-measures and clears it.
    expect(
      await refusal(t.files.write({ target, path: "x", content: "x", encoding: "utf8", mode: "create" })),
    ).toMatchObject({ code: "disk_full" });
    t.state.afterRm = 10 * MiB;
    await t.files.remove({ target, path: "big", recursive: false });
    expect(t.docker.container(nameFor("files", NS, AGENT))?.Running).toBe(true);
    expect(t.events.filter((e) => e.type === "state").at(-1)).toMatchObject({
      state: "stopped",
      reason: null,
    });
    await expect(t.sandboxes.ensure(target)).resolves.toMatchObject({
      state: "running",
      diskBytes: 10 * MiB,
    });
  });

  it("measuring never counts as activity (the sweeper does not keep a sandbox awake)", async () => {
    const t = setup();
    t.sandboxes.setPolicy(policy({ idleStopMs: 30_000 }));
    await t.sandboxes.ensure(target);
    t.advance(20_000);
    await t.quota.measure(target);
    t.advance(11_000);
    await t.sweeper.tick();
    expect(t.sbx()?.Running).toBe(false);
  });
});

describe("idle stop and usage (D-01, D-09)", () => {
  it("stops a sandbox with no op for idleStopMs with reason idle, keeps its volume, and emits one usage sample", async () => {
    const t = setup();
    t.sandboxes.setPolicy(policy({ idleStopMs: 30_000 }));
    await t.sandboxes.ensure(target);
    const sbx = t.sbx();
    if (sbx) sbx.cpuNs = 7_000_000_000;
    t.advance(29_000);
    await t.sweeper.tick();
    expect(t.sbx()?.Running).toBe(true);
    const usageBefore = t.events.filter((e) => e.type === "usage").length;
    t.advance(2_000);
    await t.sweeper.tick();
    expect(t.sbx()?.Running).toBe(false);
    expect(t.docker.volumes.has(nameFor("ws", NS, AGENT))).toBe(true);
    const stateEvents = t.events.filter((e) => e.type === "state");
    expect(stateEvents.at(-1)).toMatchObject({ state: "stopped", reason: "idle", kind: "sbx" });
    const usage = t.events.filter((e) => e.type === "usage").slice(usageBefore);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ type: "usage", target, diskBytes: 1000 });
  });

  it("a file op on the running sandbox resets the idle clock", async () => {
    const t = setup();
    t.sandboxes.setPolicy(policy({ idleStopMs: 30_000 }));
    await t.sandboxes.ensure(target);
    t.advance(25_000);
    await t.files.list({ target, path: "", hidden: true });
    t.advance(25_000);
    await t.sweeper.tick();
    expect(t.sbx()?.Running).toBe(true);
  });

  it("usage events carry the CPU delta since the previous sample and the measured disk", async () => {
    const t = setup({ disk: 4096 });
    t.sandboxes.setPolicy(policy({ idleStopMs: 3_600_000 }));
    await t.sandboxes.ensure(target);
    const sbx = t.sbx();
    if (sbx) sbx.cpuNs = 1_500_000_000;
    await t.sweeper.tick();
    if (sbx) sbx.cpuNs = 2_000_000_000;
    await t.sweeper.tick();
    const usage = t.events.filter((e) => e.type === "usage");
    expect(usage.map((u) => (u.type === "usage" ? [u.cpuMs, u.diskBytes] : null))).toEqual([
      [1500, 4096],
      [500, 4096],
    ]);
  });

  it("the usage op reports each bot's state, cumulative cpuMs and diskBytes", async () => {
    const t = setup({ disk: 2048 });
    t.sandboxes.setPolicy(policy({ idleStopMs: 3_600_000 }));
    await t.sandboxes.ensure(target);
    const sbx = t.sbx();
    if (sbx) sbx.cpuNs = 3_000_000_000;
    await t.sweeper.tick();
    const usage = await t.sandboxes.usage(ORG);
    expect(SandboxdUsage.safeParse(usage).success).toBe(true);
    expect(usage).toEqual({
      orgId: ORG,
      running: { sandboxes: 1, browsers: 0 },
      items: [{ agentId: AGENT, kind: "sbx", state: "running", diskBytes: 2048, cpuMs: 3000 }],
    });
  });

  it("a user stop emits one usage sample and one state event with its reason", async () => {
    const t = setup();
    await t.sandboxes.ensure(target);
    t.events.length = 0;
    await t.sandboxes.stop({ target, reason: "user" });
    expect(t.events.map((e) => e.type)).toEqual(["usage", "state"]);
    expect(t.events[1]).toMatchObject({ state: "stopped", reason: "user" });
  });
});

describe("files helper reaping", () => {
  it("reaps a files helper idle for 60 s and keeps the volume; a busy one stays", async () => {
    const t = setup();
    await t.sandboxes.ensure(target);
    await t.sandboxes.stop({ target, reason: "user" });
    await t.files.list({ target, path: "", hidden: true });
    expect(t.docker.container(nameFor("files", NS, AGENT))).not.toBeNull();
    t.advance(59_000);
    await t.sweeper.tick();
    expect(t.docker.container(nameFor("files", NS, AGENT))).not.toBeNull();
    t.advance(2_000);
    await t.sweeper.tick();
    expect(t.docker.container(nameFor("files", NS, AGENT))).toBeNull();
    expect(t.docker.volumes.has(nameFor("ws", NS, AGENT))).toBe(true);
    const deletes = t.docker.calls.filter((c) => c.method === "DELETE");
    expect(deletes.every((c) => !c.path.includes("v=1"))).toBe(true);
  });
});

describe("policy and usage routes", () => {
  it("POST /v1/policy stores the limits (400 on a bad body); POST /v1/usage answers the contract", async () => {
    const { createServer } = await import("./server");
    const t = setup({ disk: 777 });
    const TOKEN = "t".repeat(40);
    const server = createServer({ token: TOKEN, sandboxes: t.sandboxes, files: t.files });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as import("node:net").AddressInfo;
    const call = async (path: string, body: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    try {
      expect((await call("/v1/policy", { ...policy(), limits: { pids: 0 } })).status).toBe(400);
      expect(await call("/v1/policy", policy({ diskQuotaBytes: 5 * MiB, idleStopMs: 45_000 }))).toEqual({
        status: 200,
        json: { ok: true },
      });
      expect(t.sandboxes.limitsFor(ORG)).toMatchObject({ diskQuotaBytes: 5 * MiB, idleStopMs: 45_000 });
      await t.sandboxes.ensure(target);
      await t.quota.measure(target);
      const usage = await call("/v1/usage", { orgId: ORG });
      expect(usage.status).toBe(200);
      expect(SandboxdUsage.safeParse(usage.json).success).toBe(true);
      expect(usage.json.items).toEqual([expect.objectContaining({ agentId: AGENT, diskBytes: 777 })]);
    } finally {
      server.close();
    }
  });
});
