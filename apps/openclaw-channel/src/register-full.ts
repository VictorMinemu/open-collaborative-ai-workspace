import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import type { AgentChannelClient } from "./api-client.js";
import { type AutostartGuardDeps, registerAutostartGuard } from "./autostart-guard.js";
import { registerBoardTool } from "./board-tool.js";
import { registerCardTool } from "./card-tool.js";
import { registerConnectorTools } from "./connector-tools.js";
import { registerMemoryFileTools } from "./memory-files-tool.js";
import { registerMemoryTool } from "./memory-tool.js";
import { sharedToolGuardClient, type ToolGuard, toolGuard } from "./tool-guard.js";

/**
 * The plugin's full-runtime registrations (`defineChannelPluginEntry({ registerFull })`, run in "full" and
 * "tool-discovery"): our tools `ocw_memory_save` (D-10), `ocw_memory_list|read|write|propose` (07.2-07),
 * `ocw_agent_card` (06-14), `ocw_board_card` (07.1-13), the per-member connector and keychain tools (07.4-09), and
 * the restart-loop breaker guard on
 * `gateway_start` (autostart-guard.ts; fired from the boot registry, which is "full"). OpenClaw resolves plugin tools
 * from the boot registry or a tool-discovery load, both of which run this. The call-time tool gate is NOT here: it
 * must also exist in the non-activated registry agent turns run with (register-capabilities.ts). Kept out of
 * index.ts so it is testable without the OpenClaw runtime.
 */
export function registerFull(
  api: OpenClawPluginApi,
  guard: ToolGuard = toolGuard,
  client: () => AgentChannelClient | null = sharedToolGuardClient,
  autostart: AutostartGuardDeps = {},
): void {
  registerMemoryTool(api, { guard, client });
  registerMemoryFileTools(api, { guard, client });
  registerCardTool(api, { guard, client });
  registerBoardTool(api, { guard, client });
  registerConnectorTools(api, { guard, client });
  registerAutostartGuard(api, autostart);
}
