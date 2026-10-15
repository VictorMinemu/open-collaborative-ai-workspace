import { describe, expect, it } from "vitest";
import {
  agentKey,
  HARD_MAX,
  labelsFor,
  nameFor,
  networkSpec,
  type ShellSpecInput,
  shellSpec,
  volumeSpec,
} from "./spec";

const ORG = "0199f0a0-0000-7000-8000-00000000000a";
const AGENT = "0199f0a0-1111-7000-8000-00000000000b";

const base: ShellSpecInput = {
  ns: "ocw-test",
  orgId: ORG,
  agentId: AGENT,
  image: "ocw-sandbox-sbx:test",
  runtime: "runc",
  network: "ocw-net-ocw-test-abc",
  volume: "ocw-ws-ocw-test-abc",
  limits: { nanoCpus: 1_000_000_000, memoryBytes: 1024 ** 3, pids: 256 },
};

describe("shellSpec (D-01, D-11 hardened profile)", () => {
  it("runs as 10001 with a read-only root, no capabilities, no new privileges and an init", () => {
    const spec = shellSpec(base);
    expect(spec.User).toBe("10001:10001");
    expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
    expect(spec.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(spec.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(spec.HostConfig.Init).toBe(true);
    expect(spec.HostConfig.Runtime).toBe("runc");
  });

  it("limits memory with swap equal to memory, and sets pids and CPU", () => {
    const spec = shellSpec(base);
    expect(spec.HostConfig.Memory).toBe(1024 ** 3);
    expect(spec.HostConfig.MemorySwap).toBe(spec.HostConfig.Memory);
    expect(spec.HostConfig.PidsLimit).toBe(256);
    expect(spec.HostConfig.NanoCpus).toBe(1_000_000_000);
  });

  it("mounts /tmp as a noexec, nosuid, nodev tmpfs", () => {
    const tmp = shellSpec(base).HostConfig.Tmpfs["/tmp"];
    expect(tmp.split(",")).toEqual(expect.arrayContaining(["noexec", "nosuid", "nodev"]));
  });

  it("has exactly one volume mount at /workspace and no bind, port, privilege or capability", () => {
    const spec = shellSpec(base);
    const hc = spec.HostConfig as Record<string, unknown>;
    expect(spec.HostConfig.Mounts).toEqual([
      { Type: "volume", Source: base.volume, Target: "/workspace", ReadOnly: false },
    ]);
    expect(hc.Binds).toBeUndefined();
    expect(hc.Privileged === undefined || hc.Privileged === false).toBe(true);
    expect(hc.CapAdd).toBeUndefined();
    expect(hc.PortBindings).toBeUndefined();
    expect(hc.Devices).toBeUndefined();
    expect(hc.PublishAllPorts === undefined || hc.PublishAllPorts === false).toBe(true);
    expect((spec as Record<string, unknown>).ExposedPorts).toBeUndefined();
  });

  it("joins only the bot's own network and carries the five labels", () => {
    const spec = shellSpec(base);
    expect(spec.HostConfig.NetworkMode).toBe(base.network);
    expect(spec.Labels).toEqual({
      "ocw.sandbox": "1",
      "ocw.namespace": "ocw-test",
      "ocw.org": ORG,
      "ocw.agent": AGENT,
      "ocw.kind": "sbx",
    });
  });

  it("sets no environment beyond HOME (no OCW_ variable, no token)", () => {
    expect(shellSpec(base).Env).toEqual(["HOME=/workspace"]);
  });

  it("clamps limits over HARD_MAX and nonsense values to a safe range", () => {
    const wide = shellSpec({
      ...base,
      limits: { nanoCpus: 64e9, memoryBytes: 512 * 1024 ** 3, pids: 1_000_000 },
    });
    expect(wide.HostConfig.NanoCpus).toBe(HARD_MAX.nanoCpus);
    expect(wide.HostConfig.Memory).toBe(HARD_MAX.memoryBytes);
    expect(wide.HostConfig.MemorySwap).toBe(HARD_MAX.memoryBytes);
    expect(wide.HostConfig.PidsLimit).toBe(HARD_MAX.pids);

    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const spec = shellSpec({ ...base, limits: { nanoCpus: bad, memoryBytes: bad, pids: bad } });
      // Docker reads 0 or -1 as "unlimited"; a clamped spec is always bounded and positive.
      expect(spec.HostConfig.NanoCpus).toBeGreaterThan(0);
      expect(spec.HostConfig.NanoCpus).toBeLessThanOrEqual(HARD_MAX.nanoCpus);
      expect(spec.HostConfig.Memory).toBeGreaterThan(0);
      expect(spec.HostConfig.Memory).toBeLessThanOrEqual(HARD_MAX.memoryBytes);
      expect(spec.HostConfig.PidsLimit).toBeGreaterThan(0);
      expect(spec.HostConfig.PidsLimit).toBeLessThanOrEqual(HARD_MAX.pids);
    }
  });

  it("never copies a caller's extra key into the spec (hostile inputs)", () => {
    const hostile: Record<string, unknown>[] = [
      { privileged: true },
      { Privileged: true },
      { binds: ["/:/host"] },
      { Binds: ["/var/run/docker.sock:/var/run/docker.sock"] },
      { HostConfig: { Privileged: true, Binds: ["/:/host"], CapAdd: ["SYS_ADMIN"] } },
      { capAdd: ["SYS_ADMIN"], CapAdd: ["NET_ADMIN"] },
      { env: ["OCW_SANDBOX_TOKEN=leak"], Env: ["OCW_SANDBOX_TOKEN=leak"] },
      { user: "0:0", User: "root" },
      { labels: { "ocw.org": "other" }, Labels: { "ocw.sandbox": "0" } },
      {
        portBindings: { "22/tcp": [{ HostPort: "2222" }] },
        PortBindings: {},
        ExposedPorts: { "22/tcp": {} },
      },
      { networkMode: "host", pidMode: "host", ipcMode: "host", NetworkMode: "host", PidMode: "host" },
      {
        devices: [{ PathOnHost: "/dev/kvm" }],
        securityOpt: ["seccomp=unconfined"],
        SecurityOpt: ["apparmor=unconfined"],
      },
      { mounts: [{ Type: "bind", Source: "/", Target: "/host" }], Mounts: [{ Type: "bind", Source: "/" }] },
      { limits: { nanoCpus: 1e9, memoryBytes: 1024 ** 3, pids: 256, privileged: true } },
      { readonlyRootfs: false, ReadonlyRootfs: false, init: false, runtime: "io.containerd.runc.v2" },
    ];
    const clean = shellSpec(base);
    for (const extra of hostile) {
      const input = {
        ...base,
        ...extra,
        limits: { ...base.limits, ...(extra.limits as object | undefined) },
      };
      // The named parameters the builder reads are reset to the valid ones; everything else is the hostile payload.
      const spec = shellSpec({
        ...input,
        ns: base.ns,
        orgId: base.orgId,
        agentId: base.agentId,
        image: base.image,
        runtime: base.runtime,
        network: base.network,
        volume: base.volume,
      } as ShellSpecInput);
      expect(spec).toEqual(clean);
    }
  });
});

describe("names and the other objects", () => {
  it("names objects ocw-<kind>-<ns>-<12 hex of sha256(agentId)>", () => {
    expect(nameFor("sbx", "ocw-test", AGENT)).toBe(`ocw-sbx-ocw-test-${agentKey(AGENT)}`);
    expect(agentKey(AGENT)).toMatch(/^[0-9a-f]{12}$/);
    expect(nameFor("sbx", "ocw-test", AGENT)).toBe(nameFor("sbx", "ocw-test", AGENT));
  });

  it("gives two UUIDv7 bots created in the same minute different names", () => {
    // Same 48-bit timestamp prefix, different random tails.
    const a = "0199f0a0-1111-7000-8000-000000000001";
    const b = "0199f0a0-1111-7000-8000-000000000002";
    expect(nameFor("sbx", "ns", a)).not.toBe(nameFor("sbx", "ns", b));
  });

  it("builds an internal, labelled network and a labelled volume", () => {
    const net = networkSpec({ ns: "ocw-test", orgId: ORG, agentId: AGENT });
    expect(net.Internal).toBe(true);
    expect(net.Name).toBe(nameFor("net", "ocw-test", AGENT));
    expect(net.Labels).toEqual(labelsFor({ ns: "ocw-test", orgId: ORG, agentId: AGENT, kind: "sbx" }));
    const vol = volumeSpec({ ns: "ocw-test", orgId: ORG, agentId: AGENT });
    expect(vol.Name).toBe(nameFor("ws", "ocw-test", AGENT));
    expect(vol.Labels["ocw.agent"]).toBe(AGENT);
  });
});
