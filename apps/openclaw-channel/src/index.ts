import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { ocwChannelPlugin, setOcwRuntime } from "./channel.js";
import { registerCapabilities } from "./register-capabilities.js";
import { registerFull } from "./register-full.js";

/**
 * OpenClaw native channel plugin for the Open Collaborative AI Workspace.
 * The plugin is the only OpenClaw code that knows our API exists; it talks exclusively to the
 * Agent Channel API (AGENTS principle 9). `registerCapabilities` installs the call-time tool gate
 * (`before_tool_call` / `after_tool_call`, tool-guard.ts) in every registry OpenClaw can run a tool
 * with, including the non-activated one agent turns use; `registerFull` registers the tools `ocw_memory_save`
 * (memory-tool.ts), `ocw_agent_card` (card-tool.ts) and `ocw_board_card` (board-tool.ts), all declared in the manifest
 * `contracts.tools`.
 */

export default defineChannelPluginEntry({
  id: "ocw",
  name: "Open Collaborative AI Workspace",
  description: "Agent Channel API bridge: OCW bots as OpenClaw agents (tool-gated)",
  plugin: ocwChannelPlugin,
  setRuntime: setOcwRuntime,
  registerFull,
  registerCapabilities,
});
