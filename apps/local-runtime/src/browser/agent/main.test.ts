// The browser child's entry (07.13 D-02, PD-19): the op deadline it enforces itself. HI-01 (07.13 review): a load with
// a member's state (`openWithState`) that runs past its deadline must not keep running in the background, so the child
// leaves (its Chromium and the in-memory state go with it) right after it answers `timeout`.

import { PassThrough } from "node:stream";
import { decodeFrameHeader, FRAME_HEADER_BYTES, FRAME_TYPES } from "@ocw/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBrowserAgent } from "./main.js";
import { type BrowserAgent, opDeadlineMs } from "./ops.js";

/** The control messages written to `out` so far. */
function controlMessages(chunks: Buffer[]): Array<Record<string, unknown>> {
  let buf = Buffer.concat(chunks);
  const out: Array<Record<string, unknown>> = [];
  for (;;) {
    const header = decodeFrameHeader(buf);
    if (!header || buf.length < FRAME_HEADER_BYTES + header.length) return out;
    const payload = buf.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + header.length);
    buf = buf.subarray(FRAME_HEADER_BYTES + header.length);
    if (header.type === FRAME_TYPES.control) out.push(JSON.parse(payload.toString("utf8")));
  }
}

/** An agent whose every op hangs (a cold launch and a page that never loads). */
function hangingAgent(): BrowserAgent {
  const never = () => new Promise<never>(() => {});
  return new Proxy({} as BrowserAgent, {
    get: (_t, name) => (name === "close" ? async () => ({ closed: true }) : never),
  });
}

function start() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on("data", (c: Buffer) => chunks.push(c));
  const exit = vi.fn();
  runBrowserAgent(stdin, stdout, {
    stderr: new PassThrough(),
    env: {},
    exit,
    createAgent: () => hangingAgent(),
  });
  return { stdin, chunks, exit };
}

describe("browser-agent deadlines (HI-01)", () => {
  const before = new Set(process.listeners("SIGTERM"));
  afterEach(() => {
    vi.useRealTimers();
    // Only the agent's own handlers go (the test runner's stay).
    for (const l of process.listeners("SIGTERM")) if (!before.has(l)) process.removeListener("SIGTERM", l);
  });

  it("a timed-out openWithState answers timeout and then the child exits (the signed-in context never stays)", async () => {
    vi.useFakeTimers();
    const t = start();
    t.stdin.write(
      `${JSON.stringify({ id: 1, op: "openWithState", url: "https://a.example/", state: {} })}\n`,
    );
    await vi.advanceTimersByTimeAsync(opDeadlineMs("openWithState") - 1);
    expect(t.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(controlMessages(t.chunks)).toContainEqual(
      expect.objectContaining({ id: 1, ok: false, error: expect.objectContaining({ code: "timeout" }) }),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(t.exit).toHaveBeenCalled();
    expect(t.exit.mock.calls[0]?.[0]).not.toBe(0);
  });

  it("a timed-out public op answers timeout and the child stays", async () => {
    vi.useFakeTimers();
    const t = start();
    t.stdin.write(`${JSON.stringify({ id: 1, op: "snapshot" })}\n`);
    await vi.advanceTimersByTimeAsync(opDeadlineMs("snapshot") + 50);
    expect(controlMessages(t.chunks)).toContainEqual(
      expect.objectContaining({ id: 1, ok: false, error: expect.objectContaining({ code: "timeout" }) }),
    );
    expect(t.exit).not.toHaveBeenCalled();
  });
});
