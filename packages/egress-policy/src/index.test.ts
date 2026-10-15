import { describe, expect, it } from "vitest";
import {
  classifyAddress,
  compileCidrs,
  decideAddress,
  decideHost,
  type EgressHostPolicy,
  hostPortOf,
  isRefusedName,
  matchAllowHost,
  normalizeHost,
  PLATFORM_SERVICE_NAMES,
  parseHostPort,
  REFUSED_NAMES,
} from "./index";

/**
 * The shared egress classification (07.4 → D-11). The address cases are the same lists as the API's
 * `egress.test.ts`, which keeps passing unchanged through `apps/api/src/lib/egress.ts`; the decision cases are the
 * sandbox proxy's rules (modes, allow-list, ports, platform names, bot networks, the proxy's own addresses).
 */

const REFUSED = [
  "127.0.0.1",
  "127.1.2.3",
  "::1",
  "0.0.0.0",
  "169.254.169.254",
  "fe80::1",
  "100.100.100.200",
  "fd00:ec2::254",
  "224.0.0.1",
  "::ffff:10.0.0.1",
  "::ffff:127.0.0.1",
  "::ffff:169.254.169.254",
  "::",
  "255.255.255.255",
  "64:ff9b::a00:1",
  "64:ff9b::a9fe:a9fe",
  "2002:a00:1::1",
  "2002:a9fe:a9fe::1",
  "[::1]",
  "fe80::1%eth0",
];
const PRIVATE = ["10.1.2.3", "172.20.0.1", "192.168.1.1", "100.64.0.1", "fc00::1", "fd12:3456::1"];
const PUBLIC = ["8.8.8.8", "1.1.1.1", "2606:4700::1", "172.32.0.1", "100.128.0.1", "93.184.216.34"];

describe("classifyAddress", () => {
  it.each(REFUSED)("%s is always refused (loopback, metadata, link-local, IPv6-embedded IPv4)", (address) => {
    expect(classifyAddress(address)).toBe("refused");
  });
  it.each(PRIVATE)("%s is private", (address) => {
    expect(classifyAddress(address)).toBe("private");
  });
  it.each(PUBLIC)("%s is public", (address) => {
    expect(classifyAddress(address)).toBe("public");
  });
  it("anything that is not an IP is refused", () => {
    expect(classifyAddress("example.com")).toBe("refused");
    expect(classifyAddress("")).toBe("refused");
  });
});

describe("names and host:port", () => {
  it("normalizeHost lowercases and drops brackets, zone ids and the trailing dot", () => {
    expect(normalizeHost(" Example.COM. ")).toBe("example.com");
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("fe80::1%eth0")).toBe("fe80::1");
  });

  it("localhost and metadata names are refused names", () => {
    for (const name of ["localhost", "metadata.google.internal", "instance-data", "x.localhost"]) {
      expect(isRefusedName(name)).toBe(true);
    }
    expect(REFUSED_NAMES.has("localhost")).toBe(true);
    expect(isRefusedName("example.com")).toBe(false);
  });

  it("the platform names include the sandbox broker and the proxy itself", () => {
    for (const name of ["postgres", "redis", "api", "openclaw", "sandboxd", "sandbox-egress"]) {
      expect(PLATFORM_SERVICE_NAMES).toContain(name);
    }
  });

  it.each([
    ["https://Example.COM/x", "example.com:443"],
    ["http://example.com./", "example.com:80"],
    ["http://example.com:8080/", "example.com:8080"],
    ["https://[::1]:4000/", "[::1]:4000"],
    ["postgres://u:p@db/x", "db:5432"],
    ["redis://cache", "cache:6379"],
  ])("hostPortOf(%s) → %s", (url, hp) => {
    expect(hostPortOf(url)).toBe(hp);
  });

  it("hostPortOf answers null for a bad URL (the API turns it into bad_url)", () => {
    expect(hostPortOf("nope")).toBeNull();
  });

  it("parseHostPort normalises entries and refuses entries without a port", () => {
    expect(parseHostPort("Wiki.Internal:08080")).toEqual({ host: "wiki.internal", port: "8080" });
    expect(parseHostPort("[FD00::1]:443")).toEqual({ host: "fd00::1", port: "443" });
    expect(parseHostPort("wiki.internal")).toBeNull();
  });
});

