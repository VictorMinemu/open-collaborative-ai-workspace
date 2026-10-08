import type {
  OpenClawAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/channel-core";
import { z } from "zod";
import {
  AGENT_CARD_ACTIONS_MAX,
  AGENT_CARD_FIELDS_MAX,
  AGENT_CARD_KINDS,
  AGENT_CARD_ROUTE_PREFIXES,
  AGENT_CARD_STATUSES,
  AGENT_CARD_SUMMARY_MAX,
  AGENT_CARD_TITLE_MAX,
  AgentCardFields,
  AgentCardInput,
  AgentCardStatus,
  AgentCardSummary,
  AgentCardTitle,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
import type { ActiveTurn, ToolGuard } from "./tool-guard.js";

/**
 * `ocw_agent_card` (06-14, D-07, AGENT-04, P-11): the persona posts a typed Agent Card into the conversation it is
 * answering, or updates one it posted there. Cards go only through the Agent Channel API (`POST /cards`,
 * `PATCH /cards/:messageId`; principle 9). The tool:
 *   - resolves the active OCW turn from the trusted tool context (session key; the conversation as fallback) and takes
 *     the agent, conversation, thread and answered message from it, never from params: the model cannot choose another
 *     conversation or agent,
 *   - refuses locally without a turn, when the turn does not offer it, for an invalid card or an Open target that is
 *     not an internal app route, and for an update of a card this bot did not post in this conversation,
 *   - keys each create `<eventId>:card:<n>`, one `n` per tool call of the turn (an OpenClaw retry of the same call
 *     reuses it, so the API's idempotency stores one card),
 *   - remembers the last version it saw of each card it posted or updated (process-wide) and names it on update,
 *   - answers with a short fixed text (plus the card id after a create), never the API's error body. Logs carry ids
 *     and status codes only.
 * The call-time gate (`before_tool_call`) has already asked `POST /tool-calls` (audited, fail closed) before it runs.
 */

export const CARD_TOOL_NAME = "ocw_agent_card";

export type CardToolContext = Pick<OpenClawPluginToolContext, "sessionKey" | "nativeChannelId" | "agentId">;

type Logger = { info?: (m: string) => void; warn?: (m: string) => void };

const DESCRIPTION =
  "Post a card into this conversation, or update a card you posted here. Use a card for something people " +
  "track or act on: a deployment, a report, a pull request, an approval request, a running job. " +
  'action "create" needs a full card: kind, title, fields (label/value pairs), status, actions and a ' +
  "one-paragraph plain-text summary. Actions: open (target must be a page of this workspace, such as " +
  '"/work-zone" or "/chat/…", never an external link), follow, approve (people approve or deny; their decision ' +
  'comes back to you as a new message). action "update" needs the cardId returned when you created the card ' +
  "and a patch with any of status, title, fields, summary.";

const str = (min: number, max: number) => ({ type: "string", minLength: min, maxLength: max });
const FIELDS_SCHEMA = {
  type: "array",
  maxItems: AGENT_CARD_FIELDS_MAX,
  items: {
    type: "object",
    additionalProperties: false,
    properties: { label: str(1, 60), value: str(1, 500) },
    required: ["label", "value"],
  },
};
const ROUTE_PATTERN = `^(${AGENT_CARD_ROUTE_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})([/?#]|$)`;

const PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["create", "update"], description: "create a new card or update yours" },
    card: {
      type: "object",
      additionalProperties: false,
      description: 'The card (action "create").',
      properties: {
        kind: { type: "string", enum: [...AGENT_CARD_KINDS] },
        title: str(1, AGENT_CARD_TITLE_MAX),
        fields: FIELDS_SCHEMA,
        status: { type: "string", enum: [...AGENT_CARD_STATUSES] },
        actions: {
          type: "array",
          maxItems: AGENT_CARD_ACTIONS_MAX,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              kind: { type: "string", enum: ["open", "follow", "approve"] },
              label: str(1, 40),
              target: { type: "string", maxLength: 512, pattern: ROUTE_PATTERN },
              denyLabel: str(1, 40),
              approverIds: { type: "array", maxItems: 20, items: str(1, 64) },
            },
            required: ["kind", "label"],
          },
        },
        summary: str(1, AGENT_CARD_SUMMARY_MAX),
      },
      required: ["kind", "title", "fields", "status", "actions", "summary"],
    },
    cardId: { ...str(1, 64), description: 'The id you got when you created the card (action "update").' },
    patch: {
      type: "object",
      additionalProperties: false,
      description: 'What changes (action "update"); at least one field.',
      properties: {
        status: { type: "string", enum: [...AGENT_CARD_STATUSES] },
        title: str(1, AGENT_CARD_TITLE_MAX),
        fields: FIELDS_SCHEMA,
        summary: str(1, AGENT_CARD_SUMMARY_MAX),
      },
    },
  },
  required: ["action"],
} as const;

