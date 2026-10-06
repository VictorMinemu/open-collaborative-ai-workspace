import { describe, expect, it } from "vitest";
import { safeUrl } from "./safe-url";

/**
 * The URL allowlist of the shared renderer (T-04-02-01). Browsers drop tab/CR/LF anywhere in a URL and C0
 * controls or spaces at its ends, and treat "\" like "/": every bypass below would execute or leave the origin
 * if the check ran on the raw string.
 */

const REFUSED: Array<[string, string]> = [
  ["javascript:", "javascript:alert(1)"],
  ["mixed case", "JaVaScRiPt:alert(1)"],
  ["tab inside the scheme", "java\tscript:alert(1)"],
  ["newline inside the scheme", "java\nscript:alert(1)"],
  ["carriage return inside the scheme", "java\rscript:alert(1)"],
  ["NUL inside the scheme", "java\u0000script:alert(1)"],
  ["other C0 control inside the scheme", "java\u0001script:alert(1)"],
  ["DEL inside the scheme", "java\u007fscript:alert(1)"],
  ["leading spaces", "   javascript:alert(1)"],
  ["leading controls", "\u0000\u0008\u001f javascript:alert(1)"],
  ["trailing controls after the scheme", "javascript:alert(1)\u0000\t"],
  ["data:", "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="],
  ["data: mixed case", "DaTa:text/html,<script>alert(1)</script>"],
  ["vbscript:", "vbscript:msgbox(1)"],
  ["file:", "file:///etc/passwd"],
  ["blob:", "blob:https://example.com/uuid"],
  ["protocol-relative", "//evil.example/x"],
  ["protocol-relative with controls", "\t//evil.example/x"],
  ["backslashes", "\\\\evil.example\\x"],
  ["slash backslash", "/\\evil.example"],
  ["backslash slash", "\\/evil.example"],
  ["empty", ""],
  ["only controls", "\t\n\u0000"],
];

describe("safeUrl", () => {
  for (const [name, url] of REFUSED) {
    it(`refuses ${name}`, () => expect(safeUrl(url)).toBeUndefined());
  }

  it("keeps http, https and mailto (controls removed)", () => {
    expect(safeUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
    expect(safeUrl("http://example.com")).toBe("http://example.com");
    expect(safeUrl("HTTPS://Example.com/x")).toBe("HTTPS://Example.com/x");
    expect(safeUrl("mailto:team@example.com")).toBe("mailto:team@example.com");
    expect(safeUrl("  https://example.com/\t")).toBe("https://example.com/");
    expect(safeUrl("ht\ttps://example.com/")).toBe("https://example.com/");
  });

  it("keeps same-origin relative references", () => {
    expect(safeUrl("/chat/abc?m=1")).toBe("/chat/abc?m=1");
    expect(safeUrl("#section")).toBe("#section");
    expect(safeUrl("?q=1")).toBe("?q=1");
    expect(safeUrl("docs/readme")).toBe("docs/readme");
    expect(safeUrl("../up")).toBe("../up");
  });

  it("a colon later in a relative path is not a scheme", () => {
    expect(safeUrl("/chat/a:b")).toBe("/chat/a:b");
    expect(safeUrl("./javascript:alert(1)")).toBe("./javascript:alert(1)");
  });
});
