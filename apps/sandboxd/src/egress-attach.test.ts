import { Duplex, PassThrough } from "node:stream";
import type { SandboxdOrgPolicy } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import type { Docker, DockerMethod, DockerResponse } from "./docker";
import { compileEgressPolicy, createEgress, type EgressEntry, parseDecisionLine } from "./egress-attach";
import type { SandboxdEventInput } from "./sandboxes";
import { browserNetworkSpec, egressNames, networkSpec, packageRunNetworkSpec } from "./spec";
import { testPolicy } from "./testing/policy";

const ORG = "0199f0a0-0000-7000-8000-00000000000a";
const ORG2 = "0199f0a0-0000-7000-8000-0000000000bb";
const A = "0199f0a0-1111-7000-8000-00000000000a";
const B = "0199f0a0-1111-7000-8000-00000000000b";
const NS = "ocw-unit";

const policy = (orgId: string, over: Partial<SandboxdOrgPolicy> = {}) =>
  testPolicy(orgId, {
    sandboxEgress: "allowlist",
    browserEgress: "public",
    allowHosts: ["pypi.org"],
    privateHosts: ["panel.fake.test:8080"],
    ...over,
  });

const entry = (address: string, orgId: string, agentId: string, kind: EgressEntry["kind"]): EgressEntry => ({
  network: `${kind}-${agentId}`,
  address,
  target: { orgId, agentId },
  kind,
});

describe("compileEgressPolicy", () => {
  it("maps each network's proxy address to its org, bot and kind with the right mode", () => {
    const file = compileEgressPolicy({
      entries: [
        entry("10.1.0.2", ORG, A, "sbx"),
        entry("10.2.0.2", ORG, A, "brw"),
        entry("10.3.0.2", ORG2, B, "brw"),
      ],
      policies: new Map([
        [ORG, policy(ORG)],
        [ORG2, policy(ORG2, { browserEgress: "off" })],
      ]),
      botSubnets: ["10.1.0.0/24", "10.2.0.0/24", "10.3.0.0/24", "10.1.0.0/24"],
      ownAddresses: ["10.1.0.2", "10.2.0.2", "10.3.0.2", "172.30.0.2"],
    });
    expect(file).toEqual({
      networks: [
        {
          address: "10.1.0.2",
          orgId: ORG,
          agentId: A,
          kind: "sbx",
          mode: "allowlist",
          allowHosts: ["pypi.org"],
          privateHosts: ["panel.fake.test:8080"],
        },
        {
          address: "10.2.0.2",
          orgId: ORG,
          agentId: A,
          kind: "brw",
          mode: "public",
          allowHosts: ["pypi.org"],
          privateHosts: ["panel.fake.test:8080"],
        },
        {
          address: "10.3.0.2",
          orgId: ORG2,
          agentId: B,
          kind: "brw",
          mode: "off",
          allowHosts: [],
          privateHosts: [],
        },
      ],
      botNetworks: ["10.1.0.0/24", "10.2.0.0/24", "10.3.0.0/24"],
      ownAddresses: ["10.1.0.2", "10.2.0.2", "10.3.0.2", "172.30.0.2"],
    });
  });

  it("fails closed: no pushed policy or a killed organization is off; nothing to say is no file", () => {
    const file = compileEgressPolicy({
      entries: [entry("10.1.0.2", ORG, A, "brw"), entry("10.2.0.2", ORG2, B, "sbx")],
      policies: new Map([[ORG2, policy(ORG2, { killed: true })]]),
      botSubnets: ["10.1.0.0/24"],
      ownAddresses: ["10.1.0.2"],
    });
    expect(
      file?.networks.map((n) => [n.address, n.mode, n.allowHosts.length, n.privateHosts.length]),
    ).toEqual([
      ["10.1.0.2", "off", 0, 0],
      ["10.2.0.2", "off", 0, 0],
    ]);
    const base = { policies: new Map(), botSubnets: ["10.1.0.0/24"], ownAddresses: ["10.1.0.2"] };
    expect(compileEgressPolicy({ ...base, entries: [] })).toBeNull();
    expect(
      compileEgressPolicy({ ...base, entries: [entry("10.1.0.2", ORG, A, "sbx")], botSubnets: [] }),
    ).toBeNull();
  });
});

