import type {
  OpenClawAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/channel-core";
import { ZodError } from "zod";
import {
  AgentChannelTaskContinue,
  type AgentChannelTaskContinueResponse,
  AgentChannelTaskFinish,
  type AgentChannelTaskFinishResponse,
  AgentChannelTaskStart,
  type AgentChannelTaskStartResponse,
  BOT_TASK_LIMITS,
  BOT_TASK_SENTENCES,
  type BotTaskRefusal,
  TaskGoal,
  TaskNote,
  TaskSummary,
  TaskWaitFor,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
// tool-guard.ts never imports this module (it reads the names from turn-scoped-tools.ts), so this import is one-way.
import { type ActiveTurn, approvalLabel, type ToolGuard } from "./tool-guard.js";
import {
  TASK_CONTINUE_TOOL,
  TASK_FINISH_TOOL,
  TASK_START_TOOL,
  type TASK_TOOL_NAMES,
} from "./turn-scoped-tools.js";

/**
 * `ocw_task_start`, `ocw_task_continue`, `ocw_task_finish` (07.17.1.1.2 D-02, D-08, D-13, PD-04, PD-08): the bot starts,
 * continues and ends its own long task in the turn's thread. Like `ocw_conversation_open` (conversation-open-tool.ts)
 * they are thin, credential-free callers of the Agent Channel API that never decide and never schedule (P2: no timer,
 * no cron, no heartbeat here; the API delivers the next turn):
 *   - each resolves the active OCW turn from the trusted tool context and refuses locally without one, or when the turn
 *     does not offer the tool (`not_in_turn`, the API's own refusal too),
 *   - each posts only the turn's event and agent with the bot's own fields (a goal; progress, next step and an optional
 *     wait; a summary and an outcome). The bot never names a person, a conversation, a task, a budget or a time the API
 *     decides (P6): the schemas are closed and the text rules are the contracts' (one line, no control or bidi
 *     characters, bounded), checked here before a request,
 *   - the route decides everything else (the task, the requester, the policy, the budgets, quiet turns) and the gate
 *     lets each run once per turn outside the cap of 8, also after outside content (tool-guard.ts),
 *   - each answers one short line (never echoing the bot's notes) or the refusal's fixed sentence, and records what the
 *     turn achieved on the active turn (`taskCallEnded`), which the bridge reads after the run.
 * Logs carry ids and codes only: never a goal, a note, a next step or a summary (P1).
 */

export type TaskToolContext = Pick<OpenClawPluginToolContext, "sessionKey" | "nativeChannelId" | "agentId">;

type Logger = { info?: (m: string) => void; warn?: (m: string) => void };
type Deps = { guard: ToolGuard; client: () => AgentChannelClient | null; logger?: Logger };

export type TaskToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { ok: boolean; code?: string; taskId?: string; next?: string; quiet?: boolean; status?: string };
};

const answer = (text: string, details: TaskToolResult["details"]): TaskToolResult => ({
  content: [{ type: "text", text }],
  details,
});
const refused = (text: string, code: string) => answer(text, { ok: false, code });

/** The fixed sentences of the outcomes the plugin decides or renders itself. */
export const TASK_TOOL_SENTENCES = {
  no_turn: "There is no active conversation turn, so I can't use this tool now.",
  unknown_turn: "This conversation turn is no longer active.",
  unreachable:
    "The workspace could not be reached, so this may not have been saved. Call the tool again once; if it fails " +
    "again, tell the person where you got to.",
  unreadable: "The workspace answered in a form I can't read. Tell the person where you got to.",
  extra_keys:
    "That tool only takes its own fields. The person, the conversation, the task, its budget and the times come " +
    "from the workspace.",
  bad_goal: `goal must be one line of at most ${BOT_TASK_LIMITS.goalChars} characters, without control characters.`,
  bad_notes:
    `progress and nextStep must each be one line of at most ${BOT_TASK_LIMITS.noteChars} characters, without ` +
    "control characters.",
  bad_wait: `afterSeconds must be a whole number of seconds from 0 to ${BOT_TASK_LIMITS.afterSecondsMax}.`,
  bad_wait_for:
    "waitFor takes exactly one of processId (a background command of this task) or workSessionId (a Work Zone " +
    "session this task started).",
  bad_finish:
    `ocw_task_finish takes a summary of at most ${BOT_TASK_LIMITS.summaryChars.toLocaleString("en-US")} characters ` +
    "and an outcome: done or blocked.",
  started:
    "Work on it now, then call ocw_task_continue with your progress and next step before this turn ends, or " +
    "ocw_task_finish when it is done.",
  quiet: "Your reply this turn is not posted (the task card shows your progress), so keep it to one line.",
  finished_done: "Task finished. Tell the person the result.",
  finished_blocked: "Task ended as blocked. Tell the person what you need from them to go on.",
} as const;

type Params = Record<string, unknown>;
const asParams = (params: unknown): Params =>
  params && typeof params === "object" && !Array.isArray(params) ? (params as Params) : {};

const START_KEYS: ReadonlySet<string> = new Set(["goal"]);
const CONTINUE_KEYS: ReadonlySet<string> = new Set(["progress", "nextStep", "afterSeconds", "waitFor"]);
const FINISH_KEYS: ReadonlySet<string> = new Set(["summary", "outcome"]);

type Built<T> = { body: T } | { error: string; code: string };
type TurnIds = { eventId: string; agentId: string };

const extraKeys = (p: Params, keys: ReadonlySet<string>) => Object.keys(p).some((k) => !keys.has(k));
const bad = (error: string, code = "bad_params") => ({ error, code });
/** A model may send `null` for an optional field it does not use: the same as leaving it out. */
const present = (v: unknown) => v !== undefined && v !== null;

/** The start body, or why the params are invalid (checked locally; the API re-validates everything). */
export function taskStartOf(t: TurnIds, p: Params): Built<AgentChannelTaskStart> {
  if (extraKeys(p, START_KEYS)) return bad(TASK_TOOL_SENTENCES.extra_keys, "extra_keys");
  const goal = TaskGoal.safeParse(p.goal);
  if (!goal.success) return bad(TASK_TOOL_SENTENCES.bad_goal);
  const body = AgentChannelTaskStart.safeParse({ eventId: t.eventId, agentId: t.agentId, goal: goal.data });
  return body.success ? { body: body.data } : bad(TASK_TOOL_SENTENCES.bad_goal);
}

/** The continue body, or why the params are invalid. */
export function taskContinueOf(t: TurnIds, p: Params): Built<AgentChannelTaskContinue> {
  if (extraKeys(p, CONTINUE_KEYS)) return bad(TASK_TOOL_SENTENCES.extra_keys, "extra_keys");
  const progress = TaskNote.safeParse(p.progress);
  const nextStep = TaskNote.safeParse(p.nextStep);
  if (!progress.success || !nextStep.success) return bad(TASK_TOOL_SENTENCES.bad_notes);
  const after = p.afterSeconds;
  if (
    present(after) &&
    !(
      typeof after === "number" &&
      Number.isInteger(after) &&
      after >= 0 &&
      after <= BOT_TASK_LIMITS.afterSecondsMax
    )
  ) {
    return bad(TASK_TOOL_SENTENCES.bad_wait);
  }
  const waitFor = present(p.waitFor) ? TaskWaitFor.safeParse(p.waitFor) : undefined;
  if (waitFor && !waitFor.success) return bad(TASK_TOOL_SENTENCES.bad_wait_for);
  const body = AgentChannelTaskContinue.safeParse({
    eventId: t.eventId,
    agentId: t.agentId,
    progress: progress.data,
    nextStep: nextStep.data,
    ...(present(after) ? { afterSeconds: after } : {}),
    ...(waitFor?.success ? { waitFor: waitFor.data } : {}),
  });
  return body.success ? { body: body.data } : bad(TASK_TOOL_SENTENCES.bad_notes);
}

/** The finish body, or why the params are invalid. */
export function taskFinishOf(t: TurnIds, p: Params): Built<AgentChannelTaskFinish> {
  if (extraKeys(p, FINISH_KEYS)) return bad(TASK_TOOL_SENTENCES.extra_keys, "extra_keys");
  const summary = TaskSummary.safeParse(p.summary);
  if (!summary.success || (p.outcome !== "done" && p.outcome !== "blocked")) {
    return bad(TASK_TOOL_SENTENCES.bad_finish);
  }
  const body = AgentChannelTaskFinish.safeParse({
    eventId: t.eventId,
    agentId: t.agentId,
    summary: summary.data,
    outcome: p.outcome,
  });
  return body.success ? { body: body.data } : bad(TASK_TOOL_SENTENCES.bad_finish);
}

const KNOWN_REFUSALS: ReadonlySet<string> = new Set(Object.keys(BOT_TASK_SENTENCES));

/** A refusal: the contracts' sentence for its code; for a code from a newer API, the API's own one-line sentence. */
function renderRefusal(code: string, sentence: string): TaskToolResult {
  const known = KNOWN_REFUSALS.has(code) ? BOT_TASK_SENTENCES[code as BotTaskRefusal] : undefined;
  return refused(known ?? approvalLabel(sentence, 300) ?? BOT_TASK_SENTENCES.not_in_turn, code);
}

/** A time the API composed, shown back on one line (the mirror keeps it a string). */
const shownTime = (value: string | null) => approvalLabel(value, 40);
const turnsLeft = (n: number) => (n === 1 ? "1 turn left" : `${n} turns left`);

export function renderTaskStart(r: AgentChannelTaskStartResponse): TaskToolResult {
  if (!r.ok) return renderRefusal(r.code, r.sentence);
  const until = shownTime(r.deadlineAt);
  return answer(
    `Task started: up to ${r.maxTurns} turns${until ? `, until ${until}` : ""}. ${TASK_TOOL_SENTENCES.started}`,
    { ok: true, taskId: r.taskId },
  );
}

const NEXT_PHRASES = {
  after_turn: "right after this one",
  on_process: "when the background command ends",
  on_session: "when the Work Zone session's turn ends",
} as const;

export function renderTaskContinue(r: AgentChannelTaskContinueResponse): TaskToolResult {
  if (!r.ok) return renderRefusal(r.code, r.sentence);
  const at = shownTime(r.at);
  const when = r.next === "at" ? (at ? `at ${at}` : "at the time you asked") : NEXT_PHRASES[r.next];
  const line = `Continue scheduled: your next turn starts ${when}; ${turnsLeft(r.turnsLeft)}.`;
  return answer(r.quiet ? `${line} ${TASK_TOOL_SENTENCES.quiet}` : line, {
    ok: true,
    next: r.next,
    quiet: r.quiet,
  });
}

export function renderTaskFinish(r: AgentChannelTaskFinishResponse): TaskToolResult {
  if (!r.ok) return renderRefusal(r.code, r.sentence);
  return answer(
    r.status === "done" ? TASK_TOOL_SENTENCES.finished_done : TASK_TOOL_SENTENCES.finished_blocked,
    { ok: true, status: r.status },
  );
}

/** What a failed request tells the model: a refusal body, an ended turn, an answer it cannot read, or unreachable. */
function failureOf(error: unknown): { result: TaskToolResult; log: string } {
  if (error instanceof ZodError) {
    return { result: refused(TASK_TOOL_SENTENCES.unreadable, "unreadable"), log: "unreadable" };
  }
  if (error instanceof AgentChannelHttpError) {
    const log = `${error.status}${error.code ? ` ${error.code}` : ""}`;
    if (error.answer?.code) return { result: renderRefusal(error.answer.code, error.answer.sentence), log };
    // An ended turn; a 404 without the code is an older API without the route (the unreachable sentence below).
    if (
      (error.status === 404 && error.code === "unknown_turn") ||
      (error.status === 403 && error.code === "no_trigger")
    ) {
      return { result: refused(TASK_TOOL_SENTENCES.unknown_turn, "unknown_turn"), log };
    }
    return { result: refused(TASK_TOOL_SENTENCES.unreachable, "unreachable"), log };
  }
  const kind = error instanceof Error ? error.name : "error";
  return {
    result: refused(TASK_TOOL_SENTENCES.unreachable, "unreachable"),
    log: /^[A-Za-z]{1,40}$/u.test(kind) ? kind : "error",
  };
}

const str = (min: number, max: number, description: string) => ({
  type: "string",
  minLength: min,
  maxLength: max,
  description,
});

type Spec<T> = {
  name: (typeof TASK_TOOL_NAMES)[number];
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  build: (t: TurnIds, p: Params) => Built<T>;
  call: (client: AgentChannelClient, body: T, signal?: AbortSignal) => Promise<TaskToolResult>;
  /** Whether this tool already succeeded on the turn. */
  done: (t: ActiveTurn) => boolean;
};

/** What the log shows of an answer: its codes and counts, never the bot's text. */
function logOf(r: TaskToolResult): string {
  const d = r.details;
  if (!d.ok) return `refused (${d.code ?? "refused"})`;
  if (d.taskId) return `answered (task ${d.taskId})`;
  if (d.next) return `answered (next ${d.next}, quiet ${d.quiet === true})`;
  return `answered (status ${d.status ?? "?"})`;
}

const START: Spec<AgentChannelTaskStart> = {
  name: TASK_START_TOOL,
  label: "Start task",
  description:
    "Start a long task in this thread with a one-line goal when the request needs more work than one turn, then " +
    "keep working and call ocw_task_continue before this turn ends.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      goal: str(1, BOT_TASK_LIMITS.goalChars, "What the task will achieve, in one line."),
    },
    required: ["goal"],
  },
  build: taskStartOf,
  call: async (client, body, signal) => renderTaskStart(await client.taskStart(body, signal)),
  done: (t) => t.task.started,
};

