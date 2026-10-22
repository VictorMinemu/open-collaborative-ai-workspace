import { describe, expect, it } from "vitest";
import type { Egress } from "./egress-attach";
import { createSandboxes } from "./sandboxes";
import { nameFor } from "./spec";
import { FakeDocker } from "./testing/fake-docker";
import { testPolicy } from "./testing/policy";

/**
 * The proxy's address in a shell's /etc/hosts (07.8 gVisor DNS fix). runsc does not answer Docker's embedded DNS
 * (127.0.0.11) on the internal bot networks, so `sbx` reaches `sandbox-egress` only through an `ExtraHosts` entry with
 * the proxy's address on the bot's network, read from Docker at each attach. A restarted proxy gets a new address: a
 * stopped shell whose entry is stale is removed and created again on its next start (its workspace and packages are
 * volumes, its root is read-only), and a restart asked for by a person does the same.
 */

const ORG = "0199f0a0-0000-7000-8000-00000000000a";
const AGENT = "0199f0a0-1111-7000-8000-00000000000b";
const NS = "ocw-unit";
const target = { orgId: ORG, agentId: AGENT };

function setup() {
  const docker = new FakeDocker("29.6.2", ["runc", "runsc"]);
  const proxy = { address: "10.1.0.2" };
  const attached: Array<{ kind: string; network: string }> = [];
  const egress: Egress = {
    ensure: async () => undefined,
    attach: async (_t, kind, network) => {
      attached.push({ kind, network });
      return proxy.address;
    },
    detachTarget: async () => undefined,
    detachNetwork: async () => undefined,
    setOrgPolicy: async () => undefined,
    entries: () => [],
    close: () => undefined,
  };
  const sandboxes = createSandboxes({ docker, ns: NS, runtime: "auto", image: "sbx:test", egress });
  sandboxes.setPolicy(testPolicy(ORG));
  const name = nameFor("sbx", NS, AGENT);
  const sbx = () => docker.container(name);
  const hosts = () =>
    (sbx()?.Spec as { HostConfig?: { ExtraHosts?: string[] } } | undefined)?.HostConfig?.ExtraHosts;
  return { docker, sandboxes, proxy, attached, sbx, hosts };
}

describe("sbx names the egress proxy by its address (gVisor DNS)", () => {
  it("creates the shell with the proxy's address on its network as the only ExtraHosts entry", async () => {
    const s = setup();
    await s.sandboxes.ensure(target);
    expect(s.attached).toEqual([{ kind: "sbx", network: nameFor("net", NS, AGENT) }]);
    expect(s.hosts()).toEqual(["sandbox-egress:10.1.0.2"]);
    expect((s.sbx()?.Spec as { HostConfig?: { Runtime?: string } } | undefined)?.HostConfig?.Runtime).toBe(
      "runsc",
    );
  });

  it("starts a stopped shell with a current entry as it is", async () => {
    const s = setup();
    await s.sandboxes.ensure(target);
    const id = s.sbx()?.Id;
    await s.sandboxes.stop({ target, reason: "idle" });
    await s.sandboxes.ensure(target);
    expect(s.sbx()?.Id).toBe(id);
    expect(s.sbx()?.Running).toBe(true);
    expect(s.docker.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("recreates a stopped shell whose entry is stale (the proxy restarted), keeping its volumes", async () => {
    const s = setup();
    await s.sandboxes.ensure(target);
    const id = s.sbx()?.Id as string;
    await s.sandboxes.stop({ target, reason: "idle" });
    s.proxy.address = "10.1.0.5";
    await expect(s.sandboxes.ensure(target)).resolves.toMatchObject({ state: "running" });
    expect(s.sbx()?.Id).not.toBe(id);
    expect(s.hosts()).toEqual(["sandbox-egress:10.1.0.5"]);
    const deletes = s.docker.calls.filter((c) => c.method === "DELETE");
    // The container only: never a volume or a network, and never with v=1.
    expect(deletes.map((c) => c.path)).toEqual([`/containers/${encodeURIComponent(id)}?force=1`]);
    expect(s.docker.volumes.size).toBe(2);
  });

  it("recreates a shell created before this fix (no entry) on its next start", async () => {
    const s = setup();
    await s.sandboxes.ensure(target);
    await s.sandboxes.stop({ target, reason: "idle" });
    const spec = s.sbx()?.Spec as { HostConfig: Record<string, unknown> };
    delete spec.HostConfig.ExtraHosts;
    await s.sandboxes.ensure(target);
    expect(s.hosts()).toEqual(["sandbox-egress:10.1.0.2"]);
  });

  it("leaves a running shell alone on ensure, even with a stale entry (it is fixed at its next start)", async () => {
    const s = setup();
    await s.sandboxes.ensure(target);
    const id = s.sbx()?.Id;
    s.proxy.address = "10.1.0.5";
    await s.sandboxes.ensure(target);
    expect(s.sbx()?.Id).toBe(id);
    expect(s.hosts()).toEqual(["sandbox-egress:10.1.0.2"]);
  });

  it("a restart with a stale entry recreates the shell with the current address; a current one restarts in place", async () => {
    const s = setup();
    await s.sandboxes.ensure(target);
    const id = s.sbx()?.Id;
    await s.sandboxes.restart(target);
    expect(s.sbx()?.Id).toBe(id);
    s.proxy.address = "10.1.0.5";
    await expect(s.sandboxes.restart(target)).resolves.toMatchObject({ state: "running" });
    expect(s.sbx()?.Id).not.toBe(id);
    expect(s.hosts()).toEqual(["sandbox-egress:10.1.0.5"]);
    expect(s.sbx()?.Running).toBe(true);
  });

  it("without an egress proxy the shell gets no entry and is never recreated for it", async () => {
    const docker = new FakeDocker();
    const sandboxes = createSandboxes({ docker, ns: NS, runtime: "auto", image: "sbx:test" });
    sandboxes.setPolicy(testPolicy(ORG));
    await sandboxes.ensure(target);
    const c = docker.container(nameFor("sbx", NS, AGENT));
    expect(
      (c?.Spec as { HostConfig?: { ExtraHosts?: string[] } } | undefined)?.HostConfig?.ExtraHosts,
    ).toEqual([]);
    await sandboxes.stop({ target, reason: "idle" });
    await sandboxes.ensure(target);
    expect(docker.container(nameFor("sbx", NS, AGENT))?.Id).toBe(c?.Id);
  });
});
