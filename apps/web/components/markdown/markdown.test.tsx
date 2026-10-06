import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, MentionContext, type MentionContextValue, type MentionTarget } from "./markdown";

/**
 * Security and behaviour fixtures for the one shared renderer (04-02, D-05, CHAT-05). Rendered to static markup
 * in node: what reaches the DOM is exactly this string.
 */

const SAM: MentionTarget = { kind: "user", displayName: "Sam Lee" };

function render(
  text: string,
  opts: { variant?: "chat" | "document"; streaming?: boolean } = {},
  ctx: MentionContextValue = { handles: new Map([["sam", SAM]]), myHandle: null },
): string {
  return renderToStaticMarkup(
    <MentionContext.Provider value={ctx}>
      <Markdown text={text} {...opts} />
    </MentionContext.Provider>,
  );
}

/** Every href / src value in the markup (attribute values are HTML-escaped by React). */
function attrs(html: string, name: "href" | "src"): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((m) =>
    (m[1] ?? "").replaceAll("&amp;", "&"),
  );
}

/** http(s), mailto, or a same-origin path; never another scheme or a protocol-relative URL. */
function allowedHref(href: string): boolean {
  if (/^(https?:\/\/|mailto:)/i.test(href)) return true;
  if (href.startsWith("//")) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(href.trim());
}

function expectSafe(html: string) {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<iframe/i);
  expect(html).not.toMatch(/<style/i);
  expect(html).not.toMatch(/<img/i);
  expect(html).not.toMatch(/<object|<embed|<form|<input/i);
  // An attribute named on* inside any tag (escaped text such as "&lt;img onerror" is not a tag).
  expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i);
  for (const href of attrs(html, "href")) expect(allowedHref(href), href).toBe(true);
  expect(attrs(html, "src")).toEqual([]);
  // Inside a tag (escaped text that merely shows "javascript:" to the reader is inert).
  expect(html).not.toMatch(/<[^>]*javascript:/i);
  expect(html).not.toMatch(/<[a-z][^>]*\sstyle=/i);
}

const XSS: Array<[string, string]> = [
  ["inline script tag", "hello <script>alert(1)</script> world"],
  ["block script tag", "<script>\nalert(document.cookie)\n</script>"],
  ["img onerror", '<img src="x" onerror="alert(1)">'],
  ["raw anchor with onclick and javascript:", '<a href="javascript:alert(1)" onclick="steal()">raw</a>'],
  ["markdown javascript: link", "[click me](javascript:alert(1))"],
  [
    "markdown javascript: link, mixed case and entities",
    "[x](JaVaScRiPt:alert(1)) [y](java&#115;cript:alert(1))",
  ],
  ["data: link", "[data](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)"],
  ["vbscript: link", "[vb](vbscript:msgbox(1))"],
  ["autolink with javascript:", "<javascript:alert(1)>"],
  ["iframe", '<iframe src="https://evil.example/"></iframe>'],
  ["style element", "<style>body { display: none }</style>"],
  ["inline style attribute", '<span style="background:url(javascript:alert(1))">x</span>'],
  ["svg with onload", '<svg onload="alert(1)"><circle r="4"/></svg>'],
  ["javascript: image", "![pixel](javascript:alert(1))"],
  ["reference-style javascript: link", "[ref][1]\n\n[1]: javascript:alert(1)"],
];

describe("Markdown: no raw HTML, no unsafe URLs (T-04-02-01)", () => {
  for (const [name, body] of XSS) {
    for (const variant of ["chat", "document"] as const) {
      it(`${name} (${variant})`, () => expectSafe(render(body, { variant })));
    }
  }

  it("keeps http(s), mailto and same-origin links", () => {
    const html = render(
      "[site](https://example.com/a?b=1) [plain](http://example.com) [mail](mailto:team@example.com) [perm](/chat/abc?m=1)",
    );
    expect(attrs(html, "href")).toEqual([
      "https://example.com/a?b=1",
      "http://example.com",
      "mailto:team@example.com",
      "/chat/abc?m=1",
    ]);
  });

  it("links open in a new tab with noopener, noreferrer and nofollow", () => {
    for (const variant of ["chat", "document"] as const) {
      const html = render("[docs](https://example.com/docs)", { variant });
      expect(html).toMatch(/<a[^>]*target="_blank"/);
      const rel = html.match(/rel="([^"]*)"/)?.[1] ?? "";
      expect(rel.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer", "nofollow"]));
    }
  });
});

