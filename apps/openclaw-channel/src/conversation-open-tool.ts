import type {
  OpenClawAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/channel-core";
import { ZodError } from "zod";
import {
  AgentChannelConversationOpen,
  AgentChannelConversationOpenItem,
  type AgentChannelConversationOpenResponse,
  CONVERSATION_OPEN_SENTENCES,
  type ConversationOpenItemResult,
  type ConversationOpenRefusal,
  FAN_OUT_LIMITS,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
// tool-guard.ts never imports this module (it reads the name from turn-scoped-tools.ts), so this import is one-way.
import { approvalLabel, type ToolGuard } from "./tool-guard.js";
import { CONVERSATION_OPEN_TOOL } from "./turn-scoped-tools.js";

/**
 * `ocw_conversation_open` (07.17 D-02, D-03, D-05, PD-07): on the run turn of an automation with fan-out on, the bot
 * opens one conversation (a card on the automation's board, or a top-level message in its channel, each with its own
 * thread) per new item it found, in ONE call with every new item (`[]` when nothing is new). Like the 07.16 session
 * tools (work-session-tools.ts), it is a thin, credential-free caller of the Agent Channel API that never decides:
 *   - it resolves the active OCW turn from the trusted tool context and refuses locally without one, or when the turn
 *     does not offer the tool (the API offers it only on fan-out run turns),
 *   - it posts (`POST /agent-channel/v1/conversations/open`) only the turn's event and agent with the items
 *     (`{ externalKey, title, body }` each). The bot never names a conversation, a column, a person, an automation or
 *     a run: the API takes them from the stored turn. The schema is closed and any other key, more than 25 items or an
 *     empty key or title is refused here before a request (P6),
 *   - the route decides everything else: taint (D-05: allowed on a tainted run turn, in the run's own target; the gate
 *     lets the call through, tool-guard.ts `ROUTE_DECIDES_TAINT`), the per-run and per-day caps, the dedupe by key
 *     (an item already opened is never opened again, D-03), the tool cap,
 *   - it answers one line per item and the remaining counts, or the refusal's fixed sentence; never an error body.
 *     Logs carry ids and counts only: never a key, a title or a body (they come from outside content).
 */

export { CONVERSATION_OPEN_TOOL };

export type ConversationOpenToolContext = Pick<
  OpenClawPluginToolContext,
  "sessionKey" | "nativeChannelId" | "agentId"
>;

type Logger = { info?: (m: string) => void; warn?: (m: string) => void };
type Deps = { guard: ToolGuard; client: () => AgentChannelClient | null; logger?: Logger };

export type ConversationOpenToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { ok: boolean; code?: string; opened?: number };
};

const answer = (
  text: string,
  details: ConversationOpenToolResult["details"],
): ConversationOpenToolResult => ({ content: [{ type: "text", text }], details });
const refused = (text: string, code: string) => answer(text, { ok: false, code });

/** The fixed sentences of the outcomes the plugin decides itself (no request, or no usable answer). */
export const CONVERSATION_OPEN_TOOL_SENTENCES = {
  no_turn: "There is no active conversation turn, so I can't use this tool now.",
  unknown_turn: "This conversation turn is no longer active.",
  unreachable:
    "The workspace could not be reached, so the conversations may not have been opened. Call the tool again with " +
    "the same items: one already opened is never opened twice.",
  unreadable:
    "The workspace answered in a form I can't read. Check the automation's target before calling the tool again.",
  extra_keys:
    "That tool only takes items. The conversation, the column, the people and the run come from the automation.",
  bad_items:
    "items must be a list of the new items, each with an externalKey, a title and a body ([] when none).",
  too_many: `At most ${FAN_OUT_LIMITS.perRunMax} items per call. Open the first ${FAN_OUT_LIMITS.perRunMax} and list the rest in your reply.`,
  bad_item:
    `Each item takes only a non-empty externalKey (at most ${FAN_OUT_LIMITS.externalKeyMax} characters), a non-empty ` +
    `title (at most ${FAN_OUT_LIMITS.titleMax}) and a body (at most ${FAN_OUT_LIMITS.bodyMax.toLocaleString("en-US")}).`,
} as const;

/** The only key the tool takes (besides the turn's ids, which the tool adds). */
const KEYS: ReadonlySet<string> = new Set(["items"]);

const asParams = (params: unknown): Record<string, unknown> =>
  params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};

