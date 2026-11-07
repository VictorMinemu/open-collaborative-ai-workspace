import { SNIPPET_MAX } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { dropFenceLines, snippetOf, unwrapLinks, unwrapStrong } from "./snippet";

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

  it("keeps the edge cases of the fence, link and strong rules", () => {
    expect(snippetOf("a\n\n  ```ts\nb\n~~~\nc")).toBe("a b c");
    expect(snippetOf("![logo](x.png) [a [b](c) [d](e\n)")).toBe("logo a [b [d](e )");
    expect(snippetOf("**a **b** ~~ c~~ __d__")).toBe("a **b ~~ c~~ d");
  });
});

/**
 * Best of five interleaved passes per size after a warm-up, so a busy host slows both sizes alike. A pass over
 * `ceiling` ms ends the measurement at once instead of repeating it.
 */
function bestPair(
  fn: (text: string) => unknown,
  small: string,
  large: string,
  ceiling: number,
): [number, number] {
  const time = (text: string) => {
    const t0 = performance.now();
    fn(text);
    return performance.now() - t0;
  };
  let a = Number.POSITIVE_INFINITY;
  let b = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 6; i++) {
    const ta = time(small);
    if (ta > ceiling) return [ta, ta];
    const tb = time(large);
    if (tb > ceiling) return [ta, tb];
    if (i === 0) continue; // warm-up
    a = Math.min(a, ta);
    b = Math.min(b, tb);
  }
  return [a, b];
}

describe("snippetOf is linear on hostile bodies (it runs on every inbox read)", () => {
  // Before: the fence rule rescanned a whitespace run from every line start (~220 ms at 20 000 newlines), the link
  // rule a label or URL from every `[` (~160 ms at 20 000 `[`), the strong rule a line from every opener (~100 ms at
  // 20 000 characters of `**a `): 2-30 s at 64 000, against ~2 ms (and ~10 ms at 256 KiB) for the scans.
  const SHAPES = ["\n", "\r\n", " \n", "\r", "[", "![", "[a](", "**a ", "__a ", "~~a "];
  const sized = (run: string, size: number) => `x${run.repeat(Math.ceil(size / run.length)).slice(0, size)}x`;
  const CEILING = 2000;
  for (const shape of SHAPES) {
    it(`${JSON.stringify(shape)} repeated scales linearly (64 000 → 256 KiB)`, () => {
      const [small, large] = bestPair(snippetOf, sized(shape, 64_000), sized(shape, 256 * 1024), CEILING);
      expect(large).toBeLessThan(CEILING);
      // 4x the input: about 4x the time when linear, 16x when quadratic. The 2 ms floor stops a tiny baseline from
      // inflating the ratio.
      expect(large / Math.max(small, 2)).toBeLessThan(10);
    }, 60_000);
  }
});

// The literals the rewritten rules had before (the oracle): the scans only stop rescanning from every start position.
const ORIGINAL = {
  fence: (s: string) => s.replace(/^\s*(```|~~~)[^\n]*$/gm, " "),
  link: (s: string) => s.replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1"),
  strong: (s: string) => s.replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2"),
};
const REWRITTEN = { fence: dropFenceLines, link: unwrapLinks, strong: unwrapStrong };

/** Tokens that exercise every branch: every line terminator, Unicode whitespace, fences, delimiters and brackets. */
const TOKENS = [
  ..."ab*_~`[]()!#>-+1. \n\r\t\u00a0\u2028\u2029\u3000\ufeffé",
  "```",
  "~~~",
  "**",
  "__",
  "~~",
  "[a]",
  "](",
  "[a](b)",
  "![x](y)",
  "\r\n",
  "😀",
];

function fuzzCorpus(count: number, seed: number): string[] {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  return Array.from({ length: count }, () => {
    let s = "";
    const n = 1 + Math.floor(next() * 32);
    for (let i = 0; i < n; i++) s += TOKENS[Math.floor(next() * TOKENS.length)];
    return s;
  });
}

describe("the linear rules give the original regexes' output", () => {
  const corpus = fuzzCorpus(40_000, 2026);
  for (const id of ["fence", "link", "strong"] as const) {
    it(`${id}: identical output on a seeded random corpus`, () => {
      let changed = 0;
      for (const text of corpus) {
        const expected = ORIGINAL[id](text);
        if (expected !== text) changed++;
        expect(REWRITTEN[id](text)).toBe(expected);
      }
      // The corpus actually exercises the rule.
      expect(changed).toBeGreaterThan(1000);
    });
  }
});
