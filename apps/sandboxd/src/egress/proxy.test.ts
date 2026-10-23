import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEgressProxy,
  type DecisionLine,
  type EgressNetworkPolicy,
  type EgressPolicySnapshot,
  EMPTY_POLICY,
  type LocalNetworks,
  type ProxyLookup,
  parseEgressPolicy,
} from "./proxy.ts";

/**
 * In-process cases of the sandbox egress proxy (07.8-12, D-11, SBX-03). The resolver is injected (no DNS) and so is the
 * outbound connect: a "public" address the proxy pins is routed to a local echo or HTTP server, and every pinned
 * address is recorded, so the tests see exactly where the proxy would have connected.
 */

type Answer = Array<{ address: string; family: 4 | 6 }>;

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()?.();
});

const close = (server: net.Server) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
    (server as http.Server).closeAllConnections?.();
  });

async function listen<T extends net.Server>(server: T, host = "127.0.0.1"): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  closers.push(() => close(server));
  return (server.address() as AddressInfo).port;
}

/** A TCP echo server: what a tunnel reaches. */
async function echoServer(): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.pipe(s);
  });
  const port = await listen(server);
  closers.push(async () => {
    for (const s of sockets) s.destroy();
  });
  return port;
}

const network = (patch: Partial<EgressNetworkPolicy> = {}): EgressNetworkPolicy => ({
  orgId: "org-a",
  agentId: "agent-a",
  kind: "sbx",
  mode: "public",
  allowHosts: [],
  privateHosts: [],
  ...patch,
});

const snapshot = (networks: Record<string, EgressNetworkPolicy>): EgressPolicySnapshot =>
  parseEgressPolicy({
    networks: Object.entries(networks).map(([address, n]) => ({ address, ...n })),
    botNetworks: ["10.250.0.0/24"],
    ownAddresses: ["10.250.0.2"],
  });

interface Harness {
  port: number;
  lookup: ReturnType<typeof vi.fn<ProxyLookup>>;
  pinned: Array<{ address: string; port: number }>;
  lines: DecisionLine[];
}

/** The proxy's interfaces in the tests: none beyond loopback unless a test says so. */
const NO_INTERFACES: LocalNetworks = { addresses: [], subnets: [] };

async function harness(opts: {
  policy: () => EgressPolicySnapshot;
  local?: LocalNetworks;
  answers: Record<string, Answer | ((call: number) => Answer)>;
  upstreamPort: number;
  host?: string;
}): Promise<Harness> {
  const calls = new Map<string, number>();
  const lookup = vi.fn<ProxyLookup>(async (host) => {
    const n = (calls.get(host) ?? 0) + 1;
    calls.set(host, n);
    const a = opts.answers[host];
    if (!a) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    return typeof a === "function" ? a(n) : a;
  });
  const pinned: Array<{ address: string; port: number }> = [];
  const lines: DecisionLine[] = [];
  const proxy = createEgressProxy({
    policies: opts.policy,
    localNetworks: () => opts.local ?? NO_INTERFACES,
    lookup,
    connect: (address, port) => {
      pinned.push({ address, port });
      return net.connect(opts.upstreamPort, "127.0.0.1");
    },
    log: (line) => lines.push(line),
  });
  const port = await listen(proxy, opts.host ?? "127.0.0.1");
  return { port, lookup, pinned, lines };
}

/** Sends a CONNECT and reads the response head; the socket stays open for the tunnel. */
async function connectVia(
  proxyPort: number,
  authority: string,
  proxyHost = "127.0.0.1",
): Promise<{ status: number; reason: string | null; socket: net.Socket }> {
  const socket = net.connect(proxyPort, proxyHost);
  closers.push(async () => {
    socket.destroy();
  });
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  const head = await new Promise<string>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end >= 0) {
        socket.off("data", onData);
        resolve(buf.slice(0, end));
      }
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.on("close", () => resolve(buf));
  });
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
  const reason = /\r\nx-ocw-egress: ([a-z_]+)/i.exec(head)?.[1] ?? null;
  return { status, reason, socket };
}

