import type { AiModelOption, AiToolKey, AiToolState, AiToolUnavailableReason } from "@ocw/contracts";

/**
 * AI chat tool toggles in the browser (05-11, AICHAT-06). The server is the authority (it re-checks policy,
 * permission and model support at every turn); these helpers only explain, in words, why a toggle is off.
 */

export const TOOL_REASON_TEXT: Record<AiToolUnavailableReason, string> = {
  not_available_yet: "Not available yet",
  disabled_by_org: "Turned off by your admin",
  denied: "Not allowed for your role",
  search_not_configured: "Web search needs the search service (SearXNG) — ask your admin",
  not_supported_by_model: "This model can't search the web on your plan",
};

/** Policy and permission reasons: they hold for every model. */
const MEMBER_REASONS = new Set<AiToolUnavailableReason>(["disabled_by_org", "denied"]);

/**
 * Why Web is unavailable for the next answer, or null when it can be used: the member-wide reason (organization
 * policy, a deny rule) from the model list or the chat, else the selected model's own support (the plan's hosted
 * search, or SearXNG on organization models).
 */
export function webToolReason(
  memberTools: readonly AiToolState[] | undefined,
  chatTools: readonly AiToolState[] | undefined,
  model: Pick<AiModelOption, "caps" | "group"> | null,
): AiToolUnavailableReason | null {
  for (const list of [memberTools, chatTools]) {
    const reason = list?.find((t) => t.key === "web")?.reason ?? null;
    if (reason && MEMBER_REASONS.has(reason)) return reason;
  }
  if (model && model.caps.webSearch === "none") {
    return model.group === "chatgpt_plan" ? "not_supported_by_model" : "search_not_configured";
  }
  return null;
}

export const TOOL_ORDER: readonly AiToolKey[] = ["web", "companyKnowledge", "mcp", "skills"];

/** One source chip: the cited domain and the page it links to (the first link to that domain in the answer). */
export interface SourceLink {
  domain: string;
  href: string;
}

const MD_LINK = /\]\((https?:\/\/[^\s)]+)\)/gu;
const BARE_URL = /https?:\/\/[^\s)<>\]"']+/gu;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return null;
  }
}

/**
 * The answer's sources as chips: one per recorded domain (in order), linking to the first page of that domain the
 * answer cites (Markdown links first, then bare URLs), else the domain's home page.
 */
export function sourceLinks(text: string, domains: readonly string[]): SourceLink[] {
  const cited = [...text.matchAll(MD_LINK)].map((m) => m[1] ?? "");
  const bare = [...text.matchAll(BARE_URL)].map((m) => m[0]);
  const urls = [...cited, ...bare];
  return domains.map((domain) => ({
    domain,
    href: urls.find((u) => hostOf(u) === domain) ?? `https://${domain}/`,
  }));
}
