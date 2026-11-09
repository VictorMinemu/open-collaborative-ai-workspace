import type {
  OpenClawAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/channel-core";
import { ZodError } from "zod";
import {
  AgentChannelWorkSessionStart,
  type AgentChannelWorkSessionStartResponse,
  BOT_PROFILE_STATUS_SENTENCES,
  BOT_WORK_SESSION_PROPOSED_SENTENCE,
  BOT_WORK_SESSION_SENTENCES,
  BOT_WORK_ZONE_LIMITS,
  type BotWorkSessionRefusal,
  type BotWorkSessionRefused,
  WorkZonePermissionMode,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
// tool-guard.ts never imports this module (it reads the names from turn-scoped-tools.ts), so this import is one-way.
import { type ActiveTurn, approvalLabel, type ToolGuard } from "./tool-guard.js";
import {
  WORK_SESSION_PROMPT_TOOL,
  WORK_SESSION_READ_TOOL,
  WORK_SESSION_START_TOOL,
  WORK_SESSION_STOP_TOOL,
  WORK_SESSION_TOOL_NAMES,
  type WorkSessionToolName,
} from "./turn-scoped-tools.js";

/**
 * The bot's own Work Zone session tools (07.16 D-05, D-06, PD-09): a bot with an active Work Zone profile starts a coding
 * session on its profile's device, follows it up, reads what it did and stops it. Like the 07.5 proposal tools
 * (work-zone-tools.ts), each is a thin, credential-free caller of the Agent Channel API that never decides:
 *   - it resolves the active OCW turn from the trusted tool context and refuses locally without one, or when the turn
 *     does not offer the tool (the API offers them only to a bot with an active profile, PD-17),
 *   - it posts only the turn's event and agent with the tool's own fields. The bot never names a device, a user, an
 *     audience or a worktree: the API takes the device, the runtime and the sponsor from the profile, decides who sees
 *     the session (PD-11) and whether it gets its own worktree. Each schema is closed (`additionalProperties: false`) and
 *     any other key is refused here before a request,
 *   - every route decides and audits the call itself (`/work-sessions/start|prompt|read|stop`: the turn, the tool on
 *     it, the profile, the caps, the outside-content rule), so none of them goes through `/tool-calls` (tool-guard.ts
 *     `SELF_VALIDATED_TOOLS`),
 *   - it answers with fixed sentences or the API's own sentence, never an error body. Logs carry ids and codes only:
 *     never a prompt, an output, a project name or a file path (P1).
 * The bot never approves anything a session asks for (P3): a read lists pending approvals and the people who may decide
 * them, and tells the model to mention one of them.
 */

export {
  WORK_SESSION_PROMPT_TOOL,
  WORK_SESSION_READ_TOOL,
  WORK_SESSION_START_TOOL,
  WORK_SESSION_STOP_TOOL,
  WORK_SESSION_TOOL_NAMES,
  type WorkSessionToolName,
};

export type WorkSessionToolContext = Pick<
  OpenClawPluginToolContext,
  "sessionKey" | "nativeChannelId" | "agentId"
>;

type Logger = { info?: (m: string) => void; warn?: (m: string) => void };
type Deps = { guard: ToolGuard; client: () => AgentChannelClient | null; logger?: Logger };

export type WorkSessionToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { ok: boolean; code?: string };
};

const answer = (text: string, ok: boolean, code?: string): WorkSessionToolResult => ({
  content: [{ type: "text", text }],
  details: code ? { ok, code } : { ok },
});

/** The fixed sentences of the outcomes the plugin decides itself (no request, or no usable answer). */
export const WORK_SESSION_TOOL_SENTENCES = {
  no_turn: "There is no active conversation turn, so I can't use this tool now.",
  unknown_turn: "This conversation turn is no longer active.",
  unreadable:
    "The Work Zone answered in a form I can't read. Check the session's card in this conversation before trying again.",
  unreachable: {
    [WORK_SESSION_START_TOOL]: "The Work Zone could not be reached; nothing was started.",
    [WORK_SESSION_PROMPT_TOOL]:
      "The Work Zone could not be reached; the prompt may not have been queued. Read the session before sending it again.",
    [WORK_SESSION_READ_TOOL]:
      "The Work Zone could not be reached; try reading the session again in a moment.",
    [WORK_SESSION_STOP_TOOL]: "The Work Zone could not be reached; the session was not stopped.",
  } satisfies Record<WorkSessionToolName, string>,
  extra_keys:
    "That tool only takes a project, a prompt and optional model, effort, fastMode, contextWindow and permissionMode. " +
    "The device, the people who see the session and the worktree come from the bot's Work Zone profile.",
  bad_project: "projectId must be one of the project ids listed for this turn's Work Zone.",
  bad_prompt: `prompt must say what the session should do, in at most ${BOT_WORK_ZONE_LIMITS.promptChars.toLocaleString("en-US")} characters.`,
  bad_option:
    "model, effort, fastMode, contextWindow and permissionMode must be values listed for this turn's Work Zone, or left out.",
} as const;

/** The permission modes as people read them in the Work Zone (apps/web work-zone/meta.tsx labels). */
const MODE_LABELS: Record<WorkZonePermissionMode, string> = {
  default: "Supervised",
  acceptEdits: "Accept edits",
  plan: "Plan",
  auto: "Auto",
  fullAccess: "Full access",
};

/** A name or sentence from the API, shown inside a fixed sentence: one line, no structural characters, bounded. */
const label = (value: string | null | undefined, max = 120) => approvalLabel(value, max);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const asParams = (params: unknown): Record<string, unknown> =>
  params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};

