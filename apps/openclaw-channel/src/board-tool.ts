import type {
  OpenClawAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/channel-core";
import { z } from "zod";
import {
  BOARD_CARD_DESCRIPTION_MAX,
  BOARD_CARD_TITLE_MAX,
  BOARD_WAITING_ON,
  BoardWaitingOn,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
import { sanitizeCardTitle } from "./mention-mapper.js";
import type { ActiveTurn, ToolGuard } from "./tool-guard.js";
import { BOARD_TOOL_NAME } from "./turn-scoped-tools.js";

export { BOARD_TOOL_NAME };

/**
 * `ocw_board_card` (07.1-13, BOARD-02, D-07, C-01, P-03): on a board channel's turn the agent reads the board, creates a
 * card in it, moves a card or sets its waiting state, only through the Agent Channel API (`/board/*`, principle 9). The
 * tool:
 *   - resolves the active OCW turn from the trusted tool context (session key; the conversation as fallback) and sends
 *     only its event and agent: the API reads the board and the human from the stored turn, so the model can never
 *     choose another conversation, person or agent (a parameter naming one is refused locally),
 *   - refuses locally without a turn, when the turn does not offer it, once the turn is tainted, for an invalid
 *     request and for any card text on a move or a waiting state (agents never edit card text, P-03),
 *   - changes only the turn thread's card (its version read from the board) or a card it created in this conversation
 *     (the version it was answered),
 *   - keys each create `<eventId>:board:<n>`, one `n` per tool call of the turn from 1 (an OpenClaw retry of the same
 *     call reuses it, so the API's idempotency stores one card),
 *   - answers with short fixed texts (plus ids, and the board's columns on a read), never the API's error body. Logs
 *     carry ids and status codes only.
 * The call-time gate (`before_tool_call`) has already counted it and checked the turn and the taint; the board routes
 * count it against the turn's budget themselves (tool-guard.ts: self-validated).
 */

export type BoardToolContext = Pick<OpenClawPluginToolContext, "sessionKey" | "nativeChannelId" | "agentId">;

type Logger = { info?: (m: string) => void; warn?: (m: string) => void };

const ACTIONS = ["read", "create", "move", "set_waiting"] as const;

const DESCRIPTION =
  "Work on this board: every card is a thread, and this conversation turn runs in one of them. " +
  'action "read" lists the columns (with their ids) and this thread\'s card. ' +
  'action "create" adds a card: a title and/or a description (the first line becomes the title when the board ' +
  "names cards itself), optionally a columnId (default: the first backlog column) and a waitingOn state. " +
  'action "move" moves this thread\'s card (or a card you created here, by cardId) to columnId, after afterCardId ' +
  '(omit it for the top of the column). action "set_waiting" sets who the card waits on: none, us, customer or ' +
  "both. You cannot edit a card's title, description or fields.";

const str = (min: number, max: number) => ({ type: "string", minLength: min, maxLength: max });

const PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: [...ACTIONS], description: "read, create, move or set_waiting" },
    title: { ...str(1, BOARD_CARD_TITLE_MAX), description: 'The new card\'s title (action "create").' },
    description: {
      ...str(1, BOARD_CARD_DESCRIPTION_MAX),
      description: 'The new card\'s description (action "create").',
    },
    columnId: {
      ...str(1, 64),
      description: 'A column id from action "read" (where a new card lands, or where to move a card).',
    },
    afterCardId: { ...str(1, 64), description: 'Move after this card id (action "move"); omit for the top.' },
    cardId: {
      ...str(1, 64),
      description: "A card you created in this conversation; omit for this thread's card.",
    },
    waitingOn: { type: "string", enum: [...BOARD_WAITING_ON], description: "Who the card waits on." },
  },
  required: ["action"],
} as const;

const IdParam = z.string().trim().min(1).max(64);
const ReadParams = z.object({ action: z.literal("read") }).strict();
const CreateParams = z
  .object({
    action: z.literal("create"),
    title: z.string().trim().min(1).max(BOARD_CARD_TITLE_MAX).optional(),
    description: z.string().trim().max(BOARD_CARD_DESCRIPTION_MAX).optional(),
    columnId: IdParam.optional(),
    waitingOn: BoardWaitingOn.optional(),
  })
  .strict();
const MoveParams = z
  .object({
    action: z.literal("move"),
    columnId: IdParam,
    afterCardId: IdParam.nullable().optional(),
    cardId: IdParam.optional(),
  })
  .strict();
const WaitingParams = z
  .object({ action: z.literal("set_waiting"), waitingOn: BoardWaitingOn, cardId: IdParam.optional() })
  .strict();

/** Card text: never on a move or a waiting state (P-03). */
const TEXT_KEYS: ReadonlySet<string> = new Set(["title", "description", "fields"]);
/** Keys that would name where to act or for whom: the board, the person and the agent are the turn's only. */
const BINDING_KEY = /(conversation|channel|board|user|human|person|agent|event|org|organization)(id|_id)?$/iu;

