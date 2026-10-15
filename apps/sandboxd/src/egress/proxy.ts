import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import net, { BlockList } from "node:net";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import {
  compileCidrs,
  decideAddress,
  decideHost,
  type EgressHostPolicy,
  type EgressMode,
  type EgressRefusalReason,
  normalizeHost,
} from "@ocw/egress-policy";

/**
 * `sandbox-egress` (07.8 D-11, SBX-03): the forward proxy every bot sandbox reaches the outside through. CONNECT for
 * https and absolute-URI requests for http; it never intercepts TLS, caches or logs a body, a path or a query.
 *
 * - Identity by arrival network: the proxy sits on each bot's internal network and the local address a connection
 *   arrived on names that network's policy. A sandbox carries no proxy credential and cannot pick another policy.
 * - Each request is decided with the API's own 07.4 rules (`@ocw/egress-policy`): mode, allow-list, ports 80/443,
 *   platform names, then the host is resolved ONCE, every answer is decided and the request is refused if any answer
 *   is refused; the socket then connects to the first validated address only (pinning: no DNS rebinding window).
 * - The single shared hop (D-01): before any allow-list, an answer is refused if it is one of the proxy's own
 *   addresses (the policy's and every interface's), inside a bot network, or inside any network the proxy is attached
 *   to, unless the arrival network allows that exact fixture `host:port`. Without bot networks and own addresses
 *   there is no policy at all: every request is refused.
 * - One decision line per new (network, host, port, decision): `{ network, host, port, allowed, reason }`.
 */

export type ProxyLookup = (host: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

/** The policy of one per-bot network, keyed by the proxy's own address on that network. */
export interface EgressNetworkPolicy {
  orgId: string;
  agentId: string;
  kind: "sbx" | "brw" | "installer" | "review";
  mode: EgressMode;
  allowHosts: readonly string[];
  privateHosts: readonly string[];
}

export interface EgressPolicySnapshot {
  /** Proxy address on a network → that network's policy. */
  networks: ReadonlyMap<string, EgressNetworkPolicy>;
  /** Every bot network's subnet: refused for every network, before the private-host allowlist. */
  botNetworks: BlockList;
  /** The proxy's address on every network: refused first. */
  ownAddresses: readonly string[];
}

/** The proxy's interfaces now (networks get attached at runtime): addresses and their subnets as CIDRs. */
export interface LocalNetworks {
  addresses: readonly string[];
  subnets: readonly string[];
}

/** Non-loopback interfaces of this container (loopback is refused by classification anyway). */
export function interfaceNetworks(): LocalNetworks {
  const addresses: string[] = [];
  const subnets: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.internal || !i.cidr) continue;
      addresses.push(normalizeHost(i.address));
      subnets.push(i.cidr);
    }
  }
  return { addresses, subnets };
}

/** Bound on every host list of one network (mirrors SANDBOX_LIMITS.allowHostsMax in @ocw/contracts). */
const MAX_HOSTS = 64;
const MAX_NETWORKS = 4096;
const MODES: readonly EgressMode[] = ["off", "allowlist", "public"];
const KINDS: readonly EgressNetworkPolicy["kind"][] = ["sbx", "brw", "installer", "review"];

class PolicyError extends Error {
  constructor(what: string) {
    super(`invalid egress policy: ${what}`);
    this.name = "PolicyError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function onlyKeys(v: Record<string, unknown>, allowed: readonly string[], what: string) {
  for (const key of Object.keys(v))
    if (!allowed.includes(key)) throw new PolicyError(`unknown key in ${what}`);
}

function stringList(v: unknown, what: string, max = MAX_HOSTS): string[] {
  if (!Array.isArray(v) || v.length > max) throw new PolicyError(what);
  return v.map((s) => {
    if (typeof s !== "string" || s.length === 0 || s.length > 260) throw new PolicyError(what);
    return s;
  });
}

function idString(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 64) throw new PolicyError(what);
  return v;
}

/**
 * The policy file the broker writes into the proxy's tmpfs (`docker exec` as root, 07.8-13). Validated by hand (the
 * image carries no npm package) and strictly: any unknown key or bad value refuses the whole file.
 */
