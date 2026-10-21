import { SandboxdEventsResponse } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { createEvents } from "./events";
import { nameFor } from "./spec";
import { testPolicy } from "./testing/policy";

const ORG = "0199f0a0-0000-7000-8000-00000000000a";
const AGENT = "0199f0a0-1111-7000-8000-00000000000b";
const target = { orgId: ORG, agentId: AGENT };

const state = (s: "running" | "stopped") =>
  ({ type: "state", target, kind: "sbx", state: s, reason: s === "stopped" ? "idle" : null }) as const;

describe("events: the feed the API long-polls (D-09, P-04)", () => {
  it("since(0) returns every retained event in order with nextSeq, valid against the contract", async () => {
    const events = createEvents();
    events.emit(state("running"));
    events.emit({ type: "usage", target, cpuMs: 120, diskBytes: 4096 });
    events.emit(state("stopped"));
    const res = await events.since(0, 0);
    expect(SandboxdEventsResponse.safeParse(res).success).toBe(true);
    expect(res.events.map((e) => [e.seq, e.type])).toEqual([
      [1, "state"],
      [2, "usage"],
      [3, "state"],
    ]);
    expect(res.nextSeq).toBe(3);
    expect(res.bootId).toBe(events.bootId);
    const after = await events.since(2, 0);
    expect(after.events.map((e) => e.seq)).toEqual([3]);
  });

  it("since(nextSeq, 1000) waits and resolves on the next emit", async () => {
    const events = createEvents();
    events.emit(state("running"));
    const started = Date.now();
    const poll = events.since(1, 1000);
    setTimeout(() => events.emit(state("stopped")), 50);
    const res = await poll;
    expect(Date.now() - started).toBeLessThan(900);
    expect(res.events.map((e) => e.seq)).toEqual([2]);
    expect(res.nextSeq).toBe(2);
  });

  it("since(nextSeq, waitMs) with no event resolves after the wait with an empty list and the same cursor", async () => {
    const events = createEvents();
    events.emit(state("running"));
    const started = Date.now();
    const res = await events.since(1, 150);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(res).toEqual({ bootId: events.bootId, events: [], nextSeq: 1 });
  });

  it("keeps the last 5,000 events and pages 500 at a time", async () => {
    const events = createEvents();
    for (let i = 0; i < 5200; i++) events.emit({ type: "usage", target, cpuMs: i, diskBytes: 0 });
    expect(events.size).toBe(5000);
    const first = await events.since(0, 0);
    expect(first.events).toHaveLength(500);
    expect(first.events[0]?.seq).toBe(201);
    expect(first.nextSeq).toBe(700);
    const later = await events.since(5100, 0);
    expect(later.events.map((e) => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => 5101 + i));
  });

  it("bootId is a fresh uuid per process (per feed); a cursor from another boot never runs ahead", async () => {
    const a = createEvents();
    const b = createEvents();
    expect(a.bootId).not.toBe(b.bootId);
    b.emit(state("running"));
    const res = await b.since(9999, 0);
    expect(res).toMatchObject({ events: [], nextSeq: 1 });
  });

  it("caps a long poll at 25 s", async () => {
    const events = createEvents();
    const { EVENTS_MAX_WAIT_MS } = await import("./events");
    expect(EVENTS_MAX_WAIT_MS).toBe(25_000);
    const poll = events.since(0, 60_000);
    events.emit(state("running"));
    await expect(poll).resolves.toMatchObject({ nextSeq: 1 });
  });
});

