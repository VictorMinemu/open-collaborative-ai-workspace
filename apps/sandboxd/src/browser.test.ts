import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { decodeFrameHeader, FRAME_TYPES, SANDBOXD_LABELS, SandboxdFrameControl } from "@ocw/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { AgentError, type AgentLink, AgentOutputReader, type AgentReady, linkOverStream } from "./agent-link";
import {
  agentFailure,
  BROWSER_HOLD_MS,
  BROWSER_IDLE_MS,
  createBrowsers,
  type FrameWritable,
  frameWriter,
  postureAllowed,
  resizeMode,
} from "./browser";
import type { Egress } from "./egress-attach";
import { createFiles } from "./files";
import { createQuota } from "./quota";
import { createSandboxes, ownContainerId, ownLabelRefusal, type SandboxdEventInput } from "./sandboxes";
import { createServer, type LogLine } from "./server";
import {
  BRW_SHM_BYTES,
  browserNetworkSpec,
  brwSpec,
  egressNames,
  egressNetworkSpec,
  egressSpec,
  labelsFor,
  nameFor,
} from "./spec";
import { FakeDocker } from "./testing/fake-docker";
import { testPolicy } from "./testing/policy";

const ORG = "0199f0a0-0000-7000-8000-00000000000a";
const AGENT = "0199f0a0-1111-7000-8000-00000000000b";
const OTHER = "0199f0a0-1111-7000-8000-0000000000cc";
const CTX = "0199f0a0-2222-7000-8000-00000000000c";
const NS = "ocw-unit";
const target = { orgId: ORG, agentId: AGENT };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

// ---------------------------------------------------------------- specs (D-01, D-05, D-11, D-14)

