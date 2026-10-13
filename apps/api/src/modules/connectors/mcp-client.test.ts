import { describe, expect, it } from "vitest";
import { capSchema, redactSecrets, shapeTool, shapeToolResult, stripControl } from "./mcp-client";

/** The shaping of whatever a remote MCP server returns before it reaches a model, an audit row or a log (D-06). */

const TOKEN = "fakeat_c4n4ry-T0ken_value";

describe("shapeToolResult", () => {
  it("concatenates the text parts", () => {
    const out = shapeToolResult(
      {
        content: [
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
      [],
    );
    expect(out).toEqual({ content: "first\nsecond", truncated: false, isError: false });
  });

  it("JSON-stringifies structuredContent when there is no text", () => {
    const out = shapeToolResult({ content: [], structuredContent: { id: "rec_1", n: 2 } }, []);
    expect(out.content).toBe('{"id":"rec_1","n":2}');
  });

  it("keeps the text and does not repeat structuredContent when both are present", () => {
    const out = shapeToolResult(
      { content: [{ type: "text", text: '{"id":"rec_1"}' }], structuredContent: { id: "rec_1" } },
      [],
    );
    expect(out.content).toBe('{"id":"rec_1"}');
  });

  it("replaces image, audio and resource parts with a note", () => {
    const out = shapeToolResult(
      {
        content: [
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
          { type: "resource", resource: { uri: "file:///x", text: "secret file" } },
          { type: "resource_link", uri: "file:///y", name: "y" },
          { type: "text", text: "done" },
        ],
      },
      [],
    );
    expect(out.content).toBe(
      "[image omitted]\n[audio omitted]\n[resource omitted]\n[resource omitted]\ndone",
    );
    expect(out.content).not.toContain("secret file");
  });

  it("strips control characters except newline and tab", () => {
    const out = shapeToolResult(
      { content: [{ type: "text", text: "a\u0000b\u001bc\rd\te\nf\u007fg\u0085h" }] },
      [],
    );
    expect(out.content).toBe("abcd\te\nfgh");
  });

  it("caps the result at 32 KB of UTF-8 and says so", () => {
    const out = shapeToolResult({ content: [{ type: "text", text: "é".repeat(40_000) }] }, []);
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.content)).toBeLessThanOrEqual(32 * 1024);
    expect(out.content).not.toContain("�");
    const small = shapeToolResult({ content: [{ type: "text", text: "x".repeat(32 * 1024) }] }, []);
    expect(small.truncated).toBe(false);
  });

  it("redacts every credential string and its base64 forms, before the cap", () => {
    const b64 = Buffer.from(TOKEN).toString("base64");
    const b64url = Buffer.from(TOKEN).toString("base64url");
    const basic = Buffer.from(`user:${TOKEN}`).toString("base64");
    const out = shapeToolResult(
      {
        content: [
          { type: "text", text: `Bearer ${TOKEN}` },
          { type: "text", text: `b64 ${b64} url ${b64url}` },
          { type: "text", text: `basic ${basic}` },
        ],
        structuredContent: { echoed: TOKEN },
      },
      [TOKEN, `user:${TOKEN}`],
    );
    expect(out.content).not.toContain(TOKEN);
    expect(out.content).not.toContain(b64.replace(/=+$/u, ""));
    expect(out.content).not.toContain(b64url);
    expect(out.content).not.toContain(basic.replace(/=+$/u, ""));
    expect(out.content).toContain("Bearer [redacted]");

    // A token straddling the cap is redacted whole first, so no prefix of it survives the cut.
    const padded = shapeToolResult(
      { content: [{ type: "text", text: `${"x".repeat(32 * 1024 - 5)}${TOKEN}` }] },
      [TOKEN],
    );
    expect(padded.truncated).toBe(true);
    expect(padded.content).not.toContain(TOKEN.slice(0, 5));
  });

  it("redacts the long parts of a multi-word credential (the token after a scheme)", () => {
    expect(redactSecrets(`token is ${TOKEN}.`, [`Bearer ${TOKEN}`])).toBe("token is [redacted].");
  });

  it("passes isError through", () => {
    expect(shapeToolResult({ content: [{ type: "text", text: "no" }], isError: true }, []).isError).toBe(
      true,
    );
  });

  it("survives a malformed result", () => {
    expect(shapeToolResult(null, [])).toEqual({ content: "", truncated: false, isError: false });
    expect(shapeToolResult({ content: "not an array" }, []).content).toBe("");
  });
});

describe("stripControl", () => {
  it("keeps printable text, newlines and tabs", () => {
    expect(stripControl("héllo\tworld\n")).toBe("héllo\tworld\n");
  });
});

describe("capSchema and shapeTool", () => {
  it("keeps a small schema and drops one over 16 KB serialized", () => {
    const small = { type: "object", properties: { title: { type: "string" } } };
    expect(capSchema(small)).toEqual(small);
    const big = { type: "object", description: "x".repeat(16 * 1024) };
    expect(capSchema(big)).toBeNull();
    expect(capSchema("not an object")).toBeNull();
    expect(capSchema(null)).toBeNull();
  });

  it("derives readOnly and destructive from the annotations (destructive by default unless read-only)", () => {
    expect(
      shapeTool({
        name: "whoami",
        annotations: { readOnlyHint: true, destructiveHint: false },
        inputSchema: {},
      }),
    ).toMatchObject({ name: "whoami", readOnly: true, destructive: false, description: null });
    expect(shapeTool({ name: "create", annotations: { destructiveHint: true } })).toMatchObject({
      readOnly: false,
      destructive: true,
    });
    expect(shapeTool({ name: "plain" })).toMatchObject({
      readOnly: false,
      destructive: true,
      inputSchema: null,
    });
    expect(shapeTool({ name: "safe-write", annotations: { destructiveHint: false } })).toMatchObject({
      readOnly: false,
      destructive: false,
    });
  });

  it("cleans and caps the description and refuses a nameless tool", () => {
    expect(shapeTool({ name: "t", description: `a\u0000b${"x".repeat(2000)}` })?.description).toMatch(
      /^abx+$/u,
    );
    expect(shapeTool({ name: "t", description: "x".repeat(2000) })?.description?.length).toBe(1024);
    expect(shapeTool({ description: "no name" })).toBeNull();
    expect(shapeTool({ name: "" })).toBeNull();
  });
});
