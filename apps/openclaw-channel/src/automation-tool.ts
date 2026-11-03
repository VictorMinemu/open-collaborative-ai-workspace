import type {
  OpenClawAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/channel-core";
import { type AgentChannelAutomationPropose, AUTOMATION_LIMITS } from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
// tool-guard.ts imports `automationTaintedSentence` back (its taint block for this tool). Both sides use the other's
// bindings only when a call runs, never while the modules load, so the cycle is harmless (as with work-zone-tools.ts).
import { type ActiveTurn, approvalLabel, type ToolGuard } from "./tool-guard.js";

/**
 * `ocw_automation_propose` (07.6 AUTO-03, D-02, D-03, C-01): the bot proposes a scheduled automation (a standing order,
 * a cron schedule in a time zone, delivered here or in the person's DM with the bot) and the API posts a platform-owned
 * card the person it would run as confirms. Nothing is scheduled from the cell, and OpenClaw's own cron stays off.
 * A thin, credential-free caller of `POST /agent-channel/v1/automations/propose`:
 *   - it resolves the active OCW turn from the trusted tool context and refuses locally without one, or when the turn
 *     does not offer the tool,
 *   - it posts only the turn's event and agent with the tool's own fields (never a conversation, a person or a trigger
 *     other than a schedule: the API takes them from the stored turn; the schema is closed and any other key is refused
 *     here before a request),
 *   - it is always side-effecting: a turn that read outside content never proposes (the gate refuses it first,
 *     tool-guard.ts `ALWAYS_SIDE_EFFECTING`; the tool refuses again; the API answers 403 `tainted` too),
 *   - it answers with the server's sentence (one bounded line), or a fixed local sentence; never an error body.
 * Validated by its own route, never `/tool-calls` (tool-guard.ts `SELF_VALIDATED_TOOLS`). Logs carry ids and codes only.
 */

export const AUTOMATION_PROPOSE_TOOL = "ocw_automation_propose";

export type AutomationToolContext = Pick<
  OpenClawPluginToolContext,
  "sessionKey" | "nativeChannelId" | "agentId"
>;

type Logger = { info?: (m: string) => void; warn?: (m: string) => void };
type Deps = { guard: ToolGuard; client: () => AgentChannelClient | null; logger?: Logger };

const ASKER = "the person who asked";

/** The fixed sentences the model reads when the cell answers itself (07.6-UI-SPEC model-facing results). */
export const AUTOMATION_PROPOSE_SENTENCES = {
  tainted: (person?: string) =>
    "I can't propose an automation after reading outside content in this turn. " +
    `Tell ${person ?? ASKER} to ask again in a new message.`,
  no_turn: () => "There is no active conversation turn, so I can't use this tool now.",
  not_in_turn: () => "Proposing automations is not available on this turn.",
  unknown_turn: () => "This conversation turn is no longer active.",
  unreachable: () => "The workspace didn't answer. Try again in a moment.",
  extra_keys: () =>
    "That tool only takes a name, instructions, a cron schedule, a time zone, where to deliver and a daily run limit.",
} as const;

/** The gate's refusal on a tainted turn (tool-guard.ts): the same sentence the tool and the API give. */
export function automationTaintedSentence(requesterName?: string): string {
  return AUTOMATION_PROPOSE_SENTENCES.tainted(approvalLabel(requesterName));
}

export type AutomationToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { ok: boolean; code?: string };
};

const answer = (text: string, ok: boolean, code?: string): AutomationToolResult => ({
  content: [{ type: "text", text }],
  details: code ? { ok, code } : { ok },
});

/** The API's sentence as the model reads it: one bounded line without control or structural characters. */
export function serverSentence(sentence: string, fallback: string): string {
  return approvalLabel(sentence, 500) ?? fallback;
}

const asParams = (params: unknown): Record<string, unknown> =>
  params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};

const KEYS: ReadonlySet<string> = new Set([
  "name",
  "instructions",
  "cron",
  "timeZone",
  "deliverTo",
  "maxRunsPerDay",
]);
const TIME_ZONE = /^[A-Za-z0-9_+\-/]{1,64}$/u;

/** The proposal body, or why the params are invalid (checked locally; the API re-validates everything). */
export function automationProposalOf(
  t: Pick<ActiveTurn, "eventId" | "agentId">,
  p: Record<string, unknown>,
): { body: AgentChannelAutomationPropose } | { error: string; code: string } {
  if (Object.keys(p).some((k) => !KEYS.has(k))) {
    return { error: AUTOMATION_PROPOSE_SENTENCES.extra_keys(), code: "extra_keys" };
  }
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!name || name.length > AUTOMATION_LIMITS.nameMax) {
    return {
      error: `name must be a short title (1 to ${AUTOMATION_LIMITS.nameMax} characters).`,
      code: "bad_params",
    };
  }
  const instructions = typeof p.instructions === "string" ? p.instructions.trim() : "";
  if (!instructions || instructions.length > AUTOMATION_LIMITS.instructionsMax) {
    return {
      error: `instructions must say what to do on each run (1 to ${AUTOMATION_LIMITS.instructionsMax} characters).`,
      code: "bad_params",
    };
  }
  const cron = typeof p.cron === "string" ? p.cron.trim() : "";
  if (!cron || cron.length > AUTOMATION_LIMITS.cronMax || cron.split(/\s+/u).length !== 5) {
    return {
      error: 'cron must be five cron fields, like "0 17 * * 5" (Fridays at 17:00).',
      code: "bad_params",
    };
  }
  const timeZone = typeof p.timeZone === "string" ? p.timeZone.trim() : "";
  if (!TIME_ZONE.test(timeZone)) {
    return { error: 'timeZone must be an IANA time zone, like "Europe/Madrid".', code: "bad_params" };
  }
  if (p.deliverTo !== "here" && p.deliverTo !== "dm") {
    return {
      error: "deliverTo must be here (this conversation) or dm (a direct message).",
      code: "bad_params",
    };
  }
  const max = p.maxRunsPerDay;
  if (
    max !== undefined &&
    !(
      typeof max === "number" &&
      Number.isInteger(max) &&
      max >= 1 &&
      max <= AUTOMATION_LIMITS.maxRunsPerDayCeiling
    )
  ) {
    return {
      error: `maxRunsPerDay must be a whole number from 1 to ${AUTOMATION_LIMITS.maxRunsPerDayCeiling}, or left out.`,
      code: "bad_params",
    };
  }
  return {
    body: {
      eventId: t.eventId,
      agentId: t.agentId,
      name,
      instructions,
      schedule: { cron, timeZone },
      target: { kind: p.deliverTo },
      ...(typeof max === "number" ? { maxRunsPerDay: max } : {}),
    },
  };
}