/** The open body, or why the params are invalid (checked locally; the API re-validates everything). */
export function conversationOpenOf(
  t: { eventId: string; agentId: string },
  p: Record<string, unknown>,
): { body: AgentChannelConversationOpen } | { error: string; code: string } {
  if (Object.keys(p).some((k) => !KEYS.has(k))) {
    return { error: CONVERSATION_OPEN_TOOL_SENTENCES.extra_keys, code: "extra_keys" };
  }
  if (!Array.isArray(p.items))
    return { error: CONVERSATION_OPEN_TOOL_SENTENCES.bad_items, code: "bad_params" };
  if (p.items.length > FAN_OUT_LIMITS.perRunMax) {
    return { error: CONVERSATION_OPEN_TOOL_SENTENCES.too_many, code: "too_many" };
  }
  if (p.items.some((i) => !AgentChannelConversationOpenItem.safeParse(i).success)) {
    return { error: CONVERSATION_OPEN_TOOL_SENTENCES.bad_item, code: "bad_params" };
  }
  const body = AgentChannelConversationOpen.safeParse({
    eventId: t.eventId,
    agentId: t.agentId,
    items: p.items,
  });
  if (!body.success) return { error: CONVERSATION_OPEN_TOOL_SENTENCES.bad_item, code: "bad_params" };
  return { body: body.data };
}

/** A key or code shown back to the model: as given, on one line, without markup characters. */
const shown = (value: string, max: number = FAN_OUT_LIMITS.externalKeyMax) =>
  approvalLabel(value, max) ?? "?";

const CAP_LABELS: Readonly<Record<string, string>> = { run_cap: "run limit", day_cap: "daily limit" };

function itemLine(r: ConversationOpenItemResult): string {
  const key = shown(r.externalKey);
  if (r.opened) return `opened ${key} → ${r.threadRootMessageId ?? r.conversationId ?? "?"}`;
  if (r.refused) return `not opened ${key} (${CAP_LABELS[r.refused] ?? r.refused.replaceAll("_", " ")})`;
  return `already open ${key}`;
}

const KNOWN_REFUSALS: ReadonlySet<string> = new Set(Object.keys(CONVERSATION_OPEN_SENTENCES));

/** A refusal: the contracts' sentence for its code; for a code from a newer API, the API's own one-line sentence. */
function renderRefusal(code: string | null, sentence: string): ConversationOpenToolResult {
  const known =
    code && KNOWN_REFUSALS.has(code)
      ? CONVERSATION_OPEN_SENTENCES[code as ConversationOpenRefusal]
      : undefined;
  const text = known ?? approvalLabel(sentence, 300) ?? CONVERSATION_OPEN_SENTENCES.not_in_turn;
  return refused(text, code ?? "refused");
}

/**
 * What the model reads for an answer (D-03): one line per item in request order ("opened <key> → <thread>", "already
 * open <key>", "not opened <key> (run limit | daily limit)"), then "<remainingRun> left this run, <remainingDay>
 * today"; or the refusal's fixed sentence. The id after the arrow is the item's own thread (its root message); the
 * conversation's id when the API gives no root.
 */
export function renderConversationOpen(r: AgentChannelConversationOpenResponse): ConversationOpenToolResult {
  if (!r.ok) return renderRefusal(r.code, r.sentence);
  const lines = r.results.length > 0 ? r.results.map(itemLine) : ["Nothing new: no conversation opened."];
  lines.push(`${r.remainingRun} left this run, ${r.remainingDay} today`);
  return answer(lines.join("\n"), { ok: true, opened: r.results.filter((x) => x.opened).length });
}