const CONTINUE: Spec<AgentChannelTaskContinue> = {
  name: TASK_CONTINUE_TOOL,
  label: "Continue task",
  description:
    "Schedule your task's next turn with your progress and next step: it starts by itself right after this turn, " +
    "after afterSeconds, or when the background command or Work Zone session in waitFor ends, so you never ask the " +
    "person whether to continue.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      progress: str(1, BOT_TASK_LIMITS.noteChars, "What is done so far, in one line (your own note)."),
      nextStep: str(1, BOT_TASK_LIMITS.noteChars, "What your next turn does first, in one line."),
      afterSeconds: {
        type: "integer",
        minimum: 0,
        maximum: BOT_TASK_LIMITS.afterSecondsMax,
        description: "Wait this many seconds before the next turn (leave it out to go on right away).",
      },
      waitFor: {
        type: "object",
        additionalProperties: false,
        description:
          "Wait for exactly one of a background command (processId) or a Work Zone session (workSessionId) this " +
          "task started, instead of polling.",
        properties: {
          processId: {
            type: "string",
            maxLength: 64,
            description: "The id ocw_sandbox_exec gave a background run.",
          },
          workSessionId: { type: "string", maxLength: 64, description: "A Work Zone session you started." },
        },
      },
    },
    required: ["progress", "nextStep"],
  },
  build: taskContinueOf,
  call: async (client, body, signal) => renderTaskContinue(await client.taskContinue(body, signal)),
  done: (t) => t.task.continued,
};

