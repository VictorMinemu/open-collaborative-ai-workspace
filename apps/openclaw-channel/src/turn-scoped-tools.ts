/**
 * Tools the API offers only on some turns, decided per delivery from facts the cell-wide snapshot does not carry
 * (07.1-13). `ocw_board_card` is offered only on a board channel's turns (07.1-10), so `GET /cell` (the bot's tools in
 * any conversation, null kind) never lists it, while OpenClaw can only run a tool the bot's entry configures
 * (`alsoAllow`) and a turn may only narrow that list (`toolsAllow`).
 *
 * The plugin therefore configures it for every bot the API serves delivered-turn tools to (a non-disabled bot: its
 * snapshot always lists `ocw_agent_card`), and lets each turn decide: the run's `toolsAllow` is still
 * `turn.tools ∩ agent tools`, the tool refuses a turn that does not list it, and the board routes refuse
 * `not_in_turn`. Nothing here widens what any turn may do.
 */

export const BOARD_TOOL_NAME = "ocw_board_card";
const DELIVERED_TURN_TOOL = "ocw_agent_card";

/** The bot's snapshot tools plus the turn-scoped ones it may be offered (only for a bot that is offered any tool). */
export function withTurnScopedTools(tools: readonly string[] | undefined): string[] {
  const list = [...(tools ?? [])];
  if (list.includes(DELIVERED_TURN_TOOL) && !list.includes(BOARD_TOOL_NAME)) list.push(BOARD_TOOL_NAME);
  return list;
}
