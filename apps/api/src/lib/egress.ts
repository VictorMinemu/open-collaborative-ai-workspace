import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, type RequestInit as UndiciRequestInit, fetch as undiciFetch } from "undici";
import type { Env } from "../config/env";

/**
 * The egress guard (D-07, CONN-05, ADR-0025): the only way code in this phase calls a URL that an admin, an
 * authorization server or a model chose. The API shares the compose network with PostgreSQL, Redis, Garage, OpenBao
 * and the cell, so a URL is never trusted to point at the internet.
 *
 * - The host is resolved once, inside undici's connector (`connect.lookup`). Every resolved address is classified
 *   and the request is refused if ANY of them is refused; the socket then connects to the validated address only
 *   (pinning: no window for DNS rebinding between the check and the connect). Literal-IP URLs are classified before
 *   connecting.
 * - Always refused: loopback, unspecified, link-local, cloud metadata, multicast, reserved and documentation ranges,
 *   IPv4-mapped / IPv4-compatible / NAT64 / 6to4 IPv6 forms, `localhost` and metadata host names.
 * - Private (RFC 1918, CGNAT 100.64/10, ULA fc00::/7): refused unless the exact `host:port` is in the call's
 *   `privateAllow`, which also admits plain http to it.
 * - Platform hosts (compose service names, the hosts of the API's own URLs, `127.0.0.1:<PORT>`): refused by name, by
 *   `host:port` and by resolved address, even when a caller allows them.
 * - Redirects are never followed (`redirect: "manual"` is forced), credentials in URLs and non-http(s) schemes are
 *   refused, https is required unless the host is explicitly allowed, and the response is capped in bytes and time.
 * - Errors carry a code and the host only: never a path, a query or a header.
 *
 * `OCW_EGRESS_TEST_HOSTS` (test-only, refused in production) maps test host names to a loopback address. A test host
 * is exempt from the private and https checks for its mapped address only, never from the platform list.
 */

export type EgressRefusal =
  | "bad_url"
  | "scheme"
  | "userinfo"
  | "https_required"
  | "private_address"
  | "platform_host"
  | "dns_failed"
  | "timeout"
  | "too_large"
  | "network_error";

export class EgressRefusedError extends Error {
  readonly code: EgressRefusal;
  readonly host: string | null;

  constructor(code: EgressRefusal, host: string | null) {
    super(`Egress refused: ${code}${host ? ` (${host})` : ""}`);
    this.name = "EgressRefusedError";
    this.code = code;
    this.host = host;
  }
}

export interface EgressPolicy {
  /**
   * Exact `host:port` entries admitted to RFC 1918 / CGNAT / ULA addresses (never loopback, link-local, metadata or
   * unspecified) and to plain http.
   */
  privateAllow?: readonly string[];
  /** Default true: http only for `privateAllow` hosts and test hosts. */
  requireHttps?: boolean;
  /** Default 1 MiB: reading more of the body fails with `too_large` (readCapped truncates instead). */
  maxBytes?: number;
  /** Default 15000: connect + headers + body. */
  timeoutMs?: number;
}

export interface Egress {
  /** undici fetch through the guard; `redirect` is always "manual". */
  fetch(input: string | URL | Request, init?: RequestInit, policy?: EgressPolicy): Promise<Response>;
  /** A fetch-compatible function with the policy bound, for the MCP SDK `fetchFn` / transport `fetch`. */
  bound(policy: EgressPolicy): typeof fetch;
}

export type EgressLookup = (host: string) => Promise<Array<{ address: string; family: 4 | 6 }>>;

export interface CreateEgressOptions {
  platformHosts: readonly string[];
  testHosts?: ReadonlyMap<string, string>;
  /** Resolver for every host name (default: test hosts from the map, the rest from `dns.lookup`). */
  lookup?: EgressLookup;
}

export const EGRESS_DEFAULT_MAX_BYTES = 1024 * 1024;
export const EGRESS_DEFAULT_TIMEOUT_MS = 15_000;
/** How long resolved platform addresses are reused. */
const PLATFORM_TTL_MS = 30_000;
/** Bound on resolving one platform name (compose names may be unknown outside compose). */
const PLATFORM_LOOKUP_MS = 2_000;