const roundTrip = (socket: net.Socket, text: string) =>
  new Promise<string>((resolve) => {
    socket.once("data", (d) => resolve(d.toString()));
    socket.write(text);
  });

const PUBLIC: Answer = [{ address: "93.184.216.34", family: 4 }];

describe("sandbox-egress: CONNECT", () => {
  it("a public host in mode public is tunnelled to the one resolved address (lookup once, pinned connect)", async () => {
    const upstreamPort = await echoServer();
    const h = await harness({
      policy: () => snapshot({ "127.0.0.1": network() }),
      answers: { "public.test": PUBLIC },
      upstreamPort,
    });
    const res = await connectVia(h.port, "public.test:443");
    expect(res.status).toBe(200);
    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(h.pinned).toEqual([{ address: "93.184.216.34", port: 443 }]);
    expect(await roundTrip(res.socket, "ping")).toBe("ping");
  });

  it("one refused answer among several refuses the request (refused_address) and never connects", async () => {
    const h = await harness({
      policy: () => snapshot({ "127.0.0.1": network() }),
      answers: {
        "mixed.test": [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.5", family: 4 },
        ],
      },
      upstreamPort: 1,
    });
    const res = await connectVia(h.port, "mixed.test:443");
    expect(res.status).toBe(403);
    expect(res.reason).toBe("refused_address");
    expect(h.pinned).toEqual([]);
  });

  it("a port other than 80 and 443 is refused before any lookup", async () => {
    const h = await harness({
      policy: () => snapshot({ "127.0.0.1": network() }),
      answers: { x: PUBLIC },
      upstreamPort: 1,
    });
    const res = await connectVia(h.port, "x:22");
    expect([res.status, res.reason]).toEqual([403, "port"]);
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it("mode off refuses with egress_off", async () => {
    const h = await harness({
      policy: () => snapshot({ "127.0.0.1": network({ mode: "off" }) }),
      answers: { "public.test": PUBLIC },
      upstreamPort: 1,
    });
    const res = await connectVia(h.port, "public.test:443");
    expect([res.status, res.reason]).toEqual([403, "egress_off"]);
  });

  it("mode allowlist admits only the listed host", async () => {
    const upstreamPort = await echoServer();
    const h = await harness({
      policy: () => snapshot({ "127.0.0.1": network({ mode: "allowlist", allowHosts: ["api.github.com"] }) }),
      answers: { "api.github.com": PUBLIC, "github.com": PUBLIC },
      upstreamPort,
    });
    expect((await connectVia(h.port, "api.github.com:443")).status).toBe(200);
    const other = await connectVia(h.port, "github.com:443");
    expect([other.status, other.reason]).toEqual([403, "not_allowlisted"]);
  });

  it("platform names, metadata and loopback are refused even when listed as private hosts", async () => {
    const h = await harness({
      policy: () =>
        snapshot({
          "127.0.0.1": network({ privateHosts: ["sandboxd:8090", "169.254.169.254:80", "127.0.0.1:8080"] }),
        }),
      answers: { sandboxd: [{ address: "172.18.0.4", family: 4 }] },
      upstreamPort: 1,
    });
    expect((await connectVia(h.port, "sandboxd:8090")).reason).toBe("platform_host");
    expect((await connectVia(h.port, "sandbox-egress:443")).reason).toBe("platform_host");
    expect((await connectVia(h.port, "169.254.169.254:80")).reason).toBe("refused_address");
    expect((await connectVia(h.port, "127.0.0.1:8080")).reason).toBe("refused_address");
    expect((await connectVia(h.port, "localhost:443")).reason).toBe("refused_address");
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.pinned).toEqual([]);
  });

  it("an unresolvable host answers 502 dns_failed", async () => {
    const h = await harness({
      policy: () => snapshot({ "127.0.0.1": network() }),
      answers: {},
      upstreamPort: 1,
    });
    const res = await connectVia(h.port, "nowhere.test:443");
    expect([res.status, res.reason]).toEqual([502, "dns_failed"]);
  });

  it("a malformed authority answers 400", async () => {
    const h = await harness({
      policy: () => snapshot({ "127.0.0.1": network() }),
      answers: {},
      upstreamPort: 1,
    });
    expect((await connectVia(h.port, "no-port")).status).toBe(400);
    expect((await connectVia(h.port, "a/b:443")).status).toBe(400);
  });
});

describe("sandbox-egress: absolute-URI HTTP", () => {
  it("forwards to the pinned address with the original Host and without hop-by-hop headers", async () => {
    const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
    const upstream = http.createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "text/plain", connection: "close", "x-upstream": "1" });
      res.end("hello");
    });
    const upstreamPort = await listen(upstream);
    const h = await harness({
      policy: () => snapshot({ "127.0.0.1": network() }),
      answers: { "public.test": PUBLIC },
      upstreamPort,
    });
    const res = await new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
      (resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: h.port,
          method: "GET",
          path: "http://public.test/x?token=CANARY",
          headers: {
            host: "public.test",
            "proxy-connection": "keep-alive",
            "proxy-authorization": "Basic Q0FOQVJZ",
            te: "trailers",
            connection: "keep-alive, x-drop",
            "x-drop": "1",
            "x-keep": "1",
          },
          agent: false,
        });
        req.on("response", (r) => {
          let body = "";
          r.on("data", (d) => {
            body += d;
          });
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body, headers: r.headers }));
        });
        req.on("error", reject);
        req.end();
      },
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe("hello");
    expect(res.headers["x-upstream"]).toBe("1");
    expect(h.pinned).toEqual([{ address: "93.184.216.34", port: 80 }]);
    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("/x?token=CANARY");
    expect(seen[0]?.headers.host).toBe("public.test");
    expect(seen[0]?.headers["x-keep"]).toBe("1");
    for (const name of ["proxy-connection", "proxy-authorization", "te", "x-drop"]) {
      expect(seen[0]?.headers[name]).toBeUndefined();
    }
  });

  it("never forwards an X-OCW-Egress header either way: a site cannot forge the proxy's refusal (#254)", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const upstream = http.createServer((req, res) => {
      seen.push(req.headers);
      // A site answering its own http page with the proxy's refusal shape.
      res.writeHead(403, {
        "content-type": "text/plain",
        connection: "close",
        "X-OCW-Egress": "refused_address",
      });
      res.end("forged");
    });
    const upstreamPort = await listen(upstream);
    const h = await harness({
      policy: () => snapshot({ "127.0.0.1": network() }),
      answers: { "public.test": PUBLIC },
      upstreamPort,
    });
    const res = await new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>(
      (resolve, reject) => {
        const req = http.request({
          host: "127.0.0.1",
          port: h.port,
          method: "GET",
          path: "http://public.test/page",
          headers: { host: "public.test", "x-ocw-egress": "egress_off" },
          agent: false,
        });
        req.on("response", (r) => {
          let body = "";
          r.on("data", (d) => {
            body += d;
          });
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body, headers: r.headers }));
        });
        req.on("error", reject);
        req.end();
      },
    );
    // The site's own answer passes through, but never as the proxy's refusal.
    expect(res.status).toBe(403);
    expect(res.body).toBe("forged");
    expect(res.headers["x-ocw-egress"]).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.["x-ocw-egress"]).toBeUndefined();
  });

  it("an https absolute URI, user info or an origin-form request is refused with 400", async () => {
    const h = await harness({
      policy: () => snapshot({ "127.0.0.1": network() }),
      answers: { "public.test": PUBLIC },
      upstreamPort: 1,
    });
    for (const path of ["https://public.test/", "http://u:p@public.test/", "/plain"]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: h.port, path, agent: false });
        req.on("response", (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(400);
    }
    expect(h.pinned).toEqual([]);
  });
});

