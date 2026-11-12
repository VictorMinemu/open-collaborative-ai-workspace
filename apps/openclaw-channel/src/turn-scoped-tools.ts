/**
 * Tools the API offers only on some turns, decided per delivery from facts the cell-wide snapshot does not carry
 * (07.1-13, 07.5-10, 07.6-20). `ocw_board_card` is offered only on a board channel's turns (07.1-10), the two Work Zone
 * proposal tools only on turns whose human holds `work_session.create` (07.5-08), the two 07.6 tools and the 07.7 consult
 * tool only where their own rules hold (below), the 07.16 Work Zone session tools only to a bot with an active Work Zone
 * profile, the 07.17 open tool only on a fan-out automation's run turns, the 07.17.1.1.2 task tools only where the
 * bot may start or control its own long task, so `GET /cell` (the bot's tools in
 * any conversation, for no human) never lists them, while OpenClaw can only run a tool the bot's entry configures
 * (`alsoAllow`) and a turn may only narrow that list (`toolsAllow`).
 *
 * The plugin therefore configures them for every bot the API serves delivered-turn tools to (a non-disabled bot: its
 * snapshot always lists `ocw_agent_card`), and lets each turn decide: the run's `toolsAllow` is still
 * `turn.tools ∩ agent tools`, each tool refuses a turn that does not list it, and the API routes refuse
 * `not_in_turn`. Nothing here widens what any turn may do.
 */

export const BOARD_TOOL_NAME = "ocw_board_card";
/** 07.5-10: `ocw_work_zone_projects`, `ocw_start_work_zone` (work-zone-tools.ts `WORK_ZONE_TOOL_NAMES`). */
const WORK_ZONE_TOOLS = ["ocw_work_zone_projects", "ocw_start_work_zone"] as const;
/**
 * 07.6-20: `ocw_automation_propose` (offered by 07.6-12 to a human holding `automation.create`) and `ocw_record_update`
 * (offered by 07.6-14 only in the thread of a watched card): both decided per turn, never in `GET /cell`.
 */
const AUTOMATION_TOOLS = ["ocw_automation_propose", "ocw_record_update"] as const;
/**
 * 07.7 (D-08, ADR-0027): `ocw_consult_agent`, offered by 07.7-04 only on a channel turn below the chain's depth limit,
 * with at least one bot the `agent.message` decision allows, and never on a turn that starts tainted; never in `GET /cell`.
 */
export const CONSULT_TOOL_NAME = "ocw_consult_agent";
/**
 * 07.15 (PD-03): `ocw_attachment_read`, offered by 07.15-07 only on a delivered turn that lists at least one file it may
 * read (`access: "read"`) while object storage is configured; never in `GET /cell`.
 */
export const ATTACHMENT_TOOL_NAME = "ocw_attachment_read";
/**
 * 07.16 (D-05, PD-09, PD-17): the bot's own Work Zone session tools, offered only on the turns of a bot with an active
 * Work Zone profile (the API decides per delivery); never in `GET /cell`. Declared here, with no imports, because the
 * gate (tool-guard.ts) builds its sets from them while it loads (work-session-tools.ts imports the gate).
 */
export const WORK_SESSION_START_TOOL = "ocw_work_session_start";
export const WORK_SESSION_PROMPT_TOOL = "ocw_work_session_prompt";
export const WORK_SESSION_READ_TOOL = "ocw_work_session_read";
export const WORK_SESSION_STOP_TOOL = "ocw_work_session_stop";
/**
 * 07.17.1.1 (D-01): move one file between the turn's thread and a session the bot started (`/work-sessions/upload`,
 * `/work-sessions/download`). Offered with the four 07.16 tools, never in `GET /cell`. Same values as contracts
 * `BUILTIN_TOOLS.workSessionUpload|workSessionDownload`.
 */
export const WORK_SESSION_UPLOAD_TOOL = "ocw_work_session_upload";
export const WORK_SESSION_DOWNLOAD_TOOL = "ocw_work_session_download";
export const WORK_SESSION_TOOL_NAMES = [
  WORK_SESSION_START_TOOL,
  WORK_SESSION_PROMPT_TOOL,
  WORK_SESSION_READ_TOOL,
  WORK_SESSION_STOP_TOOL,
  WORK_SESSION_UPLOAD_TOOL,
  WORK_SESSION_DOWNLOAD_TOOL,
] as const;
export type WorkSessionToolName = (typeof WORK_SESSION_TOOL_NAMES)[number];
/**
 * 07.17 (D-02, PD-07): `ocw_conversation_open`, offered by 07.17-11 only on the run turn of an automation with fan-out
 * on (one conversation per new item); never on item, wake or person turns, never in `GET /cell`. Same value as the
 * mirror's `CONVERSATION_OPEN_TOOL` (agent-channel-protocol.ts), declared here without imports for the gate's sets.
 */
export const CONVERSATION_OPEN_TOOL = "ocw_conversation_open";
/**
 * 07.17.1.1.2 (D-02, PD-07): the bot's own long-task tools. The API offers all three on a turn that may start a task
 * (a person's mention, reply mode, a Work Zone wake or an automation item, outside AI chats, with "Allow long tasks"
 * on) and continue and finish on its task's own turns; never in `GET /cell`. Same values as the mirror's
 * `TASK_TOOL_NAMES` (agent-channel-protocol.ts), declared here without imports for the gate's sets.
 */
export const TASK_START_TOOL = "ocw_task_start";
export const TASK_CONTINUE_TOOL = "ocw_task_continue";
export const TASK_FINISH_TOOL = "ocw_task_finish";
export const TASK_TOOL_NAMES = [TASK_START_TOOL, TASK_CONTINUE_TOOL, TASK_FINISH_TOOL] as const;
const DELIVERED_TURN_TOOL = "ocw_agent_card";

/** The bot's snapshot tools plus the turn-scoped ones it may be offered (only for a bot that is offered any tool). */
export function withTurnScopedTools(tools: readonly string[] | undefined): string[] {
  const list = [...(tools ?? [])];
  if (!list.includes(DELIVERED_TURN_TOOL)) return list;
  for (const name of [
    BOARD_TOOL_NAME,
    ...WORK_ZONE_TOOLS,
    ...AUTOMATION_TOOLS,
    CONSULT_TOOL_NAME,
    ATTACHMENT_TOOL_NAME,
    ...WORK_SESSION_TOOL_NAMES,
    CONVERSATION_OPEN_TOOL,
    ...TASK_TOOL_NAMES,
  ]) {
    if (!list.includes(name)) list.push(name);
  }
  return list;
}
