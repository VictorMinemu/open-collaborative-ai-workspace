import { describe, expect, it } from "vitest";
import { browserSessionAad, keepForSite, siteKeyOf } from "./sessions";

describe("sealed browser sessions: the pure parts (07.8-21, P-09)", () => {
  it("siteKeyOf: the exact lower-case host with a non-default port, nothing else", () => {
    expect(siteKeyOf("Panel.Example.TEST")).toBe("panel.example.test");
    expect(siteKeyOf("panel.example.test:8443")).toBe("panel.example.test:8443");
    for (const bad of [null, "", "https://panel.example.test/", "panel.example.test/x", "a b"]) {
      expect(siteKeyOf(bad), String(bad)).toBeNull();
    }
  });

  it("the AAD binds organization, member, bot and site", () => {
    expect(browserSessionAad({ organizationId: "o", userId: "u", agentId: "a", siteKey: "s.test" })).toBe(
      "o:u:browser:a:s.test",
    );
  });

  it("keepForSite keeps the site's cookies (subdomain match included) and its origin only; never an IdP's", () => {
    const raw = JSON.stringify({
      cookies: [
        { name: "sid", value: "1", domain: "panel.example.test", expires: 2_000_000_000 },
        { name: "pref", value: "2", domain: ".example.test", expires: 1_900_000_000 },
        { name: "idp", value: "3", domain: "idp.other.test", expires: 1_800_000_000 },
        { name: "tmp", value: "4", domain: "panel.example.test", expires: -1 },
      ],
      origins: [
        { origin: "https://panel.example.test", localStorage: [{ name: "k", value: "v" }] },
        { origin: "https://idp.other.test", localStorage: [{ name: "t", value: "x" }] },
      ],
    });
    const kept = keepForSite(raw, "panel.example.test");
    expect(kept).not.toBeNull();
    const state = JSON.parse(kept?.state ?? "{}");
    expect(state.cookies.map((c: { name: string }) => c.name)).toEqual(["sid", "pref", "tmp"]);
    expect(state.origins.map((o: { origin: string }) => o.origin)).toEqual(["https://panel.example.test"]);
    expect(kept?.items).toBe(4);
    // The earliest expiry among the kept cookies that have one (a session cookie has none).
    expect(kept?.cookieExpiryMs).toBe(1_900_000_000_000);
  });

  it("keepForSite with a port keeps only that exact origin; nothing kept reads 0 items; non-objects are refused", () => {
    const raw = JSON.stringify({
      cookies: [],
      origins: [{ origin: "https://panel.example.test:8443" }, { origin: "https://panel.example.test" }],
    });
    expect(JSON.parse(keepForSite(raw, "panel.example.test:8443")?.state ?? "{}").origins).toEqual([
      { origin: "https://panel.example.test:8443" },
    ]);
    expect(keepForSite(JSON.stringify({ cookies: [], origins: [] }), "panel.example.test")).toMatchObject({
      items: 0,
      cookieExpiryMs: null,
    });
    for (const bad of ["[]", "null", "not json", "1"])
      expect(keepForSite(bad, "panel.example.test")).toBeNull();
  });
});