/** Unknown keys (an `expectedVersion`, ids) are dropped: the binding and the version come from this cell only. */
const CreateParams = z.object({ action: z.literal("create"), card: AgentCardInput });
const UpdateParams = z.object({
  action: z.literal("update"),
  cardId: z.string().trim().min(1).max(64),
  patch: z
    .object({
      status: AgentCardStatus.optional(),
      title: AgentCardTitle.optional(),
      fields: AgentCardFields.optional(),
      summary: AgentCardSummary.optional(),
    })
    .refine(
      (p) =>
        p.status !== undefined || p.title !== undefined || p.fields !== undefined || p.summary !== undefined,
      { message: "nothing to update" },
    ),
});

const EXTERNAL_TARGET =
  "Not posted: an Open action can only lead to a page of this workspace, never to an external link.";
const CONFLICT = "The card changed since you last saw it; not updated.";

type CallCounter = { next: number; byCall: Map<string, number> };
type KnownCard = { version: number; conversationId: string };
type CardToolState = { calls: WeakMap<ActiveTurn, CallCounter>; known: Map<string, KnownCard> };

/** Cards remembered per process (oldest dropped first); an older card can no longer be updated after that. */
const KNOWN_MAX = 2_000;

/**
 * Process-wide, like the gate's turns (tool-guard.ts): OpenClaw may load this module more than once, while the turn a
 * tool runs in was begun by another instance.
 */
const STATE_KEY = Symbol.for("ocw.openclaw-channel.card-tool");
type StateRegistry = { [STATE_KEY]?: CardToolState };
const registry = globalThis as StateRegistry;

function state(): CardToolState {
  if (!registry[STATE_KEY]) registry[STATE_KEY] = { calls: new WeakMap(), known: new Map() };
  return registry[STATE_KEY];
}

/** Tests only: forget every card and call counter. */
export function resetCardToolState(): void {
  registry[STATE_KEY] = { calls: new WeakMap(), known: new Map() };
}

const knownKey = (agentId: string, cardId: string) => `${agentId}:${cardId}`;

function remember(agentId: string, cardId: string, card: KnownCard): void {
  const known = state().known;
  const key = knownKey(agentId, cardId);
  known.delete(key);
  known.set(key, card);
  while (known.size > KNOWN_MAX) {
    const oldest = known.keys().next().value;
    if (oldest === undefined) break;
    known.delete(oldest);
  }
}

/** `n` of this call in the turn: a new tool call gets the next one, a retried call keeps its own. */
function callIndex(t: ActiveTurn, toolCallId: string): number {
  const calls = state().calls;
  let counter = calls.get(t);
  if (!counter) {
    counter = { next: 0, byCall: new Map() };
    calls.set(t, counter);
  }
  const id = toolCallId.trim();
  const seen = id ? counter.byCall.get(id) : undefined;
  if (seen !== undefined) return seen;
  const n = counter.next++;
  if (id) counter.byCall.set(id, n);
  return n;
}

const result = (text: string, details: Record<string, unknown> = { ok: false }) => ({
  content: [{ type: "text" as const, text }],
  details,
});

function invalid(prefix: string, issues: z.ZodError["issues"]): string {
  if (issues.some((i) => i.path.at(-1) === "target")) return EXTERNAL_TARGET;
  const path = issues[0]?.path.map(String).join(".") || "params";
  return prefix === "create"
    ? `Not posted: the card is not valid (${path}).`
    : `Not updated: the change is not valid (${path}).`;
}

function postRefusal(error: unknown): string {
  if (error instanceof AgentChannelHttpError) {
    if (error.status === 400) return "Not posted: the workspace did not accept the card.";
    if (error.status === 403) return "Not posted: you may not post in this conversation.";
    if (error.status === 404) return "Not posted: this conversation is no longer available.";
    if (error.status === 409) return "Not posted: the workspace refused the card.";
    if (error.status === 410) return "Not posted: this conversation is archived.";
  }
  return "Not posted: the workspace could not be reached. Try again later.";
}

