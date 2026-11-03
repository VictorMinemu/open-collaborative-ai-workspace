import { describe, expect, it } from "vitest";
import { loadEnv } from "../config/env";
import {
  classifyAddress,
  createEgress,
  EgressRefusedError,
  egressFor,
  hostPortOf,
  PLATFORM_SERVICE_NAMES,
  platformHostsFromEnv,
  resolveEgressAddress,
} from "./egress";

/**
 * Unit cases of the egress policy (D-07): address classes, URL checks and the platform list. Every refusal here
 * happens before a connection: literal IPs are classified up front and a stub resolver answers host names.
 */

const env = loadEnv({
  DATABASE_URL: "postgres://app:x@db.internal:6543/ocw",
  AUTH_DATABASE_URL: "postgres://auth:x@db.internal:6543/ocw",
  REDIS_URL: "redis://cache.internal:6380",
  BETTER_AUTH_SECRET: "b".repeat(32),
  OCW_SETUP_TOKEN: "s".repeat(16),
  OCW_ENCRYPTION_KEY: "a".repeat(64),
  OCW_S3_ENDPOINT: "http://garage:3900",
  OCW_OPENBAO_ADDR: "http://vault.internal:8200",
  OCW_PUBLIC_API_URL: "https://ocw.example.com",
  PORT: "4000",
});

type Answer = Array<{ address: string; family: 4 | 6 }>;
const noDns = async (host: string): Promise<Answer> => {
  throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
};

async function refusal(promise: Promise<unknown>): Promise<EgressRefusedError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EgressRefusedError);
  return err as EgressRefusedError;
}

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
  "::",
  "255.255.255.255",
  "64:ff9b::a00:1",
  "2002:a00:1::1",
];
const PRIVATE = ["10.1.2.3", "172.20.0.1", "192.168.1.1", "100.64.0.1", "fc00::1"];
const PUBLIC = ["8.8.8.8", "1.1.1.1", "2606:4700::1", "172.32.0.1", "100.128.0.1"];

