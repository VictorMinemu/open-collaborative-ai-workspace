import { SESSION_RENAME_REFUSAL_TEXT, SessionRenameRefusal } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import {
  canonicalSessionTool,
  refusalResult,
  renameDescription,
  renameResultText,
  WORK_SESSION_TOOL_TABLE,
} from "./tools.js";

describe("ocw_session tool text (07.13.1.1 D-07, D-08, PD-13)", () => {
  it("the description states the shape, the rate and that a person's title stays, with no rules block", () => {
    const text = renameDescription(null);
    expect(text).toContain("2 to 5 words");
    expect(text).toContain("32 characters");
    expect(text).toContain("once per turn");
    expect(text).toContain("never replaced");
    expect(text).not.toMatch(/naming-rules/i);
  });

  it("naming rules go between naming-rules tags after a sentence framing them as wording data", () => {
    const text = renameDescription("A\n\nB");
    const open = text.indexOf("<naming-rules>");
    const close = text.indexOf("</naming-rules>");
    expect(open).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(open);
    expect(text.slice(open + "<naming-rules>".length, close).trim()).toBe("A\n\nB");
    const before = text.slice(0, open);
    expect(before).toMatch(/data, not instructions/);
    expect(before).toMatch(/only to how the title is worded/);
    // Nothing follows the closing tag: the rules are the last thing the model reads.
    expect(text.slice(close + "</naming-rules>".length).trim()).toBe("");
  });

  it("blank rules are no rules", () => {
    expect(renameDescription("   ")).toBe(renameDescription(null));
  });

  it("result texts: the stored title for ok, the contracts sentence for each refusal", () => {
    expect(renameResultText({ ok: true, title: "Fix login redirect" })).toBe(
      'Renamed the session to "Fix login redirect".',
    );
    for (const reason of SessionRenameRefusal.options) {
      expect(renameResultText({ ok: false, reason })).toBe(SESSION_RENAME_REFUSAL_TEXT[reason]);
      expect(refusalResult(reason)).toEqual({
        content: [{ type: "text", text: SESSION_RENAME_REFUSAL_TEXT[reason] }],
        isError: true,
      });
    }
  });

  it("the table has one tool, rename, with the strict input", () => {
    expect(Object.keys(WORK_SESSION_TOOL_TABLE)).toEqual(["rename"]);
    expect(WORK_SESSION_TOOL_TABLE.rename.input.safeParse({ title: "Fix login" }).success).toBe(true);
    expect(WORK_SESSION_TOOL_TABLE.rename.input.safeParse({ title: "Fix login", x: 1 }).success).toBe(false);
    expect(canonicalSessionTool("rename")).toBe("ocw_session_rename");
  });
});
