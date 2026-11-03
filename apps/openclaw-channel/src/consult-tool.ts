import type {
  OpenClawAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/channel-core";
import {
  A2A_LIMITS,
  type AgentChannelConsultRequest,
  CONSULT_MODES,
  type ConsultMode,
  type ConsultTarget,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
// automation-tool.ts and tool-guard.ts import back from modules that import this one; every binding is used only while
// a call runs, never while the modules load, so the cycles are harmless (as with automation-tool.ts).
import { serverSentence } from "./automation-tool.js";
import { type ActiveTurn, approvalLabel, type ToolGuard } from "./tool-guard.js";
import { CONSULT_TOOL_NAME } from "./turn-scoped-tools.js";

export { CONSULT_TOOL_NAME };

/**
 * `ocw_consult_agent` (07.7 A2A-01, D-01, D-04, D-08, C-01, ADR-0027): the bot asks another bot of the workspace a
 * question (or hands the request over to it) through the platform. A thin, credential-free caller of
 * `POST /agent-channel/v1/consultations`:
 *   - it resolves the active OCW turn from the trusted tool context and refuses locally without one, when the turn does
 *     not offer the tool, when the turn is tainted, or when the target is not one of `turn.consult.targets`,
 *   - it posts only the turn's event and agent, the target's id, the question and the mode, keyed
 *     `<eventId>:consult:<n>` (a retried call keeps its key, so the API answers the same hop); never a conversation, a
 *     human, a chain or another agent id: the API takes them from the stored turn, and the schema is closed,
 *   - it returns at once: the answer arrives later as a new turn (`agent.consult_reply.v1`); nothing waits or polls,
 *   - it answers with the server's sentence (one bounded line), or a fixed local sentence; never an error body.
 * Validated by its own route, never `/tool-calls` (tool-guard.ts `SELF_VALIDATED_TOOLS`), and always side-effecting
 * (`ALWAYS_SIDE_EFFECTING`: a consult after untrusted content is the injection the taint rule exists for). Logs carry
 * ids and codes only, never the question.
 */

export type ConsultToolContext = Pick<
  OpenClawPluginToolContext,
  "sessionKey" | "nativeChannelId" | "agentId"
>;

type Logger = { info?: (m: string) => void; warn?: (m: string) => void };
type Deps = { guard: ToolGuard; client: () => AgentChannelClient | null; logger?: Logger };

const ASKER = "the person who asked";
/** A bot handle as the model may write it: letters, digits, `_`, `-` and `.`, never a uuid. */
const HANDLE = /^[a-z0-9][a-z0-9_.-]{0,63}$/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The fixed sentences the model reads when the cell answers itself; every API answer is the server's sentence. */
export const CONSULT_SENTENCES = {
  no_turn: () => "There is no active conversation turn, so I can't use this tool now.",
  not_in_turn: () => "Consulting other bots is not available on this turn.",
  not_a_target: (target?: string) =>
    `${target ? `@${target}` : "That bot"} is not a bot you can consult here.`,
  tainted: (person?: string) =>
    "I can't consult another bot after reading web or tool content in this turn. " +
    `Tell ${person ?? ASKER} to ask again in a new message.`,
  unknown_turn: () => "This conversation turn is no longer active.",
  unreachable: () => "The question could not be sent. Try again in a moment.",
  extra_keys: () => "That tool only takes a target bot, a question and a mode.",
  bad_target: () => "target must be the @handle of a bot listed under the bots you may consult here.",
  bad_question: () => `question must say what you want to know (1 to ${A2A_LIMITS.questionMax} characters).`,
  bad_mode: () => "mode must be consult (you get the answer back) or handoff (they continue in this thread).",
} as const;

/** The gate's refusal on a tainted turn (tool-guard.ts): the same sentence the tool and the API give. */
export function consultTaintedSentence(requesterName?: string): string {
  return CONSULT_SENTENCES.tainted(approvalLabel(requesterName));
}

export type ConsultToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { ok: boolean; code?: string };
};

const answer = (text: string, ok: boolean, code?: string): ConsultToolResult => ({
  content: [{ type: "text", text }],
  details: code ? { ok, code } : { ok },
});

const KEYS: ReadonlySet<string> = new Set(["target", "question", "mode"]);
/** The API's codes that mean the turn is gone (its human no longer reads, or it never existed): one fixed sentence. */
const TURN_GONE: ReadonlySet<string> = new Set(["unknown_turn", "no_trigger"]);

const asParams = (params: unknown): Record<string, unknown> =>
  params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};

