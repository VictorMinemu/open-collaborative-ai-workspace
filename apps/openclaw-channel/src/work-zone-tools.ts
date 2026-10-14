import type {
  OpenClawAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/channel-core";
import {
  type AgentChannelWorkZoneProjectsResponse,
  type AgentChannelWorkZonePropose,
  WORK_ZONE_PROPOSAL_LIMITS,
  WORK_ZONE_PROPOSAL_REFUSALS,
  WORK_ZONE_RUNTIMES,
  type WorkZoneProposalRefusal,
  type WorkZoneRuntime,
} from "./agent-channel-protocol.js";
import { type AgentChannelClient, AgentChannelHttpError } from "./api-client.js";
// tool-guard.ts imports `workZoneTaintedSentence` back (its taint block for ocw_start_work_zone). Both sides use the
// other's bindings only when a call runs, never while the modules load, so the cycle is harmless; keep it that way.
import { type ActiveTurn, approvalLabel, type ToolGuard } from "./tool-guard.js";

/**
 * The Work Zone proposal tools (07.5 D-03, C-01, APPROVE-03/04): a bot proposes a coding session and the person it acts
 * for starts it from a card. Nothing is created or started from the cell:
 *   - `ocw_work_zone_projects` lists the projects the turn's human may start a session on (device state, runtimes, ids),
 *   - `ocw_start_work_zone` posts `{projectId, deviceId, prompt, runtime?}` as a proposal.
 * Like the connector tools, each is a thin, credential-free caller of the Agent Channel API:
 *   - it resolves the active OCW turn from the trusted tool context and refuses locally without one, or when the turn
 *     does not offer the tool,
 *   - it posts only the turn's event and agent with the tool's own fields (never a user: the API takes the human from
 *     the stored turn; never a mode: the session starts supervised and only the person may raise it),
 *   - it answers with fixed sentences (UI-SPEC R10), never the API's error body. Logs carry ids and codes only.
 * Both are validated by their own routes (never `/tool-calls`, tool-guard.ts `SELF_VALIDATED_TOOLS`).
 * `ocw_start_work_zone` cannot express a mode: its schema is closed (`additionalProperties: false`) and any key beyond
 * project, device, prompt and runtime is refused here before a request (APPROVE-04). It is always side-effecting: on a
 * turn that read untrusted content the gate refuses it first (tool-guard.ts `ALWAYS_SIDE_EFFECTING`), the tool refuses
 * it again, and the API refuses `tainted` too. The list is read-only and stays available on such a turn.
 */

export const WORK_ZONE_PROJECTS_TOOL = "ocw_work_zone_projects";
export const START_WORK_ZONE_TOOL = "ocw_start_work_zone";
export const WORK_ZONE_TOOL_NAMES = [WORK_ZONE_PROJECTS_TOOL, START_WORK_ZONE_TOOL] as const;
export type WorkZoneToolName = (typeof WORK_ZONE_TOOL_NAMES)[number];

export type WorkZoneToolContext = Pick<
  OpenClawPluginToolContext,
  "sessionKey" | "nativeChannelId" | "agentId"
>;

type Logger = { info?: (m: string) => void; warn?: (m: string) => void };
type Deps = { guard: ToolGuard; client: () => AgentChannelClient | null; logger?: Logger };

/** The names a sentence uses; each falls back to a neutral phrase. */
type Names = { requester?: string; project?: string; device?: string; runtime?: string };

const ASKER = "the person who asked";
const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const asker = (n: Names) => n.requester ?? ASKER;
const deviceOf = (n: Names) => n.device ?? "that device";

/**
 * What the model reads (UI-SPEC "Refusals that never create a card", R10): one fixed sentence per outcome, with the
 * names the workspace gave (sanitized) or neutral fallbacks. Never the API's text.
 */
export const WORK_ZONE_SENTENCES = {
  success: (n: Names) =>
    `I proposed a session in ${n.project ?? "that project"} on ${deviceOf(n)}. ` +
    `${capitalized(asker(n))} can start it from the card.`,
  tainted: (n: Names) =>
    "I can't propose a Work Zone session after reading outside content in this turn. " +
    `Tell ${asker(n)} to ask again in a new message.`,
  device_offline: (n: Names) =>
    `${capitalized(deviceOf(n))} is offline, so I can't propose a session there. ` +
    `Tell ${asker(n)} and suggest another device or trying later.`,
  runtime_unavailable: (n: Names) =>
    `${n.runtime ?? "The runtime"} isn't installed or signed in on ${deviceOf(n)}. ` +
    `Tell ${asker(n)} to sign in on that device first.`,
  project_not_found: (n: Names) =>
    `That project doesn't exist any more or isn't on ${deviceOf(n)}. ` +
    "Call ocw_work_zone_projects to see the current list.",
  device_not_shared: (n: Names) =>
    `${capitalized(asker(n))} can't use ${deviceOf(n)}. Pick a device from ocw_work_zone_projects.`,
  not_allowed: (n: Names) =>
    `${capitalized(asker(n))} can't start Work Zone sessions. Tell them an admin can change that.`,
  too_many_pending: (n: Names) =>
    `${capitalized(asker(n))} already has ${WORK_ZONE_PROPOSAL_LIMITS.pendingPerRequester} Work Zone proposals ` +
    "waiting. Ask them to start or dismiss those first.",
  prompt_not_allowed: (n: Names) =>
    `I can't propose that prompt: it is a session command, not a task. Ask ${asker(n)} what to do instead.`,
  unknown_turn: () => "This conversation turn is no longer active.",
  not_in_turn: () => "Work Zone sessions are not available on this turn.",
  cap_reached: () => "This turn reached its limit of tool calls.",
  no_turn: () => "There is no active conversation turn, so I can't use this tool now.",
  extra_keys: () => "That tool only takes a project, a device, a prompt and a runtime.",
  unreachable: () => "The workspace didn't answer. Try again in a moment.",
} as const satisfies Record<
  WorkZoneProposalRefusal | "success" | "no_turn" | "extra_keys" | "unreachable",
  (n: Names) => string
>;

/** The outcomes whose sentence names the project, the device or the runtime (read from the turn's project list). */
const NAMES_PROJECT: ReadonlySet<string> = new Set([
  "success",
  "device_offline",
  "runtime_unavailable",
  "project_not_found",
  "device_not_shared",
]);

/** The turn's requester (already sanitized by the mapper) through the gate's label rule, or the neutral fallback. */
function requesterOf(name: string | undefined): Names {
  const requester = approvalLabel(name);
  return requester ? { requester } : {};
}

/** The gate's refusal of a proposal on a tainted turn (tool-guard.ts), the same sentence the tool and the API give. */
export function workZoneTaintedSentence(requesterName?: string): string {
  return WORK_ZONE_SENTENCES.tainted(requesterOf(requesterName));
}

const REFUSAL_SET: ReadonlySet<string> = new Set(WORK_ZONE_PROPOSAL_REFUSALS);
const isRefusal = (code: string | undefined): code is WorkZoneProposalRefusal =>
  code !== undefined && REFUSAL_SET.has(code);

/** The refusal code of a failed request: the API's code when it is one, an ended turn, else unreachable. */
function failureCode(error: unknown): WorkZoneProposalRefusal | "unreachable" {
  if (error instanceof AgentChannelHttpError) {
    if (isRefusal(error.code)) return error.code;
    if (error.status === 404 || (error.status === 403 && error.code === "no_trigger")) return "unknown_turn";
  }
  return "unreachable";
}

export type WorkZoneToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { ok: boolean; code?: string };
};

