import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_OPS, type AgentDiag, AgentDiagReader, linkOverStream, openAgentLink } from "./agent-link";
import { createDocker, type Docker } from "./docker";

/**
 * 07.8 hardening (07.8-28 candidate 1): a fresh `brw`'s first request sometimes never answered. Root cause: the attach
 * was sent with a JSON body (`{}`), which the Engine can pass on to the container's stdin once it hijacks the
 * connection; the agent then read `{}{"contextId":…}` as one line, refused it as "not JSON" with no id, and sandboxd
 * waited for an answer that could not come. The attach now sends no body, and every request starts with a newline so
 * stray bytes can never be glued to it. The agent's stderr diagnostics reach sandboxd's log only through `AgentDiag`.
 */

const CTX = "6ad0efca-e04c-43c6-98ee-9c3f52fdb87d";

function dockerFrame(stream: 1 | 2, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function jsonFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 0);
  header.writeUInt8(1, 4);
  return Buffer.concat([header, payload]);
}

/**
 * The agent's side of the attach as agent.mjs reads it: newline-split, trimmed, empty lines skipped, one answer per
 * line (`{ id: null }` for a line that is not JSON). `stray` is what reached its stdin before sandboxd's first write.
 */
function fakeAgentStream(stray: string): Duplex {
  let buf = stray;
  const stream: Duplex = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, cb) {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          let reply: unknown;
          try {
            const msg = JSON.parse(line) as { id: number };
            reply = { id: msg.id, ok: true, result: { contextId: CTX } };
          } catch {
            reply = { id: null, ok: false, error: { code: "invalid_request", message: "not JSON" } };
          }
          stream.push(dockerFrame(1, jsonFrame(reply)));
        }
        nl = buf.indexOf("\n");
      }
      cb();
    },
  });
  return stream;
}

describe("the agent link's requests", () => {
  it("a stray `{}` on the agent's stdin before the first request no longer swallows it", async () => {
    const link = linkOverStream(fakeAgentStream("{}"));
    await expect(link.request("contextOpen", { contextId: CTX }, 2_000)).resolves.toEqual({ contextId: CTX });
    await expect(link.request("contextClose", { contextId: CTX }, 2_000)).resolves.toEqual({
      contextId: CTX,
    });
    link.close();
  });

  it("every request is one JSON line after a newline", () => {
    const written: string[] = [];
    const stream = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        written.push(chunk.toString("utf8"));
        cb();
      },
    });
    const link = linkOverStream(stream);
    void link.request("info", {}, 50).catch(() => undefined);
    expect(written).toEqual([`\n${JSON.stringify({ id: 1, op: "info" })}\n`]);
    link.close();
  });

  it("openAgentLink attaches with no request body", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const docker = {
      async hijack(path: string, body: unknown) {
        calls.push({ path, body });
        return new Duplex({ read() {}, write: (_c, _e, cb) => cb() });
      },
    } as unknown as Docker;
    const link = await openAgentLink(docker, "abc");
    expect(calls).toEqual([
      { path: "/containers/abc/attach?stream=1&stdin=1&stdout=1&stderr=1", body: null },
    ]);
    link.close();
  });
});

