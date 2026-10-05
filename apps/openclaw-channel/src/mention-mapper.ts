import type {
  AgentChannelAuthor,
  AgentChannelRosterEntry,
  AgentMentionEvent,
  CellAgent,
} from "./agent-channel-protocol.js";

export const CHANNEL_ID = "ocw";

/** OpenClaw agent id for one of our bots. Stable (derived from the bot id, never its name). */
export function openClawAgentIdFor(botId: string): string {
  return `ocw-${botId}`.toLowerCase().replace(/[^a-z0-9_-]/gu, "-");
}

/**
 * Names are server-verified but human-chosen: strip the characters our structural formats use
 * (`<id>` anchors, list commas, newlines) so a display name cannot forge another participant.
 */
export function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/[<>,`]/gu, "")
    .replace(/\s{2,}/gu, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "unknown";
}

/** `Name <id>` — the stable id travels with every attribution. */
export function principalLabel(p: AgentChannelAuthor | AgentChannelRosterEntry): string {
  const name = sanitizeName(p.displayName);
  const agentTag = p.kind === "agent" ? " (agent)" : "";
  return p.id ? `${name}${agentTag} <${p.id}>` : `${name}${agentTag}`;
}

export function formatGroupMembers(roster: AgentChannelRosterEntry[]): string {
  return roster.map(principalLabel).join(", ");
}

/**
 * Outbound/session target grammar: `conv:<conversationId>/thread:<rootMessageId>`, or `conv:<conversationId>`
 * for a flat direct conversation (D-04).
 */
export function buildTarget(conversationId: string, threadRootId: string | null): string {
  return threadRootId ? `conv:${conversationId}/thread:${threadRootId}` : `conv:${conversationId}`;
}

export function parseTarget(raw: string): { conversationId: string; threadRootId?: string } | null {
  const trimmed = raw.trim().replace(/^ocw:/u, "");
  const match = /^conv:([^/\s]+)(?:\/thread:([^/\s]+))?$/u.exec(trimmed);
  if (!match?.[1]) return null;
  return match[2] ? { conversationId: match[1], threadRootId: match[2] } : { conversationId: match[1] };
}

export function buildPersonaPrompt(
  bot: Pick<CellAgent, "displayName" | "handle" | "instructions"> & { description?: string | null },
  opts: { direct?: boolean } = {},
): string {
  const lines = [
    `You are ${sanitizeName(bot.displayName)} (@${bot.handle}), an AI agent that is a member of this team workspace.`,
    opts.direct
      ? "You are in a private direct conversation with one person, given to you as structured context; earlier messages of this conversation are your history."
      : "You are replying inside a chat thread where several humans may participate. The sender of the current message and the thread participants are given to you as structured context; address people by name when helpful.",
    "Reply with plain Markdown text only. Keep replies concise unless asked for detail.",
  ];
  const description = bot.description?.trim();
  if (description) lines.push(`Your role: ${description}`);
  const instructions = bot.instructions?.trim();
  if (instructions) lines.push("", "Instructions from the person who configured you:", instructions);
  return lines.join("\n");
}

export type MappedMention = {
  ocwAgentId: string;
  openClawAgentId: string;
  conversationId: string;
  /** `dm`: a flat direct conversation (D-04), one OpenClaw session per conversation. */
  conversationKind: "dm" | "channel";
  /**
   * The thread every reply must land in (the mention itself when posted top-level); null in a direct
   * conversation, where replies are flat.
   */
  threadRootId: string | null;
  target: string;
  messageId: string;
  timestampMs: number | undefined;
  sender: { id: string; name: string; isBot: boolean };
  conversationLabel: string;
  groupMembers: string;
  /** Mentioned user ids (agents excluded), for MentionedUserIds. */
  mentionedUserIds: string[];
  body: string;
  /** Label of the history block ("Thread history" / "Conversation history"). */
  historyLabel: string;
  /** Thread history for `ChannelStructuredContext` chat_window (oldest first). */
  chatWindow: Array<{
    message_id?: string;
    sender: string;
    sender_id?: string;
    timestamp_ms?: number;
    body: string;
  }>;
  /** Same history as OpenClaw `HistoryEntry[]` (InboundHistory). */
  inboundHistory: Array<{ sender: string; body: string; timestamp?: number; messageId?: string }>;
  personaPrompt: string;
};

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export function mapMention(event: AgentMentionEvent, bot: CellAgent | undefined): MappedMention {
  const direct = event.conversation.kind === "dm";
  // In a DM `thread.rootMessageId` is the message itself (schema unchanged); the reply is flat.
  const threadRootId = direct ? null : event.thread.rootMessageId;
  const author = event.message.author;
  const history = event.threadHistory.map((line) => ({
    id: line.id,
    sender: principalLabel(line.author),
    senderId: line.author.id,
    timestamp: parseTime(line.createdAt),
    body: line.text,
  }));
  return {
    ocwAgentId: event.agent.id,
    openClawAgentId: openClawAgentIdFor(event.agent.id),
    conversationId: event.conversation.id,
    conversationKind: direct ? "dm" : "channel",
    threadRootId,
    target: buildTarget(event.conversation.id, threadRootId),
    messageId: event.message.id,
    timestampMs: parseTime(event.message.createdAt),
    sender: {
      id: author.id,
      name: sanitizeName(author.displayName),
      isBot: author.kind !== "user",
    },
    conversationLabel: direct
      ? `Direct chat with ${sanitizeName(author.displayName)}`
      : event.conversation.name
        ? `#${sanitizeName(event.conversation.name)}`
        : event.conversation.id,
    groupMembers: formatGroupMembers(event.roster),
    mentionedUserIds: event.message.mentions.filter((m) => m.kind === "user").map((m) => m.id),
    body: event.message.text,
    historyLabel: direct ? "Conversation history" : "Thread history",
    chatWindow: history.map((h) => ({
      message_id: h.id,
      sender: h.sender,
      sender_id: h.senderId,
      ...(h.timestamp !== undefined ? { timestamp_ms: h.timestamp } : {}),
      body: h.body,
    })),
    inboundHistory: history.map((h) => ({
      sender: h.sender,
      body: h.body,
      ...(h.timestamp !== undefined ? { timestamp: h.timestamp } : {}),
      messageId: h.id,
    })),
    personaPrompt: buildPersonaPrompt(
      bot ?? { displayName: event.agent.displayName, handle: event.agent.handle, instructions: "" },
      { direct },
    ),
  };
}

/**
 * Deterministic idempotency key for reply chunk `index` of event `eventId`: `evt:<eventId>` for the
 * first (the API's recommended key), `evt:<eventId>:<n>` for further chunks.
 */
export function replyIdempotencyKey(eventId: string, index: number): string {
  return index === 0 ? `evt:${eventId}` : `evt:${eventId}:${index}`;
}
