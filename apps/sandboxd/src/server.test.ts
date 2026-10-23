import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { Docker, DockerMethod, DockerRequestOptions, DockerResponse } from "./docker";
import { createFiles } from "./files";
import { createSandboxes, type RuntimeSetting, startupRefusal } from "./sandboxes";
import { createServer, tokenMatches } from "./server";
import { nameFor } from "./spec";
import { testPolicy } from "./testing/policy";

const TOKEN = "t".repeat(40);
const NS = "ocw-unit";
const ORG = "0199f0a0-0000-7000-8000-00000000000a";
const OTHER_ORG = "0199f0a0-0000-7000-8000-0000000000ff";
const AGENT = "0199f0a0-1111-7000-8000-00000000000b";
const SENTINEL = "SENTINEL-argv-value-7f3a";

interface FakeObject {
  Id: string;
  Name: string;
  Labels: Record<string, string>;
  Running: boolean;
  Internal?: boolean;
  Spec?: Record<string, unknown>;
}

/** An in-memory Docker double: only the Engine API calls sandboxd makes, and a log of every call. */
class FakeDocker implements Docker {
  calls: { method: DockerMethod; path: string; body?: unknown }[] = [];
  containers = new Map<string, FakeObject>();
  networks = new Map<string, FakeObject>();
  volumes = new Map<string, FakeObject>();
  private seq = 0;

  constructor(
    public version = "29.6.2",
    public runtimes: string[] = ["io.containerd.runc.v2", "runc"],
  ) {}

  private id() {
    this.seq += 1;
    return `id${this.seq}`.padEnd(12, "0");
  }

  private find(map: Map<string, FakeObject>, ref: string) {
    return map.get(ref) ?? [...map.values()].find((o) => o.Id === ref) ?? null;
  }