/** The target as the model named it (an id, or a handle with or without `@`), in the turn's offered list. */
export function consultTargetOf(targets: readonly ConsultTarget[], raw: string): ConsultTarget | undefined {
  const wanted = raw.trim().replace(/^@/u, "").toLowerCase();
  if (!wanted) return undefined;
  return targets.find((t) => t.id.toLowerCase() === wanted || t.handle.toLowerCase() === wanted);
}

/** A target that is not offered, as the refusal names it: a handle only, never a uuid or free text. */
function refusedTarget(raw: string): string | undefined {
  const handle = raw.trim().replace(/^@/u, "");
  return HANDLE.test(handle) && !UUID.test(handle) ? handle : undefined;
}

/** The consult body, or why the params are invalid (checked locally; the API re-validates everything). */
export function consultRequestOf(
  t: Pick<ActiveTurn, "eventId" | "agentId" | "turn">,
  p: Record<string, unknown>,
  key: () => string,
): { body: AgentChannelConsultRequest } | { error: string; code: string } {
  if (Object.keys(p).some((k) => !KEYS.has(k))) {
    return { error: CONSULT_SENTENCES.extra_keys(), code: "extra_keys" };
  }
  if (typeof p.target !== "string" || !p.target.trim() || p.target.length > 200) {
    return { error: CONSULT_SENTENCES.bad_target(), code: "bad_params" };
  }
  const question = typeof p.question === "string" ? p.question.trim() : "";
  if (!question || question.length > A2A_LIMITS.questionMax) {
    return { error: CONSULT_SENTENCES.bad_question(), code: "bad_params" };
  }
  const mode = p.mode ?? "consult";
  if (!(CONSULT_MODES as readonly unknown[]).includes(mode)) {
    return { error: CONSULT_SENTENCES.bad_mode(), code: "bad_params" };
  }
  const target = consultTargetOf(t.turn.consult?.targets ?? [], p.target);
  if (!target) {
    return { error: CONSULT_SENTENCES.not_a_target(refusedTarget(p.target)), code: "not_a_target" };
  }
  return {
    body: {
      eventId: t.eventId,
      agentId: t.agentId,
      target: target.id,
      question,
      mode: mode as ConsultMode,
      idempotencyKey: key(),
    },
  };
}

type CallCounter = { next: number; byCall: Map<string, number> };
/**
 * Process-wide, like the gate's turns (tool-guard.ts): OpenClaw may load this module more than once, while the turn a
 * tool runs in was begun by another instance.
 */
const STATE_KEY = Symbol.for("ocw.openclaw-channel.consult-tool");
type StateRegistry = { [STATE_KEY]?: WeakMap<ActiveTurn, CallCounter> };
const registry = globalThis as StateRegistry;

function counters(): WeakMap<ActiveTurn, CallCounter> {
  registry[STATE_KEY] ??= new WeakMap();
  return registry[STATE_KEY];
}

/** Tests only: forget every call counter. */
export function resetConsultToolState(): void {
  registry[STATE_KEY] = new WeakMap();
}

