// P-09 at the device and in brw (07.13 D-22, PD-02): a sign-in exported for one site keeps only that site's cookies
// and origin storage, with the rules of brw's contextExportState and the API's keepForSite (which re-filters).
import { describe, expect, it } from "vitest";
import { domainMatch, filterStateForSite, parseStorageState, type StorageCookie } from "./site.mjs";

const cookie = (name: string, domain: string): StorageCookie => ({
  name,
  value: `${name}-value`,
  domain,
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
});
const origin = (o: string) => ({ origin: o, localStorage: [{ name: "k", value: `${o}-v` }] });

describe("domainMatch (RFC 6265 §5.1.3)", () => {
  it("matches the host itself and its subdomains, with or without the leading dot", () => {
    expect(domainMatch("a.github.com", ".github.com")).toBe(true);
    expect(domainMatch("a.github.com", "github.com")).toBe(true);
    expect(domainMatch("github.com", ".github.com")).toBe(true);
    expect(domainMatch("github.com", "github.com")).toBe(true);
    expect(domainMatch("GitHub.com", ".GITHUB.com")).toBe(true);
  });

  it("never matches a suffix that is not a label boundary, a parent's sibling or a child domain", () => {
    expect(domainMatch("github.com", "hub.com")).toBe(false);
    expect(domainMatch("evilgithub.com", "github.com")).toBe(false);
    expect(domainMatch("github.com", ".githubusercontent.com")).toBe(false);
    expect(domainMatch("github.com", "api.github.com")).toBe(false);
  });

  it("an IP host matches only exactly; empty values never match", () => {
    expect(domainMatch("10.0.0.1", "10.0.0.1")).toBe(true);
    expect(domainMatch("10.0.0.1", "0.0.1")).toBe(false);
    expect(domainMatch("1.2.3.4", ".3.4")).toBe(false);
    expect(domainMatch("::1", "1")).toBe(false);
    expect(domainMatch("", "github.com")).toBe(false);
    expect(domainMatch("github.com", "")).toBe(false);
    expect(domainMatch("github.com", undefined)).toBe(false);
  });
});

describe("parseStorageState", () => {
  it("returns the cookies and origins of a storage state object, empty lists when absent", () => {
    expect(parseStorageState(JSON.stringify({ cookies: [cookie("a", "x.test")], origins: [] }))).toEqual({
      cookies: [cookie("a", "x.test")],
      origins: [],
    });
    expect(parseStorageState("{}")).toEqual({ cookies: [], origins: [] });
    expect(parseStorageState(JSON.stringify({ cookies: "no", origins: 3 }))).toEqual({
      cookies: [],
      origins: [],
    });
  });

  it("passes undefined through (no stored sign-in)", () => {
    expect(parseStorageState(undefined)).toBeUndefined();
  });

  it("throws invalid_request on text that is not a JSON object", () => {
    for (const bad of ["[]", "null", "42", '"s"', "not json", ""]) {
      let caught: unknown;
      try {
        parseStorageState(bad);
      } catch (err) {
        caught = err;
      }
      expect(caught, bad).toBeInstanceOf(Error);
      expect((caught as { code?: string }).code, bad).toBe("invalid_request");
    }
  });
});

describe("filterStateForSite (P-09)", () => {
  const state = {
    cookies: [
      cookie("session", ".github.com"),
      cookie("host-only", "github.com"),
      cookie("api", "api.github.com"),
      cookie("raw", ".githubusercontent.com"),
      cookie("idp", "accounts.google.com"),
      cookie("google", ".google.com"),
      cookie("local", "localhost"),
    ],
    origins: [
      origin("https://github.com"),
      origin("https://gist.github.com"),
      origin("https://raw.githubusercontent.com"),
      origin("https://accounts.google.com"),
      origin("http://localhost:3000"),
      origin("http://localhost:4000"),
      { origin: "not a url", localStorage: [] },
    ],
  };

  it("github.com keeps the .github.com cookies and the https://github.com origin only", () => {
    const kept = filterStateForSite("github.com", state);
    expect(kept.cookies.map((c) => c.name)).toEqual(["session", "host-only"]);
    expect(kept.origins.map((o) => o.origin)).toEqual(["https://github.com"]);
    const json = JSON.stringify(kept);
    for (const gone of ["githubusercontent", "accounts.google.com", "idp-value", "gist"])
      expect(json).not.toContain(gone);
  });

  it("a host with a port keeps that exact origin; cookies match the host name (they carry no port)", () => {
    const kept = filterStateForSite("localhost:3000", state);
    expect(kept.cookies.map((c) => c.name)).toEqual(["local"]);
    expect(kept.origins.map((o) => o.origin)).toEqual(["http://localhost:3000"]);
  });

  it("a host without a port keeps every origin of that exact host name, whatever its port", () => {
    const kept = filterStateForSite("localhost", state);
    expect(kept.origins.map((o) => o.origin)).toEqual(["http://localhost:3000", "http://localhost:4000"]);
  });

  it("an empty state or empty host keeps nothing, and never throws on missing lists", () => {
    expect(filterStateForSite("github.com", {})).toEqual({ cookies: [], origins: [] });
    expect(filterStateForSite("", state)).toEqual({ cookies: [], origins: [] });
  });
});
