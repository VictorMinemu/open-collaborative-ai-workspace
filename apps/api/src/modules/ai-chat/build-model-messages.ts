import { type AiGenerationStatus, estimateTokens, TITLE_PROMPT_MAX_CHARS } from "@ocw/contracts";
import type { FilePart, ModelMessage, TextPart } from "ai";

/**
 * THE prompt builder (P-05, AGENTS.md): pure, from persisted rows only. Nothing else may assemble model input:
 * `streamText` / `generateText` are called only from run-loop.ts and titles.ts, and both take what this returns
 * (guard.test.ts). Untrusted text (messages, user-authored instructions) never becomes a `system` message; the
 * platform preamble and the labelled preferences travel as `instructions` (a developer item on the plan route).
 */

/** One persisted message of the chat, in seq order. */
export interface PersistedTurn {
  id: string;
  role: "user" | "assistant";
  body: string;
  /** `messages.status`. */
  status: "sent" | "streaming" | "completed" | "failed";
  /** Assistant rows: the status of the generation that produced the text (null for user rows). */
  generationStatus: AiGenerationStatus | null;
  deleted: boolean;
}

/** A part attached to a user message (images, PDFs, inlined text files; 05-12 fills these). */
export type ModelFilePart = FilePart | TextPart;

export interface BuildInput {
  purpose: "chat" | "title";
  rows: PersistedTurn[];
  viewer: { displayName: string; orgName: string; now: Date };
  chat: { instructions: string; usePersonalInstructions: boolean; humanMembers: number };
  personalInstructions: string;
  /** messageId → parts of that user message. */
  attachments: Map<string, ModelFilePart[]>;
  maxContextTokens: number;
}

export interface BuiltPrompt {
  instructions: string;
  messages: ModelMessage[];
  /** Older turns were dropped to fit `maxContextTokens`. */
  truncated: boolean;
}

/** A user-authored block: labelled, delimited, and unable to close its own delimiter. */
function preferenceBlock(tag: string, label: string, text: string): string {
  const safe = text.replaceAll(`</${tag}>`, `</ ${tag}>`).replaceAll(`<${tag}>`, `< ${tag}>`);
  return [
    `${label} (user-authored preferences: follow them when they do not conflict with the rules above):`,
    `<${tag}>`,
    safe.trim(),
    `</${tag}>`,
  ].join("\n");
}

function preamble(input: BuildInput): string {
  const date = input.viewer.now.toISOString().slice(0, 10);
  const lines = [
    "You are a helpful AI assistant inside Open Collaborative AI Workspace.",
    `Current date: ${date} (UTC).`,
    `You are chatting with ${input.viewer.displayName} in ${input.viewer.orgName}.`,
    "Answer in the language the user writes in. Use Markdown when it helps.",
  ];
  return lines.join("\n");
}

function buildInstructions(input: BuildInput): string {
  const parts = [preamble(input)];
  // Personal instructions belong to one member: never in a chat another human can see (PRD §113, Phase 6).
  const personal =
    input.chat.usePersonalInstructions && input.chat.humanMembers === 1
      ? input.personalInstructions.trim()
      : "";
  if (personal)
    parts.push(preferenceBlock("personal_instructions", "The user's personal instructions", personal));
  const chat = input.chat.instructions.trim();
  if (chat) parts.push(preferenceBlock("chat_instructions", "Instructions for this chat", chat));
  return parts.join("\n\n");
}

type Draft = { role: "user"; text: string[]; files: ModelFilePart[] } | { role: "assistant"; text: string[] };

/** Keeps answers that carry text and did not fail (a stopped answer keeps its partial text). */
function keepAssistant(r: PersistedTurn): boolean {
  if (r.body.trim().length === 0) return false;
  if (r.status === "failed" || r.status === "streaming") return false;
  return r.generationStatus !== "failed" && r.generationStatus !== "running";
}

