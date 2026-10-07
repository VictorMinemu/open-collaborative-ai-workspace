import {
  type AgentChannelAuthor,
  type AgentChannelRosterEntry,
  type AgentMentionEvent,
  type CellAgent,
  EMPTY_TURN,
  type TurnContext,
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
  opts: { direct?: boolean; aiChat?: boolean } = {},
): string {
  const lines = [
    `You are ${sanitizeName(bot.displayName)} (@${bot.handle}), an AI agent that is a member of this team workspace.`,
    opts.direct
      ? "You are in a private direct conversation with one person, given to you as structured context; earlier messages of this conversation are your history."
      : opts.aiChat
        ? "You are a participant in a shared AI chat where several people and an AI assistant write. The sender of the current message, the participants and the earlier messages (each attributed to its author) are given to you as structured context; address people by name when helpful."
        : "You are replying inside a chat thread where several humans may participate. The sender of the current message and the thread participants are given to you as structured context; address people by name when helpful.",
    "Reply with plain Markdown text only. Keep replies concise unless asked for detail.",
  ];
  const description = bot.description?.trim();
  if (description) lines.push(`Your role: ${description}`);
  const instructions = bot.instructions?.trim();
  if (instructions) lines.push("", "Instructions from the person who configured you:", instructions);
  return lines.join("\n");
}

/** One `ChannelStructuredContext` entry (rendered by OpenClaw as a labelled JSON block, data not instructions). */
export type ContextBlock = { label: string; source: string; type: string; payload: Record<string, unknown> };

export type MappedMention = {
  eventId: string;
  ocwAgentId: string;
  openClawAgentId: string;
  conversationId: string;
  /** `dm`: a flat direct conversation (D-04), one OpenClaw session per conversation. */
  conversationKind: "dm" | "channel";
  /**
   * The thread every reply must land in (the mention itself when posted top-level); null in a direct
   * conversation or an AI chat, where replies are flat.
   */
  threadRootId: string | null;
  /**
   * The OpenClaw session of this turn below the per-conversation base key (`sessionKeyFor`): the thread in a channel,
   * none in a DM (one session per DM), and the mention itself in an AI chat (06-10): every turn starts from the
   * attributed chat history only, so one asker's tool results never sit in a transcript another asker's turn reuses.
   */
  sessionThreadId: string | null;
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
  /** What the API decided for this bot, this human, this turn; `EMPTY_TURN` when the event has none. */
  turn: TurnContext;
  /** The bot's tools in the cell snapshot (its `alsoAllow`). */
  agentTools: string[];
  /** `turn.tools ∩ agentTools`: the per-run `toolsAllow` cap (empty → tools disabled). */
  allowedTools: string[];
  /** Structured per-turn context: the asker's local time and, in a DM only, the bot's notes about them. */
  contextBlocks: ContextBlock[];
};

/** Why a tool was withheld, in words the persona can repeat (06-10, D-06). Unknown reasons stay neutral. */
function withheldReason(reason: string, askerName: string): string {
  switch (reason) {
    case "not_every_participant":
      return "not everyone in this conversation may use it";
    case "shared_with_group":
      return "this chat is shared with a team, a department or the whole organization";
    case "denied_for_you":
      return `${askerName} may not use it`;
    default:
      return "not available in this conversation";
  }
}

function turnContextBlocks(turn: TurnContext, askerName: string, direct: boolean): ContextBlock[] {
  const blocks: ContextBlock[] = [];
  // Data, not instructions: the persona can say what it could not use here and why (it never gets the tool).
  const withheld = turn.withheld ?? [];
  if (withheld.length > 0) {
    blocks.push({
      label: "Tools withheld in this conversation",
      source: "ocw",
      type: "withheld_tools",
      payload: {
        withheld: withheld.map((w) => `${sanitizeName(w.tool)} — ${withheldReason(w.reason, askerName)}`),
      },
    });
  }
  if (turn.now) {
    blocks.push({
      label: `Current time for ${askerName}`,
      source: "ocw",
      type: "current_time",
      payload: { local: turn.now.local, time_zone: turn.now.timeZone, iso: turn.now.iso },
    });
  }
  // Memory is private to the human's DM with the bot (D-10): never rendered anywhere else.
  if (direct && turn.memory.length > 0) {
    blocks.push({
      label: `Your notes about ${askerName} (private to this conversation)`,
      source: "ocw",
      type: "notes",
      payload: { notes: turn.memory.map((item) => item.text) },
    });
  }
  return blocks;
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** The AI chat conversation kind (06-10, P-10): flat like a DM, several participants like a channel. */
const AI_CHAT = "ai_chat";

export function mapMention(event: AgentMentionEvent, bot: CellAgent | undefined): MappedMention {
  const direct = event.conversation.kind === "dm";
  const aiChat = event.conversation.kind === AI_CHAT;
  // In a DM or an AI chat `thread.rootMessageId` is the message itself (schema unchanged); the reply is flat.
  const threadRootId = direct || aiChat ? null : event.thread.rootMessageId;
  const author = event.message.author;
  const turn = event.turn ?? EMPTY_TURN;
  const agentTools = bot?.capabilities?.tools ?? [];
  const agentToolSet = new Set(agentTools);
  const allowedTools = [...new Set(turn.tools)].filter((t) => agentToolSet.has(t));
  const askerName = sanitizeName(author.displayName);
  const history = event.threadHistory.map((line) => ({
    id: line.id,
    sender: principalLabel(line.author),
    senderId: line.author.id,
    timestamp: parseTime(line.createdAt),
    body: line.text,
  }));
  return {
    eventId: event.eventId,
    ocwAgentId: event.agent.id,
    openClawAgentId: openClawAgentIdFor(event.agent.id),
    conversationId: event.conversation.id,
    conversationKind: direct ? "dm" : "channel",
    threadRootId,
    sessionThreadId: aiChat ? event.message.id : threadRootId,
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
      : aiChat
        ? event.conversation.name
          ? `AI chat “${sanitizeName(event.conversation.name).replace(/[“”"]/gu, "")}”`
          : "AI chat"
        : event.conversation.name
          ? `#${sanitizeName(event.conversation.name)}`
          : event.conversation.id,
    groupMembers: formatGroupMembers(event.roster),
    mentionedUserIds: event.message.mentions.filter((m) => m.kind === "user").map((m) => m.id),
    body: event.message.text,
    historyLabel: direct || aiChat ? "Conversation history" : "Thread history",
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
      { direct, aiChat },
    ),
    turn,
    agentTools,
    allowedTools,
    contextBlocks: turnContextBlocks(turn, askerName, direct),
  };
}

/**
 * Deterministic idempotency key for reply chunk `index` of event `eventId`: `evt:<eventId>` for the
 * first (the API's recommended key), `evt:<eventId>:<n>` for further chunks.
 */
export function replyIdempotencyKey(eventId: string, index: number): string {
  return index === 0 ? `evt:${eventId}` : `evt:${eventId}:${index}`;
}
