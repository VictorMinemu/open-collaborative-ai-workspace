import { SNIPPET_MAX } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { snippetOf } from "./snippet";

describe("snippetOf (inbox snippets are one line of plain text)", () => {
  it("collapses whitespace into one line", () => {
    expect(snippetOf("  hi\n\n@sam   how are\tyou  ")).toBe("hi @sam how are you");
  });

  it("drops Markdown markup and keeps the words and mentions", () => {
    expect(snippetOf("Due **Friday**, see [the plan](https://x.test/p) and `make ship`, @sam")).toBe(
      "Due Friday, see the plan and make ship, @sam",
    );
    expect(snippetOf("# Title\n> quoted\n- item one\n1. item two\n~~old~~ _new_")).toBe(
      "Title quoted item one item two old new",
    );
    expect(snippetOf("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
    expect(snippetOf("snake_case_name stays")).toBe("snake_case_name stays");
  });

  it("is at most SNIPPET_MAX characters and never splits an emoji", () => {
    const s = snippetOf(`${"a".repeat(SNIPPET_MAX - 2)}😀😀😀`);
    expect(s.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(s.endsWith("…")).toBe(true);
    expect(s).not.toMatch(/[\uD800-\uDBFF]…$/);
  });
});
