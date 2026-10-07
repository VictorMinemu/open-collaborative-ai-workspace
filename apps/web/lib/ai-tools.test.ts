import { aiToolStates } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { sourceLinks, TOOL_REASON_TEXT, webToolReason } from "./ai-tools";

const plan = {
  group: "chatgpt_plan" as const,
  caps: { vision: true, pdf: false, webSearch: "hosted" as const },
};
const planNoSearch = { ...plan, caps: { ...plan.caps, webSearch: "none" as const } };
const org = {
  group: "organization" as const,
  caps: { vision: true, pdf: true, webSearch: "function" as const },
};
const orgNoSearch = { ...org, caps: { ...org.caps, webSearch: "none" as const } };

describe("webToolReason", () => {
  it("is null when policy, permission and the model allow it", () => {
    expect(webToolReason(aiToolStates({ reason: null, on: false }), undefined, plan)).toBeNull();
    expect(webToolReason(undefined, undefined, org)).toBeNull();
  });

  it("member-wide reasons win over the model", () => {
    expect(webToolReason(aiToolStates({ reason: "disabled_by_org", on: false }), undefined, plan)).toBe(
      "disabled_by_org",
    );
    expect(webToolReason(undefined, aiToolStates({ reason: "denied", on: true }), org)).toBe("denied");
  });

  it("a chat's model reason is recomputed for the selected model", () => {
    const chat = aiToolStates({ reason: "not_supported_by_model", on: true });
    expect(webToolReason(undefined, chat, org)).toBeNull();
    expect(webToolReason(undefined, chat, planNoSearch)).toBe("not_supported_by_model");
    expect(webToolReason(undefined, undefined, orgNoSearch)).toBe("search_not_configured");
  });

  it("every reason has words", () => {
    expect(TOOL_REASON_TEXT.search_not_configured).toContain("SearXNG");
    expect(TOOL_REASON_TEXT.not_available_yet).toBe("Not available yet");
  });
});

describe("sourceLinks", () => {
  it("links each domain to the first cited page of it, else its home page", () => {
    const text =
      "News ([example.com](https://example.com/ocw-fake/ocw-release)) and https://www.other.org/a?b=1 too.";
    expect(sourceLinks(text, ["example.com", "other.org", "missing.net"])).toEqual([
      { domain: "example.com", href: "https://example.com/ocw-fake/ocw-release" },
      { domain: "other.org", href: "https://www.other.org/a?b=1" },
      { domain: "missing.net", href: "https://missing.net/" },
    ]);
  });
});