function patchRefusal(error: unknown): string {
  if (error instanceof AgentChannelHttpError) {
    if (error.status === 409 && error.code === "card_version_conflict") return CONFLICT;
    if (error.status === 409 && error.code === "message_deleted") return "Not updated: the card was deleted.";
    if (error.status === 409) return "Not updated: the workspace refused the change.";
    if (error.status === 400) return "Not updated: the workspace did not accept the change.";
    if (error.status === 403) return "Not updated: only the agent that posted a card can update it.";
    if (error.status === 404) return "Not updated: the card no longer exists.";
    if (error.status === 410) return "Not updated: this conversation is archived.";
  }
  return "Not updated: the workspace could not be reached. Try again later.";
}

const codeOf = (error: unknown) =>
  error instanceof AgentChannelHttpError
    ? `${error.status}${error.code ? `/${error.code}` : ""}`
    : "unreachable";

export function registerCardTool(
  api: OpenClawPluginApi,
  deps: { guard: ToolGuard; client: () => AgentChannelClient | null; log?: Logger },
): void {
  const log = () => deps.log ?? {};
  api.registerTool(
    (ctx: CardToolContext): OpenClawAgentTool => ({
      name: CARD_TOOL_NAME,
      label: "Agent card",
      description: DESCRIPTION,
      parameters: PARAMETERS as unknown as Record<string, unknown>,
      async execute(toolCallId, params, signal) {
        const action = (params as { action?: unknown } | null)?.action;
        if (action !== "create" && action !== "update") {
          return result('Not done: action must be "create" or "update".');
        }
        const not = action === "create" ? "Not posted" : "Not updated";
        const t = deps.guard.findTurn(ctx);
        if (!t) return result(`${not}: there is no active conversation turn.`);
        if (!t.turn.tools.includes(CARD_TOOL_NAME)) return result(`${not}: cards are not available here.`);
        const conversationId = t.conversationId;
        if (!conversationId || t.threadRootId === undefined) {
          return result(`${not}: this turn has no conversation to post into.`);
        }
        const client = deps.client();

        if (action === "create") {
          const parsed = CreateParams.safeParse(params);
          if (!parsed.success) return result(invalid("create", parsed.error.issues));
          if (!client) return result(postRefusal(null));
          const n = callIndex(t, typeof toolCallId === "string" ? toolCallId : "");
          try {
            const posted = await client.postCard(
              {
                agentId: t.agentId,
                conversationId,
                threadRootId: t.threadRootId,
                ...(t.messageId ? { inReplyToMessageId: t.messageId } : {}),
                idempotencyKey: `${t.eventId}:card:${n}`,
                card: parsed.data.card,
              },
              signal,
            );
            remember(t.agentId, posted.messageId, { version: posted.version, conversationId });
            log().info?.(`card: posted ${posted.messageId} (v${posted.version}) for ${t.eventId}`);
            return result(
              `Card posted. Card id: ${posted.messageId} (use it with action "update" to change this card).`,
              { ok: true, cardId: posted.messageId, version: posted.version },
            );
          } catch (error) {
            log().warn?.(`card: post for ${t.eventId} refused (${codeOf(error)})`);
            return result(postRefusal(error));
          }
        }

        const parsed = UpdateParams.safeParse(params);
        if (!parsed.success) return result(invalid("update", parsed.error.issues));
        const { cardId, patch } = parsed.data;
        const known = state().known.get(knownKey(t.agentId, cardId));
        if (!known || known.conversationId !== conversationId) {
          return result("Not updated: you can only update a card you posted in this conversation.");
        }
        if (!client) return result(patchRefusal(null));
        try {
          const updated = await client.patchCard(
            cardId,
            { agentId: t.agentId, patch: { ...patch, expectedVersion: known.version } },
            signal,
          );
          remember(t.agentId, cardId, { version: updated.version, conversationId });
          log().info?.(`card: updated ${cardId} to v${updated.version} for ${t.eventId}`);
          return result("Card updated.", { ok: true, cardId, version: updated.version });
        } catch (error) {
          log().warn?.(`card: update of ${cardId} for ${t.eventId} refused (${codeOf(error)})`);
          return result(patchRefusal(error));
        }
      },
    }),
    { name: CARD_TOOL_NAME },
  );
}
