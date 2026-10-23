import { describe, expect, it } from "vitest";
import {
  agentKey,
  egressHosts,
  egressHostsCurrent,
  filesSpec,
  HARD_MAX,
  INSTALLER_LIMITS,
  installerSpec,
  labelsFor,
  nameFor,
  networkSpec,
  PACKAGES_DIR,
  packageRunNames,
  packageRunNetworkSpec,
  packagesVolumeSpec,
  reviewSpec,
  SHELL_ENV,
  type ShellSpecInput,
  STAGING_DIR,
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
  packagesVolume: "ocw-pkg-ocw-test-abc",
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

  it("mounts the workspace read-write and the packages volume read-only, and no bind, port, privilege or capability", () => {
    const spec = shellSpec(base);
    const hc = spec.HostConfig as Record<string, unknown>;
    expect(spec.HostConfig.Mounts).toEqual([
      { Type: "volume", Source: base.volume, Target: "/workspace", ReadOnly: false },
      { Type: "volume", Source: base.packagesVolume, Target: "/opt/ocw-packages", ReadOnly: true },
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

  it("sets exactly HOME, the package paths and the egress proxy (no OCW_ variable, no token, no secret)", () => {
    // 07.8-17: package bins come after the system paths; curl, pip and npm use the proxy by default (WINDOWS #253).
    expect(shellSpec(base).Env).toEqual([
      "HOME=/workspace",
      "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/ocw-packages/bin",
      "NODE_PATH=/opt/ocw-packages/node_modules",
      "PYTHONPATH=/opt/ocw-packages/python",
      "HTTP_PROXY=http://sandbox-egress:3128",
      "HTTPS_PROXY=http://sandbox-egress:3128",
      "http_proxy=http://sandbox-egress:3128",
      "https_proxy=http://sandbox-egress:3128",
      "NO_PROXY=localhost,127.0.0.1,::1",
      "no_proxy=localhost,127.0.0.1,::1",
    ]);
    expect(shellSpec(base).Env).toEqual([...SHELL_ENV]);
    for (const line of SHELL_ENV) expect(line).not.toMatch(/OCW_|TOKEN|SECRET|PASSWORD|@/i);
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
        packagesVolume: base.packagesVolume,
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

describe("the files helper keeps only the workspace (07.8-17)", () => {
  it("mounts no packages volume and joins no network", () => {
    const spec = filesSpec({
      ns: "ocw-test",
      orgId: ORG,
      agentId: AGENT,
      image: "img",
      runtime: "runc",
      volume: base.volume,
    });
    expect(spec.HostConfig.Mounts).toEqual([
      { Type: "volume", Source: base.volume, Target: "/workspace", ReadOnly: false },
    ]);
    expect(spec.HostConfig.NetworkMode).toBe("none");
  });
});

describe("sandbox package review and installer containers (07.8-17, D-03, D-11, P-12)", () => {
  const RUN = "0199f0a0-2222-7000-8000-00000000000c";
  const env = ["HTTP_PROXY=http://sandbox-egress:3128", "npm_config_registry=https://registry.npmjs.org/"];
  const runBase = {
    ns: "ocw-test",
    orgId: ORG,
    agentId: AGENT,
    runId: RUN,
    image: "ocw-sandbox-sbx:test",
    runtime: "runc" as const,
    network: "ocw-pnet-ocw-test-abc",
    env,
    lifetimeSeconds: 600,
  };

  it("names a run's network and container from its own run id", () => {
    const names = packageRunNames("ocw-test", RUN);
    expect(names.network).toBe(`ocw-pnet-ocw-test-${agentKey(RUN)}`);
    expect(names.container).toBe(`ocw-prun-ocw-test-${agentKey(RUN)}`);
    expect(packageRunNames("ocw-test", AGENT).network).not.toBe(names.network);
  });

  it("gives each run an internal network labelled with its kind and owner", () => {
    const net = packageRunNetworkSpec({
      ns: "ocw-test",
      orgId: ORG,
      agentId: AGENT,
      runId: RUN,
      kind: "installer",
    });
    expect(net.Internal).toBe(true);
    expect(net.Attachable).toBe(false);
    expect(net.Name).toBe(packageRunNames("ocw-test", RUN).network);
    expect(net.Labels).toEqual(labelsFor({ ns: "ocw-test", orgId: ORG, agentId: AGENT, kind: "installer" }));
  });

  it("names the bot's packages volume ocw-pkg-<ns>-<key> with the bot's labels", () => {
    const vol = packagesVolumeSpec({ ns: "ocw-test", orgId: ORG, agentId: AGENT });
    expect(vol.Name).toBe(nameFor("pkg", "ocw-test", AGENT));
    expect(vol.Labels).toEqual(labelsFor({ ns: "ocw-test", orgId: ORG, agentId: AGENT, kind: "sbx" }));
  });

  it("the installer has the shell's hardened profile, the packages volume read-write and a labelled scratch volume", () => {
    const spec = installerSpec({ ...runBase, packagesVolume: "ocw-pkg-ocw-test-abc" });
    expect(spec.User).toBe("10001:10001");
    expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
    expect(spec.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(spec.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(spec.HostConfig.Privileged).toBe(false);
    expect(spec.HostConfig.Init).toBe(true);
    expect(spec.HostConfig.AutoRemove).toBe(true);
    expect(spec.HostConfig.NetworkMode).toBe(runBase.network);
    expect(spec.HostConfig.NanoCpus).toBe(INSTALLER_LIMITS.nanoCpus);
    expect(spec.HostConfig.Memory).toBe(INSTALLER_LIMITS.memoryBytes);
    expect(spec.HostConfig.PidsLimit).toBe(INSTALLER_LIMITS.pids);
    const labels = labelsFor({ ns: "ocw-test", orgId: ORG, agentId: AGENT, kind: "installer" });
    expect(spec.Labels).toEqual(labels);
    expect(spec.HostConfig.Mounts).toEqual([
      { Type: "volume", Source: "ocw-pkg-ocw-test-abc", Target: PACKAGES_DIR, ReadOnly: false },
      { Type: "volume", Target: STAGING_DIR, ReadOnly: false, VolumeOptions: { Labels: labels } },
    ]);
    expect(spec.Env).toEqual(["HOME=/staging/home", ...env]);
    expect(spec.Cmd).toEqual(["sleep", "600"]);
    const hc = spec.HostConfig as Record<string, unknown>;
    expect(hc.Binds).toBeUndefined();
    expect(hc.CapAdd).toBeUndefined();
    expect(hc.PortBindings).toBeUndefined();
  });

  it("the installer for a removal joins no network", () => {
    const spec = installerSpec({ ...runBase, network: "none", packagesVolume: "ocw-pkg-ocw-test-abc" });
    expect(spec.HostConfig.NetworkMode).toBe("none");
  });

  it("the review container mounts nothing persistent: only its own scratch volume", () => {
    const spec = reviewSpec(runBase);
    const labels = labelsFor({ ns: "ocw-test", orgId: ORG, agentId: AGENT, kind: "review" });
    expect(spec.Labels).toEqual(labels);
    expect(spec.HostConfig.Mounts).toEqual([
      { Type: "volume", Target: STAGING_DIR, ReadOnly: false, VolumeOptions: { Labels: labels } },
    ]);
    expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
    expect(spec.HostConfig.AutoRemove).toBe(true);
    expect(JSON.stringify(spec)).not.toContain('/workspace","ReadOnly');
    expect(JSON.stringify(spec)).not.toContain(PACKAGES_DIR);
  });

  it("never copies a caller's extra key into a run spec", () => {
    const hostile = { ...runBase, Privileged: true, Binds: ["/:/host"], HostConfig: { Privileged: true } };
    expect(reviewSpec(hostile as typeof runBase)).toEqual(reviewSpec(runBase));
  });
});

describe("the proxy's address in /etc/hosts (07.8 gVisor DNS fix)", () => {
  // runsc does not answer Docker's embedded DNS (127.0.0.11) on the internal bot networks, so the alias
  // `sandbox-egress` in HTTP(S)_PROXY and Chromium's proxy flag only resolves through an /etc/hosts entry.
  const runBase = {
    ns: "ocw-test",
    orgId: ORG,
    agentId: AGENT,
    runId: "0199f0a0-2222-7000-8000-00000000000c",
    image: "ocw-sandbox-sbx:test",
    runtime: "runsc" as const,
    network: "ocw-pnet-ocw-test-abc",
    env: [],
    lifetimeSeconds: 600,
  };

  it("names the proxy by its address on the bot network, as one ExtraHosts entry", () => {
    expect(egressHosts("10.1.0.2")).toEqual(["sandbox-egress:10.1.0.2"]);
    expect(egressHosts(null)).toEqual([]);
    expect(shellSpec({ ...base, egressAddress: "10.1.0.2" }).HostConfig.ExtraHosts).toEqual([
      "sandbox-egress:10.1.0.2",
    ]);
    expect(
      installerSpec({ ...runBase, packagesVolume: "p", egressAddress: "10.6.0.2" }).HostConfig.ExtraHosts,
    ).toEqual(["sandbox-egress:10.6.0.2"]);
    expect(reviewSpec({ ...runBase, egressAddress: "10.6.0.3" }).HostConfig.ExtraHosts).toEqual([
      "sandbox-egress:10.6.0.3",
    ]);
  });

  it("adds no entry without a proxy, and never one to the network-none files helper", () => {
    expect(shellSpec(base).HostConfig.ExtraHosts).toEqual([]);
    expect(reviewSpec({ ...runBase, network: "none" }).HostConfig.ExtraHosts).toEqual([]);
    const files = filesSpec({
      ns: "ocw-test",
      orgId: ORG,
      agentId: AGENT,
      image: "i",
      runtime: "runc",
      volume: "v",
    });
    expect(files.HostConfig.ExtraHosts).toEqual([]);
  });

  it("refuses anything but an IPv4 address (no host name, no second entry, no option smuggled in)", () => {
    for (const bad of ["sandbox-egress", "10.1.0.2 evil", "10.1.0.2\n1.2.3.4 x", "::1", "10.1.0.256", ""]) {
      expect(() => egressHosts(bad)).toThrow(/address/);
      expect(() => shellSpec({ ...base, egressAddress: bad })).toThrow(/address/);
    }
  });

  it("tells a container's entry is current only when it names exactly the proxy's address now", () => {
    expect(egressHostsCurrent(["sandbox-egress:10.1.0.2"], "10.1.0.2")).toBe(true);
    expect(egressHostsCurrent(["sandbox-egress:10.1.0.9"], "10.1.0.2")).toBe(false);
    expect(egressHostsCurrent(null, "10.1.0.2")).toBe(false); // created before this fix
    expect(egressHostsCurrent(undefined, "10.1.0.2")).toBe(false);
    expect(egressHostsCurrent(["sandbox-egress:10.1.0.2", "x:1.2.3.4"], "10.1.0.2")).toBe(false);
    expect(egressHostsCurrent(null, null)).toBe(true);
    expect(egressHostsCurrent([], null)).toBe(true);
  });
});