describe("sandbox-egress: decision lines", () => {
  it("one line per new host per network: network, host, port, allowed and reason only", async () => {
    const upstreamPort = await echoServer();
    const h = await harness({
      policy: () => snapshot({ "127.0.0.1": network() }),
      answers: { "public.test": PUBLIC },
      upstreamPort,
    });
    await connectVia(h.port, "public.test:443");
    await connectVia(h.port, "public.test:443");
    await connectVia(h.port, "x:22");
    await connectVia(h.port, "x:22");
    expect(h.lines).toEqual([
      { network: "127.0.0.1", host: "public.test", port: 443, allowed: true, reason: "allowed" },
      { network: "127.0.0.1", host: "x", port: 22, allowed: false, reason: "port" },
    ]);
  });
});

describe("sandbox-egress: the policy file", () => {
  const entry = {
    address: "10.89.3.2",
    orgId: "org-a",
    agentId: "agent-a",
    kind: "sbx",
    mode: "allowlist",
    allowHosts: ["api.github.com"],
    privateHosts: ["fake-site.local:8080"],
  };

  const file = (patch: Record<string, unknown> = {}) => ({
    networks: [entry],
    botNetworks: ["10.89.3.0/24"],
    ownAddresses: ["10.89.3.2"],
    ...patch,
  });

  it("parses per-network entries keyed by the proxy's address on that network", () => {
    const p = parseEgressPolicy(file());
    expect(p.networks.get("10.89.3.2")).toEqual({
      orgId: "org-a",
      agentId: "agent-a",
      kind: "sbx",
      mode: "allowlist",
      allowHosts: ["api.github.com"],
      privateHosts: ["fake-site.local:8080"],
    });
  });

  it.each([
    ["not an object", 42],
    ["no networks", file({ networks: undefined })],
    ["an unknown key", file({ extra: 1 })],
    ["a bad address", file({ networks: [{ ...entry, address: "proxy" }] })],
    ["a bad mode", file({ networks: [{ ...entry, mode: "open" }] })],
    ["a bad kind", file({ networks: [{ ...entry, kind: "api" }] })],
    ["a non-string host", file({ networks: [{ ...entry, allowHosts: [1] }] })],
    ["too many hosts", file({ networks: [{ ...entry, allowHosts: Array(65).fill("a.test") }] })],
    ["an unknown entry key", file({ networks: [{ ...entry, token: "x" }] })],
    ["a duplicate address", file({ networks: [entry, entry] })],
    ["no blocked subnets", file({ botNetworks: undefined })],
    ["an invalid blocked subnet", file({ botNetworks: ["10.89.3.0/99"] })],
    ["empty bot networks", file({ botNetworks: [] })],
    ["no own addresses", file({ ownAddresses: undefined })],
    ["empty own addresses", file({ ownAddresses: [] })],
    ["an own address that is not an IP", file({ ownAddresses: ["sandbox-egress"] })],
  ])("refuses %s", (_name, value) => {
    expect(() => parseEgressPolicy(value)).toThrow();
  });
});