const FINISH: Spec<AgentChannelTaskFinish> = {
  name: TASK_FINISH_TOOL,
  label: "Finish task",
  description:
    "End your task with a short summary: outcome done when the work is complete, or blocked when you need the " +
    "person to go on.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: str(1, BOT_TASK_LIMITS.summaryChars, "What was done, or what you need from the person."),
      outcome: { type: "string", enum: ["done", "blocked"], description: "done, or blocked." },
    },
    required: ["summary", "outcome"],
  },
  build: taskFinishOf,
  call: async (client, body, signal) => renderTaskFinish(await client.taskFinish(body, signal)),
  done: (t) => t.task.finished,
};

function taskTool<T>(spec: Spec<T>, deps: Deps, ctx: TaskToolContext): OpenClawAgentTool {
  const { name } = spec;
  return {
    name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    async execute(_toolCallId, params, signal) {
      const t = deps.guard.findTurn(ctx);
      if (!t) return refused(TASK_TOOL_SENTENCES.no_turn, "no_turn");
      // Already succeeded this turn (the gate refuses the second call first; this holds without it too).
      if (spec.done(t)) return refused(BOT_TASK_SENTENCES.once_per_turn, "once_per_turn");
      const result = await run(t);
      deps.guard.taskCallEnded(
        t,
        name,
        result.details.ok
          ? { ok: true, quiet: result.details.quiet }
          : { ok: false, code: result.details.code ?? "refused" },
      );
      return result;

      async function run(turn: ActiveTurn): Promise<TaskToolResult> {
        if (!turn.turn.tools.includes(name)) return refused(BOT_TASK_SENTENCES.not_in_turn, "not_in_turn");
        const built = spec.build(turn, asParams(params));
        if ("error" in built) return refused(built.error, built.code);
        const client = deps.client();
        if (!client) return refused(TASK_TOOL_SENTENCES.unreachable, "unreachable");
        try {
          const r = await spec.call(client, built.body, signal);
          const line = `${name}: ${turn.eventId} ${logOf(r)}`;
          if (r.details.ok) deps.logger?.info?.(line);
          else deps.logger?.warn?.(line);
          return r;
        } catch (error) {
          const failure = failureOf(error);
          deps.logger?.warn?.(`${name}: ${turn.eventId} failed (${failure.log})`);
          return failure.result;
        }
      }
    },
  };
}

export function registerTaskTools(api: OpenClawPluginApi, deps: Deps): void {
  api.registerTool((ctx: TaskToolContext) => taskTool(START, deps, ctx), { name: START.name });
  api.registerTool((ctx: TaskToolContext) => taskTool(CONTINUE, deps, ctx), { name: CONTINUE.name });
  api.registerTool((ctx: TaskToolContext) => taskTool(FINISH, deps, ctx), { name: FINISH.name });
}
