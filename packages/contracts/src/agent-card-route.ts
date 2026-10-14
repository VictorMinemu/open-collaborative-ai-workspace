import { z } from "zod";

/**
 * Internal app routes an Agent Card's Open action (or an approval view) may point to. A leaf module (zod only) so that
 * `tool-approvals.ts`, which `approvals.ts` imports, can use `AgentCardRoute` without the cycle
 * agent-cards → approvals → tool-approvals → agent-cards (Phase 07.5). `agent-cards.ts` re-exports every name here.
 */

const AGENT_CARD_ROUTE_MAX = 512;

/** The app areas an Open action may lead to (never an external URL). */
export const AGENT_CARD_ROUTE_PREFIXES = [
  "/chat",
  "/work-zone",
  "/bots",
  "/settings",
  "/search",
  "/share",
  // Phase 07.2: memory files and proposals (`/memory/proposals/<id>`).
  "/memory",
  // Phase 07.5: the action and Work Zone approvals inbox and review (`/approvals/<id>`).
  "/approvals",
] as const;

function hasControlCharacter(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/**
 * True for an internal app route: one `AGENT_CARD_ROUTE_PREFIXES` entry followed by the end, "/", "?" or "#"; no
 * scheme, no "//", no backslash (browsers read it as "/"), no "." or ".." path segment (also percent-encoded, which
 * the URL parser normalises), no control character, at most 512 characters. The client re-checks it before navigating.
 */
export function isAgentCardRoute(v: string): boolean {
  if (v.length > AGENT_CARD_ROUTE_MAX || hasControlCharacter(v)) return false;
  if (v.includes("\\") || v.includes("//")) return false;
  const prefixed = AGENT_CARD_ROUTE_PREFIXES.some(
    (p) => v.startsWith(p) && (v.length === p.length || ["/", "?", "#"].includes(v.charAt(p.length))),
  );
  if (!prefixed) return false;
  const path = v.split(/[?#]/, 1)[0] ?? "";
  return path.split("/").every((segment) => {
    const s = segment.replace(/%2e/gi, ".");
    return s !== "." && s !== "..";
  });
}

export const AgentCardRoute = z
  .string()
  .max(AGENT_CARD_ROUTE_MAX)
  .refine(isAgentCardRoute, { message: "must be an internal app route" });
export type AgentCardRoute = z.infer<typeof AgentCardRoute>;