describe("compileEgressPolicy: package review and installer runs (07.8-17, P-12)", () => {
  const REGISTRIES = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];

  it("gives an installer or review network the registries only, whatever the bot's shell egress", () => {
    const file = compileEgressPolicy({
      entries: [entry("10.4.0.2", ORG, A, "installer"), entry("10.5.0.2", ORG, B, "review")],
      policies: new Map([[ORG, policy(ORG, { sandboxEgress: "off", allowHosts: ["evil.example"] })]]),
      botSubnets: ["10.4.0.0/24", "10.5.0.0/24"],
      ownAddresses: ["10.4.0.2", "10.5.0.2"],
      registries: REGISTRIES,
    });
    for (const n of file?.networks ?? []) {
      expect(n.mode).toBe("allowlist");
      expect(n.allowHosts).toEqual(REGISTRIES);
      // The organization's private-host fixtures still apply (an internal mirror), never its allow-list.
      expect(n.privateHosts).toEqual(["panel.fake.test:8080"]);
    }
    expect(file?.networks.map((n) => n.kind)).toEqual(["installer", "review"]);
  });

  it("fails closed for runs too: no policy, a killed organization or no registries is off", () => {
    const base = { botSubnets: ["10.4.0.0/24"], ownAddresses: ["10.4.0.2"] };
    const none = compileEgressPolicy({
      ...base,
      entries: [entry("10.4.0.2", ORG, A, "installer")],
      policies: new Map(),
      registries: REGISTRIES,
    });
    expect(none?.networks[0]).toMatchObject({ mode: "off", allowHosts: [], privateHosts: [] });
    const killed = compileEgressPolicy({
      ...base,
      entries: [entry("10.4.0.2", ORG, A, "installer")],
      policies: new Map([[ORG, policy(ORG, { killed: true })]]),
      registries: REGISTRIES,
    });
    expect(killed?.networks[0]?.mode).toBe("off");
    const empty = compileEgressPolicy({
      ...base,
      entries: [entry("10.4.0.2", ORG, A, "review")],
      policies: new Map([[ORG, policy(ORG)]]),
      registries: [],
    });
    expect(empty?.networks[0]?.mode).toBe("off");
  });
});

describe("parseDecisionLine", () => {
  it("reads the proxy's decision lines (host only) and ignores anything else", () => {
    expect(
      parseDecisionLine(
        '{"network":"10.1.0.2","host":"panel.fake.test","port":8080,"allowed":true,"reason":"allowed"}',
      ),
    ).toEqual({ network: "10.1.0.2", host: "panel.fake.test", allowed: true });
    expect(parseDecisionLine("not json")).toBeNull();
    expect(parseDecisionLine('{"level":"info","msg":"policy loaded"}')).toBeNull();
  });
});

// ---------------------------------------------------------------- createEgress against a Docker double

const dockerFrame = (stream: 1 | 2, text: string) => {
  const data = Buffer.from(text);
  const h = Buffer.alloc(8);
  h[0] = stream;
  h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, data]);
};

interface Net {
  Id: string;
  Name: string;
  Labels: Record<string, string>;
  Internal: boolean;
  subnet: string;
}

/** Just enough of the Engine for the egress container: networks, connect/disconnect, exec as root, HUP, attach. */
class EgressDocker implements Docker {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  networks = new Map<string, Net>();
  container: {
    Id: string;
    Running: boolean;
    Labels: Record<string, string>;
    nets: Map<string, string>;
  } | null = null;
  policyFile: string | null = null;
  execs = new Map<string, { cmd: string[]; user: string; stdin: Buffer; exit: number | null }>();
  attached: PassThrough[] = [];
  private seq = 0;

  addBotNetwork(name: string, labels: Record<string, string>, subnet: string) {
    this.networks.set(name, { Id: `net${++this.seq}`, Name: name, Labels: labels, Internal: true, subnet });
  }

  private stderr(msg: string) {
    for (const s of this.attached) s.push(dockerFrame(2, `${JSON.stringify({ level: "info", msg })}\n`));
  }

  stdout(line: unknown) {
    for (const s of this.attached) s.push(dockerFrame(1, `${JSON.stringify(line)}\n`));
  }