export function parseEgressPolicy(value: unknown): EgressPolicySnapshot {
  if (!isRecord(value)) throw new PolicyError("not an object");
  onlyKeys(value, ["networks", "botNetworks", "ownAddresses"], "policy");
  if (!Array.isArray(value.networks) || value.networks.length > MAX_NETWORKS)
    throw new PolicyError("networks");
  const networks = new Map<string, EgressNetworkPolicy>();
  for (const raw of value.networks) {
    if (!isRecord(raw)) throw new PolicyError("network entry");
    onlyKeys(
      raw,
      ["address", "orgId", "agentId", "kind", "mode", "allowHosts", "privateHosts"],
      "network entry",
    );
    const address = typeof raw.address === "string" ? normalizeHost(raw.address) : "";
    if (!net.isIP(address)) throw new PolicyError("network address");
    if (networks.has(address)) throw new PolicyError("duplicate network address");
    if (!MODES.includes(raw.mode as EgressMode)) throw new PolicyError("mode");
    if (!KINDS.includes(raw.kind as EgressNetworkPolicy["kind"])) throw new PolicyError("kind");
    networks.set(address, {
      orgId: idString(raw.orgId, "orgId"),
      agentId: idString(raw.agentId, "agentId"),
      kind: raw.kind as EgressNetworkPolicy["kind"],
      mode: raw.mode as EgressMode,
      allowHosts: stringList(raw.allowHosts, "allowHosts"),
      privateHosts: stringList(raw.privateHosts, "privateHosts"),
    });
  }
  // Fail closed: a policy that names no bot network or no own address cannot keep bots apart.
  const cidrs = stringList(value.botNetworks, "botNetworks", MAX_NETWORKS);
  if (cidrs.length === 0) throw new PolicyError("botNetworks is empty");
  let botNetworks: BlockList;
  try {
    botNetworks = compileCidrs(cidrs);
  } catch {
    throw new PolicyError("botNetworks");
  }
  const ownAddresses = stringList(value.ownAddresses, "ownAddresses", MAX_NETWORKS).map(normalizeHost);
  if (ownAddresses.length === 0) throw new PolicyError("ownAddresses is empty");
  if (!ownAddresses.every((a) => net.isIP(a))) throw new PolicyError("ownAddresses");
  return { networks, botNetworks, ownAddresses };
}

/** No policy loaded: every connection is refused as `unknown_network`. */
export const EMPTY_POLICY: EgressPolicySnapshot = {
  networks: new Map(),
  botNetworks: new BlockList(),
  ownAddresses: [],
};

export type DecisionReason = EgressRefusalReason | "allowed" | "unknown_network" | "dns_failed";

export interface DecisionLine {
  network: string;
  host: string;
  port: number;
  allowed: boolean;
  reason: DecisionReason;
}

export interface CreateEgressProxyOptions {
  /** The current policy; read per request, so a reload applies to new requests only. */
  policies: () => EgressPolicySnapshot;
  /** The proxy's interfaces (default: os.networkInterfaces(), read per request). */
  localNetworks?: () => LocalNetworks;
  lookup?: ProxyLookup;
  /** The outbound connect to a validated address (tests route it to a local server). */
  connect?: (address: string, port: number) => net.Socket;
  log: (line: DecisionLine) => void;
  connectTimeoutMs?: number;
  /** Idle time after which a tunnel or a forwarded request is closed. */
  idleTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
/** Bound on remembered decisions; the set is cleared past it (lines then repeat, never grow memory). */
const MAX_REMEMBERED = 10_000;

const HOST_RE = /^[a-z0-9_]([a-z0-9_-]{0,62})(\.[a-z0-9_]([a-z0-9_-]{0,62}))*$/;

/** Hop-by-hop headers (RFC 9110 §7.6.1) plus the proxy's own; never forwarded either way. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const defaultLookup: ProxyLookup = async (host) => {
  const all = await dnsLookup(host, { all: true, verbatim: true });
  return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

/** The proxy's address a socket arrived on, without an IPv4-mapped prefix. */
export function arrivalAddress(socket: net.Socket): string {
  const local = normalizeHost(socket.localAddress ?? "");
  return local.startsWith("::ffff:") && net.isIP(local.slice(7)) === 4 ? local.slice(7) : local;
}

/** `host:port` of a CONNECT authority; null when malformed. */
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const m =
    /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(authority) ?? /^([^:[\]/@\s]+):(\d{1,5})$/.exec(authority);
  if (!m?.[1] || !m[2]) return null;
  return validTarget(m[1], Number(m[2]));
}