describe("Markdown: images never load pixels (T-04-02-02)", () => {
  it("an image renders as a link to its URL, never an img element", () => {
    for (const variant of ["chat", "document"] as const) {
      const html = render("![tracking pixel](https://tracker.example/p.gif)", { variant });
      expect(html).not.toMatch(/<img/i);
      expect(html).toMatch(/<a[^>]*href="https:\/\/tracker\.example\/p\.gif"[^>]*>tracking pixel<\/a>/);
    }
  });
});

describe("Markdown: mentions", () => {
  it("a known @handle renders a chip; an unknown one stays text", () => {
    const html = render("hi @sam and @nobody");
    expect(html.match(/data-testid="mention"/g)).toHaveLength(1);
    expect(html).toMatch(/data-testid="mention"[^>]*>@sam</);
    expect(html).toContain("@nobody");
  });

  it("no chip inside inline code, a fenced block or a link", () => {
    const html = render("`@sam`\n\n```\n@sam\n```\n\n[@sam](https://example.com)");
    expect(html).not.toContain('data-testid="mention"');
  });

  it("my own handle is highlighted differently", () => {
    const me = render("@sam", {}, { handles: new Map([["sam", SAM]]), myHandle: "sam" });
    const other = render("@sam");
    expect(me).toContain('data-testid="mention"');
    expect(me).not.toEqual(other);
  });
});

describe("Markdown: the shared subset", () => {
  const TABLE = "| a | b |\n| --- | --- |\n| 1 | 2 |";

  it("a GFM table renders inside a horizontal scroll wrapper", () => {
    for (const variant of ["chat", "document"] as const) {
      const html = render(TABLE, { variant });
      expect(html).toMatch(/<div[^>]*overflow-x-auto[^>]*>(?:<[^>]+>)*<table/);
    }
  });

  it("a fenced ts block renders a pre/code pair", () => {
    for (const variant of ["chat", "document"] as const) {
      const html = render("```ts\nconst a: number = 1;\n```", { variant });
      expect(html).toMatch(/<pre[\s>]/);
      expect(html).toMatch(/<code[\s>]/);
      expect(html).toContain("const");
    }
  });

  it("lists and quotes render", () => {
    const html = render("- one\n- two\n\n1. first\n\n> quoted");
    expect(html).toMatch(/<ul/);
    expect(html).toMatch(/<ol/);
    expect(html).toMatch(/<blockquote/);
  });

  it('variant "chat" maps # Title to a bold paragraph; "document" keeps a heading', () => {
    const chat = render("# Title", { variant: "chat" });
    expect(chat).not.toMatch(/<h[1-6]/);
    expect(chat).toMatch(/<p[^>]*font-semibold[^>]*>Title<\/p>/);
    expect(render("# Title", { variant: "document" })).toMatch(/<h[1-6][^>]*>Title<\/h[1-6]>/);
  });

  it("defaults to the chat variant", () => {
    expect(render("# Title")).toEqual(render("# Title", { variant: "chat" }));
  });

  it("a 10,000-line code block renders in under 1 s (T-04-02-04)", () => {
    const lines = Array.from({ length: 10_000 }, (_, i) => `const value${i} = ${i} * 2; // line ${i}`);
    const body = `\`\`\`ts\n${lines.join("\n")}\n\`\`\``;
    const started = performance.now();
    const html = render(body);
    const elapsed = performance.now() - started;
    expect(html).toContain("value9999");
    expect(elapsed).toBeLessThan(1000);
  });
});
