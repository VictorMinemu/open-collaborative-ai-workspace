import { z } from "zod";
import { Id } from "./common";

/**
 * Automation fan-out (Phase 07.17, D-02, D-03, D-08, AFO-02): a scheduled automation's run turn opens one conversation
 * per new item (a thread in a channel, or a card on a board) through `ocw_conversation_open`, and names the people or
 * teams to mention when it finishes or needs help.
 *
 * The bot names items only: never a conversation, a column, a person, an automation or a run. The target, the run and
 * the person it runs as come from the stored turn (P6). The external key is hashed server-side, never stored in clear
 * and never audited, logged or put in a job payload (P1). Leaf module: imports `zod` and `common` only;
 * `automations.ts` and `agent-channel.ts` import it, never the other way round.
 */

// ---------------------------------------------------------------- limits

export const FAN_OUT_LIMITS = {
  /** Conversations one run opens by default, and at most. */
  perRunDefault: 10,
  perRunMax: 25,
  /** Conversations one automation opens per local day by default, and at most. */
  perDayDefault: 100,
  perDayMax: 500,
  externalKeyMax: 200,
  titleMax: 200,
  bodyMax: 4000,
  /** People and teams one automation may mention. */
  escalationMax: 5,
  /**
   * 07.17 code review WR-02: how many times one opened item is queued again after it waited for a free Work Zone
   * session or for the bot's next day; past it, the item is skipped with its waiting reason.
   */
  itemAttemptsMax: 5,
} as const;

/**
 * 07.17 code review WR-02: why an opened item waits (`automation_conversations.status = 'waiting'`). `session_capacity`:
 * its turn's Work Zone start answered `too_many_sessions`; it is queued again when one of the bot's sessions ends.
 * `agent_daily_limit`: the bot was at its daily turn limit; it is queued again on the automation's next local day.
 */
export const AutomationItemWaitReason = z.enum(["session_capacity", "agent_daily_limit"]);
export type AutomationItemWaitReason = z.infer<typeof AutomationItemWaitReason>;

// ---------------------------------------------------------------- settings (D-02, PD-05)

/**
 * The owner's fan-out settings on create and update. Allowed only on scheduled agent-turn automations into a channel or
 * a board (the API answers 400 `fan_out_not_allowed` otherwise; webhooks and mail keep one item per event, D-16).
 */
export const AutomationFanOutInput = z
  .strictObject({
    enabled: z.boolean(),
    perRun: z.number().int().min(1).max(FAN_OUT_LIMITS.perRunMax).default(FAN_OUT_LIMITS.perRunDefault),
    perDay: z.number().int().min(1).max(FAN_OUT_LIMITS.perDayMax).default(FAN_OUT_LIMITS.perDayDefault),
  })
  .refine((f) => f.perRun <= f.perDay, {
    message: "the per-run cap can't exceed the per-day cap",
    path: ["perRun"],
  });
export type AutomationFanOutInput = z.infer<typeof AutomationFanOutInput>;

/** The stored settings as the API returns them. */
export const AutomationFanOutView = z.object({
  enabled: z.boolean(),
  perRun: z.number().int(),
  perDay: z.number().int(),
});
export type AutomationFanOutView = z.infer<typeof AutomationFanOutView>;

// ---------------------------------------------------------------- escalation targets (D-08, PD-15)

export const EscalationTargetKind = z.enum(["user", "unit"]);
export type EscalationTargetKind = z.infer<typeof EscalationTargetKind>;

/** A person or a team (or department) by id, as saved on the automation; validated by the API at save (PD-15). */
export const EscalationTarget = z.strictObject({ kind: EscalationTargetKind, id: Id });
export type EscalationTarget = z.infer<typeof EscalationTarget>;

export const EscalationTargets = z
  .array(EscalationTarget)
  .max(FAN_OUT_LIMITS.escalationMax)
  .refine((ts) => new Set(ts.map((t) => `${t.kind}:${t.id}`)).size === ts.length, {
    message: "each person or team once",
  });
export type EscalationTargets = z.infer<typeof EscalationTargets>;

/**
 * What the bot sees of a target, resolved at delivery from the stored ids (gone or no longer valid targets are
 * dropped). Ids, handles and display names only; never stored by name.
 */
export const EscalationTargetView = z.object({
  kind: EscalationTargetKind,
  id: Id,
  handle: z.string().max(64),
  displayName: z.string().max(200),
});
export type EscalationTargetView = z.infer<typeof EscalationTargetView>;

// ---------------------------------------------------------------- the open tool (D-02, D-03, PD-07)