describe("brwSpec", () => {
  const base = {
    ns: "ocw-test",
    orgId: ORG,
    agentId: AGENT,
    image: "ocw-sandbox-brw:test",
    runtime: "runc" as const,
    network: "ocw-bnet-ocw-test-abc",
    limits: { nanoCpus: 1_000_000_000, memoryBytes: 2 * 1024 ** 3, pids: 512 },
    chromiumSandbox: true,
    seccompProfile: '{"defaultAction":"SCMP_ACT_ERRNO"}',
  };

  it("is the hardened profile with 512 MiB of shm, a tmpfs /tmp, no volume, no port and stdin kept open", () => {
    const spec = brwSpec(base);
    expect(spec.User).toBe("10001:10001");
    expect(spec.HostConfig.ShmSize).toBe(BRW_SHM_BYTES);
    expect(BRW_SHM_BYTES).toBe(512 * 1024 * 1024);
    expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
    expect(spec.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(spec.HostConfig.Privileged).toBe(false);
    expect(spec.HostConfig.Init).toBe(true);
    expect(spec.HostConfig.IpcMode).toBe("private");
    expect(spec.HostConfig.Mounts).toEqual([]);
    expect(spec.HostConfig.PublishAllPorts).toBe(false);
    expect(spec.HostConfig.NetworkMode).toBe(base.network);
    expect(spec.HostConfig.Tmpfs["/tmp"]).toContain("noexec");
    expect(JSON.stringify(spec)).not.toMatch(/PortBindings|ExposedPorts|Binds|remote-debugging-port/);
    expect(spec.OpenStdin).toBe(true);
    expect(spec.StdinOnce).toBe(false);
    expect(spec.Tty).toBe(false);
    expect(spec.Labels).toEqual(labelsFor({ ns: "ocw-test", orgId: ORG, agentId: AGENT, kind: "brw" }));
  });

  it("points Chromium at the proxy, passes the runtime and sends the seccomp profile inline", () => {
    const spec = brwSpec(base);
    expect(spec.Env).toEqual(
      expect.arrayContaining([
        "OCW_BROWSER_PROXY=http://sandbox-egress:3128",
        "OCW_BROWSER_CHROMIUM_SANDBOX=on",
        "OCW_BROWSER_RUNTIME=runc",
      ]),
    );
    expect(spec.HostConfig.SecurityOpt).toEqual([
      "no-new-privileges:true",
      'seccomp={"defaultAction":"SCMP_ACT_ERRNO"}',
    ]);
    expect(brwSpec({ ...base, seccompProfile: null }).HostConfig.SecurityOpt).toEqual([
      "no-new-privileges:true",
    ]);
  });

  it("D-14: refuses Chromium without its sandbox under runsc, never a silent fallback", () => {
    expect(() => brwSpec({ ...base, runtime: "runsc", chromiumSandbox: false })).toThrow(/runsc/);
    expect(brwSpec({ ...base, runtime: "runsc" }).Env).toContain("OCW_BROWSER_RUNTIME=runsc");
  });

  it("copies no caller field", () => {
    const smuggled = { ...base, HostConfig: { Privileged: true }, Env: ["X=1"], Binds: ["/:/host"] };
    expect(brwSpec(smuggled)).toEqual(brwSpec(base));
  });

  it("names the proxy by its address in /etc/hosts (runsc answers no Docker DNS on the bot network)", () => {
    expect(brwSpec({ ...base, egressAddress: "10.2.0.2" }).HostConfig.ExtraHosts).toEqual([
      "sandbox-egress:10.2.0.2",
    ]);
    expect(brwSpec(base).HostConfig.ExtraHosts).toEqual([]);
    expect(() => brwSpec({ ...base, egressAddress: "10.2.0.2 evil" })).toThrow(/address/);
  });
});

describe("browserNetworkSpec and the egress specs", () => {
  it("gives the browser its own internal network labelled brw", () => {
    const n = browserNetworkSpec({ ns: NS, orgId: ORG, agentId: AGENT });
    expect(n.Name).toBe(nameFor("bnet", NS, AGENT));
    expect(n.Internal).toBe(true);
    expect(n.Labels[SANDBOXD_LABELS.kind]).toBe("brw");
  });

  it("runs the proxy non-root, read-only, on its outbound network only, with no org or bot label", () => {
    const spec = egressSpec({ ns: NS, image: "ocw-sandbox-egress:test" });
    expect(spec.User).toBe("10002:10002");
    expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
    expect(spec.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(spec.HostConfig.NetworkMode).toBe(egressNames(NS).network);
    expect(spec.HostConfig.Tmpfs["/run/ocw-egress"]).toContain("mode=0755");
    expect(spec.HostConfig.PublishAllPorts).toBe(false);
    expect(spec.Labels).toEqual({ "ocw.sandbox": "1", "ocw.namespace": NS, "ocw.kind": "egress" });
    expect(Object.keys(spec.Labels)).not.toContain(SANDBOXD_LABELS.org);
    const net = egressNetworkSpec(NS);
    expect(net.Internal).toBe(false);
    expect(net.Name).toBe(`ocw-egress-out-${NS}`);
  });
});

// ---------------------------------------------------------------- D-14: sandboxd and its own labels

describe("ownContainerId / ownLabelRefusal (D-14)", () => {
  const id = "a".repeat(64);
  it("finds the container id from mountinfo or cgroup, null for a host process", () => {
    expect(ownContainerId(`1 2 0:1 /docker/containers/${id}/hostname /etc/hostname rw`, "")).toBe(id);
    expect(ownContainerId("", `0::/system.slice/docker-${id}.scope`)).toBe(id);
    expect(ownContainerId("1 2 0:1 / / rw", "0::/user.slice")).toBeNull();
  });
  it("refuses a container that carries the kill label", () => {
    expect(ownLabelRefusal({ "ocw.sandbox": "1" })).toMatch(/ocw\.sandbox/);
    expect(ownLabelRefusal({ "com.docker.compose.service": "sandboxd" })).toBeNull();
    expect(ownLabelRefusal(null)).toBeNull();
  });
});

// ---------------------------------------------------------------- the agent's output and the link

function agentFrame(type: 0 | 1, payload: Buffer): Buffer {
  const h = Buffer.alloc(5);
  h.writeUInt32BE(payload.length, 0);
  h[4] = type;
  return Buffer.concat([h, payload]);
}
const jpegFrame = (contextId: string, jpeg: Buffer) =>
  agentFrame(0, Buffer.concat([Buffer.from([contextId.length]), Buffer.from(contextId, "ascii"), jpeg]));
const jsonFrame = (msg: unknown) => agentFrame(1, Buffer.from(JSON.stringify(msg)));
const dockerFrame = (stream: 1 | 2, data: Buffer) => {
  const h = Buffer.alloc(8);
  h[0] = stream;
  h.writeUInt32BE(data.length, 4);
  return Buffer.concat([h, data]);
};

describe("AgentOutputReader", () => {
  it("strips the context-id tag from type-0 frames, across arbitrary chunk splits", () => {
    const bytes = Buffer.concat([jpegFrame(CTX, JPEG), jsonFrame({ event: "size", contextId: CTX })]);
    const reader = new AgentOutputReader();
    const out = [];
    for (let i = 0; i < bytes.length; i += 3) out.push(...reader.push(bytes.subarray(i, i + 3)));
    expect(out).toEqual([
      { type: "jpeg", contextId: CTX, jpeg: JPEG },
      { type: "json", message: { event: "size", contextId: CTX } },
    ]);
  });
  it("refuses an unknown type, an oversized frame and a non-object message", () => {
    expect(() => new AgentOutputReader().push(agentFrame(1, Buffer.from("[1]")))).toThrow(AgentError);
    const bad = Buffer.alloc(5);
    bad[4] = 7;
    expect(() => new AgentOutputReader().push(bad)).toThrow(AgentError);
    const huge = Buffer.alloc(5);
    huge.writeUInt32BE(0xffffffff, 0);
    expect(() => new AgentOutputReader().push(huge)).toThrow(AgentError);
  });
});

describe("linkOverStream", () => {
  it("frames requests as JSON lines and resolves responses by id; agent codes surface as AgentError", async () => {
    const stream = new PassThrough();
    const written: string[] = [];
    stream.write = ((chunk: Buffer | string) => {
      written.push(chunk.toString());
      return true;
    }) as typeof stream.write;
    const link = linkOverStream(stream);
    const ok = link.request("contextSnapshot", { contextId: CTX });
    const refused = link.request("contextAct", { contextId: CTX });
    const lines = written.map((w) => JSON.parse(w) as { id: number; op: string });
    expect(lines.map((l) => l.op)).toEqual(["contextSnapshot", "contextAct"]);
    stream.push(
      dockerFrame(1, jsonFrame({ id: lines[1]?.id, ok: false, error: { code: "paused", message: "m" } })),
    );
    stream.push(dockerFrame(2, Buffer.from("ocw-brw: diagnostic\n")));
    stream.push(dockerFrame(1, jsonFrame({ id: lines[0]?.id, ok: true, result: { host: "a" } })));
    await expect(ok).resolves.toEqual({ host: "a" });
    await expect(refused).rejects.toMatchObject({ code: "paused" });
    link.close();
  });

  it("reports ready with the posture, and fatal or a lost stream as a refusal", async () => {
    const s1 = new PassThrough();
    const l1 = linkOverStream(s1);
    s1.push(dockerFrame(1, jsonFrame({ event: "ready", browserSandbox: "chromium", runtime: "runc" })));
    await expect(l1.ready(1000)).resolves.toEqual({ browserSandbox: "chromium", runtime: "runc" });
    const s2 = new PassThrough();
    const l2 = linkOverStream(s2);
    s2.push(dockerFrame(1, jsonFrame({ event: "fatal", code: "sandbox_required", runtime: "runsc" })));
    await expect(l2.ready(1000)).rejects.toMatchObject({ code: "sandbox_required" });
    const s3 = new PassThrough();
    const l3 = linkOverStream(s3);
    const pending = l3.request("info", {});
    s3.destroy();
    await expect(pending).rejects.toMatchObject({ code: "link_closed" });
    await expect(l3.ready(1000)).rejects.toMatchObject({ code: "link_closed" });
  });
});

describe("agent codes → sandboxd codes", () => {
  it("maps paused, no_context, navigation_refused; internal and sandbox_required become 503 with fixed text", () => {
    expect(agentFailure(new AgentError("paused", "a person is in control"))).toMatchObject({
      code: "paused",
      status: 409,
    });
    expect(agentFailure(new AgentError("no_context", "x"))).toMatchObject({
      code: "no_context",
      status: 404,
    });
    expect(agentFailure(new AgentError("navigation_refused", "x"))).toMatchObject({
      code: "navigation_refused",
      status: 422,
    });
    for (const code of ["internal", "sandbox_required", "link_closed", "something-new"]) {
      const f = agentFailure(new AgentError(code, "page text https://secret.example/leak"));
      expect(f).toMatchObject({ code: "docker_unavailable", status: 503 });
      expect(f.message).not.toContain("secret");
    }
  });
  it("D-14: a posture must match its runtime", () => {
    expect(postureAllowed("runsc", "chromium+gvisor")).toBe(true);
    expect(postureAllowed("runsc", "container-only")).toBe(false);
    expect(postureAllowed("runsc", "chromium")).toBe(false);
    expect(postureAllowed("runc", "chromium")).toBe(true);
    expect(postureAllowed("runc", "container-only")).toBe(true);
    expect(postureAllowed("runc", "chromium+gvisor")).toBe(false);
    expect(postureAllowed("runc", null)).toBe(false);
  });
  it("sends a resize mode: the caller's, the live view's fixed sizes, else custom", () => {
    expect(resizeMode({ width: 390, height: 700, mode: "phone" })).toBe("phone");
    expect(resizeMode({ width: 960, height: 600 })).toBe("small");
    expect(resizeMode({ width: 1280, height: 800 })).toBe("expanded");
    expect(resizeMode({ width: 1000, height: 700 })).toBe("custom");
  });
});

// ---------------------------------------------------------------- frame subscribers

class SlowWritable extends EventEmitter implements FrameWritable {
  chunks: Uint8Array[] = [];
  writableNeedDrain = false;
  writableEnded = false;
  constructor(private capacity: number) {
    super();
  }
  write(chunk: Uint8Array) {
    this.chunks.push(chunk);
    if (this.chunks.length >= this.capacity) this.writableNeedDrain = true;
    return !this.writableNeedDrain;
  }
  end() {
    this.writableEnded = true;
  }
  drain() {
    this.writableNeedDrain = false;
    this.capacity = Number.POSITIVE_INFINITY;
    this.emit("drain");
  }
}

function decode(chunks: Uint8Array[]) {
  return chunks.map((c) => {
    const h = decodeFrameHeader(c);
    if (!h) throw new Error("short frame");
    return { type: h.type, payload: Buffer.from(c.subarray(5, 5 + h.length)) };
  });
}

describe("frameWriter (latest-frame-wins)", () => {
  it("holds only the newest frame for a slow consumer, never a queue", () => {
    const out = new SlowWritable(1);
    const sink = frameWriter(out);
    for (let i = 0; i < 50; i++) sink.frame(Buffer.from([0xff, 0xd8, i]));
    expect(out.chunks).toHaveLength(1); // the first one went out, the rest wait as one
    out.drain();
    const frames = decode(out.chunks);
    expect(frames).toHaveLength(2);
    expect(frames[1]?.payload).toEqual(Buffer.from([0xff, 0xd8, 49]));
  });
  it("writes controls in the contract framing", () => {
    const out = new SlowWritable(100);
    frameWriter(out).control({ kind: "size", width: 960, height: 600 });
    const [f] = decode(out.chunks);
    expect(f?.type).toBe(FRAME_TYPES.control);
    expect(SandboxdFrameControl.parse(JSON.parse(f?.payload.toString() ?? ""))).toEqual({
      kind: "size",
      width: 960,
      height: 600,
    });
  });
});

// ---------------------------------------------------------------- createBrowsers with a fake link and clock

class FakeLink implements AgentLink {
  calls: Array<{ op: string; input: Record<string, unknown> }> = [];
  replies: Record<string, (input: Record<string, unknown>) => unknown> = {};
  private frames: Array<(c: string, j: Buffer) => void> = [];
  private events: Array<(e: Record<string, unknown>) => void> = [];
  private closes: Array<() => void> = [];
  closed = false;
  constructor(public posture: string | null = "chromium") {}
  async request(op: string, input: Record<string, unknown>) {
    this.calls.push({ op, input });
    const r = this.replies[op];
    if (r) return r(input);
    if (op === "info") return { browserSandbox: this.posture };
    if (op === "contextFrames") return { on: input.on !== false };
    if (op === "contextTakeover") return { active: input.active === true };
    if (op === "contextInput") return { applied: (input.events as unknown[]).length };
    if (op === "contextHold") return { hold: input.hold };
    if (op === "contextClose") {
      this.emitEvent({ event: "closed", contextId: input.contextId, reason: "closed" });
      return { closed: true };
    }
    return {};
  }
  async ready(): Promise<AgentReady> {
    if (!this.posture) throw new AgentError("sandbox_required", "x");
    return { browserSandbox: this.posture, runtime: "runc" };
  }
  onFrame(l: (c: string, j: Buffer) => void) {
    this.frames.push(l);
  }
  onEvent(l: (e: Record<string, unknown>) => void) {
    this.events.push(l);
  }
  onClose(l: () => void) {
    this.closes.push(l);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.closes) l();
  }
  emitFrame(contextId: string, jpeg: Buffer) {
    for (const l of this.frames) l(contextId, jpeg);
  }
  emitEvent(e: Record<string, unknown>) {
    for (const l of this.events) l(e);
  }
}

function fakeEgress() {
  const attached: Array<{ kind: string; network: string }> = [];
  /** The proxy's address on the bot's browser network (a restarted proxy gets a new one). */
  const proxy = { address: "10.2.0.2" };
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
  return { egress, attached, proxy };
}

function setup(opts: { posture?: string | null; runtimes?: string[] } = {}) {
  const docker = new FakeDocker("29.6.2", opts.runtimes);
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
  sandboxes.setPolicy(testPolicy(ORG));
  const { egress, attached, proxy } = fakeEgress();
  const links: FakeLink[] = [];
  const browsers = createBrowsers({
    docker,
    sandboxes,
    egress,
    ns: NS,
    image: "brw:test",
    seccompProfile: null,
    clock,
    onEvent: (e) => events.push(e),
    openLink: async () => {
      const l = new FakeLink(opts.posture === undefined ? "chromium" : opts.posture);
      links.push(l);
      return l;
    },
  });
  return {
    docker,
    sandboxes,
    browsers,
    events,
    attached,
    proxy,
    links,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const viewport = { width: 960, height: 600 };

describe("createBrowsers", () => {
  it("browserEnsure: brw on the bot's browser network, the proxy attached first, posture reported (D-14)", async () => {
    const s = setup();
    expect(s.browsers.posture()).toBeNull();
    const status = await s.browsers.ensure(target);
    expect(status).toEqual({
      target,
      state: "running",
      runtime: "hardened-runc",
      browserSandbox: "chromium",
    });
    expect(s.attached).toEqual([{ kind: "brw", network: nameFor("bnet", NS, AGENT) }]);
    const brw = s.docker.container(nameFor("brw", NS, AGENT));
    expect(brw?.Running).toBe(true);
    expect(
      (brw?.Spec as { HostConfig?: { NetworkMode?: string } } | undefined)?.HostConfig?.NetworkMode,
    ).toBe(nameFor("bnet", NS, AGENT));
    expect(s.browsers.posture()).toBe("chromium");
    expect(s.events).toContainEqual({ type: "state", target, kind: "brw", state: "running", reason: null });
    // A second ensure reuses the running browser.
    await s.browsers.ensure(target);
    expect(s.links).toHaveLength(1);
  });

  it("names the proxy by its address in brw's /etc/hosts; a stopped brw with a stale entry is recreated (gVisor DNS)", async () => {
    const s = setup();
    const name = nameFor("brw", NS, AGENT);
    const hosts = () =>
      (s.docker.container(name)?.Spec as { HostConfig?: { ExtraHosts?: string[] } } | undefined)?.HostConfig
        ?.ExtraHosts;
    await s.browsers.ensure(target);
    expect(hosts()).toEqual(["sandbox-egress:10.2.0.2"]);
    const first = s.docker.container(name)?.Id;
    // Stopped with a current entry: started again as it is.
    (s.links[0] as FakeLink).close();
    (s.docker.container(name) as { Running: boolean }).Running = false;
    await s.browsers.ensure(target);
    expect(s.docker.container(name)?.Id).toBe(first);
    // The proxy restarted and has a new address: the stopped brw is removed and created again with it.
    (s.links[1] as FakeLink).close();
    (s.docker.container(name) as { Running: boolean }).Running = false;
    s.proxy.address = "10.2.0.7";
    await s.browsers.ensure(target);
    expect(s.docker.container(name)?.Id).not.toBe(first);
    expect(hosts()).toEqual(["sandbox-egress:10.2.0.7"]);
    expect(s.docker.container(name)?.Running).toBe(true);
    expect(
      s.docker.calls.filter((c) => c.method === "DELETE" && c.path.includes(first as string)),
    ).toHaveLength(1);
  });

  it("D-14: refuses a posture the runtime cannot have, and a browser that did not start", async () => {
    const lying = setup({ posture: "chromium+gvisor" });
    await expect(lying.browsers.ensure(target)).rejects.toMatchObject({
      code: "docker_unavailable",
      status: 503,
    });
    expect(lying.browsers.posture()).toBeNull();
    const fatal = setup({ posture: null });
    await expect(fatal.browsers.ensure(target)).rejects.toMatchObject({ code: "docker_unavailable" });
  });

  it("fails fast without the brw or egress image", async () => {
    const s = setup();
    const none = createBrowsers({
      docker: s.docker,
      sandboxes: s.sandboxes,
      egress: null,
      ns: NS,
      image: null,
      seccompProfile: null,
    });
    await expect(none.ensure(target)).rejects.toMatchObject({ code: "docker_unavailable", status: 503 });
    expect(s.docker.containerCreates).toHaveLength(0);
  });

  it("a context of another bot is no context; agent refusals map to sandboxd codes", async () => {
    const s = setup();
    await s.browsers.open({ target, contextId: CTX, viewport });
    await expect(
      s.browsers.snapshot({ target: { orgId: ORG, agentId: OTHER }, contextId: CTX }),
    ).rejects.toMatchObject({ code: "no_context", status: 404 });
    const link = s.links[0] as FakeLink;
    link.replies.contextSnapshot = () => {
      throw new AgentError("paused", "a person is in control of this browser");
    };
    await expect(s.browsers.snapshot({ target, contextId: CTX })).rejects.toMatchObject({
      code: "paused",
      status: 409,
    });
  });

  it("screenshot drops the agent's maskRects; resize sends the mode; input answers accepted", async () => {
    const s = setup();
    await s.browsers.open({ target, contextId: CTX, viewport });
    const link = s.links[0] as FakeLink;
    link.replies.contextScreenshot = () => ({
      mimeType: "image/jpeg",
      data: "AAAA",
      width: 960,
      height: 600,
      masked: 2,
      maskRects: [{ x: 1, y: 2, width: 3, height: 4 }],
    });
    const shot = await s.browsers.screenshot({ target, contextId: CTX });
    expect(shot).toEqual({ mimeType: "image/jpeg", data: "AAAA", width: 960, height: 600, masked: 2 });
    await s.browsers.resize({ target, contextId: CTX, width: 390, height: 700, mode: "phone" });
    expect(link.calls.at(-1)).toEqual({
      op: "contextResize",
      input: { contextId: CTX, mode: "phone", width: 390, height: 700 },
    });
    await expect(
      s.browsers.input({ target, contextId: CTX, events: [{ type: "text", text: "x" }] }),
    ).resolves.toEqual({ accepted: 1 });
  });

  it("idle: a context with no request and no subscriber for 5 min closes, then the brw container stops", async () => {
    const s = setup();
    await s.browsers.open({ target, contextId: CTX, viewport });
    s.advance(BROWSER_IDLE_MS - 1000);
    await s.browsers.sweep(s.now());
    expect(s.links[0]?.calls.some((c) => c.op === "contextClose")).toBe(false);
    s.advance(2000);
    await s.browsers.sweep(s.now());
    expect(s.links[0]?.calls.filter((c) => c.op === "contextClose")).toHaveLength(1);
    expect(s.events).toContainEqual({ type: "browser", target, contextId: CTX, event: "closed" });
    expect(s.events).toContainEqual({ type: "state", target, kind: "brw", state: "stopped", reason: "idle" });
    expect(s.docker.container(nameFor("brw", NS, AGENT))?.Running).toBe(false);
    // The stop was the broker's: no crash is reported when the link drops.
    expect(s.events.filter((e) => e.type === "state" && e.state === "stopped")).toHaveLength(1);
  });

  it("a subscriber keeps the context alive; the agent screencasts only while someone watches", async () => {
    const s = setup();
    await s.browsers.open({ target, contextId: CTX, viewport });
    const out = new SlowWritable(1000);
    const off = await s.browsers.subscribe(target, CTX, frameWriter(out));
    const link = s.links[0] as FakeLink;
    expect(link.calls.filter((c) => c.op === "contextFrames").map((c) => c.input.on)).toEqual([true]);
    s.advance(BROWSER_IDLE_MS * 3);
    await s.browsers.sweep(s.now());
    expect(link.calls.some((c) => c.op === "contextClose")).toBe(false);
    off();
    expect(link.calls.filter((c) => c.op === "contextFrames").map((c) => c.input.on)).toEqual([true, false]);
  });

  it("hold: keeps the context up to 15 min, never beyond 15 min after its last activity", async () => {
    const s = setup();
    await s.browsers.open({ target, contextId: CTX, viewport });
    await expect(s.browsers.hold({ target, contextId: CTX, hold: true, reason: "signin" })).resolves.toEqual({
      held: true,
    });
    s.advance(BROWSER_IDLE_MS + 60_000); // past the idle stop, inside the hold
    await s.browsers.sweep(s.now());
    expect(s.links[0]?.calls.some((c) => c.op === "contextClose")).toBe(false);
    // A second hold now cannot reach past 15 min after the last activity (the hold itself is not activity).
    await s.browsers.hold({ target, contextId: CTX, hold: true, reason: "approval" });
    s.advance(BROWSER_HOLD_MS - (BROWSER_IDLE_MS + 60_000) + 1000);
    await s.browsers.sweep(s.now());
    expect(s.links[0]?.calls.filter((c) => c.op === "contextClose")).toHaveLength(1);
  });

  it("two slow subscribers each get only the latest frame, as bare JPEGs without the context tag", async () => {
    const s = setup();
    await s.browsers.open({ target, contextId: CTX, viewport });
    const a = new SlowWritable(1);
    const b = new SlowWritable(1);
    await s.browsers.subscribe(target, CTX, frameWriter(a));
    await s.browsers.subscribe(target, CTX, frameWriter(b));
    const link = s.links[0] as FakeLink;
    for (let i = 0; i < 20; i++) link.emitFrame(CTX, Buffer.from([0xff, 0xd8, i]));
    link.emitFrame(OTHER, Buffer.from([0xff, 0xd8, 99])); // another context: never delivered here
    a.drain();
    b.drain();
    for (const out of [a, b]) {
      const frames = decode(out.chunks).filter((f) => f.type === FRAME_TYPES.jpeg);
      expect(frames.map((f) => f.payload[2])).toEqual([0, 19]);
      expect(frames.every((f) => f.payload[0] === 0xff && f.payload[1] === 0xd8)).toBe(true);
    }
  });

  it("agent events become controls and browser events; a lost browser is a crash, a kill is not", async () => {
    const s = setup();
    await s.browsers.open({ target, contextId: CTX, viewport });
    const out = new SlowWritable(1000);
    await s.browsers.subscribe(target, CTX, frameWriter(out));
    const link = s.links[0] as FakeLink;
    link.emitEvent({ event: "navigated", contextId: CTX, host: "panel.fake.test:8080", secure: false });
    link.emitEvent({ event: "focus", contextId: CTX, sensitive: true });
    link.emitEvent({ event: "download", contextId: CTX, name: "r.csv", size: 4, token: "t".repeat(32) });
    expect(s.events).toEqual(
      expect.arrayContaining([
        { type: "browser", target, contextId: CTX, event: "navigated", host: "panel.fake.test:8080" },
        { type: "browser", target, contextId: CTX, event: "focus_sensitive" },
        {
          type: "browser",
          target,
          contextId: CTX,
          event: "download",
          download: { name: "r.csv", size: 4, token: "t".repeat(32) },
        },
      ]),
    );
    const controls = decode(out.chunks)
      .filter((f) => f.type === FRAME_TYPES.control)
      .map((f) => JSON.parse(f.payload.toString()));
    expect(controls).toEqual([
      { kind: "navigated", host: "panel.fake.test:8080", secure: false },
      { kind: "focus", sensitive: true },
    ]);
    link.close();
    expect(s.events).toContainEqual({ type: "browser", target, contextId: CTX, event: "crashed" });
    expect(s.events).toContainEqual({ type: "state", target, kind: "brw", state: "stopped", reason: null });
    expect(out.writableEnded).toBe(true);

    // killOrg: the broker's own kill is no crash.
    const k = setup();
    await k.browsers.open({ target, contextId: CTX, viewport });
    await k.sandboxes.killOrg(ORG);
    (k.links[0] as FakeLink).close();
    expect(k.events).toContainEqual({
      type: "state",
      target,
      kind: "brw",
      state: "killed",
      reason: "kill_switch",
    });
    expect(k.events.some((e) => e.type === "state" && e.state === "stopped")).toBe(false);
    expect(k.docker.container(nameFor("brw", NS, AGENT))?.Running).toBe(false);
  });
});

// ---------------------------------------------------------------- the server's browser routes

describe("server browser routes", () => {
  const TOKEN = "t".repeat(40);
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  async function start() {
    const s = setup();
    const lines: LogLine[] = [];
    const files = createFiles({ sandboxes: s.sandboxes, quota: createQuota({ sandboxes: s.sandboxes }) });
    const server = createServer({
      token: TOKEN,
      sandboxes: s.sandboxes,
      files,
      browsers: s.browsers,
      log: (l) => lines.push(l),
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    return { ...s, lines, port, post };
  }

  it("input frames are forwarded and never logged; info reports the started posture", async () => {
    const s = await start();
    const info0 = await fetch(`http://127.0.0.1:${s.port}/v1/info`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await info0.json()) as { browserSandbox: unknown }).browserSandbox).toBeNull();
    expect((await s.post("/v1/browsers/contexts/open", { target, contextId: CTX, viewport })).status).toBe(
      200,
    );
    await s.post("/v1/browsers/contexts/takeover", { target, contextId: CTX, active: true });
    const secret = "S3cr3t-Hunter2-OCW";
    const res = await s.post("/v1/browsers/contexts/input", {
      target,
      contextId: CTX,
      events: [{ type: "text", text: secret }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 1 });
    const link = s.links[0] as FakeLink;
    expect(link.calls.find((c) => c.op === "contextInput")?.input.events).toEqual([
      { type: "text", text: secret },
    ]);
    expect(JSON.stringify(s.lines)).not.toContain(secret);
    expect(JSON.stringify(s.events)).not.toContain(secret);
    const info = await fetch(`http://127.0.0.1:${s.port}/v1/info`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await info.json()) as { browserSandbox: unknown }).browserSandbox).toBe("chromium");
  });

  it("streams frames to a viewer in the contract framing, and refuses another bot's context", async () => {
    const s = await start();
    await s.post("/v1/browsers/contexts/open", { target, contextId: CTX, viewport });
    const other = await fetch(
      `http://127.0.0.1:${s.port}/v1/browsers/contexts/frames?orgId=${ORG}&agentId=${OTHER}&contextId=${CTX}`,
      { headers: { authorization: `Bearer ${TOKEN}` } },
    );
    expect(other.status).toBe(404);
    expect(((await other.json()) as { error: { code: string } }).error.code).toBe("no_context");

    const ac = new AbortController();
    const res = await fetch(
      `http://127.0.0.1:${s.port}/v1/browsers/contexts/frames?orgId=${ORG}&agentId=${AGENT}&contextId=${CTX}`,
      { headers: { authorization: `Bearer ${TOKEN}` }, signal: ac.signal },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    const link = s.links[0] as FakeLink;
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const got: Buffer[] = [];
    for (let i = 0; i < 3; i++) link.emitFrame(CTX, Buffer.from([0xff, 0xd8, i]));
    link.emitEvent({ event: "closed", contextId: CTX });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got.push(Buffer.from(value));
    }
    const all = Buffer.concat(got);
    const frames: Array<{ type: number; payload: Buffer }> = [];
    for (let off = 0; off < all.length; ) {
      const h = decodeFrameHeader(all.subarray(off));
      if (!h) break;
      frames.push({ type: h.type, payload: all.subarray(off + 5, off + 5 + h.length) });
      off += 5 + h.length;
    }
    expect(frames.filter((f) => f.type === FRAME_TYPES.jpeg)).toHaveLength(3);
    expect(JSON.parse(frames.at(-1)?.payload.toString() ?? "")).toEqual({ kind: "closed" });
    expect(JSON.stringify(s.lines)).not.toMatch(/\\xff|ffd8/);
  });

  it("refuses browser ops for an organization without a policy (fail closed)", async () => {
    const s = await start();
    const res = await s.post("/v1/browsers/ensure", { target: { orgId: OTHER, agentId: AGENT } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("policy_missing");
  });
});