/** `n` of this call in the turn: a new tool call gets the next one, a retried call keeps its own (card-tool.ts). */
function callIndex(t: ActiveTurn, toolCallId: string): number {
  const calls = counters();
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

const DESCRIPTION =
  "Ask another bot of this workspace a question for the person you are helping, or hand the request over to it. The " +
  "question is posted in this thread for everyone to see, and it runs with that person's permissions. The answer " +
  "arrives later as a new message, so don't wait for it: tell the person in one line that you are checking. Only the " +
  "bots listed as the ones you may consult here can be asked.";

function consultTool(deps: Deps, ctx: ConsultToolContext): OpenClawAgentTool {
  const name = CONSULT_TOOL_NAME;
  return {
    name,
    label: "Consult a bot",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        target: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "The bot to ask: its @handle from the bots you may consult here.",
        },
        question: {
          type: "string",
          minLength: 1,
          maxLength: A2A_LIMITS.questionMax,
          description: "What you want to know, in plain words, with the context the other bot needs.",
        },
        mode: {
          type: "string",
          enum: [...CONSULT_MODES],
          description:
            "consult (default): you get the answer back as a new message. handoff: the other bot continues in this thread instead of you.",
        },
      },
      required: ["target", "question"],
    },
    async execute(toolCallId, params, signal) {
      const t = deps.guard.findTurn(ctx);
      if (!t) return answer(CONSULT_SENTENCES.no_turn(), false, "no_turn");
      if (!t.turn.tools.includes(name)) return answer(CONSULT_SENTENCES.not_in_turn(), false, "not_in_turn");
      // Always side-effecting (D-08): never from a turn that read untrusted content (the gate refused it already).
      if (t.tainted) {
        deps.logger?.warn?.(`${name}: ${t.eventId} refused (tainted, local)`);
        return answer(consultTaintedSentence(t.requesterName), false, "tainted");
      }
      const built = consultRequestOf(t, asParams(params), () => {
        const n = callIndex(t, typeof toolCallId === "string" ? toolCallId : "");
        return `${t.eventId}:consult:${n}`;
      });
      if ("error" in built) {
        if (built.code === "not_a_target")
          deps.logger?.warn?.(`${name}: ${t.eventId} refused (not_a_target)`);
        return answer(built.error, false, built.code);
      }
      const client = deps.client();
      if (!client) return answer(CONSULT_SENTENCES.unreachable(), false, "unreachable");
      const unknownTurn = () => {
        deps.logger?.warn?.(`${name}: ${t.eventId} refused (unknown_turn)`);
        return answer(CONSULT_SENTENCES.unknown_turn(), false, "unknown_turn");
      };
      try {
        const r = await client.consult(built.body, signal);
        if (r.ok) {
          deps.logger?.info?.(`${name}: ${t.eventId} asked ${built.body.target} (hop ${r.hopId})`);
          return answer(serverSentence(r.sentence, CONSULT_SENTENCES.unreachable()), true);
        }
        if (TURN_GONE.has(r.code)) return unknownTurn();
        deps.logger?.warn?.(`${name}: ${t.eventId} refused (${approvalLabel(r.code, 64) ?? "refused"})`);
        return answer(serverSentence(r.sentence, CONSULT_SENTENCES.unreachable()), false, r.code);
      } catch (error) {
        if (error instanceof AgentChannelHttpError) {
          // A refusal whose body carries the server's sentence (another module instance's client may not have unwrapped it).
          const code = error.answer?.code ?? error.code;
          if (code && TURN_GONE.has(code)) return unknownTurn();
          if (error.answer) {
            deps.logger?.warn?.(`${name}: ${t.eventId} refused (${code ?? "refused"})`);
            return answer(
              serverSentence(error.answer.sentence, CONSULT_SENTENCES.unreachable()),
              false,
              code ?? "refused",
            );
          }
          // 404 without a sentence: the turn (or a row it names) is gone for this cell.
          if (error.status === 404) return unknownTurn();
          if (code === "tainted") {
            deps.logger?.warn?.(`${name}: ${t.eventId} refused (tainted)`);
            return answer(consultTaintedSentence(t.requesterName), false, "tainted");
          }
        }
        deps.logger?.warn?.(`${name}: ${t.eventId} failed (unreachable)`);
        return answer(CONSULT_SENTENCES.unreachable(), false, "unreachable");
      }
    },
  };
}

export function registerConsultTool(api: OpenClawPluginApi, deps: Deps): void {
  api.registerTool((ctx: ConsultToolContext) => consultTool(deps, ctx), { name: CONSULT_TOOL_NAME });
}