describe("Docker hijack on the socket", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  /** The raw bytes of one hijack request, as the daemon's socket receives them before it upgrades. */
  async function rawHijack(body: unknown | null): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), "ocw-hijack-"));
    const socketPath = join(dir, "docker.sock");
    let received = "";
    let client: Socket | null = null;
    const server = createServer((s) => {
      client = s;
      s.on("data", (c: Buffer) => {
        received += c.toString("utf8");
        const end = received.indexOf("\r\n\r\n");
        const length = Number(/content-length: (\d+)/i.exec(received)?.[1] ?? 0);
        if (end >= 0 && received.length >= end + 4 + length) {
          s.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n");
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      const stream = await createDocker({ socketPath }).hijack("/containers/x/attach?stdin=1", body);
      // Anything the client would still send after its headers has had time to arrive.
      await new Promise((r) => setTimeout(r, 50));
      stream.destroy();
      return received;
    } finally {
      (client as Socket | null)?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it("an attach (`null`) sends headers only: no content type and nothing after them", async () => {
    const raw = await rawHijack(null);
    const [head, rest] = raw.split("\r\n\r\n");
    expect(head).toMatch(/^POST \/v1\.45\/containers\/x\/attach\?stdin=1 HTTP\/1\.1/);
    expect(head).toMatch(/\r\ncontent-length: 0/i);
    expect(head).not.toMatch(/content-type/i);
    expect(rest).toBe("");
  });

  it("an exec start keeps its JSON body", async () => {
    const raw = await rawHijack({ Detach: false, Tty: false });
    expect(raw.split("\r\n\r\n")[1]).toBe('{"Detach":false,"Tty":false}');
  });
});

describe("AgentDiagReader (brw stderr → sandboxd's log)", () => {
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;
  const read = (...chunks: string[]) => {
    const r = new AgentDiagReader();
    return chunks.flatMap((c) => r.push(Buffer.from(c, "utf8")));
  };

  it("passes the agent's diagnostics, split anywhere", () => {
    const ops = line({ brw: 1, ev: "op", t: 81, op: "contextOpen", ctx: CTX, ms: 58, outcome: "ok" });
    const ready = line({ brw: 1, ev: "ready", t: 74, posture: "chromium" });
    const text = ops + ready;
    const out = read(text.slice(0, 7), text.slice(7, 40), text.slice(40));
    expect(out).toEqual<AgentDiag[]>([
      { brw: 1, ev: "op", t: 81, op: "contextOpen", ctx: CTX, ms: 58, outcome: "ok" },
      { brw: 1, ev: "ready", t: 74, posture: "chromium" },
    ]);
    expect(AGENT_OPS).toContain("contextOpen");
  });

  it("drops anything that could carry a URL, a host, page or typed text, a cookie or a message", () => {
    const out = read(
      "ocw-brw: [0101/FATAL:zygote_host_impl_linux.cc] No usable sandbox! https://evil.test/?q=1\n",
      line({ brw: 1, ev: "op", t: 1, op: "contextNavigate", url: "https://a.test/?token=x" }),
      line({ brw: 1, ev: "op", t: 1, op: "contextNavigate", host: "a.test" }),
      line({ brw: 1, ev: "op_error", t: 1, op: "contextAct", error: "Error: page text quoted" }),
      line({ brw: 1, ev: "op", t: 1, op: "contextInput", outcome: "S3cr3t-Hunter2" }),
      line({ brw: 1, ev: "op", t: 1, op: "evaluate" }),
      line({ brw: 1, ev: "typed", t: 1 }),
      line({ brw: 1, ev: "op", t: 1, ctx: "not-a-context-id" }),
      line({ brw: 2, ev: "op", t: 1 }),
      line({ brw: 1, ev: "start", t: 1, runtime: "runc", cookie: "sid=1" }),
      "[1,2,3]\n",
      "not json at all\n",
    );
    expect(out).toEqual([]);
  });

  it("drops an overlong line and its rest, then reads on", () => {
    const long = `{"brw":1,"ev":"start","t":1,"pad":"${"x".repeat(5000)}`;
    const out = read(long.slice(0, 3000), `${long.slice(3000)}"}\n`, line({ brw: 1, ev: "start", t: 2 }));
    expect(out).toEqual([{ brw: 1, ev: "start", t: 2 }]);
  });
});

describe("linkOverStream diagnostics", () => {
  it("hands allowlisted stderr lines to onDiag and drops the rest; a throwing listener never breaks the link", async () => {
    const stream = new Duplex({ read() {}, write: (_c, _e, cb) => cb() });
    const link = linkOverStream(stream);
    const got: AgentDiag[] = [];
    link.onDiag(() => {
      throw new Error("listener failed");
    });
    link.onDiag((d) => got.push(d));
    stream.push(
      dockerFrame(2, Buffer.from('ocw-brw: free text\n{"brw":1,"ev":"stdin_first","t":75,"bytes":2}\n')),
    );
    stream.push(dockerFrame(1, jsonFrame({ event: "ready", browserSandbox: "chromium", runtime: "runc" })));
    await expect(link.ready(1_000)).resolves.toMatchObject({ browserSandbox: "chromium" });
    expect(got).toEqual([{ brw: 1, ev: "stdin_first", t: 75, bytes: 2 }]);
    expect(link.closed).toBe(false);
    link.close();
  });
});
