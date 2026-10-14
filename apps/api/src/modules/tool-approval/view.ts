import {
  type ApprovalToolSourceKind,
  hasInvisible,
  revealInvisible,
  TOOL_APPROVAL_LIMITS,
  type ToolApproverKind,
  type ToolCallPreviewField,
} from "@ocw/contracts";

/**
 * Display helpers of a `tool.call` approval (07.5-07, UI-SPEC Surface 1 and 2, R7): pure functions, no I/O. Every
 * string here is for people only: the hash is always over the raw canonical arguments, never over what is shown.
 */

const SAFE_PREFIX = /^m[0-9a-f]{8}__(?=.)/;

/** The tool's own name: `m1a2b3c4d__create_invoice` → `create_invoice` (the server shows in Source). */
export function shortToolName(tool: string): string {
  return tool.replace(SAFE_PREFIX, "");
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  let head = text.slice(0, max - 1);
  // Never leave half a surrogate pair behind.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}…`;
}

/** `due_date` / `dueDate` → "Due date"; invisible characters revealed; at most 60 characters. */
export function humanizeKey(key: string): string {
  const words = revealInvisible(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.\s]+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) return "Value";
  return cut(words.charAt(0).toUpperCase() + words.slice(1), 60);
}

export interface PreviewResult {
  fields: ToolCallPreviewField[];
  /** A value was cut at 500 characters or the arguments need more than 12 fields. */
  truncated: boolean;
  notices: { hiddenCharacters: boolean; maskedSecret: boolean };
}

/** A top-level value as people read it: strings as they are, anything else as one compact JSON value. */
function rawText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The preview of the arguments: every key in the server's order, labelled, revealed and cut (UI-SPEC R7). */
export function orderPreview(args: Record<string, unknown>): PreviewResult {
  const keys = Object.keys(args).sort();
  let truncated = keys.length > TOOL_APPROVAL_LIMITS.previewFields;
  let hiddenCharacters = false;
  const fields = keys.slice(0, TOOL_APPROVAL_LIMITS.previewFields).map((key) => {
    const raw = rawText(args[key]);
    if (hasInvisible(raw) || hasInvisible(key)) hiddenCharacters = true;
    const shown = revealInvisible(raw);
    if (shown.length > TOOL_APPROVAL_LIMITS.previewValueChars) truncated = true;
    return {
      key: cut(key, 128),
      label: humanizeKey(key),
      value: cut(shown, TOOL_APPROVAL_LIMITS.previewValueChars),
    };
  });
  return { fields, truncated, notices: { hiddenCharacters, maskedSecret: false } };
}

/** The card and review title (UI-SPEC Copywriting › Action card), at most 200 characters. */
export function toolCallTitle(p: {
  tool: string;
  sourceKind: ApprovalToolSourceKind;
  sourceName: string;
}): string {
  const tool = shortToolName(p.tool);
  switch (p.sourceKind) {
    case "mcp":
    case "connector":
      return cut(`Run ${tool} on ${p.sourceName}`, 200);
    default:
      return cut(`Run ${tool}`, 200);
  }
}

/** "Waiting for …" (UI-SPEC Surface 1 approver label), at most 200 characters. */
export function approverText(p: {
  approverKind: ToolApproverKind | null;
  requesterName: string;
  names: readonly string[];
  unitName: string | null;
}): string {
  switch (p.approverKind) {
    case null:
    case "requester":
      return cut(`Waiting for ${p.requesterName} to approve`, 200);
    default:
      return "Waiting for an approver";
  }
}
