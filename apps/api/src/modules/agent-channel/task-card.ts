import {
  AGENT_CARD_TITLE_MAX,
  type AgentCardField,
  type AgentCardNotice,
  type BotTaskOutcome,
  type BotTaskStatus,
  TASK_CARD_FIELD_LABELS,
  taskCardStatus,
  taskStatusLabel,
  taskStopNotice,
} from "@ocw/contracts";
import { messageCards, messages, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { Core } from "../../core";
import { updatePlatformCardNotified } from "./card-followers";
import type { AgentTurnRow } from "./claim";

/**
 * Phase 07.17.1.1.2 (D-05, PD-11; ADR-0042): the live `task` card of a long bot task, composed by the platform from the
 * task row (never by the bot: the agent can never PATCH it, `card_platform_owned`). Its title is the goal; its two
 * fields are the bot's last progress note and next step (the bot's own untrusted text, shown as text, never audited);
 * its pill word and generic status come from the contract helpers (`running` while the task works or waits, so the
 * card never flaps and its followers hear only the end); a notice says how it ended. The numbers (turns, times, who it
 * runs for, what it waits for) travel in `AgentCard.task`, composed for every reader by 10's provider.
 */

/** The task fields the card shows. */
export interface TaskCardFacts {
  goal: string;
  status: BotTaskStatus;
  outcome: BotTaskOutcome | null;
  progress: string | null;
  nextStep: string | null;
  maxTurns: number;
  startedAt: string | Date;
  deadlineAt: string | Date;
}

export interface ComposedTaskCard {
  title: string;
  summary: string;
  status: ReturnType<typeof taskCardStatus>;
  statusLabel: string;
  fields: AgentCardField[];
  notices: AgentCardNotice[];
}

/** A card field's bound (`AgentCardField.value`). */
const FIELD_VALUE_MAX = 500;

const clip = (text: string, max: number) => text.trim().slice(0, max).trim();

/** The task's own hour budget (its deadline minus its start, snapshotted at start), at least one. */
export function taskMaxHours(task: Pick<TaskCardFacts, "startedAt" | "deadlineAt">): number {
  const ms = new Date(task.deadlineAt).getTime() - new Date(task.startedAt).getTime();
  return Math.max(1, Math.round(ms / 3_600_000));
}

/** The card of `task` (pure). `stoppedByName`: who stopped it, for "Stopped by <name>.". */
export function composeTaskCard(
  task: TaskCardFacts,
  opts: { stoppedByName?: string | null } = {},
): ComposedTaskCard {
  const title = clip(task.goal, AGENT_CARD_TITLE_MAX);
  const fields: AgentCardField[] = [];
  if (task.progress?.trim()) {
    fields.push({ label: TASK_CARD_FIELD_LABELS.progress, value: clip(task.progress, FIELD_VALUE_MAX) });
  }
  if (task.nextStep?.trim()) {
    fields.push({ label: TASK_CARD_FIELD_LABELS.next, value: clip(task.nextStep, FIELD_VALUE_MAX) });
  }
  const notice = task.outcome
    ? taskStopNotice(task.outcome, {
        maxTurns: task.maxTurns,
        maxHours: taskMaxHours(task),
        byName: opts.stoppedByName ?? null,
      })
    : null;
  return {
    title,
    summary: title,
    status: taskCardStatus(task.status),
    statusLabel: taskStatusLabel(task.status, task.outcome),
    fields,
    notices: notice ? [{ tone: "neutral", text: notice }] : [],
  };
}

/**
 * Posts the task's card as the bot, in the asker's message thread (the Work Zone card's rule: the message's thread, or
 * the message itself at a channel's root; chat flattens direct conversations), for the requester (the post is allowed
 * only while they read the conversation), idempotent on `task:<id>`. Returns the card's message id.
 */
export async function postTaskCard(
  tx: Tx,
  core: Core,
  task: TaskCardFacts & { id: string; agentId: string; conversationId: string; requesterUserId: string },
  turn: Pick<AgentTurnRow, "messageId">,
): Promise<string> {
  const [asked] = await tx
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(eq(messages.id, turn.messageId))
    .limit(1);
  const card = composeTaskCard(task);
  const posted = await core.chatAgent.postAgentMessageIn(tx, {
    agentId: task.agentId,
    conversationId: task.conversationId,
    threadRootId: asked?.threadId ?? turn.messageId,
    body: card.title,
    idempotencyKey: `task:${task.id}`,
    onBehalfOfUserId: task.requesterUserId,
    cardPlatformOwned: true,
    card: {
      kind: "task",
      title: card.title,
      summary: card.summary,
      status: card.status,
      statusLabel: card.statusLabel,
      fields: card.fields,
      ...(card.notices.length ? { notices: card.notices } : {}),
      actions: [{ kind: "follow", label: "Follow" }],
    },
  });
  return posted.messageId;
}

/**
 * Brings the task's card in line with the row (every state change, PD-10), in the caller's transaction; its followers
 * hear a status change (`updatePlatformCardNotified`). Nothing when the task has no card or its card is gone; null when
 * the card's message was deleted (a tombstone keeps its card as it was).
 */
export async function refreshTaskCard(
  tx: Tx,
  core: Core,
  task: TaskCardFacts & { cardMessageId: string | null },
  opts: { stoppedByName?: string | null } = {},
): Promise<{ version: number } | null> {
  if (!task.cardMessageId) return null;
  const [present] = await tx
    .select({ messageId: messageCards.messageId })
    .from(messageCards)
    .where(eq(messageCards.messageId, task.cardMessageId))
    .limit(1);
  if (!present) return null;
  const card = composeTaskCard(task, opts);
  return updatePlatformCardNotified(tx, core, {
    messageId: task.cardMessageId,
    status: card.status,
    statusLabel: card.statusLabel,
    fields: card.fields,
    notices: card.notices,
  });
}