/** The turn, the client, or a local refusal (no turn / the tool not offered / no client). */
function turnFor(
  name: WorkSessionToolName,
  deps: Deps,
  ctx: WorkSessionToolContext,
): { turn: ActiveTurn; client: AgentChannelClient } | { refused: WorkSessionToolResult } {
  const t = deps.guard.findTurn(ctx);
  if (!t) return { refused: answer(WORK_SESSION_TOOL_SENTENCES.no_turn, false, "no_turn") };
  if (!t.turn.tools.includes(name)) {
    return { refused: answer(BOT_WORK_SESSION_SENTENCES.not_in_turn, false, "not_in_turn") };
  }
  const client = deps.client();
  if (!client) {
    return { refused: answer(WORK_SESSION_TOOL_SENTENCES.unreachable[name], false, "unreachable") };
  }
  return { turn: t, client };
}

const KNOWN_REFUSALS: ReadonlySet<string> = new Set(Object.keys(BOT_WORK_SESSION_SENTENCES));

/**
 * A refused answer for the model: the API's sentence (one line, bounded), else the contracts' sentence for its code;
 * for an inactive profile, the status line of its reason after it.
 */
export function renderWorkSessionRefusal(r: BotWorkSessionRefused): WorkSessionToolResult {
  const own = label(r.sentence, 300);
  const known = KNOWN_REFUSALS.has(r.code)
    ? BOT_WORK_SESSION_SENTENCES[r.code as BotWorkSessionRefusal]
    : undefined;
  const sentence = own ?? known ?? BOT_WORK_SESSION_SENTENCES.not_allowed;
  const status = r.reason ? BOT_PROFILE_STATUS_SENTENCES[r.reason] : undefined;
  const text = status && !sentence.includes(status) ? `${sentence} ${status}` : sentence;
  return answer(text, false, r.code);
}

/** What a failed request tells the model: an ended turn, an answer it cannot read, or the tool's unreachable sentence. */
function failureOf(
  name: WorkSessionToolName,
  error: unknown,
): { result: WorkSessionToolResult; log: string } {
  if (error instanceof ZodError) {
    return { result: answer(WORK_SESSION_TOOL_SENTENCES.unreadable, false, "unreadable"), log: "unreadable" };
  }
  if (error instanceof AgentChannelHttpError) {
    // An ended turn; a 404 without the code is an older API without the route (the unreachable sentence below).
    if (
      (error.status === 404 && error.code === "unknown_turn") ||
      (error.status === 403 && error.code === "no_trigger")
    ) {
      return {
        result: answer(WORK_SESSION_TOOL_SENTENCES.unknown_turn, false, "unknown_turn"),
        log: `${error.status} ${error.code}`,
      };
    }
    return {
      result: answer(WORK_SESSION_TOOL_SENTENCES.unreachable[name], false, "unreachable"),
      log: `${error.status}${error.code ? ` ${error.code}` : ""}`,
    };
  }
  const kind = error instanceof Error ? error.name : "error";
  return {
    result: answer(WORK_SESSION_TOOL_SENTENCES.unreachable[name], false, "unreachable"),
    log: /^[A-Za-z]{1,40}$/u.test(kind) ? kind : "error",
  };
}

// ---------------------------------------------------------------- ocw_work_session_start

/** Every key the start tool takes: anything else (a device, a user, an audience, a worktree) is refused locally. */
const START_KEYS: ReadonlySet<string> = new Set([
  "projectId",
  "prompt",
  "model",
  "effort",
  "fastMode",
  "contextWindow",
  "permissionMode",
]);
const START_OPTIONS = AgentChannelWorkSessionStart.pick({
  model: true,
  effort: true,
  fastMode: true,
  contextWindow: true,
  permissionMode: true,
});