function validTarget(rawHost: string, port: number): { host: string; port: number } | null {
  const host = normalizeHost(rawHost);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (net.isIP(host)) return { host, port };
  if (host.length > 253 || !HOST_RE.test(host)) return null;
  return { host, port };
}

function headersOut(raw: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i] as string, raw[i + 1] as string]);
  const named = new Set<string>();
  for (const [name, value] of pairs) {
    if (name.toLowerCase() === "connection") {
      for (const token of value.split(",")) named.add(token.trim().toLowerCase());
    }
  }
  return pairs.filter(([name]) => {
    const n = name.toLowerCase();
    return !HOP_BY_HOP.has(n) && !named.has(n);
  });
}

export function createEgressProxy(options: CreateEgressProxyOptions): http.Server {
  const lookup = options.lookup ?? defaultLookup;
  const localNetworks = options.localNetworks ?? interfaceNetworks;
  const connect =
    options.connect ?? ((address: string, port: number) => net.connect({ host: address, port }));
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const remembered = new Set<string>();

  const report = (line: DecisionLine) => {
    const key = `${line.network}\u0000${line.host}\u0000${line.port}\u0000${line.reason}`;
    if (remembered.has(key)) return;
    if (remembered.size >= MAX_REMEMBERED) remembered.clear();
    remembered.add(key);
    try {
      options.log(line);
    } catch {
      // Logging never decides traffic.
    }
  };

  type Outcome =
    | { allowed: true; address: string }
    | { allowed: false; reason: Exclude<DecisionReason, "allowed">; status: 403 | 502 };

  /** Decide one request: policy by arrival network, host rules, one lookup, every answer, pinned address. */
  async function decide(network: string, host: string, port: number): Promise<Outcome> {
    const finish = (outcome: Outcome): Outcome => {
      report({
        network,
        host,
        port,
        allowed: outcome.allowed,
        reason: outcome.allowed ? "allowed" : outcome.reason,
      });
      return outcome;
    };
    let snapshot: EgressPolicySnapshot;
    let local: LocalNetworks;
    let attachedNetworks: BlockList;
    try {
      snapshot = options.policies();
      local = localNetworks();
      attachedNetworks = compileCidrs(local.subnets);
    } catch {
      return finish({ allowed: false, reason: "unknown_network", status: 403 });
    }
    const entry = snapshot.networks.get(network);
    // Fail closed: without bot networks and own addresses the shared hop cannot keep bots apart.
    if (!entry || snapshot.ownAddresses.length === 0) {
      return finish({ allowed: false, reason: "unknown_network", status: 403 });
    }
    const policy: EgressHostPolicy = {
      mode: entry.mode,
      allowHosts: entry.allowHosts,
      privateHosts: entry.privateHosts,
      botNetworks: snapshot.botNetworks,
      ownAddresses: [...snapshot.ownAddresses, ...local.addresses],
      attachedNetworks,
    };

    let answers: Array<{ address: string }>;
    if (net.isIP(host)) answers = [{ address: host }];
    else {
      // Name rules first: a refused name is never resolved.
      const byHost = decideHost({ ...policy, host, port });
      if (!byHost.allowed) return finish({ allowed: false, reason: byHost.reason, status: 403 });
      try {
        answers = await lookup(host);
      } catch {
        return finish({ allowed: false, reason: "dns_failed", status: 502 });
      }
    }
    if (answers.length === 0) return finish({ allowed: false, reason: "dns_failed", status: 502 });
    for (const answer of answers) {
      const d = decideAddress({ ...policy, host, port, address: answer.address });
      if (!d.allowed) return finish({ allowed: false, reason: d.reason, status: 403 });
    }
    return finish({ allowed: true, address: normalizeHost((answers[0] as { address: string }).address) });
  }

  /** Never rejects: anything unexpected is a refusal, never a hanging client. */
  const decideSafely = (network: string, host: string, port: number): Promise<Outcome> =>
    decide(network, host, port).catch(() => ({
      allowed: false as const,
      reason: "unknown_network" as const,
      status: 403 as const,
    }));

  /** Opens the pinned upstream; resolves once connected, rejects on error or timeout. */
  function openUpstream(address: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const upstream = connect(address, port);
      const timer = setTimeout(() => {
        upstream.destroy();
        reject(new Error("connect timeout"));
      }, connectTimeoutMs);
      upstream.once("connect", () => {
        clearTimeout(timer);
        upstream.off("error", onError);
        resolve(upstream);
      });
      const onError = () => {
        clearTimeout(timer);
        reject(new Error("connect failed"));
      };
      upstream.once("error", onError);
    });
  }

  const rawRefusal = (socket: Duplex, status: number, reason: string) => {
    const text = status === 400 ? "Bad Request" : status === 403 ? "Forbidden" : "Bad Gateway";
    socket.end(
      `HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain\r\nX-OCW-Egress: ${reason}\r\n` +
        `Content-Length: ${reason.length + 1}\r\nConnection: close\r\n\r\n${reason}\n`,
    );
  };

  const server = http.createServer();

  server.on("connect", (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    client.on("error", () => client.destroy());
    const target = parseAuthority(req.url ?? "");
    if (!target) return rawRefusal(client, 400, "bad_request");
    const network = arrivalAddress(req.socket);
    void decideSafely(network, target.host, target.port).then(async (outcome) => {
      if (!outcome.allowed) return rawRefusal(client, outcome.status, outcome.reason);
      let upstream: net.Socket;
      try {
        upstream = await openUpstream(outcome.address, target.port);
      } catch {
        return rawRefusal(client, 502, "upstream_failed");
      }
      if (client.destroyed) return upstream.destroy();
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });

  server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
    const refuse = (status: number, reason: string) => {
      res.writeHead(status, { "content-type": "text/plain", "x-ocw-egress": reason, connection: "close" });
      res.end(`${reason}\n`);
    };
    const raw = req.url ?? "";
    if (!raw.startsWith("http://")) return refuse(400, "bad_request");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return refuse(400, "bad_request");
    }
    if (url.username || url.password) return refuse(400, "bad_request");
    const target = validTarget(url.hostname, Number(url.port || 80));
    if (!target) return refuse(400, "bad_request");
    const network = arrivalAddress(req.socket);
    void decideSafely(network, target.host, target.port).then((outcome) => {
      if (!outcome.allowed) return refuse(outcome.status, outcome.reason);
      const headers = headersOut(req.rawHeaders).filter(([name]) => name.toLowerCase() !== "host");
      headers.push(["Host", url.host]);
      const upstreamReq = http.request({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: headers.flat(),
        setHost: false,
        // No agent: createConnection is used only without one, and it connects to the pinned address (no lookup).
        createConnection: () => connect(outcome.address, target.port),
        timeout: connectTimeoutMs,
      });
      upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("timeout")));
      upstreamReq.on("error", () => {
        if (!res.headersSent) refuse(502, "upstream_failed");
        else res.destroy();
      });
      upstreamReq.on("response", (upstreamRes) => {
        upstreamReq.setTimeout(idleTimeoutMs);
        res.writeHead(
          upstreamRes.statusCode ?? 502,
          upstreamRes.statusMessage,
          headersOut(upstreamRes.rawHeaders).flat(),
        );
        upstreamRes.pipe(res);
        upstreamRes.on("error", () => res.destroy());
      });
      res.on("close", () => upstreamReq.destroy());
      req.pipe(upstreamReq);
    });
  });

  // An Upgrade over plain http (e.g. ws://) is not proxied; Node closes the socket when no listener exists.
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });

  return server;
}
