import type {
  OpenClawAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/channel-core";
import {
  type AgentChannelRecordUpdate,
  AUTOMATION_LIMITS,
  RECORD_UPDATE_MAX_CHANGES,
  RECORD_UPDATE_VALUE_MAX,
  type RecordChangeValue,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
import { serverSentence } from "./automation-tool.js";
// tool-guard.ts imports `recordTaintedSentence` back (its taint block for this tool). Both sides use the other's
// bindings only when a call runs, never while the modules load, so the cycle is harmless (as with work-zone-tools.ts).
import { type ActiveTurn, approvalLabel, type ToolGuard } from "./tool-guard.js";

/**
 * `ocw_record_update` (07.6 AUTO-04, D-04, C-01): the bot changes fields of the watched record of the turn's card. The
 * API binds the record to the turn's thread, re-reads it, compares it with the last seen hash and writes only when
 * nothing changed elsewhere (409 `record_changed` and a card with the new values otherwise). A thin, credential-free
 * caller of `POST /agent-channel/v1/records/update`:
 *   - it resolves the active OCW turn from the trusted tool context and refuses locally without one, or when the turn
 *     does not offer the tool (the API offers it only in the thread of a watched card),
 *   - it posts only the turn's event and agent with `changes` (RFC 6901 field pointers → scalar values, 1 to 20): never
 *     a record id, a hash or a connector (the schema is closed; anything else is refused here before a request),
 *   - it is side-effecting: on a turn that read outside content it is refused locally (gate and tool) unless the turn's
 *     flags carry a 07.5 approval policy, in which case the route decides (it may ask a person first),
 *   - it answers with the server's sentence (one bounded line), or a fixed local sentence; never an error body.
 * Validated by its own route, never `/tool-calls` (tool-guard.ts `SELF_VALIDATED_TOOLS`). Logs carry ids, counts and
 * codes only: never a field or a value.
 */

export const RECORD_UPDATE_TOOL = "ocw_record_update";

export type RecordToolContext = Pick<OpenClawPluginToolContext, "sessionKey" | "nativeChannelId" | "agentId">;

type Logger = { info?: (m: string) => void; warn?: (m: string) => void };
type Deps = { guard: ToolGuard; client: () => AgentChannelClient | null; logger?: Logger };

const ASKER = "the person who asked";

/** The fixed sentences the model reads when the cell answers itself (07.6-UI-SPEC model-facing results). */
export const RECORD_UPDATE_SENTENCES = {
  tainted: (person?: string) =>
    "I can't update the record after reading outside content in this turn. " +
    `Tell ${person ?? ASKER} to ask again in a new message.`,
  too_many: () =>
    `I can change at most ${RECORD_UPDATE_MAX_CHANGES} fields in one update. Split it into smaller updates.`,
  bad_changes: () =>
    'changes must name each field as a JSON pointer, like "/status", with a text (up to 500 characters), number, ' +
    "true/false or null value.",
  extra_keys: () => "That tool only takes changes: the fields to set and their new values.",
  no_turn: () => "There is no active conversation turn, so I can't use this tool now.",
  not_in_turn: () => "Updating a watched record is not available on this turn.",
  unknown_turn: () => "This conversation turn is no longer active.",
  unreachable: () => "The workspace didn't answer. Try again in a moment.",
} as const;

/** The gate's refusal on a tainted turn (tool-guard.ts): the same sentence the tool gives. */
export function recordTaintedSentence(requesterName?: string): string {
  return RECORD_UPDATE_SENTENCES.tainted(approvalLabel(requesterName));
}

export type RecordToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { ok: boolean; code?: string };
};

const answer = (text: string, ok: boolean, code?: string): RecordToolResult => ({
  content: [{ type: "text", text }],
  details: code ? { ok, code } : { ok },
});

/** A field pointer (RFC 6901, never `""`: a field, not the whole record), as the contracts' `JsonPointer`. */
const FIELD_POINTER = /^(?:\/(?:[^~/]|~[01])*)+$/u;

function isChangeValue(v: unknown): v is RecordChangeValue {
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  return typeof v === "string" && v.length <= RECORD_UPDATE_VALUE_MAX;
}

/** The update body, or why the params are invalid (checked locally; the API re-validates everything). */
export function recordUpdateOf(
  t: Pick<ActiveTurn, "eventId" | "agentId">,
  p: Record<string, unknown>,
): { body: AgentChannelRecordUpdate } | { error: string; code: string } {
  if (Object.keys(p).some((k) => k !== "changes")) {
    return { error: RECORD_UPDATE_SENTENCES.extra_keys(), code: "extra_keys" };
  }
  const raw = p.changes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: RECORD_UPDATE_SENTENCES.bad_changes(), code: "bad_params" };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > RECORD_UPDATE_MAX_CHANGES) {
    return { error: RECORD_UPDATE_SENTENCES.too_many(), code: "too_many_changes" };
  }
  if (
    entries.length === 0 ||
    entries.some(
      ([k, v]) => k.length > AUTOMATION_LIMITS.pointerMax || !FIELD_POINTER.test(k) || !isChangeValue(v),
    )
  ) {
    return { error: RECORD_UPDATE_SENTENCES.bad_changes(), code: "bad_params" };
  }
  return {
    body: {
      eventId: t.eventId,
      agentId: t.agentId,
      changes: Object.fromEntries(entries) as AgentChannelRecordUpdate["changes"],
    },
  };
}