describe("sandbox-egress: identity by arrival network", () => {
  it("the same CONNECT is allowed on A's address and refused on B's (two listeners, two policies)", async () => {
    const upstreamPort = await echoServer();
    const policy = () =>
      snapshot({ "127.0.0.1": network(), "::1": network({ agentId: "agent-b", mode: "off" }) });
    const answers = { "public.test": PUBLIC };
    const a = await harness({ policy, answers, upstreamPort, host: "127.0.0.1" });
    const b = await harness({ policy, answers, upstreamPort, host: "::1" });
    expect((await connectVia(a.port, "public.test:443", "127.0.0.1")).status).toBe(200);
    const refused = await connectVia(b.port, "public.test:443", "::1");
    expect([refused.status, refused.reason]).toEqual([403, "egress_off"]);
    expect(b.lines).toEqual([
      { network: "::1", host: "public.test", port: 443, allowed: false, reason: "egress_off" },
    ]);
  });

  it("a connection arriving on an address with no policy is refused as unknown_network", async () => {
    const h = await harness({
      policy: () => snapshot({ "10.89.3.2": network() }),
      answers: { "public.test": PUBLIC },
      upstreamPort: 1,
    });
    const res = await connectVia(h.port, "public.test:443");
    expect([res.status, res.reason]).toEqual([403, "unknown_network"]);
    expect(h.lookup).not.toHaveBeenCalled();
  });
});

