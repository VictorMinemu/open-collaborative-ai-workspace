import { z } from "zod";

/**
 * Phase 07.13.1.1 (D-07, D-08, ADR-0047): the `ocw_session` tool a Work Zone session's agent (Claude Code, Codex) uses
 * to rename its own session, and the organization's and project's naming rules it follows. The device exposes the
 * tool through the same on-device bridge as the 07.13 browser tools; the API alone decides every rename (`session.rename`
 * on the Device Link, answered by `session.rename.result`).
 *
 * Naming rules are untrusted wording data written by admins and project leads: they are never instructions, never
 * executed, and never logged or audited as text (audit carries a length at most). They reach the agent only inside
 * the tool's description and the title call, wrapped by the device in `<naming-rules>` tags that `joinNamingRules`
 * makes sure no rule can close.
 *
 * Imports only `zod`, so `device-link`, `work-zone-policy` and `work-projects` import it without a cycle; nothing here
 * uses `node:*`, so the web imports it.
 */

/** The MCP server name both runtimes see (`mcp__ocw_session__rename` in Claude Code, PD-08). */
export const WORK_SESSION_MCP_SERVER = "ocw_session";

/** The tools' short names inside the MCP server: renaming the session is the only one (D-07). */
export const WorkSessionTool = z.enum(["rename"]);
export type WorkSessionTool = z.infer<typeof WorkSessionTool>;

/**
 * What the agent passes to `rename`. Bounded and strict only: the API checks the generated-title shape (`SessionTitle`,
 * 2-5 words, at most 32 characters, no host path or secret) and answers `invalid_title` otherwise (D-14).
 */
export const SessionRenameInput = z.strictObject({ title: z.string().max(200) });
export type SessionRenameInput = z.infer<typeof SessionRenameInput>;

/**
 * Why the API refused a rename (D-07, D-14, PD-11, PD-12): a person typed the title (`user` is never replaced), the
 * turn already renamed the session (one rename per turn), the title has not the generated-title shape, no turn of the
 * session is in flight, or the rename is not available (unknown session, other device, the API is busy).
 */
export const SessionRenameRefusal = z.enum([
  "title_locked",
  "already_renamed",
  "invalid_title",
  "no_turn",
  "not_available",
]);
export type SessionRenameRefusal = z.infer<typeof SessionRenameRefusal>;

/** The one fixed sentence the agent gets for each refusal (never a server-built string). */
export const SESSION_RENAME_REFUSAL_TEXT: Readonly<Record<SessionRenameRefusal, string>> = {
  title_locked: "A person named this session, so their title stays.",
  already_renamed: "The session was already renamed in this turn.",
  invalid_title: "Use 2 to 5 words and at most 32 characters, with no paths or secrets.",
  no_turn: "The session can be renamed only during one of its turns.",
  not_available: "Renaming the session is not available right now.",
};

/** One naming rule (the organization's or a project's), in characters (D-08, PD-16). */
export const NAMING_RULE_MAX_CHARS = 600;
/** Both rules joined by `joinNamingRules` (organization, a blank line, project). */
export const NAMING_RULES_MAX_CHARS = 2 * NAMING_RULE_MAX_CHARS + 2;

/** Every control character except line feed and tab (a rule may span lines; no NUL, ESC, CR or C1). */
const RULE_FORBIDDEN_RE = /[^\P{Cc}\n\t]/u;

const ruleText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((text) => !RULE_FORBIDDEN_RE.test(text), { message: "control_character" });

/**
 * A naming rule as an admin or a project lead writes it: trimmed, at most `NAMING_RULE_MAX_CHARS`, line breaks and
 * tabs allowed, no other control character. Untrusted wording data (see the module comment).
 */
export const NamingRule = ruleText(NAMING_RULE_MAX_CHARS);
export type NamingRule = z.infer<typeof NamingRule>;

/** The joined rules a device receives (`joinNamingRules`), at most `NAMING_RULES_MAX_CHARS`. */
export const NamingRules = ruleText(NAMING_RULES_MAX_CHARS);
export type NamingRules = z.infer<typeof NamingRules>;

/**
 * Phase 07.13.1.1 (D-07, D-08, PD-10, PD-13): what the session's agent may do with `ocw_session` this turn, decided by
 * the API at send time and added to the sent `session.start` / `prompt` copy only. `rename` = the title is not
 * person-typed; `namingRules` = the joined rules shown in the tool's description (null = none).
 */
export const SessionToolsGrant = z.strictObject({
  rename: z.boolean(),
  namingRules: NamingRules.nullable(),
});
export type SessionToolsGrant = z.infer<typeof SessionToolsGrant>;

/** An opening or closing `naming-rules` tag, any case and spacing (`<naming-rules>`, `< / Naming-Rules >`). */
const NAMING_RULES_TAG_RE = /<\s*\/?\s*naming-rules(?![\w-])[^<>]*>/giu;

/** `text` with every `naming-rules` tag removed, repeated until none is left (a removal cannot rebuild one). */
function stripNamingRulesTags(text: string): string {
  let out = text;
  for (;;) {
    const next = out.replace(NAMING_RULES_TAG_RE, "");
    if (next === out) return out;
    out = next;
  }
}

/**
 * The rules a session follows (D-08, PD-16): the organization's, then the project's, each trimmed with every
 * `naming-rules` tag removed (so a rule can never close the delimiter the device wraps it in), blank parts dropped,
 * joined by one blank line. null when nothing is left.
 */
export function joinNamingRules(org: string | null, project: string | null): string | null {
  const parts = [org, project]
    .map((part) => (part === null ? "" : stripNamingRulesTags(part).trim()))
    .filter((part) => part.length > 0);
  return parts.length === 0 ? null : parts.join("\n\n");
}
