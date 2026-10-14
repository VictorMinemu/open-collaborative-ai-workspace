import type {
  OpenClawAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/channel-core";
import {
  type AgentChannelWorkZoneProjectsResponse,
  type AgentChannelWorkZonePropose,
  WORK_ZONE_PROPOSAL_LIMITS,
  WORK_ZONE_RUNTIMES,
  type WorkZoneRuntime,
} from "./agent-channel-protocol.js";
import type { AgentChannelClient } from "./api-client.js";
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
type Names = { requester?: string; project?: string; device?: string };

const ASKER = "the person who asked";
const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What the model reads (UI-SPEC "Refusals that never create a card", R10). */
export const WORK_ZONE_SENTENCES = {
  success: (n: Names) =>
    `I proposed a session in ${n.project ?? "that project"} on ${n.device ?? "that device"}. ` +
    `${capitalized(n.requester ?? ASKER)} can start it from the card.`,
  no_turn: () => "There is no active conversation turn, so I can't use this tool now.",
  not_in_turn: () => "Work Zone sessions are not available on this turn.",
  unreachable: () => "The workspace didn't answer. Try again in a moment.",
} as const;

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

async function namesFor(
  t: ActiveTurn,
  client: AgentChannelClient,
  p: { projectId: string; deviceId: string },
  signal?: AbortSignal,
): Promise<Names> {
  const projects = await projectsOf(t, client, signal);
  const project = projects.find((x) => x.projectId === p.projectId && x.device.id === p.deviceId);
  const device = project?.device ?? projects.find((x) => x.device.id === p.deviceId)?.device;
  return {
    ...(t.requesterName ? { requester: t.requesterName } : {}),
    ...(project ? { project: label(project.name) } : {}),
    ...(device ? { device: label(device.name) } : {}),
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
      const p = asParams(params);
      const found = turnFor(name, deps, ctx);
      if ("refused" in found) return found.refused;
      const { turn: t, client } = found;
      const runtime = typeof p.runtime === "string" && RUNTIME_SET.has(p.runtime) ? p.runtime : undefined;
      const body: AgentChannelWorkZonePropose = {
        eventId: t.eventId,
        agentId: t.agentId,
        projectId: String(p.projectId ?? ""),
        deviceId: String(p.deviceId ?? ""),
        prompt: typeof p.prompt === "string" ? p.prompt.trim() : "",
        ...(runtime ? { runtime: runtime as WorkZoneRuntime } : {}),
      };
      try {
        const r = await client.proposeWorkZone(body, signal);
        if ("refused" in r) {
          deps.logger?.warn?.(`${name}: ${t.eventId} refused (${r.refused})`);
          return answer(WORK_ZONE_SENTENCES.unreachable(), false, r.refused);
        }
        deps.logger?.info?.(`${name}: ${t.eventId} proposed (${r.approvalId}, created ${r.created})`);
        const names = await namesFor(t, client, body, signal);
        return answer(WORK_ZONE_SENTENCES.success(names), true);
      } catch {
        deps.logger?.warn?.(`${name}: ${t.eventId} failed`);
        return answer(WORK_ZONE_SENTENCES.unreachable(), false, "unreachable");
      }
    },
  };
}

export function registerWorkZoneTools(api: OpenClawPluginApi, deps: Deps): void {
  api.registerTool((ctx: WorkZoneToolContext) => projectsTool(deps, ctx), { name: WORK_ZONE_PROJECTS_TOOL });
  api.registerTool((ctx: WorkZoneToolContext) => startTool(deps, ctx), { name: START_WORK_ZONE_TOOL });
}