const DESCRIPTION =
  "Propose a scheduled automation for the person you are talking to: a standing order you will carry out on each run, " +
  "a cron schedule in their time zone, and where to deliver it (here, or your direct messages with them). It posts a " +
  "card; nothing runs until that person confirms it, and it always runs as them, with their permissions. Use it only " +
  "when they ask for something recurring.";

function proposeTool(deps: Deps, ctx: AutomationToolContext): OpenClawAgentTool {
  const name = AUTOMATION_PROPOSE_TOOL;
  return {
    name,
    label: "Propose an automation",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: AUTOMATION_LIMITS.nameMax,
          description: "A short title, like “Weekly sales report”.",
        },
        instructions: {
          type: "string",
          minLength: 1,
          maxLength: AUTOMATION_LIMITS.instructionsMax,
          description: "What to do on each run, in plain words.",
        },
        cron: {
          type: "string",
          maxLength: AUTOMATION_LIMITS.cronMax,
          description: 'Five cron fields (minute hour day-of-month month day-of-week), like "0 17 * * 5".',
        },
        timeZone: {
          type: "string",
          maxLength: 64,
          description:
            'The IANA time zone the schedule is in, like "Europe/Madrid" (usually the person\'s own).',
        },
        deliverTo: {
          type: "string",
          enum: ["here", "dm"],
          description: "here: this conversation; dm: your direct messages with the person.",
        },
        maxRunsPerDay: {
          type: "integer",
          minimum: 1,
          maximum: AUTOMATION_LIMITS.maxRunsPerDayCeiling,
          description: "Optional cap on runs per day; omit it for the default.",
        },
      },
      required: ["name", "instructions", "cron", "timeZone", "deliverTo"],
    },
    async execute(_toolCallId, params, signal) {
      const t = deps.guard.findTurn(ctx);
      if (!t) return answer(AUTOMATION_PROPOSE_SENTENCES.no_turn(), false, "no_turn");
      if (!t.turn.tools.includes(name)) {
        return answer(AUTOMATION_PROPOSE_SENTENCES.not_in_turn(), false, "not_in_turn");
      }
      // Always side-effecting (D-02): never from a turn that read outside content (the gate refused it already).
      if (t.tainted) {
        deps.logger?.warn?.(`${name}: ${t.eventId} refused (tainted, local)`);
        return answer(automationTaintedSentence(t.requesterName), false, "tainted");
      }
      const built = automationProposalOf(t, asParams(params));
      if ("error" in built) return answer(built.error, false, built.code);
      const client = deps.client();
      if (!client) return answer(AUTOMATION_PROPOSE_SENTENCES.unreachable(), false, "unreachable");
      try {
        const r = await client.proposeAutomation(built.body, signal);
        if (r.ok) {
          deps.logger?.info?.(`${name}: ${t.eventId} proposed (${r.approvalId})`);
          return answer(serverSentence(r.sentence, AUTOMATION_PROPOSE_SENTENCES.unreachable()), true);
        }
        deps.logger?.warn?.(`${name}: ${t.eventId} refused (${approvalLabel(r.code, 64) ?? "refused"})`);
        return answer(serverSentence(r.sentence, AUTOMATION_PROPOSE_SENTENCES.unreachable()), false, r.code);
      } catch (error) {
        if (error instanceof AgentChannelHttpError) {
          // A refusal whose body carries the server's sentence (another module instance's client may not have unwrapped it).
          if (error.answer) {
            const code = error.answer.code ?? "refused";
            deps.logger?.warn?.(`${name}: ${t.eventId} refused (${code})`);
            return answer(
              serverSentence(error.answer.sentence, AUTOMATION_PROPOSE_SENTENCES.unreachable()),
              false,
              code,
            );
          }
          if (error.status === 404 || (error.status === 403 && error.code === "no_trigger")) {
            deps.logger?.warn?.(`${name}: ${t.eventId} refused (unknown_turn)`);
            return answer(AUTOMATION_PROPOSE_SENTENCES.unknown_turn(), false, "unknown_turn");
          }
          if (error.code === "tainted") {
            deps.logger?.warn?.(`${name}: ${t.eventId} refused (tainted)`);
            return answer(automationTaintedSentence(t.requesterName), false, "tainted");
          }
        }
        deps.logger?.warn?.(`${name}: ${t.eventId} failed (unreachable)`);
        return answer(AUTOMATION_PROPOSE_SENTENCES.unreachable(), false, "unreachable");
      }
    },
  };
}

export function registerAutomationTool(api: OpenClawPluginApi, deps: Deps): void {
  api.registerTool((ctx: AutomationToolContext) => proposeTool(deps, ctx), { name: AUTOMATION_PROPOSE_TOOL });
}