  async request(
    method: DockerMethod,
    rawPath: string,
    body?: unknown,
    _options?: DockerRequestOptions,
  ): Promise<DockerResponse> {
    this.calls.push({ method, path: rawPath, body });
    const url = new URL(rawPath, "http://docker");
    const path = decodeURIComponent(url.pathname);
    const json = (status: number, b: unknown = null) => ({ status, body: b });
    if (method === "GET" && path === "/version") return json(200, { Version: this.version });
    if (method === "GET" && path === "/info") {
      return json(200, { Runtimes: Object.fromEntries(this.runtimes.map((r) => [r, { path: r }])) });
    }
    let m = /^\/containers\/([^/]+)\/json$/.exec(path);
    if (method === "GET" && m) {
      const c = this.find(this.containers, m[1] as string);
      if (!c) return json(404, { message: "No such container" });
      const spec = (c.Spec ?? {}) as { HostConfig?: Record<string, unknown> };
      return json(200, {
        Id: c.Id,
        Config: { Labels: c.Labels },
        State: {
          Running: c.Running,
          Status: c.Running ? "running" : "exited",
          StartedAt: "2026-10-15T10:00:00Z",
        },
        HostConfig: spec.HostConfig ?? { Runtime: "runc" },
      });
    }
    m = /^\/networks\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const n = this.find(this.networks, m[1] as string);
      return n ? json(200, { Id: n.Id, Name: n.Name, Labels: n.Labels, Internal: n.Internal }) : json(404);
    }
    m = /^\/volumes\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const v = this.find(this.volumes, m[1] as string);
      return v ? json(200, { Name: v.Name, Labels: v.Labels }) : json(404);
    }
    if (method === "POST" && path === "/networks/create") {
      const b = body as { Name: string; Labels: Record<string, string>; Internal: boolean };
      this.networks.set(b.Name, {
        Id: this.id(),
        Name: b.Name,
        Labels: b.Labels,
        Running: false,
        Internal: b.Internal,
      });
      return json(201, {});
    }
    if (method === "POST" && path === "/volumes/create") {
      const b = body as { Name: string; Labels: Record<string, string> };
      this.volumes.set(b.Name, { Id: b.Name, Name: b.Name, Labels: b.Labels, Running: false });
      return json(201, {});
    }
    if (method === "POST" && path === "/containers/create") {
      const name = url.searchParams.get("name") as string;
      if (this.containers.has(name)) return json(409);
      const b = body as { Labels: Record<string, string> } & Record<string, unknown>;
      this.containers.set(name, { Id: this.id(), Name: name, Labels: b.Labels, Running: false, Spec: b });
      return json(201, {});
    }
    m = /^\/containers\/([^/]+)\/(start|stop|kill|restart|exec)$/.exec(path);
    if (method === "POST" && m) {
      const c = this.find(this.containers, m[1] as string);
      if (!c) return json(404);
      if (m[2] === "exec") return json(201, { Id: "exec1" });
      c.Running = m[2] === "start" || m[2] === "restart";
      return json(204);
    }
    if (method === "GET" && path === "/containers/json") {
      const want = (JSON.parse(url.searchParams.get("filters") ?? "{}").label ?? []) as string[];
      const all = url.searchParams.get("all") === "1";
      return json(
        200,
        [...this.containers.values()]
          .filter((c) => all || c.Running)
          .filter((c) =>
            want.every((kv) => c.Labels[kv.split("=")[0] as string] === kv.split("=").slice(1).join("=")),
          )
          .map((c) => ({ Id: c.Id, Labels: c.Labels })),
      );
    }
    if (method === "GET" && path === "/networks") return json(200, []);
    if (method === "GET" && path === "/volumes") return json(200, { Volumes: [] });
    return json(404);
  }

  async hijack(): Promise<PassThrough> {
    const s = new PassThrough();
    s.end();
    return s;
  }

  async stream(): Promise<PassThrough> {
    return new PassThrough();
  }

  get execCreates() {
    return this.calls.filter((c) => c.method === "POST" && /\/exec$/.test(c.path));
  }

  get containerCreates() {
    return this.calls.filter((c) => c.method === "POST" && c.path.startsWith("/containers/create"));
  }
}

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function start(docker: FakeDocker, runtime: RuntimeSetting = "auto") {
  const sandboxes = createSandboxes({ docker, ns: NS, runtime, image: "ocw-sandbox-sbx:test" });
  sandboxes.setPolicy(testPolicy(ORG));
  const files = createFiles({
    sandboxes,
    quota: { assertRoom: async () => 0, afterWrite: () => {}, afterChange: async () => {} },
  });
  const server = createServer({ token: TOKEN, sandboxes, files });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return {
    sandboxes,
    async call(method: "GET" | "POST", path: string, body?: unknown, token: string | null = TOKEN) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, text, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
    },
  };
}

const target = { orgId: ORG, agentId: AGENT };
const execBody = (argv: string[] = ["echo", SENTINEL]) => ({
  target,
  argv,
  cwd: "",
  timeoutMs: 10_000,
  yieldMs: 1_000,
});

describe("sandboxd server: token and contract", () => {
  it("answers 401 without the token or with a wrong one, never echoing the body", async () => {
    const api = await start(new FakeDocker());
    for (const token of [null, "wrong-token", `${TOKEN}x`]) {
      const res = await api.call("POST", "/v1/sandboxes/exec", execBody(), token);
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: { code: "unauthorized", message: expect.any(String) } });
      expect(res.text).not.toContain(SENTINEL);
    }
    expect(tokenMatches(TOKEN, `Bearer ${TOKEN}`)).toBe(true);
    expect(tokenMatches(TOKEN, `bearer ${TOKEN}`)).toBe(false);
    expect(tokenMatches(TOKEN, undefined)).toBe(false);
  });

  it("answers 400 for a body that fails the contract, without echoing it", async () => {
    const docker = new FakeDocker();
    const api = await start(docker);
    const bad = [
      { ...execBody(), env: { OCW_SANDBOX_TOKEN: SENTINEL } },
      { ...execBody([]) },
      { ...execBody(), cwd: `../${SENTINEL}` },
      { ...execBody(), image: SENTINEL },
      `{"target": ${SENTINEL}`,
    ];
    for (const body of bad) {
      const res = await api.call("POST", "/v1/sandboxes/exec", body);
      expect(res.status).toBe(400);
      expect((res.json?.error as { code: string } | undefined)?.code).toBe("invalid_request");
      expect(res.text).not.toContain(SENTINEL);
    }
    expect(docker.execCreates).toHaveLength(0);
  });

  it("answers 404 for an unknown route", async () => {
    const api = await start(new FakeDocker());
    expect((await api.call("POST", "/v1/nope", {})).status).toBe(404);
    expect((await api.call("GET", "/v1/sandboxes/ensure")).status).toBe(404);
  });
});

