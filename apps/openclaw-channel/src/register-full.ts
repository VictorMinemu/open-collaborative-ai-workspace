import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import type { AgentChannelClient } from "./api-client.js";
import { registerMemoryTool } from "./memory-tool.js";
import { registerToolGate, sharedToolGuardClient, type ToolGuard, toolGuard } from "./tool-guard.js";

/**
 * The plugin's full-runtime registrations (`defineChannelPluginEntry({ registerFull })`): the call-time tool
 * gate (D-08) and our own memory tool `ocw_memory_save` (D-10). Kept out of index.ts so it is testable without
 * the OpenClaw runtime.
 */
export function registerFull(
  api: OpenClawPluginApi,
  guard: ToolGuard = toolGuard,
  client: () => AgentChannelClient | null = sharedToolGuardClient,
): void {
  registerToolGate(api, guard);
  registerMemoryTool(api, { guard, client });
}