describe("sandbox-egress: pinning and reload", () => {
  it("DNS rebinding: one CONNECT resolves once and connects to the address it decided on", async () => {
    const upstreamPort = await echoServer();
    const h = await harness({
      policy: () => snapshot({ "127.0.0.1": network() }),
      answers: {
        "rebind.test": (call) =>
          call === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }],
      },
      upstreamPort,
    });
    const first = await connectVia(h.port, "rebind.test:443");
    expect(first.status).toBe(200);
    expect(await roundTrip(first.socket, "ping")).toBe("ping");
    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(h.pinned).toEqual([{ address: "93.184.216.34", port: 443 }]);
    // The next request resolves again and sees loopback: refused, never connected.
    const second = await connectVia(h.port, "rebind.test:443");
    expect([second.status, second.reason]).toEqual([403, "refused_address"]);
    expect(h.pinned).toHaveLength(1);
  });

  it("a reloaded policy applies to new connections only; an open tunnel keeps working", async () => {
    const upstreamPort = await echoServer();
    let current = snapshot({ "127.0.0.1": network() });
    const h = await harness({ policy: () => current, answers: { "public.test": PUBLIC }, upstreamPort });
    const open = await connectVia(h.port, "public.test:443");
    expect(open.status).toBe(200);
    current = snapshot({ "127.0.0.1": network({ mode: "off" }) });
    expect(await roundTrip(open.socket, "still")).toBe("still");
    const next = await connectVia(h.port, "public.test:443");
    expect([next.status, next.reason]).toEqual([403, "egress_off"]);
  });
});

describe("sandbox-egress: decision lines never carry a path or a query", () => {
  it("an absolute-URI GET with ?token=x logs the host only", async () => {
    const upstream = http.createServer((_req, res) => res.end("ok"));
    const upstreamPort = await listen(upstream);
    const h = await harness({
      policy: () => snapshot({ "127.0.0.1": network() }),
      answers: { "public.test": PUBLIC },
      upstreamPort,
    });
    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port: h.port,
        path: "http://public.test/secret-path?token=x",
      });
      req.on("response", (r) => {
        r.resume();
        r.on("end", () => resolve());
      });
      req.on("error", reject);
      req.end();
    });
    const text = JSON.stringify(h.lines);
    expect(text).not.toMatch(/secret-path|token|\?/);
    expect(h.lines).toEqual([
      { network: "127.0.0.1", host: "public.test", port: 80, allowed: true, reason: "allowed" },
    ]);
  });
});

describe("sandbox-egress: the single shared hop", () => {
  const shared = (patch: Partial<EgressNetworkPolicy> = {}) =>
    parseEgressPolicy({
      networks: [
        {
          address: "127.0.0.1",
          ...network({ privateHosts: ["10.89.3.4:8080", "10.89.3.2:3128", "bot-b.test:8080"], ...patch }),
        },
      ],
      botNetworks: ["10.89.3.0/24", "10.89.4.0/24"],
      ownAddresses: ["10.89.3.2", "10.89.4.2"],
    });

  it("an address inside a bot network is refused as bot_network even when it is an allowed private host", async () => {
    const h = await harness({ policy: () => shared(), answers: {}, upstreamPort: 1 });
    const res = await connectVia(h.port, "10.89.3.4:8080");
    expect([res.status, res.reason]).toEqual([403, "bot_network"]);
    expect(h.pinned).toEqual([]);
  });

  it("one of the proxy's own addresses is refused as proxy_self, allowed or not", async () => {
    const h = await harness({ policy: () => shared(), answers: {}, upstreamPort: 1 });
    expect((await connectVia(h.port, "10.89.3.2:3128")).reason).toBe("proxy_self");
    expect((await connectVia(h.port, "10.89.4.2:3128")).reason).toBe("proxy_self");
    expect(h.pinned).toEqual([]);
  });

  it("a host name that resolves into a bot network is refused as bot_network", async () => {
    const h = await harness({
      policy: () => shared(),
      answers: { "bot-b.test": [{ address: "10.89.3.7", family: 4 }] },
      upstreamPort: 1,
    });
    const res = await connectVia(h.port, "bot-b.test:8080");
    expect([res.status, res.reason]).toEqual([403, "bot_network"]);
    expect(h.pinned).toEqual([]);
  });
});