const NOT_TAINTED = "Not done: this turn read web or tool content, so it can no longer change the board.";
const CONFLICT = "Not done: the card changed since you last saw it. Try again.";

type CallCounter = { next: number; byCall: Map<string, number> };
type KnownCard = { version: number; conversationId: string };
type BoardToolState = { calls: WeakMap<ActiveTurn, CallCounter>; known: Map<string, KnownCard> };

/** Card versions remembered per process (oldest dropped first). */
const KNOWN_MAX = 2_000;

/** Process-wide, like the gate's turns (tool-guard.ts): OpenClaw may load this module more than once. */
const STATE_KEY = Symbol.for("ocw.openclaw-channel.board-tool");
type StateRegistry = { [STATE_KEY]?: BoardToolState };
const registry = globalThis as StateRegistry;

function state(): BoardToolState {
  if (!registry[STATE_KEY]) registry[STATE_KEY] = { calls: new WeakMap(), known: new Map() };
  return registry[STATE_KEY];
}

/** Tests only: forget every card version and call counter. */
export function resetBoardToolState(): void {
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

/** `n` of this create in the turn, from 1: a new tool call gets the next one, a retried call keeps its own. */
function callIndex(t: ActiveTurn, toolCallId: string): number {
  const calls = state().calls;
  let counter = calls.get(t);
  if (!counter) {
    counter = { next: 1, byCall: new Map() };
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

/** The first local refusal for an invalid request: binding keys, card text, unknown keys, then the field. */
function invalid(action: (typeof ACTIONS)[number], issues: z.ZodError["issues"]): string {
  const unknown = issues.flatMap((i) => (i.code === "unrecognized_keys" ? i.keys : []));
  const binding = unknown.find((k) => BINDING_KEY.test(k));
  if (binding) return `Not done: the board is always this conversation's; ${binding} is not accepted.`;
  if (action !== "create" && unknown.some((k) => TEXT_KEYS.has(k))) {
    return "Not done: agents do not edit card text.";
  }
  if (unknown.length > 0) return `Not done: unknown parameter (${unknown[0]}).`;
  const path = issues[0]?.path.map(String).join(".") || "params";
  return action === "create"
    ? `Not done: the card is not valid (${path}).`
    : `Not done: the change is not valid (${path}).`;
}

function refusal(error: unknown, what: "card" | "change"): string {
  if (error instanceof AgentChannelHttpError) {
    const { status, code } = error;
    if (status === 403 && code === "tainted") return NOT_TAINTED;
    if (status === 403 && code === "cap_reached") return "Not done: this turn reached its tool call limit.";
    if (status === 403 && code === "not_in_turn") return "Not done: the board tool is not offered here.";
    if (status === 403 && code === "no_trigger")
      return "Not done: this conversation turn is no longer active.";
    if (status === 403 && code === "not_author") return "Not done: agents do not edit card text.";
    if (status === 403) return "Not done: you may not change this board.";
    if (status === 400 && code === "not_a_board") return "Not done: this conversation is not a board.";
    if (status === 400) return `Not done: the workspace did not accept the ${what}.`;
    if (status === 404) return "Not done: that card or column is not on this board.";
    if (status === 409 && code === "board_card_version_conflict") return CONFLICT;
    if (status === 409) return `Not done: the workspace refused the ${what}.`;
    if (status === 410) return "Not done: this board is archived.";
  }
  return "Not done: the workspace could not be reached. Try again later.";
}

const codeOf = (error: unknown) =>
  error instanceof AgentChannelHttpError
    ? `${error.status}${error.code ? `/${error.code}` : ""}`
    : "unreachable";

/** Column names and card titles are people's words shown back to the model: one line, no URLs, bounded. */
const clean = (s: string) => sanitizeCardTitle(s);

export function registerBoardTool(
  api: OpenClawPluginApi,
  deps: { guard: ToolGuard; client: () => AgentChannelClient | null; log?: Logger },
): void {
  const log = () => deps.log ?? {};
  api.registerTool(
    (ctx: BoardToolContext): OpenClawAgentTool => ({
      name: BOARD_TOOL_NAME,
      label: "Board card",
      description: DESCRIPTION,
      parameters: PARAMETERS as unknown as Record<string, unknown>,
      async execute(toolCallId, params, signal) {
        const action = (params as { action?: unknown } | null)?.action;
        if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) {
          return result('Not done: action must be "read", "create", "move" or "set_waiting".');
        }
        const act = action as (typeof ACTIONS)[number];
        const t = deps.guard.findTurn(ctx);
        if (!t) return result("Not done: there is no active conversation turn.");
        if (!t.turn.tools.includes(BOARD_TOOL_NAME))
          return result("Not done: the board tool is not offered here.");
        if (t.tainted) return result(NOT_TAINTED);
        const conversationId = t.conversationId;
        if (!conversationId) return result("Not done: this turn has no board.");
        const client = deps.client();
        const turn = { eventId: t.eventId, agentId: t.agentId };

        /** The board read: the version of this thread's card is remembered for the next change. */
        const read = async (c: AgentChannelClient) => {
          const board = await c.boardRead(turn, signal);
          if (board.card) {
            remember(t.agentId, board.card.messageId, { version: board.card.version, conversationId });
          }
          return board;
        };

        if (act === "read") {
          const parsed = ReadParams.safeParse(params);
          if (!parsed.success) return result(invalid(act, parsed.error.issues));
          if (!client) return result(refusal(null, "change"));
          try {
            const board = await read(client);
            log().info?.(`board: read for ${t.eventId} (${board.columns.length} columns)`);
            const columnName = (id: string) => board.columns.find((c) => c.id === id)?.name;
            const lines = [
              "Board columns:",
              ...board.columns.map((c) => `- ${clean(c.name)} (${clean(c.category)}), column id ${c.id}`),
              board.card
                ? `This thread's card: id ${board.card.messageId}, title "${clean(board.card.title)}", column ${clean(
                    columnName(board.card.columnId) ?? board.card.columnId,
                  )}, waiting on ${clean(board.card.waitingOn)}.`
                : "This thread is not a card.",
            ];
            return result(lines.join("\n"), { ok: true, columns: board.columns.length });
          } catch (error) {
            log().warn?.(`board: read for ${t.eventId} refused (${codeOf(error)})`);
            return result(refusal(error, "change"));
          }
        }

        if (act === "create") {
          const parsed = CreateParams.safeParse(params);
          if (!parsed.success) return result(invalid(act, parsed.error.issues));
          const { title, description = "", columnId, waitingOn } = parsed.data;
          if (!title && !description) return result("Not done: give the card a title or a description.");
          if (!client) return result(refusal(null, "card"));
          const n = callIndex(t, typeof toolCallId === "string" ? toolCallId : "");
          try {
            const { card } = await client.boardCreateCard(
              {
                ...turn,
                idempotencyKey: `${t.eventId}:board:${n}`,
                ...(title !== undefined ? { title } : {}),
                description,
                ...(columnId !== undefined ? { columnId } : {}),
                ...(waitingOn !== undefined ? { waitingOn } : {}),
              },
              signal,
            );
            remember(t.agentId, card.messageId, { version: card.version, conversationId });
            log().info?.(`board: created ${card.messageId} (v${card.version}) for ${t.eventId}`);
            return result(`Card created. Card id: ${card.messageId}.`, {
              ok: true,
              cardId: card.messageId,
              version: card.version,
            });
          } catch (error) {
            log().warn?.(`board: create for ${t.eventId} refused (${codeOf(error)})`);
            return result(refusal(error, "card"));
          }
        }

        const parsed = act === "move" ? MoveParams.safeParse(params) : WaitingParams.safeParse(params);
        if (!parsed.success) return result(invalid(act, parsed.error.issues));
        const p = parsed.data;
        const threadCard = t.threadRootId ?? null;
        const cardId = p.cardId ?? threadCard;
        if (!cardId) return result("Not done: this turn is not in a card's thread; name the card id.");
        let known = state().known.get(knownKey(t.agentId, cardId));
        if (known && known.conversationId !== conversationId) known = undefined;
        if (!known && cardId !== threadCard) {
          return result(
            "Not done: you can change this thread's card or a card you created in this conversation.",
          );
        }
        if (!client) return result(refusal(null, "change"));
        try {
          if (!known) {
            const board = await read(client);
            if (!board.card || board.card.messageId !== cardId)
              return result("Not done: this thread is not a card.");
            known = { version: board.card.version, conversationId };
          }
          const { card } = await client.boardPatchCard(
            cardId,
            {
              ...turn,
              expectedVersion: known.version,
              ...(p.action === "move"
                ? { move: { columnId: p.columnId, afterCardId: p.afterCardId ?? null } }
                : { waitingOn: p.waitingOn }),
            },
            signal,
          );
          remember(t.agentId, cardId, { version: card.version, conversationId });
          log().info?.(`board: ${act} ${cardId} to v${card.version} for ${t.eventId}`);
          return result(p.action === "move" ? "Card moved." : "Waiting state set.", {
            ok: true,
            cardId,
            version: card.version,
          });
        } catch (error) {
          if (error instanceof AgentChannelHttpError && error.status === 409) {
            state().known.delete(knownKey(t.agentId, cardId));
          }
          log().warn?.(`board: ${act} of ${cardId} for ${t.eventId} refused (${codeOf(error)})`);
          return result(refusal(error, "change"));
        }
      },
    }),
    { name: BOARD_TOOL_NAME },
  );
}
