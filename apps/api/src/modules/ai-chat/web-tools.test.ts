import { AI_MAX_SEARCHES_PER_TURN } from "@ocw/contracts";
import type { Tool } from "ai";
import { describe, expect, it, vi } from "vitest";
import { searxngWebSearchTool, UNTRUSTED_PREFIX } from "./web-tools";

/**
 * The SearXNG `web_search` function tool of organization-key and mock answers (05-11, D-04, ADR-0010): the API
 * calls only the operator's SearXNG, returns at most five capped results labelled as untrusted, refuses a sixth
 * search in the same answer and never throws a fetch failure at the model.
 */

const BASE = "http://searxng.test:8080";

function payload(n: number, snippet = "short") {
  return {
    query: "q",
    results: Array.from({ length: n }, (_, i) => ({
      url: `https://site${i}.example/page`,
      title: `Result ${i}`,
      content: snippet,
      engine: "fake",
    })),
  };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Runs the tool's `execute` the way the AI SDK does. */
async function run(tool: Tool, input: unknown): Promise<string> {
  const exec = tool.execute as (input: unknown, opts: unknown) => Promise<string>;
  return exec(input, { toolCallId: "call-1", messages: [], abortSignal: new AbortController().signal });
}

describe("searxngWebSearchTool", () => {
  it("calls <base>/search?q=…&format=json and returns at most five results, snippets ≤ 300 chars, labelled untrusted", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(payload(8, "x".repeat(900))),
    );
    const seen: string[][] = [];
    const tool = searxngWebSearchTool({
      baseUrl: `${BASE}/`,
      fetchFn: fetchFn as unknown as typeof fetch,
      onSearch: (d) => seen.push(d),
    });
    const out = await run(tool, { query: "ocw release" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchFn.mock.calls[0]?.[0]));
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/search`);
    expect(url.searchParams.get("q")).toBe("ocw release");
    expect(url.searchParams.get("format")).toBe("json");
    expect(out.startsWith(UNTRUSTED_PREFIX)).toBe(true);
    const parsed = JSON.parse(out.slice(out.indexOf("{"))) as {
      results: Array<{ title: string; url: string; snippet: string }>;
    };
    expect(parsed.results).toHaveLength(5);
    for (const r of parsed.results) expect(r.snippet.length).toBeLessThanOrEqual(300);
    expect(seen).toEqual([
      ["site0.example", "site1.example", "site2.example", "site3.example", "site4.example"],
    ]);
  });

  it(`answers call ${AI_MAX_SEARCHES_PER_TURN + 1} of one answer with the limit message, without fetching`, async () => {
    const fetchFn = vi.fn(async () => jsonResponse(payload(1)));
    const tool = searxngWebSearchTool({
      baseUrl: BASE,
      fetchFn: fetchFn as unknown as typeof fetch,
      onSearch: () => {},
    });
    for (let i = 0; i < AI_MAX_SEARCHES_PER_TURN; i++) await run(tool, { query: `q${i}` });
    const sixth = await run(tool, { query: "one more" });
    expect(fetchFn).toHaveBeenCalledTimes(AI_MAX_SEARCHES_PER_TURN);
    expect(sixth).toMatch(/search limit reached/iu);
  });

  it("turns a non-200, a timeout or a network error into a plain 'Search failed' result", async () => {
    for (const fetchFn of [
      vi.fn(async () => jsonResponse({ error: "boom" }, 502)),
      vi.fn(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    ]) {
      const tool = searxngWebSearchTool({
        baseUrl: BASE,
        fetchFn: fetchFn as unknown as typeof fetch,
        onSearch: () => {},
      });
      expect(await run(tool, { query: "x" })).toMatch(/^Search failed/u);
    }
  });

  it("passes an 8 s timeout signal to the fetch", async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse(payload(1)),
    );
    const tool = searxngWebSearchTool({
      baseUrl: BASE,
      fetchFn: fetchFn as unknown as typeof fetch,
      onSearch: () => {},
    });
    await run(tool, { query: "x" });
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a query over 200 characters (and an empty one) in its input schema", async () => {
    const tool = searxngWebSearchTool({
      baseUrl: BASE,
      fetchFn: vi.fn() as unknown as typeof fetch,
      onSearch: () => {},
    });
    const schema = tool.inputSchema as {
      "~standard"?: unknown;
      safeParse?: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse?.({ query: "a".repeat(200) }).success).toBe(true);
    expect(schema.safeParse?.({ query: "a".repeat(201) }).success).toBe(false);
    expect(schema.safeParse?.({ query: "" }).success).toBe(false);
  });
});
