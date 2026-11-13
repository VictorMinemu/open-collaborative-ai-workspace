import { describe, expect, it } from "vitest";
import { createSandboxes, type SandboxdEventInput } from "./sandboxes";
import { nameFor } from "./spec";
import { FakeDocker } from "./testing/fake-docker";
import { testPolicy } from "./testing/policy";

/**
 * A cold `ensure` on a contended Docker daemon (sandbox-proof, CI p142/p164/p178): the bot's network and the proxy's
 * attach take under a second, then Docker holds the shell's create and start for 15-42 s. The API waits for it within
 * its own budget (contracts SANDBOX_TIMEOUTS_MS) and sandboxd finishes the start even when the API stopped waiting, so:
 * the kill switch pushed during that wait still wins (nothing starts, or what just started is killed), a second ensure
 * of the same bot waits for the first instead of creating again, and each ensure logs where its time went (ids and
 * milliseconds only).
 */

const ORG = "0199f0a0-0000-7000-8000-00000000000a";
const AGENT = "0199f0a0-1111-7000-8000-00000000000b";
const NS = "ocw-unit";
const target = { orgId: ORG, agentId: AGENT };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Line = { level: string; msg: string; [k: string]: unknown };

function boot() {
  const docker = new FakeDocker();
  const emitted: SandboxdEventInput[] = [];
  const lines: Line[] = [];
  const sandboxes = createSandboxes({
    docker,
    ns: NS,
    runtime: "auto",
    image: "sbx:test",
    onEvent: (e) => emitted.push(e),
    log: (line) => lines.push(line),
  });
  sandboxes.setPolicy(testPolicy(ORG));
  const shell = () => docker.container(nameFor("sbx", NS, AGENT));
  /** Holds every call to `path` (an exact Engine path, `{id}` for a container id) for `ms`, then runs `then`. */
  const hold = (pattern: RegExp, ms: number, then?: () => void) => {
    docker.beforeRequest = async (method, path) => {
      if (method !== "POST" || !pattern.test(path)) return;
      await sleep(ms);
      then?.();
    };
  };
  return { docker, sandboxes, emitted, lines, shell, hold };
}

const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);

describe("a cold ensure on a slow Docker daemon", () => {
  it("finishes the start however long Docker holds the create, and logs each phase's milliseconds (ids only)", async () => {
    const t = boot();
    t.hold(/^\/containers\/create$/, 300);
    const status = await t.sandboxes.ensure(target);
    expect(status.state).toBe("running");
    expect(t.shell()?.Running).toBe(true);

    const line = t.lines.find((l) => l.msg === "ensure");
    expect(line).toMatchObject({
      level: "info",
      orgId: ORG,
      agentId: AGENT,
      created: true,
      started: true,
      recreated: null,
    });
    const ms = line?.ms as Record<string, number>;
    expect(Object.keys(ms).sort()).toEqual(["create", "egress", "network", "runtime", "start", "total"]);
    expect(ms.create).toBeGreaterThanOrEqual(250);
    expect(ms.total).toBeGreaterThanOrEqual(ms.create as number);
    // Nothing but ids, flags and numbers: never an image, a path or a spec.
    expect(JSON.stringify(line)).not.toMatch(/sbx:test|\/workspace|Binds|HostConfig/);
  });

  it("a warm ensure logs that it neither created nor started anything", async () => {
    const t = boot();
    await t.sandboxes.ensure(target);
    t.lines.length = 0;
    await t.sandboxes.ensure(target);
    expect(t.lines.find((l) => l.msg === "ensure")).toMatchObject({
      created: false,
      started: false,
      recreated: null,
    });
  });

  it("the kill switch pushed while Docker holds the create: refused `killed`, nothing is started", async () => {
    const t = boot();
    t.hold(/^\/containers\/create$/, 200, () =>
      t.sandboxes.setPolicy(testPolicy(ORG, { killed: true, version: 2 })),
    );
    expect(await refusal(t.sandboxes.ensure(target))).toMatchObject({ code: "killed", status: 409 });
    expect(t.shell()?.Running ?? false).toBe(false);
    expect(t.docker.calls.some((c) => c.method === "POST" && c.path.endsWith("/start"))).toBe(false);
    expect(t.emitted.some((e) => e.type === "state" && e.state === "running")).toBe(false);
  });

  it("the kill switch pushed while Docker holds the start: what just started is killed at once and refused `killed`", async () => {
    const t = boot();
    t.hold(/^\/containers\/[^/]+\/start$/, 200, () =>
      t.sandboxes.setPolicy(testPolicy(ORG, { killed: true, version: 2 })),
    );
    expect(await refusal(t.sandboxes.ensure(target))).toMatchObject({ code: "killed", status: 409 });
    expect(t.shell()?.Running).toBe(false);
    expect(t.docker.calls.some((c) => c.method === "POST" && c.path.endsWith("/kill"))).toBe(true);
    expect(t.emitted.some((e) => e.type === "state" && e.state === "running")).toBe(false);
    expect(t.emitted).toContainEqual(
      expect.objectContaining({ type: "state", target, kind: "sbx", state: "killed", reason: "kill_switch" }),
    );
  });

  it("a second ensure of the same bot during a slow first one waits for it and creates nothing again", async () => {
    const t = boot();
    t.hold(/^\/containers\/create$/, 200);
    const first = t.sandboxes.ensure(target);
    await sleep(20);
    const second = t.sandboxes.ensure(target);
    const [a, b] = await Promise.all([first, second]);
    expect(a.state).toBe("running");
    expect(b.state).toBe("running");
    expect(t.docker.containerCreates).toHaveLength(1);
  });
});
