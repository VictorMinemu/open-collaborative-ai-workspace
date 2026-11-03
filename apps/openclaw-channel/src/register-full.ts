import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import type { AgentChannelClient } from "./api-client.js";
import { registerAutomationTool } from "./automation-tool.js";
import { type AutostartGuardDeps, registerAutostartGuard } from "./autostart-guard.js";
import { registerBoardTool } from "./board-tool.js";
import { registerBrowserTools } from "./browser-tools.js";
import { registerCardTool } from "./card-tool.js";
import { registerConnectorTools } from "./connector-tools.js";
import { registerConsultTool } from "./consult-tool.js";
import { registerMemoryFileTools } from "./memory-files-tool.js";
import { registerMemoryTool } from "./memory-tool.js";
import { registerRecordTool } from "./record-tool.js";
import { registerSandboxTools } from "./sandbox-tools.js";
import { sharedToolGuardClient, type ToolGuard, toolGuard } from "./tool-guard.js";
import { registerWorkZoneTools } from "./work-zone-tools.js";

/**
 * The plugin's full-runtime registrations (`defineChannelPluginEntry({ registerFull })`, run in "full" and
 * "tool-discovery"): our tools `ocw_memory_save` (D-10), `ocw_memory_list|read|write|propose` (07.2-07),
 * `ocw_agent_card` (06-14), `ocw_board_card` (07.1-13), the per-member connector and keychain tools (07.4-09), the
 * Work Zone proposal tools `ocw_work_zone_projects|ocw_start_work_zone` (07.5-10), the confined sandbox and browser
 * tools `ocw_sandbox_*` / `ocw_browser_*` (07.8, sandbox-tools.ts, browser-tools.ts), the 07.6 tools
 * `ocw_automation_propose` (automation-tool.ts) and `ocw_record_update` (record-tool.ts), the 07.7 consult tool
 * `ocw_consult_agent` (consult-tool.ts), and the restart-loop breaker guard on
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
  registerWorkZoneTools(api, { guard, client });
  registerSandboxTools(api, { guard, client });
  registerBrowserTools(api, { guard, client });
  registerAutomationTool(api, { guard, client });
  registerRecordTool(api, { guard, client });
  registerConsultTool(api, { guard, client });
  registerAutostartGuard(api, autostart);
}