// --- address classification ---------------------------------------------------------------------------------
// Separate lists per family: a BlockList matches IPv4 addresses against IPv4-mapped IPv6 subnets too.
// Values extend modules/mcp/url-policy.ts (REFUSED_V4/V6, PRIVATE_V4) to the full special-purpose registries.

const REFUSED_V4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network", incl. 0.0.0.0
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. 169.254.169.254 (metadata)
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255
] as const) {
  REFUSED_V4.addSubnet(net, prefix, "ipv4");
}
REFUSED_V4.addAddress("100.100.100.200", "ipv4"); // Alibaba Cloud metadata (inside CGNAT: checked first)

const PRIVATE_V4 = new BlockList();
for (const [net, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10], // CGNAT
] as const) {
  PRIVATE_V4.addSubnet(net, prefix, "ipv4");
}

const REFUSED_V6 = new BlockList();
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback, IPv4-compatible
  ["::ffff:0:0", 96], // IPv4-mapped: would bypass the IPv4 rules
  ["64:ff9b::", 96], // NAT64 well-known prefix
  ["64:ff9b:1::", 48], // NAT64 local-use
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments (Teredo, ORCHID…)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4: embeds any IPv4 address
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  REFUSED_V6.addSubnet(net, prefix, "ipv6");
}
REFUSED_V6.addAddress("fd00:ec2::254", "ipv6"); // AWS IMDS over IPv6 (inside ULA: checked first)

const PRIVATE_V6 = new BlockList();
PRIVATE_V6.addSubnet("fc00::", 7, "ipv6"); // ULA

const REFUSED_NAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** The compose services every deployment runs next to the API (compose.yaml). */
export const PLATFORM_SERVICE_NAMES = [
  "postgres",
  "redis",
  "garage",
  "openbao",
  "openclaw",
  "api",
  "web",
  "caddy",
  "otel-collector",
] as const;

export type AddressClass = "public" | "private" | "refused";

/** Lowercase, no brackets, no zone id, no trailing dot. */
function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  const zone = h.indexOf("%");
  if (zone >= 0 && isIP(h.slice(0, zone)) === 6) h = h.slice(0, zone);
  return h.replace(/\.$/, "");
}

export function classifyAddress(raw: string): AddressClass {
  const address = normalizeHost(raw);
  const family = isIP(address);
  if (family === 4) {
    if (REFUSED_V4.check(address, "ipv4")) return "refused";
    return PRIVATE_V4.check(address, "ipv4") ? "private" : "public";
  }
  if (family === 6) {
    if (REFUSED_V6.check(address, "ipv6")) return "refused";
    return PRIVATE_V6.check(address, "ipv6") ? "private" : "public";
  }
  return "refused";
}

const isRefusedName = (host: string) => REFUSED_NAMES.has(host) || host.endsWith(".localhost");

// --- host:port ------------------------------------------------------------------------------------------------

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "postgres:": "5432",
  "postgresql:": "5432",
  "redis:": "6379",
  "rediss:": "6379",
};