const answer = (text: string, ok: boolean, code?: string): WorkZoneToolResult => ({
  content: [{ type: "text", text }],
  details: code ? { ok, code } : { ok },
});

type Project = AgentChannelWorkZoneProjectsResponse["projects"][number];

/** The projects answer of each turn (names for the sentences), dropped with the turn. */
const projectsByTurn = new WeakMap<ActiveTurn, Project[]>();

/** A project, device or runtime name from the API (people chose it): one bounded line, no structural characters. */
const label = (value: string, max = 80) => approvalLabel(value, max);

/** The turn, the client, or a local refusal (no turn / the tool not offered / no client). */
function turnFor(
  name: WorkZoneToolName,
  deps: Deps,
  ctx: WorkZoneToolContext,
): { turn: ActiveTurn; client: AgentChannelClient } | { refused: WorkZoneToolResult } {
  const t = deps.guard.findTurn(ctx);
  if (!t) return { refused: answer(WORK_ZONE_SENTENCES.no_turn(), false, "no_turn") };
  if (!t.turn.tools.includes(name)) {
    return { refused: answer(WORK_ZONE_SENTENCES.not_in_turn(), false, "not_in_turn") };
  }
  const client = deps.client();
  if (!client) return { refused: answer(WORK_ZONE_SENTENCES.unreachable(), false, "unreachable") };
  return { turn: t, client };
}

