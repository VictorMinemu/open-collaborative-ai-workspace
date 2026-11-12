import { describe, expect, it } from "vitest";
import type { Egress } from "./egress-attach";
import { createSandboxes } from "./sandboxes";
import { nameFor } from "./spec";
import { FakeDocker } from "./testing/fake-docker";
import { testPolicy } from "./testing/policy";

/**
 * Existing bots pick up a new `sbx` image (07.17.1.1.1, D-10, PD-10). Compose rebuilds the same tag, so a bot's shell
 * keeps the image ID it was created from: on `ensure`, a **stopped** shell whose image ID differs from the one the tag
 * now names is removed (the container only: its workspace and packages volumes stay) and created again from the current
 * spec. A running shell is never touched by `ensure` (no command is cut); it converges at its next start or `restart`.
 * An image Docker cannot inspect is "unknown": nothing is re-created and one warn line with ids only is written.
 */

const ORG = "0199f0a0-0000-7000-8000-00000000000a";
const AGENT = "0199f0a0-1111-7000-8000-00000000000b";
const NS = "ocw-unit";
const IMAGE = "sbx:test";
const target = { orgId: ORG, agentId: AGENT };

type Line = { level: string; msg: string; [k: string]: unknown };

function setup(opts: { egress?: boolean } = {}) {
  const docker = new FakeDocker("29.6.2", ["runc", "runsc"]);
  docker.images.set(IMAGE, "sha256:old");
  const proxy = { address: "10.1.0.2" };
  const egress: Egress = {
    ensure: async () => undefined,
    attach: async () => proxy.address,
    detachTarget: async () => undefined,
    detachNetwork: async () => undefined,
    setOrgPolicy: async () => undefined,
    entries: () => [],
    close: () => undefined,
  };
  const lines: Line[] = [];
  const sandboxes = createSandboxes({
    docker,
    ns: NS,
    runtime: "auto",
    image: IMAGE,
    egress: opts.egress === false ? null : egress,
    log: (line) => lines.push(line),
  });
  sandboxes.setPolicy(testPolicy(ORG));
  const name = nameFor("sbx", NS, AGENT);
  const sbx = () => docker.container(name);
  const inspect = async () =>
    (await docker.request("GET", `/containers/${encodeURIComponent(name)}/json`)).body as {
      Id: string;
      Image?: string;
      Config: { Image?: string; Env?: string[] };
    };
  /** Calls made after `mark()`, so each case looks only at what the drift step did. */
  let from = 0;
  const mark = () => {
    from = docker.calls.length;
    lines.length = 0;
  };
  const since = () => docker.calls.slice(from);
  const deletes = () => since().filter((c) => c.method === "DELETE");
  const creates = () => since().filter((c) => c.method === "POST" && c.path.startsWith("/containers/create"));
  const starts = () =>
    since().filter((c) => c.method === "POST" && /\/containers\/[^/]+\/start$/.test(c.path));
  const imageCalls = () => since().filter((c) => c.path.startsWith("/images/"));
  const volumeCalls = () => since().filter((c) => c.path.startsWith("/volumes/") && c.method !== "GET");
  const ensureLine = () => lines.find((l) => l.msg === "ensure");
  return {
    docker,
    sandboxes,
    proxy,
    lines,
    sbx,
    inspect,
    mark,
    since,
    deletes,
    creates,
    starts,
    imageCalls,
    volumeCalls,
    ensureLine,
  };
}

const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);

