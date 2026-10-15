import { BlockList, isIP } from "node:net";

/**
 * The egress classification shared by the API's egress guard (`apps/api/src/lib/egress.ts`, 07.4, ADR-0025) and the
 * `sandbox-egress` proxy (`apps/sandboxd/src/egress/proxy.ts`, 07.8 D-11), so the two cannot drift. Pure and
 * synchronous; Node built-ins only (the proxy image carries no npm package).
 *
 * - Always refused: loopback, unspecified, link-local, cloud metadata, multicast, reserved and documentation ranges,
 *   IPv4-mapped / IPv4-compatible / NAT64 / 6to4 IPv6 forms, `localhost` and metadata host names.
 * - Private (RFC 1918, CGNAT 100.64/10, ULA fc00::/7): refused unless the exact `host:port` is allowed.
 * - Platform hosts (the compose services, incl. `sandboxd` and `sandbox-egress`): refused by name, by `host:port` and
 *   by address, even when allowed.
 * - Proxy only (D-01, D-11, the single shared hop): the proxy's own addresses and every bot network's subnet are
 *   refused first, before and regardless of the private-host allowlist, so one bot never reaches another.
 *
 * Resolution and pinning stay with the callers: each resolves a host once, decides every answer and connects to the
 * validated address only.
 */

export type AddressClass = "public" | "private" | "refused";

/** Outbound network mode of a bot's shell or browser (mirrors `SandboxEgressMode` in @ocw/contracts). */
export type EgressMode = "off" | "allowlist" | "public";

export type EgressRefusalReason =
  | "egress_off"
  | "not_allowlisted"
  | "port"
  | "platform_host"
  | "refused_address"
  | "bot_network"
  | "proxy_self";

export type EgressDecision = { allowed: true } | { allowed: false; reason: EgressRefusalReason };

// --- address classification ---------------------------------------------------------------------------------
// Separate lists per family: a BlockList matches IPv4 addresses against IPv4-mapped IPv6 subnets too.

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

export const REFUSED_NAMES: ReadonlySet<string> = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

/** The compose services every deployment runs next to the API (compose.yaml), plus the sandbox broker and proxy. */
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
  "sandboxd",
  "sandbox-egress",
] as const;

/** Lowercase, no brackets, no zone id, no trailing dot. */
export function normalizeHost(host: string): string {
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

/** `localhost`, `*.localhost` and the cloud metadata names (expects a normalised host). */
export const isRefusedName = (host: string): boolean =>
  REFUSED_NAMES.has(host) || host.endsWith(".localhost");

// --- host:port ------------------------------------------------------------------------------------------------

export const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  "http:": "80",
  "https:": "443",
  "postgres:": "5432",
  "postgresql:": "5432",
  "redis:": "6379",
  "rediss:": "6379",
};

