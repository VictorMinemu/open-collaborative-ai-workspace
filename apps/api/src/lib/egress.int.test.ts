import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEgress, EgressRefusedError, readCapped } from "./egress";

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

describe("egress guard: the whole policy against real sockets", () => {
  let srv: Local;
  const big = Buffer.alloc(2 * 1024 * 1024, 0x61); // 2 MiB of "a"

  beforeAll(async () => {
    srv = await listen((req, res) => {
      const path = req.url ?? "";
      if (path === "/redirect-metadata") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        return res.end();
      }
      if (path === "/redirect-local") {
        res.writeHead(302, { location: "/target" });
        return res.end();
      }
      if (path === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end(big);
      }
      if (path.startsWith("/hang") || path.startsWith("/secret-path")) return; // never answers
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
  });
  afterAll(() => close(srv));

  const local = (extra: Record<string, Answer | Answer[]> = {}) => {
    const dns = stubLookup({ "svc.test": v4("127.0.0.1"), ...extra });
    const egress = createEgress({
      platformHosts: [],
      testHosts: new Map([["svc.test", "127.0.0.1"]]),
      lookup: dns.lookup,
    });
    return { egress, dns };
  };

  it("a host whose answer mixes a public and a private address is refused, before any connection", async () => {
    const { egress, dns } = local({
      "mixed.test": [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
    });
    const err = await refusal(egress.fetch("https://mixed.test/"));
    expect(err.code).toBe("private_address");
    expect(dns.calls).toEqual(["mixed.test"]);
  });

  it("a literal loopback URL never connects without a test host", async () => {
    const { egress } = local();
    const connections = srv.connections;
    const err = await refusal(egress.fetch(`http://127.0.0.1:${srv.port}/ok`, {}, { requireHttps: false }));
    expect(err.code).toBe("private_address");
    expect(srv.connections).toBe(connections);
  });

  it("a test host on the platform list never connects", async () => {
    const dns = stubLookup({ "svc.test": v4("127.0.0.1") });
    const egress = createEgress({
      platformHosts: [`127.0.0.1:${srv.port}`],
      testHosts: new Map([["svc.test", "127.0.0.1"]]),
      lookup: dns.lookup,
    });
    const connections = srv.connections;
    const err = await refusal(egress.fetch(`http://svc.test:${srv.port}/ok`));
    expect(err.code).toBe("platform_host");
    expect(srv.connections).toBe(connections);
  });

  it("privateAllow admits the exact host:port to a private address, never loopback and never another port", async () => {
    const { egress } = local({
      "intranet.test": v4("10.255.255.1"),
      "loop.test": v4("127.0.0.1"),
    });
    const allow = { privateAllow: ["intranet.test:9443", "loop.test:9443"], timeoutMs: 400 };
    // Admitted over plain http: the guard gets as far as connecting to the unroutable address.
    const admitted = await refusal(egress.fetch("http://intranet.test:9443/", {}, allow));
    expect(["timeout", "network_error"]).toContain(admitted.code);
    // Loopback is never admitted.
    expect((await refusal(egress.fetch("http://loop.test:9443/", {}, allow))).code).toBe("private_address");
    // Another port is not the allowed host:port.
    expect((await refusal(egress.fetch("https://intranet.test:9444/", {}, allow))).code).toBe(
      "private_address",
    );
    expect((await refusal(egress.fetch("http://intranet.test:9444/", {}, allow))).code).toBe(
      "https_required",
    );
  });

  it("a redirect is returned to the caller and never followed", async () => {
    const { egress } = local();
    const before = srv.requests.length;
    const res = await egress.fetch(`http://svc.test:${srv.port}/redirect-metadata`, { redirect: "follow" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://169.254.169.254/latest/meta-data/");
    const same = await egress.fetch(`http://svc.test:${srv.port}/redirect-local`);
    expect(same.status).toBe(302);
    expect(srv.requests.slice(before).map((r) => r.path)).toEqual(["/redirect-metadata", "/redirect-local"]);
  });

  it("readCapped stops at maxBytes; reading past the policy cap fails with too_large", async () => {
    const { egress } = local();
    const cap = 256 * 1024;
    const res = await egress.fetch(`http://svc.test:${srv.port}/big`, {}, { maxBytes: cap });
    const read = await readCapped(res, cap);
    expect(read.truncated).toBe(true);
    expect(read.text.length).toBe(cap);

    const small = await readCapped(await egress.fetch(`http://svc.test:${srv.port}/ok`), cap);
    expect(small).toEqual({ text: "ok", truncated: false });

    const raw = await egress.fetch(`http://svc.test:${srv.port}/big`, {}, { maxBytes: cap });
    const err = await refusal(raw.text());
    expect(err.code).toBe("too_large");
  });

  it("a server that never answers is cut off at timeoutMs", async () => {
    const { egress } = local();
    const started = Date.now();
    const err = await refusal(egress.fetch(`http://svc.test:${srv.port}/hang`, {}, { timeoutMs: 500 }));
    expect(err.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("no error carries the path or the query", async () => {
    const { egress } = local({ "evil.test": v4("10.0.0.5") });
    const canary = "/secret-path?token=CANARY";
    const errors = [
      await refusal(egress.fetch(`http://svc.test:${srv.port}${canary}`, {}, { timeoutMs: 300 })),
      await refusal(egress.fetch(`https://evil.test${canary}`)),
      await refusal(egress.fetch(`http://svc.test:1${canary}`)),
    ];
    expect(errors.map((e) => e.code)).toEqual(["timeout", "private_address", "network_error"]);
    for (const err of errors) {
      expect(`${err.message} ${err.stack ?? ""} ${JSON.stringify(err)}`).not.toMatch(/CANARY|secret-path/);
    }
  });

  it("bound() is fetch-compatible (the MCP SDK's fetchFn) and accepts a Request", async () => {
    const { egress } = local();
    const f = egress.bound({});
    const res = await f(`http://svc.test:${srv.port}/ok`);
    expect(await res.text()).toBe("ok");
    const viaRequest = await f(new Request(`http://svc.test:${srv.port}/ok`, { method: "POST", body: "x" }));
    expect(viaRequest.status).toBe(200);
    expect((await refusal(f("http://public.test/"))).code).toBe("https_required");
  });
});