/** One new item the bot found. `externalKey` is the source's own id (an order number): the dedupe key. */
export const AgentChannelConversationOpenItem = z.strictObject({
  externalKey: z.string().trim().min(1).max(FAN_OUT_LIMITS.externalKeyMax),
  title: z.string().trim().min(1).max(FAN_OUT_LIMITS.titleMax),
  body: z.string().max(FAN_OUT_LIMITS.bodyMax).default(""),
});
export type AgentChannelConversationOpenItem = z.infer<typeof AgentChannelConversationOpenItem>;

/**
 * `POST /agent-channel/v1/conversations/open` (`ocw_conversation_open`). Strict: the event and the bot only, plus the
 * items; `items: []` is the "nothing new" call that marks the run answered (D-10).
 */
export const AgentChannelConversationOpen = z.strictObject({
  eventId: Id,
  agentId: Id,
  items: z.array(AgentChannelConversationOpenItem).max(FAN_OUT_LIMITS.perRunMax),
});
export type AgentChannelConversationOpen = z.infer<typeof AgentChannelConversationOpen>;

export const ConversationOpenRefusal = z.enum([
  "not_in_turn",
  "not_a_run",
  "automation_inactive",
  "fan_out_off",
  "target_not_postable",
  "cap_reached",
]);
export type ConversationOpenRefusal = z.infer<typeof ConversationOpenRefusal>;

/** The one fixed sentence per refusal the model reads (never the API's own text). */
export const CONVERSATION_OPEN_SENTENCES: Readonly<Record<ConversationOpenRefusal, string>> = {
  not_in_turn: "Opening conversations is not available on this turn.",
  not_a_run: "Only an automation run can open conversations. Reply in this thread instead.",
  automation_inactive: "This automation is paused or needs attention, so it can't open conversations now.",
  fan_out_off: "This automation no longer opens a conversation per item. Reply in this thread instead.",
  target_not_postable:
    "The bot can't post in this automation's channel or board any more. Tell the person who owns the automation.",
  cap_reached: "This turn has used all its tool calls. List the new items in your reply instead.",
};

/**
 * One item's outcome: `opened` (a new conversation), an existing one (`opened: false` with its ids; the key was opened
 * before, so nothing is posted again; ids null once its root is deleted) or refused past a cap (ids null).
 */
export const ConversationOpenItemResult = z.object({
  externalKey: z.string().max(FAN_OUT_LIMITS.externalKeyMax),
  opened: z.boolean(),
  conversationId: Id.nullable(),
  threadRootMessageId: Id.nullable(),
  refused: z.enum(["run_cap", "day_cap"]).nullable(),
});
export type ConversationOpenItemResult = z.infer<typeof ConversationOpenItemResult>;

export const AgentChannelConversationOpenResponse = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    results: z.array(ConversationOpenItemResult).max(FAN_OUT_LIMITS.perRunMax),
    remainingRun: z.number().int().nonnegative(),
    remainingDay: z.number().int().nonnegative(),
  }),
  z.object({
    ok: z.literal(false),
    code: ConversationOpenRefusal,
    sentence: z.string().max(300),
  }),
]);
export type AgentChannelConversationOpenResponse = z.infer<typeof AgentChannelConversationOpenResponse>;

// ---------------------------------------------------------------- wording

/** The run card's status label of a fan-out run (the run history chip reuses it). */
export function fanOutLabel(opened: number): string {
  if (opened <= 0) return "Nothing new";
  return opened === 1 ? "Opened 1 conversation" : `Opened ${opened} conversations`;
}

/**
 * The sentence the plugin adds to run and item turns of automations with escalation targets (D-08); null without any.
 * "When you finish or need help, mention @a, @b and @c."
 */
export function escalationSentence(targets: readonly { handle: string }[]): string | null {
  if (targets.length === 0) return null;
  const handles = targets.map((t) => `@${t.handle}`);
  const last = handles.pop() as string;
  const list = handles.length === 0 ? last : `${handles.join(", ")} and ${last}`;
  return `When you finish or need help, mention ${list}.`;
}

/** Characters of the automation's name quoted in the item turn's sentence. */
const ITEM_SENTENCE_NAME_MAX = 120;

/**
 * `message.text` of an `agent.automation_item.v1` turn (D-04, PD-09): a server sentence, never the item itself (the item
 * travels only in `automationItem.item`, labelled as outside content).
 */
export function automationItemSentence(name: string): string {
  const quoted = name.trim().slice(0, ITEM_SENTENCE_NAME_MAX).trim();
  return `“${quoted}” opened this conversation for a new item. The item is below, as outside content.`;
}
