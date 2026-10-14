/**
 * Tools the API offers only on some turns, decided per delivery from facts the cell-wide snapshot does not carry
 * (07.1-13, 07.5-10). `ocw_board_card` is offered only on a board channel's turns (07.1-10), and the two Work Zone
 * proposal tools only on turns whose human holds `work_session.create` (07.5-08), so `GET /cell` (the bot's tools in
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
const DELIVERED_TURN_TOOL = "ocw_agent_card";

/** The bot's snapshot tools plus the turn-scoped ones it may be offered (only for a bot that is offered any tool). */
export function withTurnScopedTools(tools: readonly string[] | undefined): string[] {
  const list = [...(tools ?? [])];
  if (!list.includes(DELIVERED_TURN_TOOL)) return list;
  for (const name of [BOARD_TOOL_NAME, ...WORK_ZONE_TOOLS]) if (!list.includes(name)) list.push(name);
  return list;
}