/** The start body, or why the params are invalid (checked locally; the API re-validates everything). */
export function workSessionStartOf(
  t: Pick<ActiveTurn, "eventId" | "agentId">,
  p: Record<string, unknown>,
): { body: AgentChannelWorkSessionStart } | { error: string; code: string } {
  if (Object.keys(p).some((k) => !START_KEYS.has(k))) {
    return { error: WORK_SESSION_TOOL_SENTENCES.extra_keys, code: "extra_keys" };
  }
  const projectId = typeof p.projectId === "string" ? p.projectId.trim() : "";
  if (!UUID.test(projectId)) return { error: WORK_SESSION_TOOL_SENTENCES.bad_project, code: "bad_params" };
  const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
  if (!prompt || prompt.length > BOT_WORK_ZONE_LIMITS.promptChars) {
    return { error: WORK_SESSION_TOOL_SENTENCES.bad_prompt, code: "bad_params" };
  }
  const { projectId: _p, prompt: _q, ...rest } = p;
  const options = START_OPTIONS.safeParse(rest);
  if (!options.success) return { error: WORK_SESSION_TOOL_SENTENCES.bad_option, code: "bad_params" };
  const body = AgentChannelWorkSessionStart.safeParse({
    eventId: t.eventId,
    agentId: t.agentId,
    projectId,
    prompt,
    ...options.data,
  });
  if (!body.success) return { error: WORK_SESSION_TOOL_SENTENCES.bad_option, code: "bad_params" };
  return { body: body.data };
}

/** What the model reads for a start answer. */
export function renderWorkSessionStart(r: AgentChannelWorkSessionStartResponse): WorkSessionToolResult {
  if (r.kind === "started") {
    const project = label(r.projectName, 80) ?? "the project";
    const model = label(r.model, 80);
    const card = r.cardMessageId
      ? "Its card is in this conversation; you'll be told when it changes."
      : "You'll be told when it changes.";
    return answer(
      `Started a Work Zone session in ${project} (${MODE_LABELS[r.mode]}${model ? ` · ${model}` : ""}). ` +
        `Session ${r.workSessionId}. ${card}`,
      true,
    );
  }
  if (r.kind === "proposed") {
    return answer(`${BOT_WORK_SESSION_PROPOSED_SENTENCE} Proposal ${r.approvalId}.`, false, "proposed");
  }
  return renderWorkSessionRefusal(r);
}

const START_DESCRIPTION =
  "Start a Work Zone coding session on your Work Zone device: one of the projects listed for this turn and the task as " +
  "the prompt. Optionally choose a model, effort, fast mode, context window or permission mode among the values " +
  "listed for this turn; leave them out for your profile's defaults. The device, the people who can see the session " +
  "and the worktree come from your Work Zone profile. A card for the session appears in this conversation.";

function startTool(deps: Deps, ctx: WorkSessionToolContext): OpenClawAgentTool {
  const name = WORK_SESSION_START_TOOL;
  return {
    name,
    label: "Start a Work Zone session",
    description: START_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: {
          type: "string",
          format: "uuid",
          description: "A project id listed for this turn's Work Zone.",
        },
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: BOT_WORK_ZONE_LIMITS.promptChars,
          description: "The task for the session, in plain words (never a slash command).",
        },
        model: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "A model listed for this turn; omit it for the profile's default.",
        },
        effort: {
          type: "string",
          minLength: 1,
          maxLength: 32,
          description: "An effort level listed for this turn; omit it for the default.",
        },
        fastMode: { type: "boolean", description: "Turn fast mode on, when this turn allows it." },
        contextWindow: {
          type: "integer",
          minimum: 1000,
          maximum: 10_000_000,
          description: "A context window in tokens the model supports; omit it for the default.",
        },
        permissionMode: {
          type: "string",
          enum: [...WorkZonePermissionMode.options],
          description:
            "default (Supervised), acceptEdits, plan, auto or fullAccess; at most this turn's maximum mode. Omit it for the profile's default.",
        },
      },
      required: ["projectId", "prompt"],
    },
    async execute(_toolCallId, params, signal) {
      const found = turnFor(name, deps, ctx);
      if ("refused" in found) return found.refused;
      const { turn: t, client } = found;
      const built = workSessionStartOf(t, asParams(params));
      if ("error" in built) return answer(built.error, false, built.code);
      try {
        const r = await client.workSessionStart(built.body, signal);
        if (r.kind === "started") deps.logger?.info?.(`${name}: ${t.eventId} started (${r.workSessionId})`);
        else if (r.kind === "proposed")
          deps.logger?.info?.(`${name}: ${t.eventId} proposed (${r.approvalId})`);
        else deps.logger?.warn?.(`${name}: ${t.eventId} refused (${r.code})`);
        return renderWorkSessionStart(r);
      } catch (error) {
        const failure = failureOf(name, error);
        deps.logger?.warn?.(`${name}: ${t.eventId} failed (${failure.log})`);
        return failure.result;
      }
    },
  };
}

export function registerWorkSessionTools(api: OpenClawPluginApi, deps: Deps): void {
  api.registerTool((ctx: WorkSessionToolContext) => startTool(deps, ctx), { name: WORK_SESSION_START_TOOL });
}
