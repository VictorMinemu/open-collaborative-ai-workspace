import { describe, expect, it } from "vitest";
import {
  AgentVaultKey,
  CreateVaultItemRequest,
  FORBIDDEN_INJECTION_HEADERS,
  isAllowedInjectionHeader,
  PrivateHostsSettings,
  SetVaultItemAgentsRequest,
  UpdateVaultItemRequest,
  VaultHandle,
  VaultHostPattern,
  VaultInjection,
  VaultItem,
  VaultItemList,
  vaultHostAllowed,
} from "./index";

const ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ID2 = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const NOW = "2026-10-13T10:00:00.000Z";

const item = {
  id: ID,
  scope: "personal",
  unitId: null,
  ownerUserId: ID2,
  name: "Acme ERP",
  handle: "k_abcdefgh23",
  kind: "api_key",
  injection: { header: "Authorization", scheme: "bearer" },
  allowedHosts: ["erp.example.com:8443"],
  allowedPathPrefix: "/v2/",
  tokenUrl: null,
  hasValue: true,
  valueUpdatedAt: NOW,
  agentIds: [ID],
  createdAt: NOW,
  updatedAt: NOW,
  lastUsedAt: null,
};

describe("vault handles and host patterns (07.4 D-04)", () => {
  it("a handle is k_ and 10 lower-case base32 characters", () => {
    expect(VaultHandle.safeParse("k_abcdefgh23").success).toBe(true);
    for (const bad of [
      "k_ABCDEFGH23",
      "k_abcdefgh2",
      "k_abcdefgh234",
      "x_abcdefgh23",
      "k_abcdefgh01",
      "abcdefgh23",
    ]) {
      expect(VaultHandle.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("accepts DNS names, subdomain wildcards, ports and IPv4 literals", () => {
    for (const ok of [
      "api.example.com",
      "*.example.com",
      "erp.example.com:8443",
      "localhost",
      "10.0.0.5:8069",
    ]) {
      expect(VaultHostPattern.safeParse(ok).success, ok).toBe(true);
    }
    expect(VaultHostPattern.parse("  API.Example.COM ")).toBe("api.example.com");
  });

  it("refuses schemes, paths, IP wildcards, a bare wildcard, empty labels and long names", () => {
    for (const bad of [
      "https://x",
      "x/y",
      "*.1.2.3.4",
      "*",
      "*.com",
      "a..b",
      "-a.example.com",
      "a.example.com.",
      "a.example.com:0",
      "a.example.com:65536",
      "a.example.com:080",
      "999.1.1.1",
      "user@example.com",
      "",
      `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}.com`,
    ]) {
      expect(VaultHostPattern.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("vaultHostAllowed matches exact hosts, strict subdomains of wildcards and ports", () => {
    expect(vaultHostAllowed(["api.example.com"], "https://api.example.com/v1")).toBe(true);
    expect(vaultHostAllowed(["api.example.com"], "https://api.example.com:443/v1")).toBe(true);
    expect(vaultHostAllowed(["api.example.com"], "https://api.example.com:8443/v1")).toBe(false);
    expect(vaultHostAllowed(["api.example.com"], "https://evil.example.com/")).toBe(false);
    expect(vaultHostAllowed(["api.example.com"], "https://api.example.com.evil.test/")).toBe(false);
    expect(vaultHostAllowed(["*.example.com"], "https://a.b.example.com/")).toBe(true);
    expect(vaultHostAllowed(["*.example.com"], "https://example.com/")).toBe(false);
    expect(vaultHostAllowed(["*.example.com"], "https://badexample.com/")).toBe(false);
    expect(vaultHostAllowed(["erp.example.com:8443"], "https://erp.example.com:8443/x")).toBe(true);
    expect(vaultHostAllowed(["erp.example.com:8443"], "https://erp.example.com/x")).toBe(false);
    expect(vaultHostAllowed(["api.example.com"], "https://user:pw@api.example.com/")).toBe(false);
    expect(vaultHostAllowed(["api.example.com"], "ftp://api.example.com/")).toBe(false);
    expect(vaultHostAllowed(["api.example.com"], "not a url")).toBe(false);
  });
});

describe("vault injection (T-07.4-01-03)", () => {
  it("defaults to Authorization: Bearer and refuses headers that smuggle, route or carry cookies", () => {
    expect(VaultInjection.parse({})).toEqual({ header: "Authorization", scheme: "bearer" });
    expect(VaultInjection.parse({ header: "X-Api-Key", scheme: "raw" })).toEqual({
      header: "X-Api-Key",
      scheme: "raw",
    });
    for (const header of [
      "Cookie",
      "Host",
      "Proxy-Authorization",
      "proxy-anything",
      "Content-Length",
      "Transfer-Encoding",
      "Connection",
      "Bad Header",
    ]) {
      expect(VaultInjection.safeParse({ header }).success, header).toBe(false);
      expect(isAllowedInjectionHeader(header), header).toBe(false);
    }
    expect(FORBIDDEN_INJECTION_HEADERS).toContain("cookie");
    expect(isAllowedInjectionHeader("X-Api-Key")).toBe(true);
  });
});

describe("vault create and update requests (write-only secrets)", () => {
  const base = { scope: "personal", name: "Acme ERP", allowedHosts: ["erp.example.com"] };

  it("an api key gets the default injection", () => {
    expect(CreateVaultItemRequest.parse({ ...base, kind: "api_key", value: "sk-1" })).toMatchObject({
      kind: "api_key",
      injection: { header: "Authorization", scheme: "bearer" },
    });
    expect(CreateVaultItemRequest.safeParse({ ...base, kind: "api_key", value: "" }).success).toBe(false);
    expect(
      CreateVaultItemRequest.safeParse({
        ...base,
        kind: "api_key",
        value: "x",
        injection: { scheme: "basic" },
      }).success,
    ).toBe(false);
  });

  it("a username and password key always injects Authorization: Basic", () => {
    const parsed = CreateVaultItemRequest.parse({
      ...base,
      kind: "basic",
      username: "sam",
      password: "pw",
      injection: { header: "X-Auth", scheme: "raw" },
    });
    expect(parsed.injection).toEqual({ header: "Authorization", scheme: "basic" });
  });

  it("an oauth client needs an https token URL on an allowed host", () => {
    const oauth = {
      ...base,
      kind: "oauth",
      clientId: "c",
      clientSecret: "s",
      tokenUrl: "https://erp.example.com/token",
    };
    expect(CreateVaultItemRequest.safeParse(oauth).success).toBe(true);
    expect(
      CreateVaultItemRequest.safeParse({ ...oauth, tokenUrl: "http://erp.example.com/token" }).success,
    ).toBe(false);
    expect(
      CreateVaultItemRequest.safeParse({ ...oauth, tokenUrl: "https://auth.other.test/token" }).success,
    ).toBe(false);
  });

  it("a personal key belongs to no unit; a unit key may name one or the organization", () => {
    expect(
      CreateVaultItemRequest.safeParse({ ...base, kind: "api_key", value: "x", unitId: ID }).success,
    ).toBe(false);
    expect(
      CreateVaultItemRequest.safeParse({ ...base, scope: "unit", kind: "api_key", value: "x", unitId: ID })
        .success,
    ).toBe(true);
    expect(
      CreateVaultItemRequest.safeParse({ ...base, scope: "unit", kind: "api_key", value: "x", unitId: null })
        .success,
    ).toBe(true);
  });

  it("allows 1 to 16 hosts and a clean path prefix", () => {
    const key = { ...base, kind: "api_key", value: "x" };
    expect(CreateVaultItemRequest.safeParse({ ...key, allowedHosts: [] }).success).toBe(false);
    expect(
      CreateVaultItemRequest.safeParse({
        ...key,
        allowedHosts: Array.from({ length: 17 }, (_, i) => `h${i}.test`),
      }).success,
    ).toBe(false);
    expect(CreateVaultItemRequest.safeParse({ ...key, allowedPathPrefix: "/v2/" }).success).toBe(true);
    for (const allowedPathPrefix of ["v2", "/v2/../admin", "/v2?x=1", "/v2#a"]) {
      expect(CreateVaultItemRequest.safeParse({ ...key, allowedPathPrefix }).success, allowedPathPrefix).toBe(
        false,
      );
    }
  });

  it("update takes any subset and new secret material of one kind", () => {
    expect(UpdateVaultItemRequest.parse({})).toEqual({});
    expect(
      UpdateVaultItemRequest.parse({ allowedPathPrefix: null, secret: { kind: "api_key", value: "new" } }),
    ).toEqual({ allowedPathPrefix: null, secret: { kind: "api_key", value: "new" } });
    expect(UpdateVaultItemRequest.safeParse({ secret: { kind: "basic", username: "sam" } }).success).toBe(
      false,
    );
    expect(UpdateVaultItemRequest.safeParse({ allowedHosts: ["https://x"] }).success).toBe(false);
  });

  it("agent grants and private hosts are bounded", () => {
    expect(SetVaultItemAgentsRequest.safeParse({ agentIds: Array(65).fill(ID) }).success).toBe(false);
    expect(PrivateHostsSettings.parse({ hosts: ["erp.lan", "10.0.0.5:8069"] }).hosts).toHaveLength(2);
    expect(PrivateHostsSettings.safeParse({ hosts: ["*.lan"] }).success).toBe(false);
    expect(
      PrivateHostsSettings.safeParse({ hosts: Array.from({ length: 65 }, (_, i) => `h${i}.lan`) }).success,
    ).toBe(false);
  });
});

describe("vault responses never carry a value (D-06, R3)", () => {
  it("an item says hasValue and when the value was set", () => {
    expect(VaultItem.parse(item)).toEqual(item);
    const { valueUpdatedAt: _drop, ...noValueDate } = item;
    expect(VaultItem.safeParse(noValueDate).success).toBe(false);
    expect(VaultItem.safeParse({ ...item, hasValue: false }).success).toBe(false);
    expect(VaultItem.parse({ ...item, value: "sk-leak", password: "pw" })).not.toHaveProperty("value");
  });

  it("the list has personal, unit and manageable units, and no private-host list (R5)", () => {
    const list = VaultItemList.parse({
      personal: [item],
      unit: [],
      manageableUnits: [{ unitId: null, name: "Whole organization" }],
    });
    expect(list.personal).toHaveLength(1);
    expect(Object.keys(VaultItemList.shape)).not.toContain("privateHosts");
  });

  it("an agent sees a key's handle, name and hosts", () => {
    expect(
      AgentVaultKey.parse({
        handle: "k_abcdefgh23",
        name: "ERP",
        allowedHosts: ["erp.example.com"],
        value: "x",
      }),
    ).toEqual({ handle: "k_abcdefgh23", name: "ERP", allowedHosts: ["erp.example.com"] });
  });
});