/** "host:port", IPv6 hosts in brackets. */
export const formatHostPort = (host: string, port: string | number): string =>
  `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;

/** "host:port" of a URL with the scheme's default port; null when the URL does not parse or has no host. */
export function hostPortOf(url: string | URL): string | null {
  let u: URL;
  try {
    u = typeof url === "string" ? new URL(url) : url;
  } catch {
    return null;
  }
  const host = normalizeHost(u.hostname);
  if (!host) return null;
  return formatHostPort(host, u.port || DEFAULT_PORTS[u.protocol] || "");
}

/** Normalises a "host:port" entry; null when it has no port. */
export function parseHostPort(entry: string): { host: string; port: string } | null {
  const e = entry.trim().toLowerCase();
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(e) ?? /^([^:[\]]+):(\d{1,5})$/.exec(e);
  if (!m?.[1] || !m[2]) return null;
  return { host: normalizeHost(m[1]), port: String(Number(m[2])) };
}

/**
 * An allow-list entry against a target: exact `host` (any port), exact `host:port`, or `*.example.com` (any subdomain,
 * never the apex), optionally with `:port`. Case and a trailing dot are ignored.
 */
export function matchAllowHost(pattern: string, host: string, port: number | string): boolean {
  let p = pattern.trim().toLowerCase();
  let patternPort: string | null = null;
  const withPort = /^(.*):(\d{1,5})$/.exec(p);
  if (withPort?.[1] && withPort[2] && !withPort[1].includes(":")) {
    p = withPort[1];
    patternPort = String(Number(withPort[2]));
  }
  if (patternPort !== null && patternPort !== String(Number(port))) return false;
  const h = normalizeHost(host);
  if (p.startsWith("*.")) {
    const suffix = normalizeHost(p.slice(1)); // ".example.com"
    return suffix.length > 1 && h.endsWith(suffix) && h.length > suffix.length;
  }
  return normalizeHost(p) === h;
}

/** A BlockList of CIDRs (`10.89.3.0/24`, `fd00:89::/64`); throws on any invalid entry (fail closed). */
export function compileCidrs(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const m = /^([^/]+)\/(\d{1,3})$/.exec(cidr.trim());
    const address = m?.[1] ? normalizeHost(m[1]) : "";
    const family = isIP(address);
    const prefix = Number(m?.[2]);
    if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
      throw new Error("invalid CIDR in the egress policy");
    }
    list.addSubnet(address, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

// --- decisions -------------------------------------------------------------------------------------------------

export interface EgressHostPolicy {
  mode: EgressMode;
  /** `host`, `host:port` or `*.domain` entries; consulted in `allowlist` mode only. */
  allowHosts: readonly string[];
  /** Exact `host:port` entries admitted to private addresses and to their non-default port. */
  privateHosts: readonly string[];
  /** Extra platform entries (names, `host:port`, IPs or `ip:port`) on top of PLATFORM_SERVICE_NAMES. */
  platformHosts?: readonly string[];
  /** Every bot network's subnet (proxy only): refused before the private-host allowlist. */
  botNetworks?: BlockList;
  /** The proxy's own addresses (proxy only): refused first. */
  ownAddresses?: readonly string[];
}

export interface EgressTarget {
  host: string;
  port: number;
}

const ALLOWED: EgressDecision = { allowed: true };
const refuse = (reason: EgressRefusalReason): EgressDecision => ({ allowed: false, reason });

function inPlatform(policy: EgressHostPolicy, host: string, port: number): boolean {
  if ((PLATFORM_SERVICE_NAMES as readonly string[]).includes(host)) return true;
  const hostPort = formatHostPort(host, port);
  for (const entry of policy.platformHosts ?? []) {
    const hp = parseHostPort(entry);
    if (hp ? formatHostPort(hp.host, hp.port) === hostPort : normalizeHost(entry) === host) return true;
  }
  return false;
}

const privateAllowed = (policy: EgressHostPolicy, host: string, port: number): boolean => {
  const hostPort = formatHostPort(host, port);
  return policy.privateHosts.some((entry) => {
    const hp = parseHostPort(entry);
    return hp !== null && formatHostPort(hp.host, hp.port) === hostPort;
  });
};

/** The decision on the requested host and port, before any resolution (no DNS for a refused name). */
export function decideHost(input: EgressHostPolicy & EgressTarget): EgressDecision {
  const host = normalizeHost(input.host);
  const port = input.port;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return refuse("refused_address");
  if (input.mode === "off") return refuse("egress_off");
  if (inPlatform(input, host, port)) return refuse("platform_host");
  if (isRefusedName(host)) return refuse("refused_address");
  if (port !== 80 && port !== 443 && !privateAllowed(input, host, port)) return refuse("port");
  if (input.mode === "allowlist" && !input.allowHosts.some((p) => matchAllowHost(p, host, port))) {
    return refuse("not_allowlisted");
  }
  if (input.mode !== "allowlist" && input.mode !== "public") return refuse("egress_off");
  return ALLOWED;
}

/**
 * The decision on one resolved (or literal) address of a target. Callers refuse the whole request if ANY answer is
 * refused, then connect to a validated address only.
 */
export function decideAddress(input: EgressHostPolicy & EgressTarget & { address: string }): EgressDecision {
  const byHost = decideHost(input);
  if (!byHost.allowed) return byHost;
  const host = normalizeHost(input.host);
  const address = normalizeHost(input.address);
  const family = isIP(address);
  if (!family) return refuse("refused_address");
  if ((input.ownAddresses ?? []).some((own) => normalizeHost(own) === address)) return refuse("proxy_self");
  if (input.botNetworks?.check(address, family === 4 ? "ipv4" : "ipv6")) return refuse("bot_network");
  if (inPlatform(input, address, input.port)) return refuse("platform_host");
  const cls = classifyAddress(address);
  if (cls === "refused") return refuse("refused_address");
  if (cls === "private" && !privateAllowed(input, host, input.port)) return refuse("refused_address");
  return ALLOWED;
}