describe("sandboxd: the label check (D-02, Pattern 1)", () => {
  function squatted(labels: Record<string, string>) {
    const docker = new FakeDocker();
    docker.containers.set(nameFor("sbx", NS, AGENT), {
      Id: "squat0000000",
      Name: nameFor("sbx", NS, AGENT),
      Labels: labels,
      Running: true,
    });
    return docker;
  }

  const variants: [string, Record<string, string>][] = [
    [
      "another org",
      {
        "ocw.sandbox": "1",
        "ocw.namespace": NS,
        "ocw.org": OTHER_ORG,
        "ocw.agent": AGENT,
        "ocw.kind": "sbx",
      },
    ],
    ["no labels", {}],
    [
      "another namespace",
      { "ocw.sandbox": "1", "ocw.namespace": "x", "ocw.org": ORG, "ocw.agent": AGENT, "ocw.kind": "sbx" },
    ],
    ["not a sandbox", { "ocw.namespace": NS, "ocw.org": ORG, "ocw.agent": AGENT, "ocw.kind": "sbx" }],
  ];

  for (const [label, labels] of variants) {
    it(`refuses a container named like the bot's but labelled with ${label} (409, no exec)`, async () => {
      const docker = squatted(labels);
      const api = await start(docker);
      for (const [path, body] of [
        ["/v1/sandboxes/ensure", { target }],
        ["/v1/sandboxes/exec", execBody()],
        ["/v1/sandboxes/kill", { target }],
        ["/v1/sandboxes/purge", { target }],
        ["/v1/sandboxes/stop", { target, reason: "user" }],
      ] as const) {
        const res = await api.call("POST", path, body);
        expect(res.status, path).toBe(409);
        expect((res.json?.error as { code: string } | undefined)?.code).toBe("label_mismatch");
      }
      expect(docker.execCreates).toHaveLength(0);
      expect(docker.containerCreates).toHaveLength(0);
      expect(docker.containers.get(nameFor("sbx", NS, AGENT))?.Running).toBe(true);
    });
  }
});