const asParams = (params: unknown): Record<string, unknown> =>
  params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};

const DESCRIPTION =
  "Change fields of the watched record linked to this card (for example an order in the ERP). Give only the fields " +
  'to change, as JSON pointers like "/status", with their new values. The workspace checks first that nobody changed ' +
  "the record elsewhere since the last check; if someone did, nothing is written and a card with the new values is " +
  "posted in the thread.";

function updateTool(deps: Deps, ctx: RecordToolContext): OpenClawAgentTool {
  const name = RECORD_UPDATE_TOOL;
  return {
    name,
    label: "Update the watched record",
    description: DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        changes: {
          type: "object",
          minProperties: 1,
          maxProperties: RECORD_UPDATE_MAX_CHANGES,
          description:
            'Field pointer → new value, like {"/status": "Shipped"}. Values: text, number, true/false or null.',
          additionalProperties: {
            anyOf: [
              { type: "string", maxLength: RECORD_UPDATE_VALUE_MAX },
              { type: "number" },
              { type: "boolean" },
              { type: "null" },
            ],
          },
        },
      },
      required: ["changes"],
    },
    async execute(_toolCallId, params, signal) {
      const t = deps.guard.findTurn(ctx);
      if (!t) return answer(RECORD_UPDATE_SENTENCES.no_turn(), false, "no_turn");
      if (!t.turn.tools.includes(name)) {
        return answer(RECORD_UPDATE_SENTENCES.not_in_turn(), false, "not_in_turn");
      }
      // Side-effecting: after outside content only a 07.5 approval policy lets the route decide (D-07, 07.5 D-04).
      if (t.tainted && !t.turn.toolFlags[name]?.approval) {
        deps.logger?.warn?.(`${name}: ${t.eventId} refused (tainted, local)`);
        return answer(recordTaintedSentence(t.requesterName), false, "tainted");
      }
      const built = recordUpdateOf(t, asParams(params));
      if ("error" in built) return answer(built.error, false, built.code);
      const client = deps.client();
      if (!client) return answer(RECORD_UPDATE_SENTENCES.unreachable(), false, "unreachable");
      const count = Object.keys(built.body.changes).length;
      try {
        const r = await client.updateRecord(built.body, signal);
        const code = r.code ?? (r.ok ? undefined : "refused");
        deps.logger?.[r.ok ? "info" : "warn"]?.(
          `${name}: ${t.eventId} ${r.ok ? "updated" : "refused"} (${count} fields${code ? `, ${approvalLabel(code, 64)}` : ""})`,
        );
        return answer(
          serverSentence(r.sentence, RECORD_UPDATE_SENTENCES.unreachable()),
          r.ok,
          r.ok ? undefined : code,
        );
      } catch (error) {
        if (error instanceof AgentChannelHttpError) {
          // A refusal whose body carries the server's sentence (another module instance's client may not have unwrapped it).
          if (error.answer) {
            const code = error.answer.code ?? "refused";
            deps.logger?.warn?.(`${name}: ${t.eventId} refused (${code})`);
            return answer(
              serverSentence(error.answer.sentence, RECORD_UPDATE_SENTENCES.unreachable()),
              false,
              code,
            );
          }
          if (error.status === 404 || (error.status === 403 && error.code === "no_trigger")) {
            deps.logger?.warn?.(`${name}: ${t.eventId} refused (unknown_turn)`);
            return answer(RECORD_UPDATE_SENTENCES.unknown_turn(), false, "unknown_turn");
          }
          if (error.code === "tainted") {
            return answer(recordTaintedSentence(t.requesterName), false, "tainted");
          }
        }
        deps.logger?.warn?.(`${name}: ${t.eventId} failed (unreachable)`);
        return answer(RECORD_UPDATE_SENTENCES.unreachable(), false, "unreachable");
      }
    },
  };
}

export function registerRecordTool(api: OpenClawPluginApi, deps: Deps): void {
  api.registerTool((ctx: RecordToolContext) => updateTool(deps, ctx), { name: RECORD_UPDATE_TOOL });
}
