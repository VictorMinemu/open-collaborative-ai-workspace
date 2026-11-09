import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentAuthorLine, OutsideContentChip } from "./agent-author-line";

const scout = { agentId: "44444444-4444-4444-8444-444444444444", displayName: "Scout", handle: "scout" };
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** 07.16-18 (D-06, D-08, PD-20): who wrote a prompt and after what, in the queue and the stream. */
describe("AgentAuthorLine", () => {
  it("shows the bot's name and '· for' the person's first name; screen readers hear one phrase", () => {
    const html = renderToStaticMarkup(<AgentAuthorLine agent={scout} forName="Ana Pérez" />);
    expect(html).toContain('data-testid="agent-author"');
    expect(html).toContain('<span class="sr-only">Scout, for Ana Pérez</span>');
    // The visible parts are decoration for screen readers.
    expect(text(html.replace(/<span class="sr-only">[^<]*<\/span>/, ""))).toBe("Scout · for Ana");
    expect(html).not.toContain('sr-only">Scout · for Ana<');
  });

  it("without a person's name says only the bot's", () => {
    const html = renderToStaticMarkup(<AgentAuthorLine agent={scout} forName={null} />);
    expect(html).toContain('<span class="sr-only">Scout</span>');
    expect(html).not.toContain("for ");
  });
});

describe("OutsideContentChip", () => {
  it("is the amber 'After outside content' chip with the reason in words for screen readers", () => {
    const html = renderToStaticMarkup(<OutsideContentChip />);
    expect(html).toContain('data-testid="outside-content"');
    expect(text(html)).toContain("After outside content");
    expect(html).toContain(
      "Sent after the bot read outside content (an MCP result, a file, a webhook or a web page)",
    );
    expect(html).toContain("text-amber-800");
    expect(html).toContain("dark:text-amber-300");
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
});