describe("events from sandboxd's lifecycle (D-09, T-07.8-09-04)", () => {
  const NS = "ocw-unit";
  const OTHER = "0199f0a0-1111-7000-8000-0000000000cc";

  async function stack() {
    const { FakeDocker } = await import("./testing/fake-docker");
    const { createSandboxes } = await import("./sandboxes");
    const { createFiles } = await import("./files");
    const { createQuota } = await import("./quota");
    const docker = new FakeDocker();
    docker.onExec = (call) => {
      if (call.cmd[1] === "du") return { exitCode: 0, stdout: "100\n" };
      if (call.cmd[1] === "write") return { exitCode: 0, stdout: String(call.stdin.length) };
      return { exitCode: 0, stdout: "SENTINEL-output-1f9e\n" };
    };
    const events = createEvents();
    const sandboxes = createSandboxes({
      docker,
      ns: NS,
      runtime: "auto",
      image: "sbx:test",
      onEvent: (e) => events.emit(e),
    });
    sandboxes.setPolicy(testPolicy(ORG));
    const quota = createQuota({ sandboxes });
    const files = createFiles({ sandboxes, quota });
    return { docker, events, sandboxes, files };
  }

  const states = (list: { type: string }[]) =>
    list
      .filter(
        (e): e is { type: "state"; state: string; reason: string | null; kind: string } => e.type === "state",
      )
      .map((e) => [e.kind, e.state, e.reason]);

  it("every lifecycle change emits one state event with org, agent, kind, state and reason", async () => {
    const { events, sandboxes } = await stack();
    await sandboxes.ensure(target);
    await sandboxes.ensure(target);
    await sandboxes.stop({ target, reason: "user" });
    await sandboxes.ensure(target);
    await sandboxes.restart(target);
    await sandboxes.kill(target);
    await sandboxes.ensure(target);
    await sandboxes.killOrg(ORG);
    await sandboxes.purge(target);
    const res = await events.since(0, 0);
    expect(SandboxdEventsResponse.safeParse(res).success).toBe(true);
    expect(states(res.events)).toEqual([
      ["sbx", "running", null],
      ["sbx", "stopped", "user"],
      ["sbx", "running", null],
      ["sbx", "running", null],
      ["sbx", "killed", "kill_switch"],
      ["sbx", "running", null],
      ["sbx", "killed", "kill_switch"],
      ["sbx", "absent", null],
    ]);
    for (const e of res.events) expect(e).toMatchObject({ target });
  });

  it("a container that dies without the broker → state stopped (reason null); the broker's own stops are not crashes", async () => {
    const { docker, events, sandboxes } = await stack();
    const stopWatching = sandboxes.watch();
    try {
      await sandboxes.ensure(target);
      await sandboxes.ensure({ orgId: ORG, agentId: OTHER });
      await new Promise((r) => setImmediate(r));
      const mine = docker.container(nameFor("sbx", NS, AGENT));
      const other = docker.container(nameFor("sbx", NS, OTHER));
      // The broker stops its own: Docker reports a die that must not read as a crash.
      await sandboxes.stop({ target, reason: "user" });
      docker.emitEvent({ status: "die", id: mine?.Id, Actor: { ID: mine?.Id, Attributes: mine?.Labels } });
      // Someone else stops the other bot's container.
      if (other) other.Running = false;
      docker.emitEvent({ status: "die", id: other?.Id, Actor: { ID: other?.Id, Attributes: other?.Labels } });
      // A die from another namespace or without labels is ignored.
      docker.emitEvent({
        status: "die",
        id: "x",
        Actor: { ID: "x", Attributes: { "ocw.namespace": "other" } },
      });
      await new Promise((r) => setTimeout(r, 20));
      const res = await events.since(0, 0);
      const stopped = res.events.filter((e) => e.type === "state" && e.state === "stopped");
      expect(stopped.map((e) => (e.type === "state" ? [e.target.agentId, e.reason] : null))).toEqual([
        [AGENT, "user"],
        [OTHER, null],
      ]);
      const filters = docker.calls.find((c) => c.method === "STREAM")?.path ?? "";
      expect(decodeURIComponent(filters)).toContain(`"ocw.namespace=${NS}"`);
      expect(decodeURIComponent(filters)).toContain('"die"');
    } finally {
      stopWatching();
    }
  });

  it("no event carries a path, an argv or content", async () => {
    const { events, sandboxes, files } = await stack();
    await sandboxes.ensure(target);
    await sandboxes.exec({
      target,
      argv: ["echo", "SENTINEL-argv-55aa"],
      cwd: "",
      timeoutMs: 5000,
      yieldMs: 1000,
    });
    await files.write({
      target,
      path: "SENTINEL-path-77bb.txt",
      content: "SENTINEL-content-99cc",
      encoding: "utf8",
      mode: "create",
    });
    await files.remove({ target, path: "SENTINEL-path-77bb.txt", recursive: false });
    await sandboxes.stop({ target, reason: "idle" });
    const text = JSON.stringify(await events.since(0, 0));
    for (const s of [
      "SENTINEL-argv-55aa",
      "SENTINEL-path-77bb",
      "SENTINEL-content-99cc",
      "SENTINEL-output-1f9e",
    ]) {
      expect(text).not.toContain(s);
    }
    expect(text).toContain('"type":"usage"');
  });

  it("GET /v1/events requires the token, rejects waitMs over the contract and caps a long poll at 25 s", async () => {
    const { createServer } = await import("./server");
    const { events, sandboxes, files } = await stack();
    const TOKEN = "t".repeat(40);
    const server = createServer({ token: TOKEN, sandboxes, files, events });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as import("node:net").AddressInfo;
    const get = async (query: string, token: string | null = TOKEN) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/events${query}`, {
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    try {
      expect((await get("?after=0&waitMs=0", null)).status).toBe(401);
      expect((await get("?after=0&waitMs=30001")).status).toBe(400);
      expect((await get("?after=0&waitMs=0&x=1")).status).toBe(400);
      const poll = get("?after=0&waitMs=30000");
      await new Promise((r) => setTimeout(r, 30));
      await sandboxes.ensure(target);
      const res = await poll;
      expect(res.status).toBe(200);
      expect(SandboxdEventsResponse.safeParse(res.json).success).toBe(true);
      expect(res.json).toMatchObject({ bootId: events.bootId, nextSeq: 1 });
    } finally {
      server.close();
    }
  });
});
