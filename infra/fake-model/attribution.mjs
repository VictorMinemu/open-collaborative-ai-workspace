// Attributed prompts (06-03, P-06) for the fake model: pure functions, no I/O, no dependencies.
//
// A multiplayer AI chat sends a roster in the instructions:
//   <participants>
//   - name="Víctor Ruiz" user_id="…" role="admin" access="owner"
//   - name="@backend" agent_id="…" kind="agent" display="Backend Bot"
//   </participants>
// and each human message as a server-generated block, the last user message ending with the turn context:
//   <message from="Alex Kim" user_id="…" at="…">…</message>
//   <turn_context>
//   <responding_to name="Alex Kim" user_id="…"/>
//   <notice>…</notice>
//   <withheld tool="…" reason="…"/>
//   </turn_context>
// Bodies are neutralised by the API (`< message`), so a `<message` / `</message>` in the text is always the
// platform's own tag. The reply proves who the model was told it answers:
//   Hi Alex Kim! (participants: Alex Kim, Víctor Ruiz) Echo: <Alex's last message>

const DIRECTIVE_RE = /\[\[[^\]]*\]\]/gu;
const PARTICIPANTS_RE = /<participants>([\s\S]*?)<\/participants>/u;
const TURN_CONTEXT_RE = /<turn_context>([\s\S]*?)<\/turn_context>/gu;
const MESSAGE_RE = /<message\b[^>]*>([\s\S]*?)<\/message>/gu;

/** The value of `attr="…"` in a tag or roster line, or null. */
function attr(text, name) {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "u").exec(text);
  return m ? (m[1] ?? "") : null;
}

const asText = (v) =>
  Array.isArray(v) ? v.filter((t) => typeof t === "string").join("\n") : String(v ?? "");

/** Roster lines of the `<participants>` block: `[{kind: "user"|"agent", name, id}]` (empty when there is none). */
export function parseParticipants(instructionsText) {
  const block = PARTICIPANTS_RE.exec(asText(instructionsText));
  if (!block) return [];
  const out = [];
  for (const line of (block[1] ?? "").split("\n")) {
    const name = attr(line, "name");
    if (name === null) continue;
    const agentId = attr(line, "agent_id");
    if (agentId !== null) out.push({ kind: "agent", name, id: agentId });
    else out.push({ kind: "user", name, id: attr(line, "user_id") ?? "" });
  }
  return out;
}

/**
 * The last `<turn_context>` of a text: who the turn answers, the access notices and the withheld tools, or null when
 * the text has none.
 */
export function parseTurnContext(text) {
  const blocks = [...asText(text).matchAll(TURN_CONTEXT_RE)];
  const inner = blocks.at(-1)?.[1];
  if (inner === undefined) return null;
  const respondingTo = [...inner.matchAll(/<responding_to\b([^>]*?)\/?>/gu)].map((m) => {
    const tag = m[1] ?? "";
    const agentId = attr(tag, "agent_id");
    return agentId !== null
      ? { name: attr(tag, "name") ?? "", agentId }
      : { name: attr(tag, "name") ?? "", userId: attr(tag, "user_id") ?? "" };
  });
  const notices = [...inner.matchAll(/<notice>([\s\S]*?)<\/notice>/gu)].map((m) => (m[1] ?? "").trim());
  const withheld = [...inner.matchAll(/<withheld\b([^>]*?)\/?>/gu)].map((m) => ({
    tool: attr(m[1] ?? "", "tool") ?? "",
    reason: attr(m[1] ?? "", "reason") ?? "",
  }));
  return { respondingTo, notices, withheld };
}

/** The trimmed body of the last `<message …>…</message>` block ("" when there is none). */
export function lastMessageBody(text) {
  const blocks = [...asText(text).matchAll(MESSAGE_RE)];
  return (blocks.at(-1)?.[1] ?? "").trim();
}

/**
 * The deterministic reply to an attributed prompt, or null when the instructions carry no `<participants>` or the
 * last user text no `<turn_context>` (solo prompts keep their Phase 5 reply). Agents never count as participants.
 */
export function attributedReply({ instructions, lastUserText }) {
  const instructionText = asText(instructions);
  if (!PARTICIPANTS_RE.test(instructionText)) return null;
  const context = parseTurnContext(lastUserText);
  if (!context) return null;
  const humans = parseParticipants(instructionText)
    .filter((p) => p.kind === "user")
    .map((p) => p.name)
    .sort((a, b) => a.localeCompare(b));
  const names = context.respondingTo.map((p) => p.name).join(" and ") || "there";
  const echo = lastMessageBody(lastUserText).replace(DIRECTIVE_RE, " ").replace(/\s+/gu, " ").trim();
  return `Hi ${names}! (participants: ${humans.join(", ")}) Echo: ${echo}`;
}
