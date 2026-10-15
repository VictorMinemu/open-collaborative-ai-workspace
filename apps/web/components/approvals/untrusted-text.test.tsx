import type { WorkZoneProposalView as WorkZoneProposal } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { splitUntrusted, UntrustedText } from "./untrusted-text";
import { WorkZoneProposalView } from "./work-zone-proposal-view";

/**
 * `UntrustedText` (07.5-13, UI-SPEC Surface 1 "Untrusted text", T-07.5-13-01): every value a bot wrote is shown as text
 * nodes only. Revealed invisible characters (`⟨U+202E⟩`, revealed by the server) become named chips, masked secrets
 * read in mono, a long value clamps with Show more, and nothing is ever a link, Markdown or HTML.
 */

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("splitUntrusted", () => {
  it("splits markers and masked runs out of plain text, keeping every character", () => {
    const text = "pay⟨U+202E⟩to ES91 •••• 1332 now";
    const parts = splitUntrusted(text);
    expect(parts.map((p) => p.text).join("")).toBe(text);
    expect(parts).toEqual([
      { kind: "text", text: "pay" },
      { kind: "marker", text: "⟨U+202E⟩", code: "U+202E" },
      { kind: "text", text: "to " },
      { kind: "masked", text: "ES91 •••• 1332" },
      { kind: "text", text: " now" },
    ]);
  });

  it("finds a prefixed key mask and a bare card mask", () => {
    expect(splitUntrusted("key sk-ant-•••• 9f2c").filter((p) => p.kind === "masked")).toEqual([
      { kind: "masked", text: "sk-ant-•••• 9f2c" },
    ]);
    expect(splitUntrusted("•••• 1111").filter((p) => p.kind === "masked")).toEqual([
      { kind: "masked", text: "•••• 1111" },
    ]);
  });
});

describe("UntrustedText", () => {
  it("wraps a revealed invisible character in a chip named for assistive tech", () => {
    const out = html(<UntrustedText text="pay⟨U+202E⟩to" />);
    expect(out).toMatch(
      /<span[^>]*role="img"[^>]*aria-label="hidden character U\+202E"[^>]*>⟨U\+202E⟩<\/span>/,
    );
    expect(out).toContain("font-mono");
    expect(out).toContain("bg-amber-100");
  });

  it("never renders a link, Markdown or HTML", () => {
    const out = html(
      <UntrustedText text={"see https://x.example and a@b.example **bold** <b>x</b> [l](http://y)"} />,
    );
    expect(out).not.toMatch(/<a[\s>]/);
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("<strong>");
    expect(out).toContain(
      "see https://x.example and a@b.example **bold** &lt;b&gt;x&lt;/b&gt; [l](http://y)",
    );
  });

  it("shows a masked secret in mono", () => {
    const out = html(<UntrustedText text="to ES91 •••• 1332." />);
    expect(out).toMatch(/<span[^>]*font-mono[^>]*>ES91 •••• 1332<\/span>/);
  });

  it("clamps a long value with a Show more toggle that names what it controls", () => {
    const seven = ["1", "2", "3", "4", "5", "6", "7"].join("\n");
    const out = html(<UntrustedText text={seven} clampLines={6} />);
    const toggle = out.match(/<button[^>]*>[^<]*Show more[^<]*<\/button>/)?.[0] ?? "";
    expect(toggle).toContain('aria-expanded="false"');
    const controls = toggle.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(out).toContain(`id="${controls}"`);
    expect(out).toContain("-webkit-line-clamp:6");
  });

  it("has no toggle when the value fits", () => {
    const out = html(<UntrustedText text={"1\n2\n3"} clampLines={6} />);
    expect(out).not.toContain("Show more");
    expect(out).not.toContain("aria-expanded");
  });

  it("keeps whitespace and line breaks as written", () => {
    const out = html(<UntrustedText text={"a\n\n  b"} />);
    expect(out).toContain("whitespace-pre-wrap");
    expect(out).toContain("a\n\n  b");
  });

  it("renders the whole value in mono on request", () => {
    expect(html(<UntrustedText text="abc" mono />)).toMatch(/class="[^"]*font-mono/);
  });
});

describe("the Work Zone prompt goes through UntrustedText", () => {
  const view = (prompt: string): WorkZoneProposal => ({
    type: "work_zone_proposal",
    title: "Start a session in billing-api",
    project: { id: "01a11635-d6e7-7c87-9f17-000000000004", name: "billing-api", removed: false },
    device: { id: "01a11635-d6e7-7c87-9f17-000000000003", name: "MacBook Pro", online: true, usable: true },
    runtime: { id: "claude-code", label: "Claude Code", available: true },
    mode: "default",
    prompt,
    agent: { id: "01a11635-d6e7-7c87-9f17-000000000002", displayName: "Scout" },
    requestedFor: { id: "01a11635-d6e7-7c87-9f17-000000000001", displayName: "Sam Lee" },
    origin: { kind: "dm", name: null },
    workSessionId: null,
    startBlocked: null,
  });

  it("a revealed zero-width space in the prompt becomes a chip", () => {
    const out = html(<WorkZoneProposalView view={view("Fix it⟨U+200B⟩ now")} device="online" />);
    expect(out).toContain('aria-label="hidden character U+200B"');
    expect(out).not.toMatch(/<a[\s>]/);
  });
});