const formatHostPort = (host: string, port: string) => `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;

/** "host:port" with the scheme's default port; IPv6 hosts in brackets. */
export function hostPortOf(url: string | URL): string {
  let u: URL;
  try {
    u = typeof url === "string" ? new URL(url) : url;
  } catch {
    throw new EgressRefusedError("bad_url", null);
  }
  const host = normalizeHost(u.hostname);
  if (!host) throw new EgressRefusedError("bad_url", null);
  return formatHostPort(host, u.port || DEFAULT_PORTS[u.protocol] || "");
}

/** Normalises a "host:port" entry; null when it has no port. */
function parseHostPort(entry: string): { host: string; port: string } | null {
  const e = entry.trim().toLowerCase();
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(e) ?? /^([^:[\]]+):(\d{1,5})$/.exec(e);
  if (!m?.[1] || !m[2]) return null;
  return { host: normalizeHost(m[1]), port: String(Number(m[2])) };
}

// --- platform hosts -------------------------------------------------------------------------------------------

/**
 * The platform's own hosts: the compose service names plus `host:port` of every URL the API itself uses and its own
 * listener. Refused even when a call's `privateAllow` or the test hosts list them.
 */
export function platformHostsFromEnv(env: Env): string[] {
  const hosts = new Set<string>(PLATFORM_SERVICE_NAMES);
  for (const url of [
    env.DATABASE_URL,
    env.AUTH_DATABASE_URL,
    env.REDIS_URL,
    env.OCW_S3_ENDPOINT,
    env.OCW_OPENBAO_ADDR,
    env.OCW_PUBLIC_API_URL,
  ]) {
    if (!url) continue;
    try {
      hosts.add(hostPortOf(url));
    } catch {
      // Env validated these as URLs; nothing to add otherwise.
    }
  }
  hosts.add(`127.0.0.1:${env.PORT}`);
  hosts.add(`[::1]:${env.PORT}`);
  hosts.add(`localhost:${env.PORT}`);
  return [...hosts];
}

interface Platform {
  names: Set<string>;
  hostPorts: Set<string>;
  /** Platform names and the hosts of platform host:port entries that need resolving. */
  toResolve: Array<{ host: string; port: string | null }>;
}

function compilePlatform(entries: readonly string[]): Platform {
  const platform: Platform = { names: new Set(), hostPorts: new Set(), toResolve: [] };
  for (const entry of entries) {
    const hp = parseHostPort(entry);
    if (hp) {
      platform.hostPorts.add(formatHostPort(hp.host, hp.port));
      if (!isIP(hp.host)) platform.toResolve.push({ host: hp.host, port: hp.port });
      continue;
    }
    const name = normalizeHost(entry);
    if (!name) continue;
    if (isIP(name)) platform.hostPorts.add(name);
    else {
      platform.names.add(name);
      platform.toResolve.push({ host: name, port: null });
    }
  }
  return platform;
}

// --- the guard --------------------------------------------------------------------------------------------------

interface Target {
  host: string;
  port: string;
  hostPort: string;
}

const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });

function findRefusal(err: unknown): EgressRefusedError | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur; depth++) {
    if (cur instanceof EgressRefusedError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

const isTimeout = (err: unknown) => (err as { name?: string } | null)?.name === "TimeoutError";

export function createEgress(opts: CreateEgressOptions): Egress {
  const testHosts = new Map<string, string>();
  for (const [name, address] of opts.testHosts ?? [])
    testHosts.set(normalizeHost(name), normalizeHost(address));
  const platform = compilePlatform(opts.platformHosts);
  const lookup: EgressLookup =
    opts.lookup ??
    (async (host) => {
      const mapped = testHosts.get(host);
      if (mapped) return [{ address: mapped, family: isIP(mapped) === 6 ? 6 : 4 }];
      const all = await dnsLookup(host, { all: true, verbatim: true });
      return all.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
    });

  // Platform addresses: "address" (a compose service, any port) and "address:port" (a URL the API uses).
  let platformCache: { at: number; addresses: Promise<Set<string>> } | null = null;
  const platformAddresses = (): Promise<Set<string>> => {
    if (platform.toResolve.length === 0) return Promise.resolve(new Set());
    if (platformCache && Date.now() - platformCache.at < PLATFORM_TTL_MS) return platformCache.addresses;
    const addresses = Promise.all(
      platform.toResolve.map(async ({ host, port }) => {
        const answer = await withTimeout(lookup(host), PLATFORM_LOOKUP_MS, []);
        return answer.map((a) => {
          const address = normalizeHost(a.address);
          return port === null ? address : formatHostPort(address, port);
        });
      }),
    ).then((lists) => new Set(lists.flat()));
    platformCache = { at: Date.now(), addresses };
    return addresses;
  };

  /** Checks one resolved (or literal) address for a target; throws the refusal. */
  async function checkAddress(target: Target, rawAddress: string, allowed: ReadonlySet<string>) {
    const address = normalizeHost(rawAddress);
    const addressPort = formatHostPort(address, target.port);
    if (platform.hostPorts.has(address) || platform.hostPorts.has(addressPort)) {
      throw new EgressRefusedError("platform_host", target.host);
    }
    const resolved = await platformAddresses();
    if (resolved.has(address) || resolved.has(addressPort)) {
      throw new EgressRefusedError("platform_host", target.host);
    }
    if (testHosts.get(target.host) === address) return;
    const cls = classifyAddress(address);
    if (cls === "refused") throw new EgressRefusedError("private_address", target.host);
    if (cls === "private" && !allowed.has(target.hostPort)) {
      throw new EgressRefusedError("private_address", target.host);
    }
  }

  /** URL-level checks, before any resolution or connection. */
  function precheck(raw: string, policy: EgressPolicy): { url: URL; target: Target; allowed: Set<string> } {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new EgressRefusedError("bad_url", null);
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new EgressRefusedError("scheme", normalizeHost(url.hostname) || null);
    }
    const host = normalizeHost(url.hostname);
    if (!host) throw new EgressRefusedError("bad_url", null);
    if (url.username || url.password) throw new EgressRefusedError("userinfo", host);
    const port = url.port || (DEFAULT_PORTS[url.protocol] as string);
    const target: Target = { host, port, hostPort: formatHostPort(host, port) };
    if (platform.names.has(host) || platform.hostPorts.has(target.hostPort)) {
      throw new EgressRefusedError("platform_host", host);
    }
    const isTest = testHosts.has(host);
    if (!isTest && isRefusedName(host)) throw new EgressRefusedError("private_address", host);
    const allowed = new Set<string>();
    for (const entry of policy.privateAllow ?? []) {
      const hp = parseHostPort(entry);
      if (hp) allowed.add(formatHostPort(hp.host, hp.port));
    }
    if (
      url.protocol === "http:" &&
      policy.requireHttps !== false &&
      !isTest &&
      !allowed.has(target.hostPort)
    ) {
      throw new EgressRefusedError("https_required", host);
    }
    return { url, target, allowed };
  }

  /** The connector's lookup: resolve once, check every address, hand back the first one only (pinning). */
  function pinnedLookup(target: Target, allowed: ReadonlySet<string>, timeoutMs: number): LookupFunction {
    return (hostname, options, callback) => {
      const resolveChecked = async (): Promise<{ address: string; family: 4 | 6 }> => {
        if (normalizeHost(hostname) !== target.host) throw new EgressRefusedError("bad_url", target.host);
        let answer: Array<{ address: string; family: 4 | 6 }>;
        try {
          answer = await lookup(target.host);
        } catch {
          throw new EgressRefusedError("dns_failed", target.host);
        }
        if (answer.length === 0) throw new EgressRefusedError("dns_failed", target.host);
        for (const a of answer) await checkAddress(target, a.address, allowed);
        const first = answer[0] as { address: string; family: 4 | 6 };
        return {
          address: normalizeHost(first.address),
          family: isIP(normalizeHost(first.address)) === 6 ? 6 : 4,
        };
      };
      const timer = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new EgressRefusedError("timeout", target.host)), timeoutMs).unref(),
      );
      Promise.race([resolveChecked(), timer]).then(
        (pinned) => {
          if ((options as { all?: boolean }).all) {
            const list: LookupAddress[] = [{ address: pinned.address, family: pinned.family }];
            callback(null, list);
          } else callback(null, pinned.address, pinned.family);
        },
        (err: unknown) => {
          const refusal = findRefusal(err) ?? new EgressRefusedError("dns_failed", target.host);
          callback(refusal as NodeJS.ErrnoException, "", 0);
        },
      );
    };
  }

  /** Wraps the body: caps it at maxBytes and turns timeouts into `timeout` refusals carrying the host only. */
  function guardBody(res: Response, host: string, maxBytes: number): Response {
    const source = res.body;
    if (!source) return res;
    const reader = source.getReader();
    let seen = 0;
    let overflowed = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Erroring resets the queue, so the cap fails on the pull after the last allowed bytes were handed over.
        if (overflowed) return controller.error(new EgressRefusedError("too_large", host));
        try {
          const { done, value } = await reader.read();
          if (done) return controller.close();
          const room = maxBytes - seen;
          seen += value.byteLength;
          if (value.byteLength > room) {
            overflowed = true;
            void reader.cancel().catch(() => {});
            if (room > 0) return controller.enqueue(value.subarray(0, room));
            return controller.error(new EgressRefusedError("too_large", host));
          }
          controller.enqueue(value);
        } catch (err) {
          controller.error(
            findRefusal(err) ?? new EgressRefusedError(isTimeout(err) ? "timeout" : "network_error", host),
          );
        }
      },
      cancel(reason) {
        return reader.cancel(reason).catch(() => {});
      },
    });
    const wrapped = new Response(body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
    Object.defineProperty(wrapped, "url", { value: res.url });
    return wrapped;
  }

  async function guardedFetch(
    input: string | URL | Request,
    init: RequestInit = {},
    policy: EgressPolicy = {},
  ): Promise<Response> {
    let raw: string;
    let merged: RequestInit = init;
    if (typeof input === "string") raw = input;
    else if (input instanceof URL) raw = input.href;
    else {
      raw = input.url;
      merged = {
        method: input.method,
        headers: input.headers,
        body: input.body,
        signal: input.signal,
        ...init,
        ...(input.body ? { duplex: "half" } : {}),
      } as RequestInit;
    }
    const { url, target, allowed } = precheck(raw, policy);
    const timeoutMs = policy.timeoutMs ?? EGRESS_DEFAULT_TIMEOUT_MS;
    const maxBytes = policy.maxBytes ?? EGRESS_DEFAULT_MAX_BYTES;

    // A literal IP is never looked up by the connector: classify it here.
    if (isIP(target.host)) await checkAddress(target, target.host, allowed);

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = merged.signal ? AbortSignal.any([merged.signal, timeout]) : timeout;
    const agent = new Agent({
      connect: { lookup: pinnedLookup(target, allowed, timeoutMs), timeout: timeoutMs },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    let res: Response;
    try {
      res = (await undiciFetch(url, {
        ...(merged as UndiciRequestInit),
        redirect: "manual",
        signal,
        dispatcher: agent,
      })) as unknown as Response;
    } catch (err) {
      void agent.destroy().catch(() => {});
      const refusal = findRefusal(err);
      if (refusal) throw refusal;
      if (timeout.aborted) throw new EgressRefusedError("timeout", target.host);
      if (merged.signal?.aborted) throw err; // the caller's own abort
      throw new EgressRefusedError("network_error", target.host);
    }
    // Graceful: the agent closes once the body has been consumed, cancelled or timed out.
    void agent.close().catch(() => {});
    return guardBody(res, target.host, maxBytes);
  }

  return {
    fetch: guardedFetch,
    bound(policy) {
      return ((input: string | URL | Request, init?: RequestInit) =>
        guardedFetch(input, init, policy)) as typeof fetch;
    },
  };
}

const memo = new WeakMap<Env, Egress>();

/** The egress guard for this API process: platform hosts and test hosts from env; one instance per env object. */
export function egressFor(env: Env): Egress {
  let egress = memo.get(env);
  if (!egress) {
    egress = createEgress({ platformHosts: platformHostsFromEnv(env), testHosts: env.OCW_EGRESS_TEST_HOSTS });
    memo.set(env, egress);
  }
  return egress;
}

/**
 * Reads at most `maxBytes` of the body as text; past that it stops reading and reports `truncated` (also when the
 * guard's own cap ends the stream first). Timeouts surface as `EgressRefusedError("timeout")`.
 */
export async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - size;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        size += room;
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (err) {
    const refusal = findRefusal(err);
    if (refusal?.code === "too_large") truncated = true;
    else if (refusal) throw refusal;
    else if (isTimeout(err)) throw new EgressRefusedError("timeout", hostOf(res.url));
    else throw new EgressRefusedError("network_error", hostOf(res.url));
  }
  if (truncated) await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

function hostOf(url: string): string | null {
  try {
    return normalizeHost(new URL(url).hostname) || null;
  } catch {
    return null;
  }
}
