// The redacting snapshot serializer of the bot browser agent (07.8-07, D-07, P-10). Pure, no dependencies.
//
// E1 (07.8-RESEARCH.md §6): Playwright's aria snapshot, DOMSnapshot and DOM.getDocument all carry a typed password, so
// the bot never reads them. The agent reads CDP `Accessibility.getFullAXTree` and passes it through
// `serializeSnapshot`, which replaces the value of every sensitive or human-typed field with "[redacted]" and never
// serializes what is inside a text field (its inner editor repeats the value). Default to redact on doubt: a text
// field whose DOM facts the agent could not read is sensitive.
//
//   facts (per backendDOMNodeId, read by the agent in its isolated world; never the value):
//     { tag, type, autocomplete, textSecurity, label, attrName, attrId, placeholder }
//   marks: Set<backendDOMNodeId> of fields that received a person's input during a takeover.

export const REDACTED = "[redacted]";
export const SENSITIVE_AUTOCOMPLETE = /\b(current-password|new-password|one-time-code)\b/i;
export const SENSITIVE_LABEL = /pass|pwd|otp|code|pin|secret|token/i;

/** Roles whose value the snapshot may show (after redaction). Every other role carries `value: null`. */
const VALUE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider"]);
/** Text-entry roles: redacted when the agent has no facts for them (default to redact on doubt). */
const TEXT_ENTRY_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
/** Never serialize inside these: the inner editor's static text repeats the field's value. */
const OPAQUE_ROLES = new Set(["textbox", "searchbox", "spinbutton"]);
/** Dropped with their subtree (they only repeat their parent's text). */
const DROPPED_ROLES = new Set(["InlineTextBox", "LineBreak"]);
/** Dropped, children kept at the same depth, when they have no name. */
const FLATTENED_ROLES = new Set(["generic", "none", "presentation", "LayoutTable", "LayoutTableRow"]);

const NAME_MAX = 200;
const VALUE_MAX = 2000;
const ROLE_MAX = 64;
const DEPTH_MAX = 256;
const REF = /^e([1-9]\d{0,15})$/;

export const refFor = (backendId) => `e${backendId}`;

export function backendIdFromRef(ref) {
  const m = typeof ref === "string" ? REF.exec(ref) : null;
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

const roleOf = (node) => String(node?.role?.value ?? "").slice(0, ROLE_MAX);
const clean = (s, max) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const nameOf = (node) => clean(node?.name?.value, NAME_MAX);

/** Whether a field with these DOM facts (and accessible name) holds a secret, before any human-typed mark. */
export function isSensitiveField(facts, name = "") {
  if (!facts) return true;
  if (String(facts.type ?? "").toLowerCase() === "password") return true;
  if (SENSITIVE_AUTOCOMPLETE.test(String(facts.autocomplete ?? ""))) return true;
  const ts = String(facts.textSecurity ?? "none").toLowerCase();
  if (ts !== "" && ts !== "none") return true;
  return [name, facts.label, facts.attrName, facts.attrId, facts.placeholder, facts.ariaLabel].some(
    (s) => typeof s === "string" && SENSITIVE_LABEL.test(s),
  );
}

/** Whether this AX node's value must be redacted: human-typed, or a sensitive field, or a text field of doubt. */
export function isSensitive(node, marks = new Set(), facts = new Map()) {
  const id = node?.backendDOMNodeId;
  if (id != null && marks.has(id)) return true;
  const role = roleOf(node);
  if (!VALUE_ROLES.has(role)) return false;
  const f = id != null ? facts.get(id) : undefined;
  if (!f) return TEXT_ENTRY_ROLES.has(role) || SENSITIVE_LABEL.test(nameOf(node));
  return isSensitiveField(f, nameOf(node));
}

function nodeValue(node) {
  const v = node?.value?.value;
  if (v === undefined || v === null) return null;
  return String(v).slice(0, VALUE_MAX);
}

function line(n) {
  const indent = "  ".repeat(Math.min(n.depth, 40));
  const name = n.name ? ` ${JSON.stringify(n.name)}` : "";
  let value = "";
  if (n.redacted) value = ` = ${REDACTED}`;
  else if (n.value !== null) value = ` = ${JSON.stringify(n.value)}`;
  return `${indent}- [${n.ref}] ${n.role}${name}${value}\n`;
}

/**
 * The bot's only view of a page: `{ nodes, text, truncated }` (sandboxd-protocol `SnapshotResult` without host and
 * title). Each emitted node appears once, with its ref (`e<backendDOMNodeId>`), role, name, value and depth.
 */
export function serializeSnapshot(axNodes, marks = new Set(), facts = new Map(), options = {}) {
  const maxNodes = options.maxNodes ?? 600;
  const maxText = options.maxText ?? 32_000;
  const byId = new Map();
  const isChild = new Set();
  for (const node of axNodes ?? []) {
    if (node && typeof node.nodeId === "string") byId.set(node.nodeId, node);
  }
  for (const node of byId.values()) for (const c of node.childIds ?? []) isChild.add(c);
  let roots = [...byId.values()].filter((n) => !isChild.has(n.nodeId));
  if (roots.length === 0 && byId.size > 0) roots = [byId.values().next().value];

  const nodes = [];
  const refs = new Set();
  const visited = new Set();
  let text = "";
  let truncated = false;
  // Iterative DFS: [node, depth of the next emitted node, the nearest emitted ancestor's name].
  const stack = roots.reverse().map((n) => [n, 0, null]);
  while (stack.length > 0) {
    const [node, depth, parentName] = stack.pop();
    if (visited.has(node.nodeId)) continue;
    visited.add(node.nodeId);
    const role = roleOf(node);
    if (DROPPED_ROLES.has(role)) continue;

    const name = nameOf(node);
    const id = node.backendDOMNodeId;
    let emit = !node.ignored && Number.isSafeInteger(id) && id > 0 && role !== "";
    if (emit && FLATTENED_ROLES.has(role) && name === "") emit = false;
    if (emit && role === "StaticText" && (name === "" || name === parentName)) emit = false;
    if (emit && refs.has(refFor(id))) emit = false;

    let childDepth = depth;
    let childParentName = parentName;
    let opaque = false;
    if (emit) {
      if (nodes.length >= maxNodes) {
        truncated = true;
        break;
      }
      const redacted = isSensitive(node, marks, facts);
      const value = VALUE_ROLES.has(role) ? (redacted ? REDACTED : nodeValue(node)) : null;
      const out = {
        ref: refFor(id),
        role,
        name,
        value,
        redacted: redacted && value !== null,
        depth: Math.min(depth, DEPTH_MAX),
      };
      if (out.redacted) out.value = REDACTED;
      const l = line(out);
      if (text.length + l.length > maxText) {
        truncated = true;
        break;
      }
      nodes.push(out);
      refs.add(out.ref);
      text += l;
      childDepth = depth + 1;
      childParentName = name;
      opaque = OPAQUE_ROLES.has(role) || out.redacted;
    }
    if (opaque) continue;
    const children = (node.childIds ?? []).map((c) => byId.get(c)).filter(Boolean);
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push([children[i], childDepth, childParentName]);
  }
  return { nodes, text: text.replace(/\n$/, ""), truncated };
}
