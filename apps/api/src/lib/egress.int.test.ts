import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEgress, EgressRefusedError } from "./egress";

/**
 * The egress guard against real sockets (D-07, CONN-05). Local servers stand in for remote hosts; a stub resolver
 * stands in for DNS, so every case is deterministic and nothing leaves the machine.
 */

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface Local {
  server: Server;
  port: number;
  requests: Array<{ path: string; localAddress: string | undefined }>;
  connections: number;
}

async function listen(handler: Handler, host = "127.0.0.1"): Promise<Local> {
  const local: Local = { server: createServer(), port: 0, requests: [], connections: 0 };
  local.server.on("connection", () => {
    local.connections += 1;
  });
  local.server.on("request", (req, res) => {
    local.requests.push({ path: req.url ?? "", localAddress: req.socket.localAddress });
    handler(req, res);
  });
  await new Promise<void>((resolve) => local.server.listen(0, host, resolve));
  local.port = (local.server.address() as AddressInfo).port;
  return local;
}

const close = (local: Local | undefined) =>
  new Promise<void>((resolve) => {
    if (!local) return resolve();
    local.server.closeAllConnections();
    local.server.close(() => resolve());
  });

type Answer = Array<{ address: string; family: 4 | 6 }>;

/** A stub resolver: answers from a table (or a per-call sequence) and records every name it was asked for. */
function stubLookup(table: Record<string, Answer | Answer[]>) {
  const calls: string[] = [];
  const seen = new Map<string, number>();
  const lookup = async (host: string): Promise<Answer> => {
    calls.push(host);
    const n = seen.get(host) ?? 0;
    seen.set(host, n + 1);
    const entry = table[host];
    if (!entry) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    const sequence = Array.isArray(entry[0]) ? (entry as Answer[]) : [entry as Answer];
    return sequence[Math.min(n, sequence.length - 1)] as Answer;
  };
  return { lookup, calls };
}

const v4 = (address: string) => [{ address, family: 4 as const }];

async function refusal(promise: Promise<unknown>): Promise<EgressRefusedError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EgressRefusedError);
  return err as EgressRefusedError;
}

describe("egress guard: the tracer (pinned, validated connect)", () => {
  let ok: Local;

  beforeAll(async () => {
    ok = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  afterAll(() => close(ok));

  it("an allowed test host reaches the local server through the address it validated, once", async () => {
    const dns = stubLookup({ "svc.test": v4("127.0.0.1") });
    const egress = createEgress({
      platformHosts: [],
      testHosts: new Map([["svc.test", "127.0.0.1"]]),
      lookup: dns.lookup,
    });
    const before = ok.requests.length;
    const res = await egress.fetch(`http://svc.test:${ok.port}/ok`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(ok.requests.length - before).toBe(1);
    expect(ok.requests.at(-1)?.localAddress).toBe("127.0.0.1");
    // One connection, one resolution.
    expect(dns.calls).toEqual(["svc.test"]);
  });

  it("a host that resolves to a private address is refused before any connection", async () => {
    const dns = stubLookup({ "evil.test": v4("10.0.0.5") });
    const egress = createEgress({ platformHosts: [], lookup: dns.lookup });
    const connections = ok.connections;
    const err = await refusal(egress.fetch("https://evil.test/"));
    expect(err.code).toBe("private_address");
    expect(err.host).toBe("evil.test");
    expect(dns.calls).toEqual(["evil.test"]);
    expect(ok.connections).toBe(connections);
  });

  it("DNS rebinding cannot swap the address: the name is resolved once and the validated address is the one used", async () => {
    // The first answer is the allowed loopback test address; any later answer would be the metadata service.
    const dns = stubLookup({ "flip.test": [v4("127.0.0.1"), v4("169.254.169.254")] });
    const egress = createEgress({
      platformHosts: [],
      testHosts: new Map([["flip.test", "127.0.0.1"]]),
      lookup: dns.lookup,
    });
    const res = await egress.fetch(`http://flip.test:${ok.port}/once`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(dns.calls).toEqual(["flip.test"]);
    expect(ok.requests.at(-1)).toEqual({ path: "/once", localAddress: "127.0.0.1" });
  });

  it("a test host is only exempt for its mapped address: another answer is checked like any host", async () => {
    const dns = stubLookup({ "svc.test": v4("10.9.9.9") });
    const egress = createEgress({
      platformHosts: [],
      testHosts: new Map([["svc.test", "127.0.0.1"]]),
      lookup: dns.lookup,
    });
    const err = await refusal(egress.fetch(`http://svc.test:${ok.port}/ok`));
    expect(err.code).toBe("private_address");
  });
});