  async request(method: DockerMethod, rawPath: string, body?: unknown): Promise<DockerResponse> {
    this.calls.push({ method, path: rawPath, body });
    const url = new URL(rawPath, "http://docker");
    const path = decodeURIComponent(url.pathname);
    const json = (status: number, b: unknown = null) => ({ status, body: b });
    let m = /^\/networks\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const n = this.networks.get(m[1] as string);
      if (!n) return json(404);
      return json(200, { ...n, IPAM: { Config: [{ Subnet: n.subnet }] } });
    }
    if (method === "GET" && path === "/networks") {
      return json(
        200,
        [...this.networks.values()].map((n) => ({ Name: n.Name, Labels: n.Labels })),
      );
    }
    if (method === "POST" && path === "/networks/create") {
      const b = body as { Name: string; Labels: Record<string, string>; Internal: boolean };
      this.networks.set(b.Name, {
        Id: `net${++this.seq}`,
        Name: b.Name,
        Labels: b.Labels,
        Internal: b.Internal,
        subnet: "172.30.0.0/24",
      });
      return json(201);
    }
    m = /^\/networks\/([^/]+)\/(connect|disconnect)$/.exec(path);
    if (method === "POST" && m && this.container) {
      const n = this.networks.get(m[1] as string);
      if (!n) return json(404);
      if (m[2] === "connect") {
        const aliases = (body as { EndpointConfig: { Aliases: string[] } }).EndpointConfig.Aliases;
        if (!aliases.includes("sandbox-egress")) return json(400);
        this.container.nets.set(n.Name, n.subnet.replace(/0\/24$/, "2"));
      } else this.container.nets.delete(n.Name);
      return json(200);
    }
    if (method === "GET" && path === `/containers/${egressNames(NS).container}/json`) {
      const c = this.container;
      if (!c) return json(404);
      return json(200, {
        Id: c.Id,
        Config: { Labels: c.Labels },
        State: { Running: c.Running },
        NetworkSettings: {
          Networks: Object.fromEntries([...c.nets.entries()].map(([name, ip]) => [name, { IPAddress: ip }])),
        },
      });
    }
    if (method === "POST" && path === "/containers/create") {
      const b = body as { Labels: Record<string, string>; HostConfig: { NetworkMode: string } };
      this.container = {
        Id: "egress1",
        Running: false,
        Labels: b.Labels,
        nets: new Map([[b.HostConfig.NetworkMode, "172.30.0.2"]]),
      };
      return json(201);
    }
    m = /^\/containers\/([^/]+)\/(start|kill|exec)$/.exec(path);
    if (method === "POST" && m && this.container) {
      if (m[2] === "start") {
        this.container.Running = true;
        this.policyFile = null;
        setImmediate(() => this.stderr("policy missing"));
        return json(204);
      }
      if (m[2] === "kill") {
        // The proxy reloads on SIGHUP: a file it can parse, none, or garbage.
        const sig = url.searchParams.get("signal");
        if (sig !== "HUP") return json(400);
        setImmediate(() => {
          if (this.policyFile === null) return this.stderr("policy missing");
          try {
            JSON.parse(this.policyFile);
            this.stderr("policy loaded");
          } catch {
            this.stderr("policy invalid");
          }
        });
        return json(204);
      }
      const b = body as { Cmd: string[]; User: string };
      const id = `exec${++this.seq}`;
      this.execs.set(id, { cmd: b.Cmd, user: b.User, stdin: Buffer.alloc(0), exit: null });
      return json(201, { Id: id });
    }
    m = /^\/exec\/([^/]+)\/json$/.exec(path);
    if (method === "GET" && m) {
      const e = this.execs.get(m[1] as string);
      return e ? json(200, { Running: e.exit === null, ExitCode: e.exit ?? 0 }) : json(404);
    }
    return json(404);
  }

  async hijack(path: string): Promise<Duplex> {
    this.calls.push({ method: "HIJACK", path });
    if (path.includes("/attach")) {
      const s = new PassThrough();
      this.attached.push(s);
      return s;
    }
    const id = /^\/exec\/([^/]+)\/start$/.exec(path)?.[1] as string;
    const exec = this.execs.get(id);
    const chunks: Buffer[] = [];
    const self = this;
    const duplex: Duplex = new Duplex({
      read() {},
      write(chunk: Buffer, _e, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        if (exec) {
          exec.stdin = Buffer.concat(chunks);
          const script = exec.cmd[2] ?? "";
          if (script.startsWith("rm -f")) self.policyFile = null;
          else self.policyFile = exec.stdin.toString();
          exec.exit = 0;
        }
        duplex.push(null);
        cb();
      },
    });
    if (exec?.cmd[2]?.startsWith("rm -f")) setImmediate(() => duplex.end());
    return duplex;
  }

  async stream(): Promise<never> {
    throw new Error("not used");
  }
}