describe("ensure re-creates a stopped shell built from an older image (07.17.1.1.1 D-10)", () => {
  it("removes the container only, creates it from the current image and starts it; the volumes are the same objects", async () => {
    const s = setup();
    await expect(s.sandboxes.ensure(target)).resolves.toMatchObject({ state: "running" });
    const c1 = s.sbx()?.Id as string;
    expect((await s.inspect()).Image).toBe("sha256:old");
    await s.sandboxes.stop({ target, reason: "idle" });
    const volumesBefore = [...s.docker.volumes.values()];
    expect(volumesBefore).toHaveLength(2);
    s.docker.images.set(IMAGE, "sha256:new");

    s.mark();
    await expect(s.sandboxes.ensure(target)).resolves.toMatchObject({ state: "running" });
    // The container only: one DELETE, never with v=1, and no volume created or removed.
    expect(s.deletes().map((c) => c.path)).toEqual([`/containers/${encodeURIComponent(c1)}?force=1`]);
    expect(s.creates()).toHaveLength(1);
    expect(s.starts()).toHaveLength(1);
    expect(s.volumeCalls()).toEqual([]);
    const after = await s.inspect();
    expect(after.Id).not.toBe(c1);
    expect(after.Image).toBe("sha256:new");
    expect(after.Config.Image).toBe(IMAGE);
    const volumesAfter = [...s.docker.volumes.values()];
    expect(volumesAfter).toHaveLength(2);
    volumesAfter.forEach((v, i) => expect(v).toBe(volumesBefore[i]));
    expect(s.sbx()?.Running).toBe(true);
    expect(s.ensureLine()).toMatchObject({ created: true, started: true, recreated: "image" });
  });

  it("starts a stopped shell whose image is current in place", async () => {
    const s = setup();
    await s.sandboxes.ensure(target);
    const c1 = s.sbx()?.Id;
    await s.sandboxes.stop({ target, reason: "idle" });
    s.mark();
    await s.sandboxes.ensure(target);
    expect(s.sbx()?.Id).toBe(c1);
    expect(s.sbx()?.Running).toBe(true);
    expect(s.deletes()).toEqual([]);
    expect(s.creates()).toEqual([]);
    expect(s.ensureLine()).toMatchObject({ created: false, started: true, recreated: null });
  });

  it("never touches a running shell, whatever its image, and does not even inspect the image", async () => {
    const s = setup();
    await s.sandboxes.ensure(target);
    const c1 = s.sbx()?.Id;
    s.docker.images.set(IMAGE, "sha256:new");
    s.mark();
    await expect(s.sandboxes.ensure(target)).resolves.toMatchObject({ state: "running" });
    expect(s.sbx()?.Id).toBe(c1);
    expect(s.deletes()).toEqual([]);
    expect(s.creates()).toEqual([]);
    expect(s.since().some((c) => /\/(stop|kill|restart)/.test(c.path))).toBe(false);
    expect(s.imageCalls()).toEqual([]);
    expect(s.ensureLine()).toMatchObject({ created: false, started: false, recreated: null });
  });

  it("an image Docker cannot inspect is unknown: the shell starts in place and one warn line with ids only is written", async () => {
    const s = setup();
    await s.sandboxes.ensure(target);
    const c1 = s.sbx()?.Id;
    await s.sandboxes.stop({ target, reason: "idle" });
    s.docker.images.delete(IMAGE);
    s.mark();
    await expect(s.sandboxes.ensure(target)).resolves.toMatchObject({ state: "running" });
    expect(s.sbx()?.Id).toBe(c1);
    expect(s.deletes()).toEqual([]);
    expect(s.creates()).toEqual([]);
    const warns = s.lines.filter((l) => l.level === "warn");
    expect(warns).toEqual([{ level: "warn", msg: "image_unknown", orgId: ORG, agentId: AGENT }]);
    expect(s.ensureLine()).toMatchObject({ recreated: null });
  });

  it("a container that reports no image is unknown too: started in place, one warn line", async () => {
    const s = setup();
    await s.sandboxes.ensure(target);
    const c1 = s.sbx()?.Id;
    await s.sandboxes.stop({ target, reason: "idle" });
    const obj = s.sbx() as { ImageId?: string };
    delete obj.ImageId;
    s.docker.images.set(IMAGE, "sha256:new");
    s.mark();
    await s.sandboxes.ensure(target);
    expect(s.sbx()?.Id).toBe(c1);
    expect(s.deletes()).toEqual([]);
    expect(s.lines.filter((l) => l.level === "warn")).toEqual([
      { level: "warn", msg: "image_unknown", orgId: ORG, agentId: AGENT },
    ]);
  });

  it("works without an egress proxy as well", async () => {
    const s = setup({ egress: false });
    await s.sandboxes.ensure(target);
    const c1 = s.sbx()?.Id as string;
    await s.sandboxes.stop({ target, reason: "idle" });
    s.docker.images.set(IMAGE, "sha256:new");
    s.mark();
    await s.sandboxes.ensure(target);
    expect(s.deletes().map((c) => c.path)).toEqual([`/containers/${encodeURIComponent(c1)}?force=1`]);
    expect((await s.inspect()).Image).toBe("sha256:new");
    expect(s.ensureLine()).toMatchObject({ recreated: "image" });
  });

  it("a killed organization is refused exactly as before and nothing is removed, even with a drifted image", async () => {
    const s = setup();
    await s.sandboxes.ensure(target);
    await s.sandboxes.stop({ target, reason: "idle" });
    s.docker.images.set(IMAGE, "sha256:new");
    s.sandboxes.setPolicy(testPolicy(ORG, { killed: true, version: 2 }));
    s.mark();
    expect(await refusal(s.sandboxes.ensure(target))).toMatchObject({ code: "killed", status: 409 });
    expect(s.deletes()).toEqual([]);
    expect(s.creates()).toEqual([]);
  });

  it("a workspace over its quota is refused `disk_full` and nothing is removed, even with a drifted image", async () => {
    const s = setup();
    await s.sandboxes.ensure(target);
    await s.sandboxes.stop({ target, reason: "idle" });
    await s.sandboxes.markDiskFull(target);
    s.docker.images.set(IMAGE, "sha256:new");
    s.mark();
    expect(await refusal(s.sandboxes.ensure(target))).toMatchObject({ code: "disk_full", status: 409 });
    expect(s.deletes()).toEqual([]);
    expect(s.creates()).toEqual([]);
  });
});
