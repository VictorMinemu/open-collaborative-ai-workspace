import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { ocwChannelPlugin, setOcwRuntime } from "./channel.js";
import { registerToolGate } from "./tool-guard.js";

/**
 * OpenClaw native channel plugin for the Open Collaborative AI Workspace.
 * The plugin is the only OpenClaw code that knows our API exists; it talks exclusively to the
 * Agent Channel API (AGENTS principle 9). `registerFull` installs the call-time tool gate
 * (`before_tool_call` / `after_tool_call`, tool-guard.ts).
 */

export default defineChannelPluginEntry({
  id: "ocw",
  name: "Open Collaborative AI Workspace",
  description: "Agent Channel API bridge: OCW bots as OpenClaw agents (tool-gated)",
  plugin: ocwChannelPlugin,
  setRuntime: setOcwRuntime,
  registerFull: registerToolGate,
});