describe("matchAllowHost", () => {
  it.each([
    ["api.github.com", "api.github.com", 443, true],
    ["api.github.com", "API.GITHUB.COM.", 443, true],
    ["api.github.com", "github.com", 443, false],
    ["api.github.com:443", "api.github.com", 443, true],
    ["api.github.com:443", "api.github.com", 80, false],
    ["*.example.com", "a.example.com", 443, true],
    ["*.example.com", "a.b.example.com", 443, true],
    ["*.example.com", "example.com", 443, false],
    ["*.example.com", "evilexample.com", 443, false],
    ["*.example.com:443", "a.example.com", 80, false],
  ] as const)("matchAllowHost(%s, %s, %s) → %s", (pattern, host, port, expected) => {
    expect(matchAllowHost(pattern, host, port)).toBe(expected);
  });
});

const base: EgressHostPolicy = { mode: "public", allowHosts: [], privateHosts: [] };

describe("decideHost (before any resolution)", () => {
  it("mode off refuses everything", () => {
    expect(decideHost({ ...base, mode: "off", host: "example.com", port: 443 })).toEqual({
      allowed: false,
      reason: "egress_off",
    });
  });

  it.each(["sandboxd", "sandbox-egress", "postgres", "api"])(
    "%s is refused by name even when allowed as a private host and on the allow-list",
    (name) => {
      const policy = {
        ...base,
        mode: "allowlist" as const,
        allowHosts: [name, `${name}:8090`],
        privateHosts: [`${name}:8090`, `${name}:443`],
      };
      expect(decideHost({ ...policy, host: name, port: 8090 })).toEqual({
        allowed: false,
        reason: "platform_host",
      });
      expect(decideHost({ ...policy, host: name.toUpperCase(), port: 443 })).toEqual({
        allowed: false,
        reason: "platform_host",
      });
    },
  );

  it("extra platform hosts are refused by name and by host:port", () => {
    const policy = { ...base, platformHosts: ["vault.internal", "db.internal:6543"] };
    expect(decideHost({ ...policy, host: "vault.internal", port: 443 }).allowed).toBe(false);
    expect(decideHost({ ...policy, host: "db.internal", port: 6543 })).toEqual({
      allowed: false,
      reason: "platform_host",
    });
  });

  it("localhost and metadata names are refused", () => {
    for (const host of ["localhost", "metadata.google.internal", "app.localhost"]) {
      expect(decideHost({ ...base, host, port: 443 })).toEqual({ allowed: false, reason: "refused_address" });
    }
  });

  it("only ports 80 and 443, unless the exact host:port is an allowed private host", () => {
    expect(decideHost({ ...base, host: "example.com", port: 22 })).toEqual({
      allowed: false,
      reason: "port",
    });
    expect(decideHost({ ...base, host: "example.com", port: 80 })).toEqual({ allowed: true });
    expect(decideHost({ ...base, host: "example.com", port: 443 })).toEqual({ allowed: true });
    const priv = { ...base, privateHosts: ["wiki.internal:8080"] };
    expect(decideHost({ ...priv, host: "wiki.internal", port: 8080 })).toEqual({ allowed: true });
    expect(decideHost({ ...priv, host: "wiki.internal", port: 8081 })).toEqual({
      allowed: false,
      reason: "port",
    });
  });

  it("allowlist mode admits only listed hosts", () => {
    const policy = { ...base, mode: "allowlist" as const, allowHosts: ["api.github.com", "*.npmjs.org"] };
    expect(decideHost({ ...policy, host: "api.github.com", port: 443 })).toEqual({ allowed: true });
    expect(decideHost({ ...policy, host: "registry.npmjs.org", port: 443 })).toEqual({ allowed: true });
    expect(decideHost({ ...policy, host: "github.com", port: 443 })).toEqual({
      allowed: false,
      reason: "not_allowlisted",
    });
  });
});