function setup() {
  const docker = new EgressDocker();
  const sbxNet = networkSpec({ ns: NS, orgId: ORG, agentId: A });
  const brwNet = browserNetworkSpec({ ns: NS, orgId: ORG, agentId: A });
  const bSbx = networkSpec({ ns: NS, orgId: ORG2, agentId: B });
  docker.addBotNetwork(sbxNet.Name, sbxNet.Labels, "10.1.0.0/24");
  docker.addBotNetwork(brwNet.Name, brwNet.Labels, "10.2.0.0/24");
  docker.addBotNetwork(bSbx.Name, bSbx.Labels, "10.3.0.0/24");
  docker.addBotNetwork("control", {}, "10.9.0.0/24");
  const events: SandboxdEventInput[] = [];
  const egress = createEgress({
    docker,
    ns: NS,
    image: "egress:test",
    onEvent: (e) => events.push(e),
    reloadTimeoutMs: 500,
    retryMs: 10_000,
    registries: ["registry.test"],
  });
  return { docker, egress, events, sbxNet: sbxNet.Name, brwNet: brwNet.Name, bSbx: bSbx.Name };
}

const file = (d: EgressDocker) => JSON.parse(d.policyFile ?? "null");

describe("createEgress", () => {
  it("attaches the proxy under the alias sandbox-egress, writes the policy as root and sends HUP", async () => {
    const s = setup();
    await s.egress.setOrgPolicy(policy(ORG));
    await s.egress.attach({ orgId: ORG, agentId: A }, "sbx", s.sbxNet);
    await s.egress.attach({ orgId: ORG, agentId: A }, "brw", s.brwNet);
    const connects = s.docker.calls.filter((c) => c.path.endsWith("/connect"));
    expect(connects).toHaveLength(2);
    for (const c of connects) {
      expect(c.body).toMatchObject({ Container: "egress1", EndpointConfig: { Aliases: ["sandbox-egress"] } });
    }
    const writes = [...s.docker.execs.values()].filter((e) => e.cmd[2]?.startsWith("cat >"));
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((e) => e.user === "0")).toBe(true);
    expect(s.docker.calls.filter((c) => c.path.includes("signal=HUP")).length).toBeGreaterThan(0);
    const f = file(s.docker);
    expect(
      f.networks.map((n: { address: string; kind: string; mode: string }) => [n.address, n.kind, n.mode]),
    ).toEqual([
      ["10.1.0.2", "sbx", "allowlist"],
      ["10.2.0.2", "brw", "public"],
    ]);
    // Every bot network of the namespace is refused (B's too, though the proxy is not on it); never the control one.
    expect(f.botNetworks).toEqual(["10.1.0.0/24", "10.2.0.0/24", "10.3.0.0/24"]);
    expect(f.ownAddresses).toEqual(expect.arrayContaining(["10.1.0.2", "10.2.0.2", "172.30.0.2"]));
  });

  it("is never attached to a network that is not this bot's network of that kind", async () => {
    const s = setup();
    await expect(s.egress.attach({ orgId: ORG, agentId: A }, "sbx", "control")).rejects.toMatchObject({
      code: "label_mismatch",
    });
    await expect(s.egress.attach({ orgId: ORG, agentId: A }, "sbx", s.brwNet)).rejects.toMatchObject({
      code: "label_mismatch",
    });
    await expect(s.egress.attach({ orgId: ORG, agentId: B }, "sbx", s.bSbx)).rejects.toMatchObject({
      code: "label_mismatch",
    });
    expect(s.docker.calls.filter((c) => c.path.endsWith("/connect"))).toHaveLength(0);
    // The proxy itself starts on its outbound network only.
    const create = s.docker.calls.find((c) => c.path.startsWith("/containers/create"));
    expect(
      (create?.body as { HostConfig?: { NetworkMode?: string } } | undefined)?.HostConfig?.NetworkMode,
    ).toBe(egressNames(NS).network);
  });

  it("a kill or a new push rewrites the file; detaching a purged bot removes its entries", async () => {
    const s = setup();
    await s.egress.setOrgPolicy(policy(ORG));
    await s.egress.attach({ orgId: ORG, agentId: A }, "brw", s.brwNet);
    await s.egress.setOrgPolicy(policy(ORG, { killed: true, version: 2 }));
    expect(file(s.docker).networks[0].mode).toBe("off");
    // A stale push never undoes the kill.
    await s.egress.setOrgPolicy(policy(ORG, { version: 1 }));
    expect(file(s.docker).networks[0].mode).toBe("off");
    await s.egress.detachTarget({ orgId: ORG, agentId: A });
    expect(s.docker.calls.some((c) => c.path.endsWith("/disconnect"))).toBe(true);
    expect(s.egress.entries()).toEqual([]);
    expect(s.docker.policyFile).toBeNull(); // nothing left: no file, the proxy refuses everything
  });

  it("turns decision lines into egress events with the bot and kind, host only", async () => {
    const s = setup();
    await s.egress.setOrgPolicy(policy(ORG));
    await s.egress.attach({ orgId: ORG, agentId: A }, "brw", s.brwNet);
    s.docker.stdout({
      network: "10.2.0.2",
      host: "panel.fake.test",
      port: 8080,
      allowed: true,
      reason: "allowed",
    });
    s.docker.stdout({
      network: "10.9.9.9",
      host: "unknown.test",
      port: 443,
      allowed: false,
      reason: "unknown_network",
    });
    await new Promise((r) => setImmediate(r));
    expect(s.events).toEqual([
      {
        type: "egress",
        target: { orgId: ORG, agentId: A },
        kind: "brw",
        host: "panel.fake.test",
        allowed: true,
      },
    ]);
    s.egress.close();
  });

  it("attaches to a package run's own network with the registries-only policy and detaches from that one only", async () => {
    const s = setup();
    const RUN = "0199f0a0-3333-7000-8000-00000000000d";
    const run = packageRunNetworkSpec({ ns: NS, orgId: ORG, agentId: A, runId: RUN, kind: "installer" });
    s.docker.addBotNetwork(run.Name, run.Labels, "10.6.0.0/24");
    await s.egress.setOrgPolicy(policy(ORG, { sandboxEgress: "off" }));
    await s.egress.attach({ orgId: ORG, agentId: A }, "sbx", s.sbxNet);
    // The installer label must match the kind asked for.
    await expect(s.egress.attach({ orgId: ORG, agentId: A }, "review", run.Name)).rejects.toMatchObject({
      code: "label_mismatch",
    });
    await s.egress.attach({ orgId: ORG, agentId: A }, "installer", run.Name);
    const f = file(s.docker);
    const inst = f.networks.find((n: { kind: string }) => n.kind === "installer");
    expect(inst).toMatchObject({ mode: "allowlist", allowHosts: ["registry.test"] });
    expect(f.networks.find((n: { kind: string }) => n.kind === "sbx").mode).toBe("off");
    expect(f.botNetworks).toContain("10.6.0.0/24");
    await s.egress.detachNetwork(run.Name);
    expect(s.egress.entries().map((e) => e.kind)).toEqual(["sbx"]);
    expect(file(s.docker).networks.map((n: { kind: string }) => n.kind)).toEqual(["sbx"]);
    s.egress.close();
  });

  it("rebuilds its attachments from Docker after a restart, with every mode off until the API pushes", async () => {
    const s = setup();
    await s.egress.setOrgPolicy(policy(ORG));
    await s.egress.attach({ orgId: ORG, agentId: A }, "brw", s.brwNet);
    s.egress.close();
    const again = createEgress({ docker: s.docker, ns: NS, image: "egress:test", reloadTimeoutMs: 500 });
    await again.ensure();
    expect(again.entries()).toEqual([
      { network: s.brwNet, address: "10.2.0.2", target: { orgId: ORG, agentId: A }, kind: "brw" },
    ]);
    expect(file(s.docker).networks[0].mode).toBe("off");
    await again.setOrgPolicy(policy(ORG));
    expect(file(s.docker).networks[0].mode).toBe("public");
    again.close();
  });
});
