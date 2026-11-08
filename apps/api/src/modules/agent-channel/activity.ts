import { randomUUID } from "node:crypto";
import {
  type ActivityStep,
  type ActivityVerb,
  type BotTurnActivity,
  EphemeralTypes,
  SANDBOX_LIMITS,
  type TurnActivityEvent,
} from "@ocw/contracts";
import { botTurnActivity, messages, orgMembers, type Tx, tenantOf } from "@ocw/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Core } from "../../core";
import { convTopic } from "../chat";
import { cut, maskForDisplay } from "../tool-approval";
import type { AgentTurnRow } from "./claim";

/**
 * A bot turn's activity (07.8-10; R2, UI-SPEC Surface 5; T-07.8-10-01/03; WINDOWS #168). The API composes one step per
 * confined call it decided (allowed or refused) from the call's own input and outcome: never from model text. Every
 * string is masked before it is stored or sent: URLs become their host, `/workspace/` paths become relative, the value
 * of every `NAME=value` environment assignment is hidden, and 07.5's `maskForDisplay` hides secret-looking values. Exec
 * shows its masked command and the last 20 lines (at most 4 KB) of its output; typed text, file content and page text
 * are never part of a step.
 *
 * Steps live in `app.bot_turn_activity` (one row per turn, at most 50 steps, the rest counted in `more`). While the turn
 * runs, each change is published as the ephemeral `turn.activity` on the conversation's topic, so only the readers the
 * realtime gateway authorized for that topic receive it; once the bot replies, the reply message carries the activity
 * for every reader (`chat/activity.ts` `withActivity`).
 */

