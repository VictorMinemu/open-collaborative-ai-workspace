import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import type { AgentChannelClient } from "./api-client.js";
import { registerMemoryTool } from "./memory-tool.js";
import { sharedToolGuardClient, type ToolGuard, toolGuard } from "./tool-guard.js";

/**
 * The plugin's full-runtime registrations (`defineChannelPluginEntry({ registerFull })`, run in "full" and
 * "tool-discovery"): our memory tool `ocw_memory_save` (D-10). OpenClaw resolves plugin tools from the boot
 * registry or a tool-discovery load, both of which run this. The call-time tool gate is NOT here: it must also
 * exist in the non-activated registry agent turns run with (register-capabilities.ts). Kept out of index.ts so it
 * is testable without the OpenClaw runtime.
 */
export function registerFull(
  api: OpenClawPluginApi,
  guard: ToolGuard = toolGuard,
  client: () => AgentChannelClient | null = sharedToolGuardClient,
): void {
  registerMemoryTool(api, { guard, client });
}