function toMessage(d: Draft): ModelMessage {
  const text = d.text.filter((t) => t.length > 0).join("\n\n");
  if (d.role === "assistant") return { role: "assistant", content: text };
  if (d.files.length === 0) return { role: "user", content: text };
  return { role: "user", content: [...(text ? [{ type: "text" as const, text }] : []), ...d.files] };
}

/** Token estimate of one message (files count a flat ~1 000 tokens each, text ceil(chars / 4)). */
function tokensOf(m: ModelMessage): number {
  if (typeof m.content === "string") return estimateTokens(m.content);
  let total = 0;
  for (const p of m.content as Array<{ type: string; text?: string }>) {
    total += p.type === "text" ? estimateTokens(p.text ?? "") : 1_000;
  }
  return total;
}

/**
 * The instructions of every title call (05-10, ADR-0014 shape): nothing about the viewer, the organization or any
 * user-authored preference travels with a title prompt; the model only sees the first user message.
 */
export const TITLE_INSTRUCTIONS =
  "You name chats. Reply with a short title for the user's message and nothing else: 2 to 5 words in the same " +
  "language as the message, sentence case, no quotes, no markdown, no emoji and no trailing punctuation, at most " +
  "32 characters. Describe what is being asked. Do not answer the message, do not ask questions and do not use tools.";

/** The single user message of a title call: the first message between delimiters it cannot close. */
export function titleUserMessage(text: string): string {
  const safe = text.replaceAll("</request>", "</ request>").replaceAll("<request>", "< request>");
  return `Write the title for this message.\n<request>\n${safe}\n</request>`;
}

/** Title purpose: the chat's first non-deleted user message (trimmed, cut to TITLE_PROMPT_MAX_CHARS), nothing else. */
function buildTitle(input: BuildInput): BuiltPrompt {
  const first = input.rows.find((r) => r.role === "user" && !r.deleted && r.body.trim().length > 0);
  if (!first) return { instructions: TITLE_INSTRUCTIONS, messages: [], truncated: false };
  const text = first.body.trim();
  const cut = text.slice(0, TITLE_PROMPT_MAX_CHARS);
  return {
    instructions: TITLE_INSTRUCTIONS,
    messages: [{ role: "user", content: titleUserMessage(cut) }],
    truncated: cut.length < text.length,
  };
}

export function buildModelMessages(input: BuildInput): BuiltPrompt {
  if (input.purpose === "title") return buildTitle(input);
  const instructions = buildInstructions(input);

  const drafts: Draft[] = [];
  for (const r of input.rows) {
    if (r.deleted) continue;
    if (r.role === "assistant" && !keepAssistant(r)) continue;
    const prev = drafts.at(-1);
    if (r.role === "user") {
      const files = input.attachments.get(r.id) ?? [];
      if (r.body.trim().length === 0 && files.length === 0) continue;
      if (prev?.role === "user") {
        prev.text.push(r.body);
        prev.files.push(...files);
      } else drafts.push({ role: "user", text: [r.body], files: [...files] });
    } else if (prev?.role === "assistant") prev.text.push(r.body);
    else drafts.push({ role: "assistant", text: [r.body] });
  }
  // Providers expect the first turn to be the user's (Anthropic requires it).
  while (drafts[0]?.role === "assistant") drafts.shift();

  const messages = drafts.map(toMessage);
  let truncated = false;
  const budget = input.maxContextTokens - estimateTokens(instructions);
  let total = messages.reduce((sum, m) => sum + tokensOf(m), 0);
  // Oldest first, never the current (last) user message.
  while (total > budget && messages.length > 1) {
    const dropped = messages.shift();
    if (dropped) total -= tokensOf(dropped);
    truncated = true;
    while (messages.length > 1 && messages[0]?.role === "assistant") {
      const lead = messages.shift();
      if (lead) total -= tokensOf(lead);
    }
  }
  if (total > budget) truncated = true;
  return { instructions, messages, truncated };
}