describe("classifyAddress", () => {
  it.each(REFUSED)("%s is always refused", (address) => {
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

describe("egress: literal-IP URLs are classified before connecting", () => {
  const egress = createEgress({ platformHosts: [], lookup: noDns });
  const literal = (a: string) => (a.includes(":") ? `[${a}]` : a);

  it.each([...REFUSED, ...PRIVATE])("https://%s/ is refused as private_address", async (address) => {
    const err = await refusal(egress.fetch(`https://${literal(address)}/`));
    expect(err.code).toBe("private_address");
  });

  it.each(REFUSED)("%s stays refused even when the exact host:port is allowed", async (address) => {
    const host = literal(address);
    const err = await refusal(egress.fetch(`https://${host}/`, {}, { privateAllow: [`${host}:443`] }));
    expect(err.code).toBe("private_address");
  });
});

describe("egress: URL checks", () => {
  const egress = createEgress({ platformHosts: [], lookup: noDns });

  it.each([
    ["not a url", "bad_url"],
    ["http://user:pw@x.test/", "userinfo"],
    ["https://user@x.test/", "userinfo"],
    ["ftp://x.test/", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["http://public.test/", "https_required"],
    ["https://localhost/", "private_address"],
    ["https://api.localhost/", "private_address"],
    ["https://metadata.google.internal/", "private_address"],
    ["https://unknown.test/", "dns_failed"],
  ])("%s → %s", async (url, code) => {
    const err = await refusal(egress.fetch(url));
    expect(err.code).toBe(code);
  });

  it("plain http is allowed when the caller turns requireHttps off (the address check still applies)", async () => {
    const err = await refusal(egress.fetch("http://public.test/", {}, { requireHttps: false }));
    expect(err.code).toBe("dns_failed");
  });

  it("bound() applies its policy to every call", async () => {
    const strict = egress.bound({});
    const err = await refusal(strict("http://public.test/"));
    expect(err.code).toBe("https_required");
    const relaxed = egress.bound({ requireHttps: false });
    expect((await refusal(relaxed("http://public.test/"))).code).toBe("dns_failed");
  });

  it("errors carry the code and the host only, never the path, the query or a header", async () => {
    const canary = "/secret-path?token=CANARY";
    const cases = [
      egress.fetch(`http://public.test${canary}`),
      egress.fetch(`https://10.0.0.1${canary}`),
      egress.fetch(`https://unknown.test${canary}`, { headers: { authorization: "Bearer CANARY" } }),
      egress.fetch(`http://user:CANARY@x.test${canary}`),
    ];
    for (const p of cases) {
      const err = await refusal(p);
      const text = `${err.message} ${err.stack ?? ""} ${JSON.stringify(err)} ${String(err.host)}`;
      expect(text).not.toMatch(/CANARY|secret-path/);
    }
  });
});

describe("platform hosts", () => {
  it("lists the compose services, the API's own URLs and its listener", () => {
    const hosts = platformHostsFromEnv(env);
    for (const name of PLATFORM_SERVICE_NAMES) expect(hosts).toContain(name);
    expect(hosts).toEqual(
      expect.arrayContaining([
        "db.internal:6543",
        "cache.internal:6380",
        "garage:3900",
        "vault.internal:8200",
        "ocw.example.com:443",
        "127.0.0.1:4000",
        "[::1]:4000",
      ]),
    );
  });

  it("default ports come from the scheme", () => {
    const hosts = platformHostsFromEnv(
      loadEnv({
        DATABASE_URL: "postgres://app:x@pg.internal/ocw",
        AUTH_DATABASE_URL: "postgres://auth:x@pg.internal/ocw",
        REDIS_URL: "redis://cache.internal",
        BETTER_AUTH_SECRET: "b".repeat(32),
        OCW_SETUP_TOKEN: "s".repeat(16),
        OCW_ENCRYPTION_KEY: "a".repeat(64),
      }),
    );
    expect(hosts).toEqual(
      expect.arrayContaining(["pg.internal:5432", "cache.internal:6379", "localhost:4000"]),
    );
  });

  const all = [
    "postgres",
    "redis",
    "garage",
    "api",
    "openclaw",
    "openbao",
    "web",
    "caddy",
    "otel-collector",
    "db.internal:6543",
  ];
  const egress = createEgress({
    platformHosts: platformHostsFromEnv(env),
    testHosts: new Map(all.map((h) => [h.split(":")[0] as string, "127.0.0.1"])),
    lookup: noDns,
  });

  it.each(all)("%s is a platform host even when privateAllow and the test hosts list it", async (entry) => {
    const [host, port = "443"] = entry.split(":");
    const allow = [`${host}:${port}`, `${host}:80`, `${host}:443`];
    for (const url of [`https://${host}:${port}/`, `http://${host}:${port}/`]) {
      const err = await refusal(egress.fetch(url, {}, { privateAllow: allow }));
      expect(err.code).toBe("platform_host");
      expect(err.host).toBe(host);
    }
  });

  it("the API's own listener is refused by address:port, also behind a test host", async () => {
    const e = createEgress({
      platformHosts: platformHostsFromEnv(env),
      testHosts: new Map([["self.test", "127.0.0.1"]]),
      lookup: async (h) => (h === "self.test" ? [{ address: "127.0.0.1", family: 4 }] : noDns(h)),
    });
    expect((await refusal(e.fetch("http://self.test:4000/"))).code).toBe("platform_host");
    expect((await refusal(e.fetch("http://127.0.0.1:4000/"))).code).toBe("platform_host");
  });

  it("a name that resolves to a platform service's address is refused even when allowed", async () => {
    const answers: Record<string, Answer> = {
      postgres: [{ address: "172.18.0.3", family: 4 }],
      "db.internal": [{ address: "172.18.0.9", family: 4 }],
      "evil.test": [{ address: "172.18.0.3", family: 4 }],
      "evil2.test": [{ address: "172.18.0.9", family: 4 }],
    };
    const e = createEgress({
      platformHosts: platformHostsFromEnv(env),
      lookup: async (h) => answers[h] ?? noDns(h),
    });
    const a = await refusal(e.fetch("https://evil.test:8443/", {}, { privateAllow: ["evil.test:8443"] }));
    expect(a.code).toBe("platform_host");
    expect(a.host).toBe("evil.test");
    const b = await refusal(e.fetch("https://evil2.test:6543/", {}, { privateAllow: ["evil2.test:6543"] }));
    expect(b.code).toBe("platform_host");
  });
});

describe("hostPortOf", () => {
  it.each([
    ["https://Example.COM/x", "example.com:443"],
    ["http://example.com./", "example.com:80"],
    ["http://example.com:8080/", "example.com:8080"],
    ["https://[::1]:4000/", "[::1]:4000"],
    ["postgres://u:p@db/x", "db:5432"],
    ["redis://cache", "cache:6379"],
  ])("%s → %s", (url, hp) => {
    expect(hostPortOf(url)).toBe(hp);
  });

  it("a bad URL throws bad_url", () => {
    expect(() => hostPortOf("nope")).toThrow(EgressRefusedError);
  });
});

describe("egressFor", () => {
  it("is memoised per env object", () => {
    expect(egressFor(env)).toBe(egressFor(env));
    expect(egressFor({ ...env })).not.toBe(egressFor(env));
  });

  it("uses the env's platform hosts", async () => {
    const err = await refusal(egressFor(env).fetch("https://postgres/"));
    expect(err.code).toBe("platform_host");
  });
});

describe("resolveEgressAddress: the same refusals for a non-HTTP connection (07.6-11, IMAP)", () => {
  const table: Record<string, Answer> = {
    "imap.acme.com": [{ address: "203.0.113.10", family: 4 }],
    "imap.public.example": [{ address: "8.8.4.4", family: 4 }],
    "imap.lan.example": [{ address: "192.168.1.20", family: 4 }],
    "imap.loop.example": [{ address: "127.0.0.1", family: 4 }],
    "imap.mixed.example": [
      { address: "8.8.4.4", family: 4 },
      { address: "10.0.0.9", family: 4 },
    ],
    "imap.platform.example": [{ address: "172.30.0.5", family: 4 }],
    postgres: [{ address: "172.30.0.5", family: 4 }],
    // An injected resolver answers test hosts itself (createEgress uses the map only in its default lookup).
    greenmail: [{ address: "127.0.0.1", family: 4 }],
  };
  const lookup = async (host: string): Promise<Answer> => {
    const answer = table[host];
    if (!answer) return noDns(host);
    return answer;
  };
  const egress = createEgress({
    platformHosts: ["postgres"],
    testHosts: new Map([["greenmail", "127.0.0.1"]]),
    lookup,
  });

  it("a public host resolves to its pinned address", async () => {
    await expect(resolveEgressAddress(egress, "imap.public.example", { port: 993 })).resolves.toEqual({
      address: "8.8.4.4",
      family: 4,
      testHost: false,
    });
  });

  it("refuses documentation, loopback, private and mixed answers like fetch does", async () => {
    for (const host of ["imap.acme.com", "imap.loop.example", "imap.lan.example", "imap.mixed.example"]) {
      const err = await refusal(resolveEgressAddress(egress, host, { port: 993 }));
      expect(err.code, host).toBe("private_address");
      expect(err.host).toBe(host);
    }
  });

  it("admits a private address only for the exact host:port of privateAllow (never loopback)", async () => {
    await expect(
      resolveEgressAddress(egress, "imap.lan.example", { port: 993, privateAllow: ["imap.lan.example:993"] }),
    ).resolves.toMatchObject({ address: "192.168.1.20", testHost: false });
    const otherPort = await refusal(
      resolveEgressAddress(egress, "imap.lan.example", { port: 143, privateAllow: ["imap.lan.example:993"] }),
    );
    expect(otherPort.code).toBe("private_address");
    const loop = await refusal(
      resolveEgressAddress(egress, "imap.loop.example", {
        port: 993,
        privateAllow: ["imap.loop.example:993"],
      }),
    );
    expect(loop.code).toBe("private_address");
  });

  it("refuses platform hosts by name and by resolved address, even when allowed", async () => {
    expect((await refusal(resolveEgressAddress(egress, "postgres", { port: 5432 }))).code).toBe(
      "platform_host",
    );
    const byAddress = await refusal(
      resolveEgressAddress(egress, "imap.platform.example", {
        port: 993,
        privateAllow: ["imap.platform.example:993"],
      }),
    );
    expect(byAddress.code).toBe("platform_host");
  });

  it("refuses localhost and metadata names and literal private IPs, answers dns_failed for unknown names", async () => {
    expect((await refusal(resolveEgressAddress(egress, "localhost", { port: 993 }))).code).toBe(
      "private_address",
    );
    expect((await refusal(resolveEgressAddress(egress, "10.0.0.1", { port: 993 }))).code).toBe(
      "private_address",
    );
    expect((await refusal(resolveEgressAddress(egress, "nowhere.example", { port: 993 }))).code).toBe(
      "dns_failed",
    );
    await expect(resolveEgressAddress(egress, "1.1.1.1", { port: 993 })).resolves.toEqual({
      address: "1.1.1.1",
      family: 4,
      testHost: false,
    });
  });

  it("a test host maps to its loopback address and says so", async () => {
    await expect(resolveEgressAddress(egress, "GreenMail", { port: 3143 })).resolves.toEqual({
      address: "127.0.0.1",
      family: 4,
      testHost: true,
    });
  });
});