/** The turn's projects: the cached answer, else one read (best effort; a failure leaves the neutral names). */
async function projectsOf(
  t: ActiveTurn,
  client: AgentChannelClient,
  signal?: AbortSignal,
): Promise<Project[]> {
  const cached = projectsByTurn.get(t);
  if (cached) return cached;
  try {
    const r = await client.listWorkZoneProjects({ eventId: t.eventId, agentId: t.agentId }, signal);
    projectsByTurn.set(t, r.projects);
    return r.projects;
  } catch {
    projectsByTurn.set(t, []);
    return [];
  }
}

/** Runtime labels when the list does not name one (contracts' runtimes). */
const RUNTIME_LABELS: Record<WorkZoneRuntime, string> = { "claude-code": "Claude Code", codex: "Codex" };

async function namesFor(
  outcome: string,
  t: ActiveTurn,
  client: AgentChannelClient,
  p: { projectId: string; deviceId: string; runtime?: WorkZoneRuntime },
  signal?: AbortSignal,
): Promise<Names> {
  if (!NAMES_PROJECT.has(outcome)) return requesterOf(t.requesterName);
  const projects = await projectsOf(t, client, signal);
  const project = projects.find((x) => x.projectId === p.projectId && x.device.id === p.deviceId);
  const device = project?.device ?? projects.find((x) => x.device.id === p.deviceId)?.device;
  const listed = p.runtime ? project?.runtimes.find((r) => r.id === p.runtime)?.label : undefined;
  const runtime = p.runtime ? ((listed && label(listed, 60)) ?? RUNTIME_LABELS[p.runtime]) : undefined;
  const projectName = project ? label(project.name) : undefined;
  const deviceName = device ? label(device.name) : undefined;
  return {
    ...requesterOf(t.requesterName),
    ...(projectName ? { project: projectName } : {}),
    ...(deviceName ? { device: deviceName } : {}),
    ...(runtime ? { runtime } : {}),
  };
}

/** One line per project for the model: names, device state, ready runtimes and the ids to propose with. */
export function renderWorkZoneProjects(projects: readonly Project[]): string {
  if (projects.length === 0) return "No projects you can start sessions on.";
  const lines = [
    "Projects you can propose a Work Zone session in (call ocw_start_work_zone with the projectId and deviceId):",
  ];
  for (const p of projects.slice(0, 50)) {
    const runtimes = p.runtimes
      .slice(0, 4)
      .map((r) => {
        const name = label(r.label, 60) ?? "unknown runtime";
        return r.available ? name : `${name} (not signed in)`;
      })
      .join(", ");
    lines.push(
      `- ${label(p.name) ?? "unnamed project"} on ${label(p.device.name) ?? "unnamed device"} ` +
        `(${p.device.online ? "online" : "offline"}): ${runtimes || "no runtime ready"} ` +
        `[projectId ${p.projectId}, deviceId ${p.device.id}]`,
    );
  }
  return lines.join("\n");
}

const asParams = (params: unknown): Record<string, unknown> =>
  params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {};

const PROJECTS_DESCRIPTION =
  "List the projects where you can propose a Work Zone coding session for the person you are talking to: each " +
  "project with its device, whether the device is online, its coding runtimes, and the ids ocw_start_work_zone needs.";

function projectsTool(deps: Deps, ctx: WorkZoneToolContext): OpenClawAgentTool {
  const name = WORK_ZONE_PROJECTS_TOOL;
  return {
    name,
    label: "List Work Zone projects",
    description: PROJECTS_DESCRIPTION,
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute(_toolCallId, _params, signal) {
      const found = turnFor(name, deps, ctx);
      if ("refused" in found) return found.refused;
      const { turn: t, client } = found;
      try {
        const r = await client.listWorkZoneProjects({ eventId: t.eventId, agentId: t.agentId }, signal);
        projectsByTurn.set(t, r.projects);
        deps.logger?.info?.(`${name}: ${r.projects.length} projects for ${t.eventId}`);
        return answer(renderWorkZoneProjects(r.projects), true);
      } catch {
        deps.logger?.warn?.(`${name}: ${t.eventId} failed`);
        return answer(WORK_ZONE_SENTENCES.unreachable(), false, "unreachable");
      }
    },
  };
}

const START_DESCRIPTION =
  "Propose a Work Zone coding session for the person you are talking to: a project and a device from " +
  "ocw_work_zone_projects, the task as the prompt, and optionally a runtime. Nothing runs until that person starts it " +
  "from the card it creates. You cannot choose permissions: the session starts supervised and only the person can " +
  "change that.";

