import { z } from "zod";
import { Mention, MessageBody } from "./chat";
import { Id, MemberKind, PrincipalKind } from "./common";

/**
 * Agent Channel API v1 (placeholder shapes; B2 owns the transport).
 * Consumed ONLY by the OpenClaw channel plugin with a bearer service token. OpenClaw never talks to the
 * database, Redis or messaging internals directly (AGENTS principle 9).
 */

export const AgentChannelAuthor = z.object({
  kind: PrincipalKind,
  id: Id.nullable(),
  displayName: z.string(),
});

export const AgentChannelRosterEntry = z.object({
  kind: MemberKind,
  id: Id,
  displayName: z.string(),
  username: z.string().nullable().optional(),
});

export const AgentChannelContextMessage = z.object({
  id: Id,
  author: AgentChannelAuthor,
  body: z.string(),
  createdAt: z.string(),
});

/** Server → plugin: a message the agent should consider (it was mentioned or DM'd). */
export const AgentChannelInboundDelivery = z.object({
  deliveryId: Id,
  agentId: Id,
  organizationId: Id,
  conversationId: Id,
  /** Root message of the thread the reply must go to (null for DMs without threads). */
  threadRootId: Id.nullable(),
  message: z.object({
    id: Id,
    author: AgentChannelAuthor,
    body: z.string(),
    mentions: z.array(Mention),
  }),
  roster: z.array(AgentChannelRosterEntry),
  context: z.array(AgentChannelContextMessage),
});
export type AgentChannelInboundDelivery = z.infer<typeof AgentChannelInboundDelivery>;

/** Plugin → server: the agent's reply. */
export const AgentChannelOutboundMessage = z.object({
  agentId: Id,
  conversationId: Id,
  threadRootId: Id.optional(),
  body: MessageBody,
  /** Correlates the reply with the delivery that triggered it. */
  inReplyToDeliveryId: Id.optional(),
});
export type AgentChannelOutboundMessage = z.infer<typeof AgentChannelOutboundMessage>;

export const AgentChannelTyping = z.object({
  agentId: Id,
  conversationId: Id,
  threadRootId: Id.optional(),
  typing: z.boolean(),
});
export type AgentChannelTyping = z.infer<typeof AgentChannelTyping>;
