import { describe, expect, it } from "vitest";
import {
  buildInjectionHeader,
  hostAllowed,
  KeychainError,
  pathAllowed,
  sanitizeModelHeaders,
  secretParts,
} from "./inject";

/** Pure keychain injection rules (07.4-07 Task 3; D-04, D-07 item 3, T-07.4-07-06). */

const u = (s: string) => new URL(s);
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("hostAllowed", () => {
  it("an exact host matches only itself on the scheme's default port", () => {
    expect(hostAllowed(["api.x.com"], u("https://api.x.com/"))).toBe(true);
    expect(hostAllowed(["api.x.com"], u("https://API.x.com:443/v1"))).toBe(true);
    expect(hostAllowed(["api.x.com"], u("http://api.x.com/"))).toBe(true);
    expect(hostAllowed(["api.x.com"], u("https://api.x.com:8443/"))).toBe(false);
    expect(hostAllowed(["api.x.com"], u("https://evil-api.x.com/"))).toBe(false);
    expect(hostAllowed(["api.x.com"], u("https://api.x.com.evil.example/"))).toBe(false);
    expect(hostAllowed(["api.x.com"], u("https://user:pw@api.x.com/"))).toBe(false);
    expect(hostAllowed(["api.x.com"], u("ftp://api.x.com/"))).toBe(false);
  });

  it("a wildcard matches strict subdomains at any depth, never the apex or a look-alike", () => {
    expect(hostAllowed(["*.x.com"], u("https://a.x.com/"))).toBe(true);
    expect(hostAllowed(["*.x.com"], u("https://a.b.x.com/"))).toBe(true);
    expect(hostAllowed(["*.x.com"], u("https://x.com/"))).toBe(false);
    expect(hostAllowed(["*.x.com"], u("https://ax.com/"))).toBe(false);
  });

  it("a pattern with a port matches that port only", () => {
    expect(hostAllowed(["erp.lan:8443"], u("http://erp.lan:8443/"))).toBe(true);
    expect(hostAllowed(["erp.lan:8443"], u("https://erp.lan:8443/x"))).toBe(true);
    expect(hostAllowed(["erp.lan:8443"], u("http://erp.lan/"))).toBe(false);
    expect(hostAllowed(["erp.lan:8443"], u("http://erp.lan:8444/"))).toBe(false);
  });
});

describe("pathAllowed", () => {
  it("accepts paths under the prefix on a segment boundary, after URL normalisation", () => {
    expect(pathAllowed("/v1/", u("https://a.example/v1/items"))).toBe(true);
    expect(pathAllowed("/v1/", u("https://a.example/v1/"))).toBe(true);
    expect(pathAllowed("/v1", u("https://a.example/v1/items?x=1"))).toBe(true);
    expect(pathAllowed("/v1/", u("https://a.example/v10"))).toBe(false);
    expect(pathAllowed("/v1", u("https://a.example/v10"))).toBe(false);
    expect(pathAllowed("/v1/", u("https://a.example/v1/../admin"))).toBe(false);
    expect(pathAllowed("/v1/", u("https://a.example/v1/%2e%2e/admin"))).toBe(false);
    expect(pathAllowed("/v1/", u("https://a.example/"))).toBe(false);
  });

  it("no prefix allows every path", () => {
    expect(pathAllowed(null, u("https://a.example/anything"))).toBe(true);
  });
});

describe("sanitizeModelHeaders", () => {
  it("drops credentials, cookies, routing, framing and the injected header name, case-insensitively", () => {
    const out = sanitizeModelHeaders(
      {
        Authorization: "Bearer stolen",
        cookie: "a=b",
        Host: "evil.example",
        "Proxy-Authorization": "Basic x",
        "proxy-connection": "keep-alive",
        "Content-Length": "5",
        "Transfer-Encoding": "chunked",
        Connection: "close",
        "X-Api-Key": "model-chosen",
        Accept: "application/json",
        "X-Trace": "1",
      },
      "x-api-key",
    );
    expect(out).toEqual({ Accept: "application/json", "X-Trace": "1" });
  });

  it("drops invalid header names and values with control characters", () => {
    expect(
      sanitizeModelHeaders({ "bad name": "x", "X-Ok": "a\r\nInjected: 1", "X-Good": "v" }, "Authorization"),
    ).toEqual({ "X-Good": "v" });
  });
});

describe("buildInjectionHeader", () => {
  const bearer = { header: "Authorization", scheme: "bearer" as const };

  it("api_key: Bearer by default, raw on a custom header", () => {
    expect(buildInjectionHeader("api_key", bearer, { kind: "api_key", value: "v" })).toEqual({
      name: "Authorization",
      value: "Bearer v",
    });
    expect(
      buildInjectionHeader(
        "api_key",
        { header: "X-Api-Key", scheme: "raw" },
        { kind: "api_key", value: "v" },
      ),
    ).toEqual({ name: "X-Api-Key", value: "v" });
  });

  it("basic: Basic base64(user:pass) on Authorization", () => {
    expect(
      buildInjectionHeader(
        "basic",
        { header: "Authorization", scheme: "basic" },
        { kind: "basic", username: "u", password: "p" },
      ),
    ).toEqual({ name: "Authorization", value: `Basic ${b64("u:p")}` });
  });

  it("oauth: the client-credentials token, never the client secret", () => {
    const secret = { kind: "oauth" as const, clientId: "c", clientSecret: "s" };
    expect(buildInjectionHeader("oauth", bearer, secret, "tok")).toEqual({
      name: "Authorization",
      value: "Bearer tok",
    });
    expect(() => buildInjectionHeader("oauth", bearer, secret)).toThrow(KeychainError);
  });

  it("refuses a forbidden header, a kind mismatch and a value with control characters", () => {
    for (const header of ["Cookie", "Host", "Proxy-Authorization", "Content-Length"]) {
      expect(() =>
        buildInjectionHeader("api_key", { header, scheme: "raw" }, { kind: "api_key", value: "v" }),
      ).toThrow(KeychainError);
    }
    expect(() => buildInjectionHeader("basic", bearer, { kind: "api_key", value: "v" })).toThrow(
      KeychainError,
    );
    expect(() => buildInjectionHeader("api_key", bearer, { kind: "api_key", value: "v\r\nX: y" })).toThrow(
      KeychainError,
    );
  });
});

describe("secretParts", () => {
  it("api_key: the value, its base64 forms and the header value, longest first", () => {
    const parts = secretParts({ kind: "api_key", value: "sk-1234" }, "Bearer sk-1234");
    expect(parts).toEqual(expect.arrayContaining(["sk-1234", "Bearer sk-1234", b64("sk-1234")]));
    expect(parts).toEqual([...parts].sort((a, b) => b.length - a.length));
  });

  it("basic: the password, user:pass and its base64", () => {
    const header = `Basic ${b64("user:hunter2")}`;
    expect(secretParts({ kind: "basic", username: "user", password: "hunter2" }, header)).toEqual(
      expect.arrayContaining(["hunter2", "user:hunter2", b64("user:hunter2"), header]),
    );
  });

  it("oauth: the client secret and the token", () => {
    expect(
      secretParts({ kind: "oauth", clientId: "id", clientSecret: "cs-secret" }, "Bearer tok-123", "tok-123"),
    ).toEqual(expect.arrayContaining(["cs-secret", "tok-123", "Bearer tok-123", b64("id:cs-secret")]));
  });
});