describe("sandboxd: runtime choice fails closed (D-01, D-11, D-14)", () => {
  it("auto with runsc present → gvisor, and the container is created with runsc", async () => {
    const docker = new FakeDocker("29.6.2", ["runc", "runsc"]);
    const api = await start(docker, "auto");
    const info = await api.call("GET", "/v1/info");
    expect(info.json).toMatchObject({ dockerOk: true, runtime: "gvisor" });
    const res = await api.call("POST", "/v1/sandboxes/ensure", { target });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ state: "running", runtime: "gvisor" });
    const spec = docker.containerCreates[0]?.body as { HostConfig: { Runtime: string } };
    expect(spec.HostConfig.Runtime).toBe("runsc");
  });

  it("auto without runsc → hardened-runc, reported honestly", async () => {
    const docker = new FakeDocker("29.6.2", ["runc"]);
    const api = await start(docker, "auto");
    const info = await api.call("GET", "/v1/info");
    expect(info.json).toMatchObject({ dockerOk: true, runtime: "hardened-runc" });
    const res = await api.call("POST", "/v1/sandboxes/ensure", { target });
    expect(res.json).toMatchObject({ state: "running", runtime: "hardened-runc" });
    const spec = docker.containerCreates[0]?.body as { HostConfig: { Runtime: string } };
    expect(spec.HostConfig.Runtime).toBe("runc");
  });

  it("runc requested explicitly → hardened-runc even when runsc exists", async () => {
    const docker = new FakeDocker("29.6.2", ["runc", "runsc"]);
    const api = await start(docker, "runc");
    expect((await api.call("GET", "/v1/info")).json).toMatchObject({
      dockerOk: true,
      runtime: "hardened-runc",
    });
    await api.call("POST", "/v1/sandboxes/ensure", { target });
    const spec = docker.containerCreates[0]?.body as { HostConfig: { Runtime: string } };
    expect(spec.HostConfig.Runtime).toBe("runc");
  });

  it("runsc required but absent → info dockerOk false, startup refused, ensure 503 and nothing created", async () => {
    const docker = new FakeDocker("29.6.2", ["io.containerd.runc.v2", "runc"]);
    const api = await start(docker, "runsc");
    const info = await api.call("GET", "/v1/info");
    expect(info.status).toBe(200);
    expect(info.json).toMatchObject({
      dockerOk: false,
      runtime: "gvisor",
      runtimes: ["io.containerd.runc.v2", "runc"],
    });
    expect(startupRefusal("runsc", await api.sandboxes.info())).toMatch(/runsc/);

    const res = await api.call("POST", "/v1/sandboxes/ensure", { target });
    expect(res.status).toBe(503);
    expect(res.json).toEqual({
      error: { code: "docker_unavailable", message: "the required runsc runtime is unavailable" },
    });
    expect(docker.containerCreates).toHaveLength(0);
    expect(docker.networks.size).toBe(0);
    expect(docker.volumes.size).toBe(0);
  });

  it("does not refuse to start when the runtime is available or not required", async () => {
    const withRunsc = createSandboxes({
      docker: new FakeDocker("29.6.2", ["runc", "runsc"]),
      ns: NS,
      runtime: "runsc",
      image: "i",
    });
    expect(startupRefusal("runsc", await withRunsc.info())).toBeNull();
    const auto = createSandboxes({
      docker: new FakeDocker("29.6.2", ["runc"]),
      ns: NS,
      runtime: "auto",
      image: "i",
    });
    expect(startupRefusal("auto", await auto.info())).toBeNull();
  });

  it("Docker 25.0.3 → info dockerOk false and ensure 503 docker_too_old, nothing created", async () => {
    const docker = new FakeDocker("25.0.3", ["runc"]);
    const api = await start(docker, "auto");
    expect((await api.call("GET", "/v1/info")).json).toMatchObject({
      dockerOk: false,
      dockerVersion: "25.0.3",
    });
    const res = await api.call("POST", "/v1/sandboxes/ensure", { target });
    expect(res.status).toBe(503);
    expect(res.json).toEqual({
      error: { code: "docker_unavailable", message: "docker_too_old: Docker Engine 26 or later is required" },
    });
    expect(docker.containerCreates).toHaveLength(0);
  });
});

describe("sandboxd: ensure builds from the fixed spec", () => {
  it("creates an internal network, a volume and a hardened container, and kill stops by label", async () => {
    const docker = new FakeDocker();
    const api = await start(docker);
    const res = await api.call("POST", "/v1/sandboxes/ensure", { target });
    expect(res.status).toBe(200);
    expect([...docker.networks.values()][0]?.Internal).toBe(true);
    const spec = docker.containerCreates[0]?.body as Record<string, unknown> & {
      HostConfig: Record<string, unknown>;
    };
    expect(spec.User).toBe("10001:10001");
    expect(spec.Image).toBe("ocw-sandbox-sbx:test");
    expect(spec.HostConfig.Binds).toBeUndefined();
    expect(spec.HostConfig.NetworkMode).toBe(nameFor("net", NS, AGENT));

    const killed = await api.call("POST", "/v1/sandboxes/kill", { target });
    expect(killed.json).toEqual({ removed: 1 });
    expect(docker.containers.get(nameFor("sbx", NS, AGENT))?.Running).toBe(false);
    const again = await api.call("POST", "/v1/orgs/kill", { orgId: ORG });
    expect(again.json).toEqual({ removed: 0 });
  });
});