const RUNTIME_SET: ReadonlySet<string> = new Set(WORK_ZONE_RUNTIMES);
/** Every key the tool takes: anything else (a mode, a model, full access, a user) is refused before a request. */
const START_KEYS: ReadonlySet<string> = new Set(["projectId", "deviceId", "prompt", "runtime"]);
/** An id as the API mints them (contracts `Id`, a UUID); the API re-validates. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The proposal body, or why the params are invalid (checked locally; the API re-validates everything). */
export function proposalOf(
  t: Pick<ActiveTurn, "eventId" | "agentId">,
  p: Record<string, unknown>,
): { body: AgentChannelWorkZonePropose } | { error: string; code: string } {
  if (Object.keys(p).some((k) => !START_KEYS.has(k))) {
    return { error: WORK_ZONE_SENTENCES.extra_keys(), code: "extra_keys" };
  }
  const projectId = typeof p.projectId === "string" ? p.projectId.trim() : "";
  const deviceId = typeof p.deviceId === "string" ? p.deviceId.trim() : "";
  if (!UUID.test(projectId) || !UUID.test(deviceId)) {
    return {
      error: "projectId and deviceId must be the ids from ocw_work_zone_projects. Call it to get them.",
      code: "bad_params",
    };
  }
  const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
  if (!prompt) return { error: "prompt must say what the session should do.", code: "bad_params" };
  if (prompt.length > WORK_ZONE_PROPOSAL_LIMITS.promptChars) {
    return { error: "prompt can be at most 50,000 characters.", code: "bad_params" };
  }
  if (p.runtime !== undefined && !(typeof p.runtime === "string" && RUNTIME_SET.has(p.runtime))) {
    return { error: "runtime must be claude-code or codex, or left out.", code: "bad_params" };
  }
  return {
    body: {
      eventId: t.eventId,
      agentId: t.agentId,
      projectId,
      deviceId,
      prompt,
      ...(p.runtime !== undefined ? { runtime: p.runtime as WorkZoneRuntime } : {}),
    },
  };
}

function startTool(deps: Deps, ctx: WorkZoneToolContext): OpenClawAgentTool {
  const name = START_WORK_ZONE_TOOL;
  return {
    name,
    label: "Propose a Work Zone session",
    description: START_DESCRIPTION,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: {
          type: "string",
          format: "uuid",
          description: "The projectId from ocw_work_zone_projects.",
        },
        deviceId: {
          type: "string",
          format: "uuid",
          description: "The deviceId from ocw_work_zone_projects.",
        },
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: WORK_ZONE_PROPOSAL_LIMITS.promptChars,
          description: "The task for the session, in plain words.",
        },
        runtime: {
          type: "string",
          enum: [...WORK_ZONE_RUNTIMES],
          description: "claude-code (Claude Code) or codex (Codex); omit it for the device's default.",
        },
      },
      required: ["projectId", "deviceId", "prompt"],
    },
    async execute(_toolCallId, params, signal) {
      const found = turnFor(name, deps, ctx);
      if ("refused" in found) return found.refused;
      const { turn: t, client } = found;
      const built = proposalOf(t, asParams(params));
      if ("error" in built) return answer(built.error, false, built.code);
      const { body } = built;
      // Always side-effecting (D-03): never from a turn that read untrusted content (the gate refused it already).
      if (t.tainted) {
        deps.logger?.warn?.(`${name}: ${t.eventId} refused (tainted, local)`);
        return answer(workZoneTaintedSentence(t.requesterName), false, "tainted");
      }
      let code: string;
      try {
        const r = await client.proposeWorkZone(body, signal);
        if (!("refused" in r)) {
          deps.logger?.info?.(`${name}: ${t.eventId} proposed (${r.approvalId}, created ${r.created})`);
          const names = await namesFor("success", t, client, body, signal);
          return answer(WORK_ZONE_SENTENCES.success(names), true);
        }
        code = r.refused;
      } catch (error) {
        code = failureCode(error);
      }
      // A code a newer API added (or a failure) is the generic sentence; logs carry known codes only.
      if (!isRefusal(code)) {
        deps.logger?.warn?.(
          `${name}: ${t.eventId} failed (${code === "unreachable" ? code : "unknown refusal"})`,
        );
        return answer(WORK_ZONE_SENTENCES.unreachable(), false, "unreachable");
      }
      deps.logger?.warn?.(`${name}: ${t.eventId} refused (${code})`);
      return answer(WORK_ZONE_SENTENCES[code](await namesFor(code, t, client, body, signal)), false, code);
    },
  };
}

export function registerWorkZoneTools(api: OpenClawPluginApi, deps: Deps): void {
  api.registerTool((ctx: WorkZoneToolContext) => projectsTool(deps, ctx), { name: WORK_ZONE_PROJECTS_TOOL });
  api.registerTool((ctx: WorkZoneToolContext) => startTool(deps, ctx), { name: START_WORK_ZONE_TOOL });
}
