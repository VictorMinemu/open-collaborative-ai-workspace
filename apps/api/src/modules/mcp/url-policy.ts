import { BlockList, isIP } from "node:net";

/**
 * Endpoint policy for admin-supplied MCP URLs (D-13, T-03.1-09-02). The API never connects to these URLs (the
 * probe and every call run in the cell); the policy keeps the cell from being pointed at itself, the host, link-
 * local services or cloud metadata, and keeps credentials off plaintext links to the internet:
 *
 * - `https:` to any host that is not refused below;
 * - `http:` only to a single-label host (a compose service such as `mcp-docs`) or an RFC 1918 IPv4 literal;
 * - never loopback, `0.0.0.0`, link-local (IPv4 and IPv6), IPv4-mapped IPv6, the metadata addresses or
 *   `localhost` names, on any scheme; never credentials in the URL (they belong in write-only headers).
 *
 * WHATWG URL parsing already normalises numeric IPv4 forms (`2130706433` → `127.0.0.1`). DNS names that resolve
 * to refused addresses cannot be caught here; the cell's network is the boundary for those.
 */

// Separate lists per family: a BlockList matches IPv4 addresses against IPv4-mapped IPv6 subnets too.
const REFUSED_V4 = new BlockList();
REFUSED_V4.addSubnet("0.0.0.0", 8, "ipv4");
REFUSED_V4.addSubnet("127.0.0.0", 8, "ipv4");
REFUSED_V4.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, incl. 169.254.169.254 (metadata)
REFUSED_V4.addAddress("100.100.100.200", "ipv4"); // Alibaba Cloud metadata

const REFUSED_V6 = new BlockList();
REFUSED_V6.addAddress("::", "ipv6");
REFUSED_V6.addAddress("::1", "ipv6");
REFUSED_V6.addSubnet("fe80::", 10, "ipv6");
REFUSED_V6.addSubnet("::ffff:0:0", 96, "ipv6"); // IPv4-mapped: would bypass the IPv4 rules
REFUSED_V6.addAddress("fd00:ec2::254", "ipv6"); // AWS IMDS over IPv6

const PRIVATE_V4 = new BlockList();
PRIVATE_V4.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE_V4.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE_V4.addSubnet("192.168.0.0", 16, "ipv4");

const REFUSED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
  "instance-data.ec2.internal",
]);

const SINGLE_LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;

export type McpUrlCheck = { ok: true } | { ok: false; reason: string };

const refuse = (reason: string): McpUrlCheck => ({ ok: false, reason });

export function checkMcpUrl(raw: string): McpUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("Not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return refuse("Only https (or http to a private host) is allowed");
  }
  if (url.username || url.password) {
    return refuse("Credentials in the URL are not allowed; add them as a header instead");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return refuse("The URL has no host");
  const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const family = isIP(literal);

  if (family === 4 && REFUSED_V4.check(literal, "ipv4")) {
    return refuse("Loopback, link-local and metadata addresses are not allowed");
  }
  if (family === 6 && REFUSED_V6.check(literal, "ipv6")) {
    return refuse("Loopback, link-local, IPv4-mapped and metadata addresses are not allowed");
  }
  if (family === 0 && (REFUSED_HOSTS.has(host) || host.endsWith(".localhost"))) {
    return refuse("Local and metadata host names are not allowed");
  }

  if (url.protocol === "http:") {
    const privateV4 = family === 4 && PRIVATE_V4.check(literal, "ipv4");
    const composeHost = family === 0 && SINGLE_LABEL.test(host);
    if (!privateV4 && !composeHost) {
      return refuse(
        "Plain http is only allowed to a private compose host or a 10/8, 172.16/12 or 192.168/16 address",
      );
    }
  }
  return { ok: true };
}