describe("decideAddress (every resolved answer)", () => {
  it("a public answer is allowed in public mode", () => {
    expect(decideAddress({ ...base, host: "public.test", port: 443, address: "93.184.216.34" })).toEqual({
      allowed: true,
    });
  });

  it.each(REFUSED)("%s is refused even when the exact host:port is an allowed private host", (address) => {
    const policy = { ...base, privateHosts: ["x.test:443"] };
    expect(decideAddress({ ...policy, host: "x.test", port: 443, address })).toEqual({
      allowed: false,
      reason: "refused_address",
    });
  });

  it("a private answer needs the exact host:port in the private hosts", () => {
    const d = (privateHosts: string[], port = 8080) =>
      decideAddress({ ...base, privateHosts, host: "fake-site.local", port, address: "172.20.0.5" });
    expect(d([])).toEqual({ allowed: false, reason: "port" });
    expect(d([], 443)).toEqual({ allowed: false, reason: "refused_address" });
    expect(d(["fake-site.local:8080"])).toEqual({ allowed: true });
    expect(d(["other.local:8080"])).toEqual({ allowed: false, reason: "port" });
  });

  it("a literal private IP is admitted by its own ip:port entry", () => {
    expect(
      decideAddress({
        ...base,
        privateHosts: ["10.1.2.3:8080"],
        host: "10.1.2.3",
        port: 8080,
        address: "10.1.2.3",
      }),
    ).toEqual({ allowed: true });
  });

  it("platform addresses (ip or ip:port entries) are refused by address", () => {
    const policy = {
      ...base,
      platformHosts: ["172.18.0.3", "172.18.0.9:6543"],
      privateHosts: ["evil.test:443"],
    };
    expect(decideAddress({ ...policy, host: "evil.test", port: 443, address: "172.18.0.3" })).toEqual({
      allowed: false,
      reason: "platform_host",
    });
  });

  describe("the shared hop: bot networks and the proxy's own addresses come first", () => {
    const shared = {
      ...base,
      privateHosts: ["10.89.3.4:8080", "bot-b.test:8080", "10.89.3.2:3128"],
      botNetworks: compileCidrs(["10.89.3.0/24", "10.89.4.0/24", "fd00:89::/64"]),
      ownAddresses: ["10.89.3.2", "10.89.4.2"],
    };

    it("a bot-network address is refused as bot_network even when allowed as a private host", () => {
      expect(decideAddress({ ...shared, host: "10.89.3.4", port: 8080, address: "10.89.3.4" })).toEqual({
        allowed: false,
        reason: "bot_network",
      });
    });

    it("a host name resolving into a bot network is refused as bot_network", () => {
      expect(decideAddress({ ...shared, host: "bot-b.test", port: 8080, address: "10.89.3.7" })).toEqual({
        allowed: false,
        reason: "bot_network",
      });
      expect(decideAddress({ ...shared, host: "v6.test", port: 443, address: "fd00:89::5" })).toEqual({
        allowed: false,
        reason: "bot_network",
      });
    });

    it("the proxy's own address is refused as proxy_self", () => {
      expect(decideAddress({ ...shared, host: "10.89.3.2", port: 3128, address: "10.89.3.2" })).toEqual({
        allowed: false,
        reason: "proxy_self",
      });
    });

    it("compileCidrs refuses an invalid entry instead of dropping it", () => {
      expect(() => compileCidrs(["10.89.3.0/24", "nope"])).toThrow();
      expect(() => compileCidrs(["10.89.3.0/33"])).toThrow();
    });
  });
});
