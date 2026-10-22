import { randomUUID } from "node:crypto";
import { decodeFrameHeader, FRAME_HEADER_BYTES, FRAME_TYPES, SandboxdFrameControl } from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeSandboxdServer, startFakeSandboxd } from "../../testing-sandbox";
import { createSandboxdClient, SandboxdRefusedError, SandboxdUnavailableError } from "./client";

/**
 * 07.8-08 (P-13): the fake sandboxd's browser ops through the API's own client, which parses every answer with the
 * contract's `SANDBOXD_ROUTES` output schema, so the fake the API, UI and e2e tests rely on (14, 16, 21, 25) cannot drift
 * from the contract. The leak control's snapshot must FAIL that parse: a redacted node carrying a value is refused.
 */

let fake: FakeSandboxdServer;
let client: ReturnType<typeof createSandboxdClient>;
const target = { orgId: randomUUID(), agentId: randomUUID() };
const viewport = { width: 960, height: 600 };

beforeAll(async () => {
  fake = await startFakeSandboxd();
  client = createSandboxdClient({ url: fake.url, token: fake.token });
  // sandboxd holds no default policy: push one for the target's organization first, as the API's consumer does.
  const limits = {
    nanoCpus: 1_000_000_000,
    memoryBytes: 1024 ** 3,
    pids: 256,
    diskQuotaBytes: 2 * 1024 ** 3,
    idleStopMs: 900_000,
  };
  await client.call("policy", {
    orgId: target.orgId,
    sandboxEgress: "off",
    browserEgress: "off",
    allowHosts: [],
    privateHosts: [],
    limits,
    browserLimits: { ...limits, memoryBytes: 2 * 1024 ** 3, pids: 512, idleStopMs: 300_000 },
    killed: false,
    version: 1,
  });
});

afterAll(async () => {
  await fake?.stop();
});

async function open(extra: { siteLock?: string; storageState?: string } = {}) {
  await client.call("browserEnsure", { target });
  const contextId = randomUUID();
  await client.call("contextOpen", { target, contextId, viewport, ...extra });
  await client.call("contextNavigate", { target, contextId, url: "https://panel.fake.test/app" });
  return contextId;
}

const control = (path: string, body: unknown) =>
  fetch(`${fake.url}/__control/browser/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("fake sandboxd browser ops parse with the contract (createSandboxdClient)", () => {
  it("every JSON op answers its contract output", async () => {
    const contextId = await open();
    const snap = await client.call("contextSnapshot", { target, contextId });
    expect(snap.nodes.find((n) => n.name === "Password")).toMatchObject({
      value: "[redacted]",
      redacted: true,
    });
    expect((await client.call("contextScreenshot", { target, contextId })).masked).toBeGreaterThan(0);
    expect(await client.call("contextWait", { target, contextId, for: "load" })).toEqual({
      ok: true,
      host: "panel.fake.test",
    });
    expect(await client.call("contextAct", { target, contextId, action: "click", ref: "r4" })).toEqual({
      navigated: false,
      blockedNavigation: null,
      download: null,
    });
    const act = await client.call("contextAct", { target, contextId, action: "click", ref: "download-link" });
    const token = act.download?.token ?? "";
    expect((await client.call("contextDownload", { target, contextId, token })).name).toBe("report.csv");
    expect(await client.call("contextHold", { target, contextId, hold: true, reason: "approval" })).toEqual({
      held: true,
    });
    expect(await client.call("contextResize", { target, contextId, width: 390, height: 844 })).toEqual({
      ok: true,
    });
    expect(await client.call("contextTakeover", { target, contextId, active: true })).toEqual({
      active: true,
    });
    expect(
      // 07.8-16: input events are the live view's LiveInputFrame (the contract refuses a looser record).
      await client.call("contextInput", {
        target,
        contextId,
        events: [{ type: "key", event: "down", key: "a", code: "KeyA", modifiers: 0 }],
      }),
    ).toEqual({ accepted: 1 });
    expect(await client.call("contextTakeover", { target, contextId, active: false })).toEqual({
      active: false,
    });
    await control("signed-in", { contextId });
    const state = await client.call("contextExportState", { target, contextId });
    expect(JSON.parse(state.storageState).cookies).toHaveLength(1);
    expect(await client.call("contextClose", { target, contextId })).toEqual({ closed: true });
  });

  it("the site lock reports a blocked navigation and allowCrossSite passes it (D-13)", async () => {
    const contextId = await open({ siteLock: "panel.fake.test" });
    const blocked = await client.call("contextAct", {
      target,
      contextId,
      action: "click",
      ref: "export-link",
    });
    expect(blocked.blockedNavigation).toEqual({ host: "evil.fake.test" });
    const allowed = await client.call("contextAct", {
      target,
      contextId,
      action: "click",
      ref: "export-link",
      allowCrossSite: true,
    });
    expect(allowed).toMatchObject({ navigated: true, blockedNavigation: null });
  });

  it("paused, element_gone and no_context arrive as contract refusal codes", async () => {
    const contextId = await open();
    await client.call("contextTakeover", { target, contextId, active: true });
    await expect(client.call("contextSnapshot", { target, contextId })).rejects.toMatchObject({
      code: "paused",
      status: 409,
    });
    await client.call("contextTakeover", { target, contextId, active: false });
    const gone = client.call("contextAct", { target, contextId, action: "click", ref: "gone" });
    await expect(gone).rejects.toBeInstanceOf(SandboxdRefusedError);
    await expect(gone).rejects.toMatchObject({ code: "element_gone" });
    await expect(client.call("contextSnapshot", { target, contextId: randomUUID() })).rejects.toMatchObject({
      code: "no_context",
    });
  });

  it("the leak control's snapshot fails the contract parse (a redacted node may only carry [redacted])", async () => {
    const contextId = await open();
    await control("leak", {});
    await expect(client.call("contextSnapshot", { target, contextId })).rejects.toBeInstanceOf(
      SandboxdUnavailableError,
    );
  });

  it("the frame stream decodes with the contract's framing: a size control, then JPEG frames", async () => {
    const contextId = await open();
    const ac = new AbortController();
    const body = await client.stream("contextFrames", { ...target, contextId }, { signal: ac.signal });
    const reader = body.getReader();
    let buf = new Uint8Array(0);
    const frames: Array<{ type: number; payload: Uint8Array }> = [];
    while (frames.length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
      for (
        let h = decodeFrameHeader(buf);
        h && buf.length >= FRAME_HEADER_BYTES + h.length;
        h = decodeFrameHeader(buf)
      ) {
        frames.push({ type: h.type, payload: buf.slice(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + h.length) });
        buf = buf.slice(FRAME_HEADER_BYTES + h.length);
      }
    }
    ac.abort();
    expect(frames[0]?.type).toBe(FRAME_TYPES.control);
    expect(SandboxdFrameControl.parse(JSON.parse(new TextDecoder().decode(frames[0]?.payload)))).toEqual({
      kind: "size",
      ...viewport,
    });
    expect(frames.slice(1).every((f) => f.type === FRAME_TYPES.jpeg && f.payload[0] === 0xff)).toBe(true);
  });
});