/** What a failed request tells the model: a refusal body, an ended turn, an answer it cannot read, or unreachable. */
function failureOf(error: unknown): { result: ConversationOpenToolResult; log: string } {
  if (error instanceof ZodError) {
    return { result: refused(CONVERSATION_OPEN_TOOL_SENTENCES.unreadable, "unreadable"), log: "unreadable" };
  }
  if (error instanceof AgentChannelHttpError) {
    const log = `${error.status}${error.code ? ` ${error.code}` : ""}`;
    if (error.answer) return { result: renderRefusal(error.answer.code, error.answer.sentence), log };
    // An ended turn; a 404 without the code is an older API without the route (the unreachable sentence below).
    if (
      (error.status === 404 && error.code === "unknown_turn") ||
      (error.status === 403 && error.code === "no_trigger")
    ) {
      return { result: refused(CONVERSATION_OPEN_TOOL_SENTENCES.unknown_turn, "unknown_turn"), log };
    }
    return { result: refused(CONVERSATION_OPEN_TOOL_SENTENCES.unreachable, "unreachable"), log };
  }
  const kind = error instanceof Error ? error.name : "error";
  return {
    result: refused(CONVERSATION_OPEN_TOOL_SENTENCES.unreachable, "unreachable"),
    log: /^[A-Za-z]{1,40}$/u.test(kind) ? kind : "error",
  };
}

const DESCRIPTION =
  "Open one conversation per new item this automation run found (a card on the automation's board, or a message in " +
  "its channel, each with its own thread where the item is handled). Call it once with every new item, or with an " +
  "empty list when nothing is new. Each item: externalKey (the item's id in the source, like an order number), a " +
  "short title and a body with what the person handling it needs. An item already opened is never opened again. " +
  "Where the conversations open comes from the automation; you never choose it.";

const str = (min: number, max: number, description: string) => ({
  type: "string",
  minLength: min,
  maxLength: max,
  description,
});

const PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: {
      type: "array",
      maxItems: FAN_OUT_LIMITS.perRunMax,
      description: "Every new item of this run ([] when nothing is new).",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          externalKey: str(
            1,
            FAN_OUT_LIMITS.externalKeyMax,
            "The item's id in the source (an order number).",
          ),
          title: str(1, FAN_OUT_LIMITS.titleMax, "A short title for the conversation."),
          body: str(0, FAN_OUT_LIMITS.bodyMax, "What the person handling the item needs to know."),
        },
        required: ["externalKey", "title"],
      },
    },
  },
  required: ["items"],
} as const;

function openTool(deps: Deps, ctx: ConversationOpenToolContext): OpenClawAgentTool {
  const name = CONVERSATION_OPEN_TOOL;
  return {
    name,
    label: "Open conversations",
    description: DESCRIPTION,
    parameters: PARAMETERS as unknown as Record<string, unknown>,
    async execute(_toolCallId, params, signal) {
      const t = deps.guard.findTurn(ctx);
      if (!t) return refused(CONVERSATION_OPEN_TOOL_SENTENCES.no_turn, "no_turn");
      if (!t.turn.tools.includes(name))
        return refused(CONVERSATION_OPEN_SENTENCES.not_in_turn, "not_in_turn");
      const built = conversationOpenOf(t, asParams(params));
      if ("error" in built) return refused(built.error, built.code);
      const client = deps.client();
      if (!client) return refused(CONVERSATION_OPEN_TOOL_SENTENCES.unreachable, "unreachable");
      try {
        const r = await client.conversationOpen(built.body, signal);
        if (r.ok) {
          const opened = r.results.filter((x) => x.opened).length;
          deps.logger?.info?.(
            `${name}: ${t.eventId} answered (${built.body.items.length} items, ${opened} opened, ` +
              `${r.remainingRun} left this run, ${r.remainingDay} today)`,
          );
        } else deps.logger?.warn?.(`${name}: ${t.eventId} refused (${r.code})`);
        return renderConversationOpen(r);
      } catch (error) {
        const failure = failureOf(error);
        deps.logger?.warn?.(`${name}: ${t.eventId} failed (${failure.log})`);
        return failure.result;
      }
    },
  };
}

export function registerConversationOpenTool(api: OpenClawPluginApi, deps: Deps): void {
  api.registerTool((ctx: ConversationOpenToolContext) => openTool(deps, ctx), {
    name: CONVERSATION_OPEN_TOOL,
  });
}