const MASK = "••••";
/** `scheme://[user@]host[:port]/path?query#frag` → the host (with its port). */
const URL_RE = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^\s/?#@'"]*@)?([^\s/?#'"]+)[^\s'"]*/g;
/** `/workspace/…` (the bot's workspace root inside its sandbox) → relative. */
const WORKSPACE_RE = /(^|[\s'"=:(])\/workspace(?:\/|(?=$|[\s'")]))/g;
/** `NAME=value` with an environment-style name: the value is never shown. */
const ENV_RE = /\b([A-Z_][A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s'"]*)/g;
const OUTPUT_LINES = 20;
const COMMAND_MAX = 2000;
const TARGET_MAX = 200;
const PHRASE_MAX = 80;

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

/** A text as an activity step may show it (see the file comment). Pure. */
export function maskActivityText(text: string): string {
  const step1 = text
    .replace(URL_RE, (_m, host: string) => host)
    .replace(WORKSPACE_RE, (_m, lead: string) => lead)
    .replace(ENV_RE, (_m, name: string) => `${name}=${MASK}`);
  return maskForDisplay(step1).text;
}

/** A workspace path as shown: relative (never a leading `/`), masked; the root reads "workspace". */
function displayPath(raw: unknown): string {
  const path = typeof raw === "string" ? raw : "";
  const relative = path.replace(/^\/workspace(?:\/|$)/, "").replace(/^\/+/, "");
  return relative === "" ? "workspace" : cut(maskActivityText(relative).replace(/^\/+/, ""), TARGET_MAX);
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** One argv as a person reads it: shell-quoted where needed, then masked, at most 2,000 characters. */
function commandOf(argv: unknown): string {
  const list = Array.isArray(argv) ? argv.filter((a): a is string => typeof a === "string") : [];
  const quoted = list.map((a) =>
    a === "" || /[\s'"\\$`;&|<>(){}*?!#~]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a,
  );
  return cut(maskActivityText(quoted.join(" ")), COMMAND_MAX);
}

/** The last 20 lines of stdout then stderr, masked, at most 4 KB (the oldest lines go first). */
function outputTailOf(stdout: unknown, stderr: unknown): string {
  const out = typeof stdout === "string" ? stdout : "";
  const err = typeof stderr === "string" ? stderr : "";
  const joined = err ? `${out}${out && !out.endsWith("\n") ? "\n" : ""}${err}` : out;
  // The trailing newlines go by a scan from the end: `/\n+$/` rescans a newline run from every start position, so
  // output of newlines then one character blocked the event loop for seconds.
  let end = joined.length;
  while (end > 0 && joined.charCodeAt(end - 1) === 10) end--;
  let lines = joined.slice(0, end).split("\n").slice(-OUTPUT_LINES);
  lines = maskActivityText(lines.join("\n")).split("\n");
  while (lines.length > 1 && utf8(lines.join("\n")) > SANDBOX_LIMITS.activityOutputBytes) lines.shift();
  let tail = lines.join("\n");
  while (utf8(tail) > SANDBOX_LIMITS.activityOutputBytes)
    tail = tail.slice(Math.ceil((tail.length - 1) / 8) || 1);
  return tail;
}

export interface StepOutcomeInput {
  kind: ActivityStep["outcome"]["kind"];
  /** A `SandboxRefusal`, approval or sandboxd code. */
  code?: string | null;
  durationMs?: number | null;
  /** What the call returned (exec/process: `status`, `exitCode`, `stdout`, `stderr`; share: `name`; write: `size`). */
  result?: Record<string, unknown> | null;
  /** 07.8-14 (WINDOWS #245): the approval card's permalink of a step waiting for a person ("Needs approval →"). */
  approvalMessageRoute?: string | null;
}

/** 07.8-14 (UI-SPEC Surface 5): the browser verbs; `ocw_browser_act`'s depends on its action. */
const BROWSER_VERBS: Record<string, ActivityVerb> = {
  ocw_browser_open: "opened",
  ocw_browser_snapshot: "read_page",
  ocw_browser_screenshot: "screenshot",
  ocw_browser_wait: "waited",
  ocw_browser_signin: "asked_signin",
  ocw_browser_close: "closed",
};

const ACT_VERBS: Record<string, ActivityVerb> = {
  click: "clicked",
  type: "typed",
  select: "chose",
  press: "pressed",
  scroll: "scrolled",
};

/** A host as a step shows it (a host only: anything else reads "a page"). */
function displayHost(raw: unknown): string {
  const h = typeof raw === "string" ? raw.toLowerCase() : "";
  return /^[a-z0-9.\-[\]:]{1,260}$/.test(h) ? h : "a page";
}

/** Page text or a model-chosen option as a step shows it: one line, masked, quoted, at most 80 characters. */
function quoted(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const one = maskActivityText(raw.replace(/\s+/g, " ").trim());
  return one ? `“${cut(one, 80)}”` : null;
}

/**
 * The target of a browser step (UI-SPEC Surface 5): the host, and for an action the element's name (page text, masked)
 * or the key or option. Never the typed text, a URL path or query, or page content.
 */
function browserTarget(tool: string, input: Record<string, unknown>): string {
  const host = displayHost(input.host);
  if (tool !== "ocw_browser_act") return host;
  const name = quoted(input.elementName);
  switch (input.action) {
    case "click":
    case "type":
      return name ? `${name} on ${host}` : host;
    case "select": {
      const option = quoted(input.option);
      return option ? `${option} on ${host}` : name ? `${name} on ${host}` : host;
    }
    case "press": {
      const key = typeof input.key === "string" ? maskActivityText(input.key).slice(0, 32) : "";
      return key ? `${key} on ${host}` : host;
    }
    default:
      return host;
  }
}

const SANDBOX_VERBS: Record<string, ActivityVerb> = {
  ocw_sandbox_exec: "ran",
  ocw_sandbox_read: "read",
  ocw_sandbox_list: "listed",
  ocw_sandbox_write: "wrote",
  ocw_sandbox_delete: "deleted",
  ocw_sandbox_share: "shared",
  ocw_sandbox_import: "imported",
};

/**
 * The step of one confined sandbox call, from its input (the request body the API validated) and its outcome. Pure;
 * the browser steps are added by 07.8-14.
 */
export function stepFor(
  tool: string,
  input: Record<string, unknown>,
  outcome: StepOutcomeInput,
  opts: { id?: string; signedIn?: boolean; contextId?: string | null } = {},
): ActivityStep {
  const result = outcome.result ?? null;
  let verb: ActivityVerb =
    tool === "ocw_sandbox_process"
      ? input.action === "kill"
        ? "stopped_process"
        : "checked_process"
      : tool === "ocw_browser_act"
        ? (ACT_VERBS[String(input.action)] ?? "clicked")
        : (SANDBOX_VERBS[tool] ?? BROWSER_VERBS[tool] ?? "blocked");
  let kind = outcome.kind;
  let exitCode: number | null = null;
  if (result && (tool === "ocw_sandbox_exec" || tool === "ocw_sandbox_process") && kind === "ok") {
    if (result.status === "running") kind = "running";
    else if (typeof result.exitCode === "number") {
      exitCode = Math.trunc(result.exitCode);
      if (exitCode !== 0) kind = "error";
    }
  }
  if (kind === "blocked") verb = "blocked";

  let target: string;
  let details: ActivityStep["details"] = null;
  switch (tool) {
    case "ocw_sandbox_exec": {
      const command = commandOf(input.argv);
      target = cut(command.split("\n")[0] ?? "", TARGET_MAX);
      details = {
        command,
        ...(typeof input.cwd === "string" && input.cwd !== "" ? { cwd: displayPath(input.cwd) } : {}),
        ...(exitCode !== null ? { exitCode } : {}),
        ...(result ? { outputTail: outputTailOf(result.stdout, result.stderr) } : {}),
      };
      break;
    }
    case "ocw_sandbox_process":
      target = "a running command";
      details = exitCode !== null ? { exitCode } : null;
      break;
    case "ocw_sandbox_write": {
      const path = displayPath(input.path);
      const size =
        typeof result?.size === "number"
          ? result.size
          : typeof input.content === "string"
            ? utf8(input.content)
            : null;
      target = kind === "ok" && size !== null ? `${path} · ${formatSize(size)}` : path;
      break;
    }
    case "ocw_sandbox_share": {
      const name =
        typeof result?.name === "string"
          ? result.name
          : (displayPath(input.path).split("/").at(-1) ?? "workspace");
      target = cut(maskActivityText(name), TARGET_MAX);
      break;
    }
    default:
      target = tool.startsWith("ocw_browser_") ? browserTarget(tool, input) : displayPath(input.path);
  }

  return {
    id: opts.id ?? randomUUID(),
    tool,
    verb,
    target: cut(target, TARGET_MAX),
    outcome: {
      kind,
      code: outcome.code ?? null,
      exitCode,
      durationMs: typeof outcome.durationMs === "number" ? Math.max(0, Math.trunc(outcome.durationMs)) : null,
    },
    signedIn: opts.signedIn === true,
    contextId: opts.contextId ?? null,
    approvalMessageRoute: kind === "approval" ? (outcome.approvalMessageRoute ?? null) : null,
    details,
  };
}

/** 07.8-25 (F-8): why a browser download was not kept, as the step reads it. */
const DOWNLOAD_NOT_KEPT: Record<string, string> = {
  sandbox_off: "Download not kept: the sandbox is off",
  too_large: "Download not kept: the file is too large",
  busy: "Download not kept: no free name in downloads",
  service_unavailable: "Download not kept: it could not be saved",
};

/**
 * 07.8-25 (D-11 F-8, P-11): the step of a file the bot's browser downloaded during an act: `shared` with its name when
 * it became an attachment of the conversation, `imported` with its workspace path, or a blocked step that says why it
 * was not kept. Pure; never the file's content.
 */
export function downloadStep(
  d:
    | { stored: "conversation"; name: string }
    | { stored: "workspace"; path: string }
    | { stored: null; reason: string },
  opts: { signedIn?: boolean; contextId?: string | null } = {},
): ActivityStep {
  const verb: ActivityVerb =
    d.stored === "conversation" ? "shared" : d.stored === "workspace" ? "imported" : "blocked";
  const target =
    d.stored === "conversation"
      ? cut(maskActivityText(d.name), TARGET_MAX)
      : d.stored === "workspace"
        ? displayPath(d.path)
        : (DOWNLOAD_NOT_KEPT[d.reason] ?? DOWNLOAD_NOT_KEPT.service_unavailable ?? "Download not kept");
  return {
    id: randomUUID(),
    tool: "ocw_browser_act",
    verb,
    target,
    outcome: {
      kind: d.stored === null ? "blocked" : "ok",
      code: d.stored === null ? d.reason.slice(0, 64) : null,
      exitCode: null,
      durationMs: null,
    },
    signedIn: opts.signedIn === true,
    contextId: opts.contextId ?? null,
    approvalMessageRoute: null,
    details: null,
  };
}

const PHRASES: Partial<Record<ActivityVerb, (target: string) => string>> = {
  ran: (t) => `running ${t}`,
  checked_process: () => "checking a running command",
  stopped_process: () => "stopping a running command",
  read: (t) => `reading ${t}`,
  listed: (t) => `listing ${t}`,
  wrote: (t) => `writing ${t}`,
  deleted: (t) => `deleting ${t}`,
  shared: (t) => `sharing ${t}`,
  imported: (t) => `importing ${t}`,
  opened: (t) => `opening ${t}`,
  read_page: (t) => `reading the page on ${t}`,
  screenshot: (t) => `taking a screenshot of ${t}`,
  clicked: (t) => `clicking ${t}`,
  typed: (t) => `typing into ${t}`,
  chose: (t) => `choosing ${t}`,
  pressed: (t) => `pressing ${t}`,
  scrolled: (t) => `scrolling on ${t}`,
  waited: (t) => `waiting for ${t}`,
  closed: (t) => `closing ${t}`,
};

/** What the bot does now, for the live label ("Scout is writing reports/late.csv"), at most 80 characters. */
export function currentPhrase(step: ActivityStep): string {
  const phrase = PHRASES[step.verb];
  const target = step.target.split(" · ")[0] ?? step.target;
  return phrase ? cut(phrase(target), PHRASE_MAX) : "";
}

/** A step added to (or, by id, updated in) a turn's stored steps: at most 50, the rest counted in `more`. Pure. */
export function mergeStep(
  state: { steps: ActivityStep[]; more: number },
  step: ActivityStep,
): { steps: ActivityStep[]; more: number } {
  const at = state.steps.findIndex((s) => s.id === step.id);
  if (at >= 0) {
    const steps = [...state.steps];
    steps[at] = step;
    return { steps, more: state.more };
  }
  if (state.steps.length < SANDBOX_LIMITS.activityStepsMax) {
    return { steps: [...state.steps, step], more: state.more };
  }
  return { steps: state.steps, more: state.more + 1 };
}

/**
 * Records (or updates, by id) one step of the turn in the caller's transaction, opened as the turn's human, and
 * publishes the turn's activity as `turn.activity` on the conversation's topic after the commit. `current` is the live
 * phrase while the call is in flight (null once it finished).
 */
export async function recordStep(
  tx: Tx,
  core: Pick<Core, "realtime" | "log">,
  p: { turn: AgentTurnRow; step: ActivityStep; inFlight?: boolean },
): Promise<BotTurnActivity> {
  const { turn } = p;
  const [trigger] = await tx
    .select({ threadId: messages.threadId })
    .from(messages)
    .where(eq(messages.id, turn.messageId))
    .limit(1);
  const threadRootMessageId = trigger?.threadId ?? null;
  await tx
    .insert(botTurnActivity)
    .values({
      eventId: turn.eventId,
      organizationId: turn.organizationId,
      agentId: turn.agentId,
      conversationId: turn.conversationId,
      threadRootMessageId,
    })
    .onConflictDoNothing();
  const [row] = await tx
    .select()
    .from(botTurnActivity)
    .where(eq(botTurnActivity.eventId, turn.eventId))
    .for("update");
  if (!row) throw new Error("bot_turn_activity row missing");
  const merged = mergeStep({ steps: row.steps as ActivityStep[], more: row.more }, p.step);
  const running = row.replyMessageId === null;
  await tx
    .update(botTurnActivity)
    .set({ steps: merged.steps, more: merged.more, running, updatedAt: new Date().toISOString() })
    .where(eq(botTurnActivity.eventId, turn.eventId));
  // WINDOWS #265 (07.8-21): who the bot acts for, so sign-in and paused rows say "Asked you" / "Asked Sam".
  const [asker] = await tx
    .select({ name: orgMembers.displayName })
    .from(orgMembers)
    .where(eq(orgMembers.userId, turn.userId))
    .limit(1);
  const activity: BotTurnActivity = {
    eventId: turn.eventId,
    steps: merged.steps,
    more: merged.more,
    running,
    current: running && p.inFlight ? currentPhrase(p.step) || null : null,
    requester: { id: turn.userId, displayName: (asker?.name ?? "Former member").slice(0, 200) },
  };
  const event: TurnActivityEvent = {
    type: EphemeralTypes.turnActivity,
    conversationId: turn.conversationId,
    threadRootMessageId: row.threadRootMessageId,
    agentId: turn.agentId,
    activity,
  };
  // Ephemeral, after the commit: the realtime gateway delivers it only to the topic's authorized readers.
  tenantOf(tx).afterCommit(async () => {
    try {
      await core.realtime.publishEphemeral(
        convTopic(turn.conversationId),
        EphemeralTypes.turnActivity,
        event,
      );
    } catch (err) {
      core.log.warn({ err: { name: (err as Error)?.name } }, "turn.activity publish failed");
    }
  });
  return activity;
}

/**
 * The bot replied for this turn: its activity is attached to that reply (the first reply of the turn) and stops
 * running. Called in the reply's transaction before its `message.created` is appended. Returns whether a row was
 * attached.
 */
export async function finishActivity(
  tx: Tx,
  p: { eventId: string; replyMessageId: string },
): Promise<boolean> {
  const done = await tx
    .update(botTurnActivity)
    .set({ replyMessageId: p.replyMessageId, running: false, updatedAt: new Date().toISOString() })
    .where(and(eq(botTurnActivity.eventId, p.eventId), isNull(botTurnActivity.replyMessageId)))
    .returning({ eventId: botTurnActivity.eventId });
  return done.length > 0;
}
