import { describe, expect, it } from "vitest";
import { safeNext } from "./safe-next";

const ORIGIN = "https://ocw.example.com";

/**
 * The login page's `?next=` (07.12 review ME-04): only a same-origin path survives, so a `/login?next=…` link (the
 * server pairing deep link goes through it) can never send a signed-in person to another site.
 */
describe("safeNext", () => {
  it.each([
    ["/settings/devices?pair=ABCD-EFGH", "/settings/devices?pair=ABCD-EFGH"],
    ["/chat", "/chat"],
    ["/work-zone/projects?tab=1#top", "/work-zone/projects?tab=1#top"],
    // Still encoded (not decoded by useSearchParams): a path segment on this origin.
    ["/%5Cevil.example/x", "/%5Cevil.example/x"],
  ])("keeps the same-origin path %j", (next, expected) => {
    expect(safeNext(next, ORIGIN)).toBe(expected);
  });

  it.each([
    null,
    "",
    "chat",
    "//evil.example",
    "//evil.example/settings/devices?pair=ABCD-EFGH",
    "/\\evil.example/x",
    "\\\\evil.example",
    "/\\/evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    "\t//evil.example",
    "/x\u0000",
    "/x\u007f",
    "https://evil.example/settings",
    "http:/evil.example",
    "javascript:alert(1)",
    "data:text/html,hi",
    // Normalised by the URL parser into a protocol-relative path.
    "/..//evil.example",
    "/.//evil.example",
  ])("refuses %j", (next) => {
    expect(safeNext(next, ORIGIN)).toBe("/chat");
  });
});