describe("sandbox-egress: fail closed and every attached network (security review)", () => {
  it("no policy (missing, invalid, or without bot networks / own addresses) refuses every CONNECT", async () => {
    const h = await harness({
      policy: () => EMPTY_POLICY,
      answers: { "public.test": PUBLIC },
      upstreamPort: 1,
    });
    const res = await connectVia(h.port, "public.test:443");
    expect([res.status, res.reason]).toEqual([403, "unknown_network"]);
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it("a policy source that throws refuses the request instead of hanging", async () => {
    const h = await harness({
      policy: () => {
        throw new Error("broken");
      },
      answers: { "public.test": PUBLIC },
      upstreamPort: 1,
    });
    const res = await connectVia(h.port, "public.test:443");
    expect([res.status, res.reason]).toEqual([403, "unknown_network"]);
  });

  const shared = () =>
    parseEgressPolicy({
      networks: [
        {
          address: "127.0.0.1",
          ...network({
            privateHosts: ["bot-b.test:8080", "self.test:3128", "fixture.test:8080", "10.77.0.9:8080"],
          }),
        },
      ],
      botNetworks: ["10.89.3.0/24", "10.89.4.0/24"],
      ownAddresses: ["10.89.3.2", "10.89.4.2"],
    });
  // The proxy is also on a fixtures/egress network 10.77.0.0/24 that the broker did not list as a bot network.
  const local: LocalNetworks = {
    addresses: ["10.77.0.2", "10.89.3.2"],
    subnets: ["10.77.0.0/24", "10.89.3.0/24"],
  };

  it("a DNS answer pointing at bot B's IP is refused as bot_network even when the private hosts list it", async () => {
    const h = await harness({
      policy: shared,
      local,
      answers: { "bot-b.test": [{ address: "10.89.4.7", family: 4 }] },
      upstreamPort: 1,
    });
    const res = await connectVia(h.port, "bot-b.test:8080");
    expect([res.status, res.reason]).toEqual([403, "bot_network"]);
    expect(h.pinned).toEqual([]);
  });

  it("a DNS answer pointing at the proxy's own address on any network is refused as proxy_self", async () => {
    const h = await harness({
      policy: shared,
      local,
      answers: {
        "self.test": [{ address: "10.89.4.2", family: 4 }],
        "self2.test": [{ address: "10.77.0.2", family: 4 }],
      },
      upstreamPort: 1,
    });
    expect((await connectVia(h.port, "self.test:3128")).reason).toBe("proxy_self");
    // 10.77.0.2 is not in the file's own addresses: the proxy's interfaces count too.
    expect((await connectVia(h.port, "self2.test:443")).reason).toBe("proxy_self");
    expect(h.pinned).toEqual([]);
  });

  it("an answer inside any attached network is refused unless the arrival network allows that exact fixture", async () => {
    const upstreamPort = await echoServer();
    const h = await harness({
      policy: shared,
      local,
      answers: {
        "fixture.test": [{ address: "10.77.0.5", family: 4 }],
        "other.test": [{ address: "10.77.0.6", family: 4 }],
      },
      upstreamPort,
    });
    expect((await connectVia(h.port, "fixture.test:8080")).status).toBe(200);
    expect((await connectVia(h.port, "other.test:443")).reason).toBe("attached_network");
    expect(h.pinned).toEqual([{ address: "10.77.0.5", port: 8080 }]);
  });

  it("an attached bot subnet has no fixture exception", async () => {
    const h = await harness({ policy: shared, local, answers: {}, upstreamPort: 1 });
    // 10.89.3.0/24 is attached and a bot network: listed or not, it is refused.
    expect((await connectVia(h.port, "10.89.3.9:443")).reason).toBe("bot_network");
  });
});
