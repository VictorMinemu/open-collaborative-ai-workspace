import { createHash } from "node:crypto";

/**
 * Stable names for MCP servers and their tools in the cell (research Addendum B1, Pitfall P-B2).
 *
 * OpenClaw names MCP tools `<safeServerName>__<tool>`. Human server names (and OpenClaw's declaration-order
 * collision suffixes on them) would make tool names drift on a rename or reorder, so every server gets an
 * immutable `m` + 8 hex name derived from its id. The tool fragment mirrors OpenClaw 2026.9.7
 * `buildSafeToolName` (dist `agent-bundle-mcp-names.ts`) exactly, so the names the API grants are the names
 * the cell exposes.
 */

const TOOL_NAME_SAFE_RE = /[^A-Za-z0-9_-]/g;
const TOOL_NAME_MAX_TOTAL = 64;

/** `m` + the first 8-hex slice of sha256(id) not in `taken` (then the next slice, …). */
export function safeServerName(serverId: string, taken: ReadonlySet<string>): string {
  const hex = createHash("sha256").update(serverId).digest("hex");
  for (let i = 0; i + 8 <= hex.length; i += 8) {
    const candidate = `m${hex.slice(i, i + 8)}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("no free MCP server name for this id");
}

/** OpenClaw `sanitizeToolName`: unsafe chars → `-`, must start with a letter (`tool-` prefix), `tool` if empty. */
function sanitizeToolFragment(raw: string): string {
  const normalized = raw.trim().replace(TOOL_NAME_SAFE_RE, "-") || "tool";
  return /^[A-Za-z]/.test(normalized) ? normalized : `tool-${normalized}`;
}

function buildSafeToolName(safeName: string, tool: string, reserved: Set<string>): string {
  const maxToolChars = Math.max(1, TOOL_NAME_MAX_TOTAL - safeName.length - 2);
  const truncated = sanitizeToolFragment(tool).slice(0, maxToolChars) || "tool";
  let candidate = `${safeName}__${truncated}`;
  let n = 2;
  while (reserved.has(candidate.toLowerCase())) {
    const suffix = `-${n}`;
    candidate = `${safeName}__${truncated.slice(0, Math.max(1, maxToolChars - suffix.length))}${suffix}`;
    n += 1;
  }
  return candidate;
}

/** `${safe}__${tool sanitised}`, at most 64 characters. */
export function openclawToolName(safeName: string, tool: string): string {
  return buildSafeToolName(safeName, tool, new Set());
}

/**
 * OpenClaw names for a server's tool list, returned in input order. OpenClaw 2026.9.7
 * (`buildBundleMcpToolsFromCatalog`) materialises a server's tools sorted by MCP name (`localeCompare`) and only
 * then assigns the `-2`, `-3` … collision suffixes, so the suffixes follow that order, never the server's listing
 * order: a server that reorders its list keeps every tool's name.
 */
export function openclawToolNames(safeName: string, tools: readonly string[]): string[] {
  const reserved = new Set<string>();
  const out: string[] = new Array(tools.length);
  const order = tools.map((tool, index) => ({ tool, index })).sort((a, b) => a.tool.localeCompare(b.tool));
  for (const { tool, index } of order) {
    const name = buildSafeToolName(safeName, tool, reserved);
    reserved.add(name.toLowerCase());
    out[index] = name;
  }
  return out;
}

/** Env var the cell exports a header value as (`${OCW_MCP_<SAFE>_<index>}` in its config, D-13). */
export function cellEnvName(safeName: string, index: number): string {
  return `OCW_MCP_${safeName.toUpperCase()}_${index}`;
}
