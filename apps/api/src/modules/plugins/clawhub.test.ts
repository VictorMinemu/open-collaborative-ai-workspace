import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeClawhub, type FakeClawhub } from "../../../../../infra/fake-model/fake-clawhub.mjs";
import {
  CLAWHUB_TIMEOUT_MS,
  CLAWHUB_USER_AGENT,
  type ClawhubCache,
  createClawhubClient,
  MarketplaceNotFoundError,
  MarketplaceUnavailableError,
} from "./clawhub";

/** 03.1-11 Task 2: the ClawHub proxy client against the in-process fake ClawHub (no network). */

let fake: FakeClawhub;
let server: Server;
let baseUrl: string;

function memoryCache(): ClawhubCache & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
  };
}

beforeAll(async () => {
  fake = createFakeClawhub();
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!fake(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => fake.reset());

describe("createClawhubClient (D-14, P-B6)", () => {
  it("search maps ClawHub packages to our fields; an identical second call is served from the cache", async () => {
    const client = createClawhubClient({ baseUrl, cache: memoryCache() });
    const first = await client.search("duck", { limit: 10 });
    expect(first.source).toBe("live");
    expect(first.nextCursor).toBeNull();
    expect(first.packages).toEqual([
      {
        packageName: "@openclaw/duckduckgo-plugin",
        displayName: "OpenClaw DuckDuckGo Plugin",
        summary: "OpenClaw DuckDuckGo plugin.",
        publisher: "openclaw",
        publisherOfficial: true,
        channel: "official",
        latestVersion: "2026.9.7",
        downloads: 11164,
        installs: 59,
        stars: 0,
        scanStatus: null,
        verificationTier: "source-linked",
        runtimeId: "duckduckgo",
      },
    ]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.path).toBe("/api/v1/packages/search");
    expect(fake.requests[0]?.query).toMatchObject({ q: "duck", family: "code-plugin", limit: "10" });

    const second = await client.search("duck", { limit: 10 });
    expect(second.source).toBe("cache");
    expect(second.packages).toEqual(first.packages);
    expect(fake.requests).toHaveLength(1);
  });

  it("an empty query browses the catalog with a cursor", async () => {
    const client = createClawhubClient({ baseUrl, cache: memoryCache() });
    const page = await client.search("", { limit: 3 });
    expect(page.packages).toHaveLength(3);
    expect(page.nextCursor).toBe("3");
    expect(fake.requests[0]?.path).toBe("/api/v1/plugins");
    const next = await client.search("", { limit: 3, cursor: page.nextCursor ?? undefined });
    expect(next.packages).toHaveLength(2);
    expect(next.nextCursor).toBeNull();
  });

  it("version detail maps release metadata and ignores unknown fields", async () => {
    // Unknown fields anywhere (new ClawHub releases) must not break parsing.
    const v = fake.version("@ocw-test/notes-plugin", "1.0.0");
    if (!v) throw new Error("fixture missing");
    v.someFutureField = { nested: [1, 2, 3] };
    v.pluginManifestSummary.someFutureKey = "x";
    const pkg = fake.pkg("@ocw-test/notes-plugin");
    if (pkg) pkg.newBadge = true;

    const client = createClawhubClient({ baseUrl, cache: memoryCache() });
    const { detail, source } = await client.versionDetail("@ocw-test/notes-plugin", "1.0.0");
    expect(source).toBe("live");
    expect(fake.requests[0]?.path).toBe(
      `/api/v1/packages/${encodeURIComponent("@ocw-test/notes-plugin")}/detail`,
    );
    expect(detail.package).toMatchObject({
      packageName: "@ocw-test/notes-plugin",
      publisher: "ocw-test",
      publisherOfficial: true,
      channel: "official",
      latestVersion: "1.1.0",
      runtimeId: "ocw-notes",
    });
    expect(detail.version).toBe("1.0.0");
    expect(detail.publishedAt).toBe(new Date(1788000000000).toISOString());
    expect(detail.versions).toEqual([
      { version: "1.1.0", publishedAt: new Date(1790000000000).toISOString() },
      { version: "1.0.0", publishedAt: new Date(1788000000000).toISOString() },
    ]);
    expect(detail.verification).toEqual({
      tier: "source-linked",
      hasProvenance: false,
      sourceRepo: "ocw-test/notes-plugin",
      sourceCommit: "1111111111111111111111111111111111111111",
    });
    expect(detail.scan).toEqual({
      status: "clean",
      blockedFromDownload: false,
      pending: false,
      reasons: [],
      moderationState: null,
    });
    expect(detail.compatibility).toEqual({ minGatewayVersion: ">=2026.7.2", pluginApiRange: ">=2026.9.7" });
    expect(detail.artifact).toEqual({
      sha256: "1a".repeat(32),
      npmIntegrity: expect.stringMatching(/^sha512-/),
      size: 2048,
    });
    expect(detail.declared).toEqual({
      tools: ["notes_lookup"],
      hooks: [],
      channels: [],
      providers: [],
      webSearchProviders: [],
      webFetchProviders: [],
      mcpServers: [],
      other: [],
    });
  });

  it("maps every declared family of the manifest summary", async () => {
    const v = fake.version("@ocw-test/echo-plugin", "0.1.0");
    if (!v) throw new Error("fixture missing");
    v.pluginManifestSummary = {
      channels: ["relay"],
      providers: ["acme", { id: "beta" }],
      hooks: ["before_agent_run"],
      contracts: {
        tools: ["ocw_echo"],
        webSearchProviders: ["acme-search"],
        webFetchProviders: ["acme-fetch"],
        gatewayMethodDispatch: ["authenticated-request"],
        embeddingProviders: ["acme-embed"],
      },
      toolMetadata: { ocw_echo_extra: {} },
      mcpServers: [{ name: "files" }],
      bundledSkills: [{ name: "summarise" }],
      cliBackends: ["claude-cli"],
      cliCommands: [{ name: "echo-admin" }],
      kind: "memory",
      configContracts: { dangerousFlags: [{ path: "plugins.entries.ocw-echo.config.unsafe" }] },
      configFields: [],
    };
    const client = createClawhubClient({ baseUrl, cache: memoryCache() });
    const { detail } = await client.versionDetail("@ocw-test/echo-plugin", "0.1.0");
    expect(detail.declared).toEqual({
      tools: ["ocw_echo", "ocw_echo_extra"],
      hooks: ["before_agent_run"],
      channels: ["relay"],
      providers: ["acme", "beta"],
      webSearchProviders: ["acme-search"],
      webFetchProviders: ["acme-fetch"],
      mcpServers: ["files"],
      other: [
        "cliBackends:claude-cli",
        "cliCommands:echo-admin",
        "dangerousConfigFlags:plugins.entries.ocw-echo.config.unsafe",
        "embeddingProviders:acme-embed",
        "gatewayMethodDispatch:authenticated-request",
        "kind:memory",
        "skills:summarise",
      ],
    });
  });

  it("a version without a manifest summary is marked surface-unknown", async () => {
    const v = fake.version("@ocw-test/echo-plugin", "0.1.0");
    if (!v) throw new Error("fixture missing");
    v.pluginManifestSummary = null;
    const client = createClawhubClient({ baseUrl, cache: memoryCache() });
    const { detail } = await client.versionDetail("@ocw-test/echo-plugin", "0.1.0");
    expect(detail.declared.other).toEqual(["manifest:missing"]);
  });

  it("live: true bypasses a fresh cache entry (approvals re-check ClawHub) and refreshes it", async () => {
    const cache = memoryCache();
    const client = createClawhubClient({ baseUrl, cache });
    await client.versionDetail("@ocw-test/notes-plugin", "1.0.0");
    expect((await client.versionDetail("@ocw-test/notes-plugin", "1.0.0")).source).toBe("cache");
    expect(fake.requests).toHaveLength(1);
    fake
      .version("@ocw-test/notes-plugin", "1.0.0")
      ?.pluginManifestSummary.contracts.tools.push("notes_delete");
    const live = await client.versionDetail("@ocw-test/notes-plugin", "1.0.0", { live: true });
    expect(live.source).toBe("live");
    expect(live.detail.declared.tools).toEqual(["notes_delete", "notes_lookup"]);
    expect(fake.requests).toHaveLength(2);
    // The refreshed entry is what the next cached read sees.
    expect((await client.versionDetail("@ocw-test/notes-plugin", "1.0.0")).detail.declared.tools).toContain(
      "notes_delete",
    );
  });

  it("a response slower than the timeout raises MarketplaceUnavailableError (default 8 s)", async () => {
    expect(CLAWHUB_TIMEOUT_MS).toBe(8000);
    const client = createClawhubClient({ baseUrl, cache: memoryCache(), timeoutMs: 150 });
    fake.setOutage({ delayMs: 1000 });
    const err = await client.search("duck", { limit: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketplaceUnavailableError);
    expect((err as MarketplaceUnavailableError).reason).toBe("timeout");
  });

  it("a 5xx raises MarketplaceUnavailableError, unless a stale cached copy exists (served as cache)", async () => {
    let now = 1_000_000;
    const cache = memoryCache();
    const client = createClawhubClient({ baseUrl, cache, now: () => now });
    fake.setOutage({ status: 503 });
    const err = await client.search("notes", { limit: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketplaceUnavailableError);
    expect((err as MarketplaceUnavailableError).reason).toBe("unavailable");

    fake.setOutage(null);
    const fresh = await client.search("notes", { limit: 5 });
    expect(fresh.source).toBe("live");
    now += 11 * 60_000; // past the 10-minute freshness window
    fake.setOutage({ status: 502 });
    const stale = await client.search("notes", { limit: 5 });
    expect(stale.source).toBe("cache");
    expect(stale.packages).toEqual(fresh.packages);
    // Approvals never accept stale data.
    const live = await client
      .versionDetail("@ocw-test/notes-plugin", "1.0.0", { live: true })
      .catch((e: unknown) => e);
    expect(live).toBeInstanceOf(MarketplaceUnavailableError);
  });

  it("an unknown package raises MarketplaceNotFoundError; a network failure is unavailable", async () => {
    const client = createClawhubClient({ baseUrl, cache: memoryCache() });
    await expect(client.versionDetail("@nobody/nothing")).rejects.toBeInstanceOf(MarketplaceNotFoundError);
    await expect(client.versionDetail("@ocw-test/notes-plugin", "9.9.9")).rejects.toBeInstanceOf(
      MarketplaceNotFoundError,
    );
    const down = createClawhubClient({
      baseUrl: "http://127.0.0.1:9",
      cache: memoryCache(),
      timeoutMs: 2000,
    });
    const err = await down.search("x", { limit: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketplaceUnavailableError);
    expect((err as MarketplaceUnavailableError).reason).toBe("network");
  });

  it("a malformed body is unavailable, not a crash", async () => {
    const client = createClawhubClient({
      baseUrl,
      cache: memoryCache(),
      fetchImpl: async () => new Response("<html>not json</html>", { status: 200 }),
    });
    const err = await client.search("x", { limit: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarketplaceUnavailableError);
    expect((err as MarketplaceUnavailableError).reason).toBe("malformed");
  });

  it("every request carries only the proxy user agent: no cookie, authorization or user/org identifier", async () => {
    const client = createClawhubClient({ baseUrl, cache: memoryCache() });
    await client.search("duck", { limit: 5 });
    await client.search("", { limit: 5 });
    await client.versionDetail("@openclaw/duckduckgo-plugin", "2026.9.7", { live: true });
    expect(fake.requests.length).toBeGreaterThanOrEqual(3);
    const allowed = new Set([
      "host",
      "connection",
      "user-agent",
      "accept",
      "accept-encoding",
      "accept-language",
      "sec-fetch-mode",
    ]);
    for (const r of fake.requests) {
      expect(r.headers["user-agent"]).toBe(CLAWHUB_USER_AGENT);
      expect(CLAWHUB_USER_AGENT).toBe("ocw-marketplace-proxy");
      for (const name of Object.keys(r.headers)) expect(allowed.has(name)).toBe(true);
      expect(r.headers.cookie).toBeUndefined();
      expect(r.headers.authorization).toBeUndefined();
      // Only the package name, version and search terms travel in the URL.
      expect(
        Object.keys(r.query).every((k) => ["q", "family", "limit", "cursor", "sort", "version"].includes(k)),
      ).toBe(true);
    }
  });

  it("artifact URLs are built on the configured ClawHub origin", () => {
    const client = createClawhubClient({ baseUrl: "https://clawhub.example/", cache: memoryCache() });
    expect(client.origin).toBe("https://clawhub.example");
    expect(client.artifactUrl("@openclaw/duckduckgo-plugin", "2026.9.7")).toBe(
      "https://clawhub.example/api/v1/packages/%40openclaw%2Fduckduckgo-plugin/versions/2026.9.7/artifact/download",
    );
  });
});
