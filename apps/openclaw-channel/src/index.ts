import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { ocwChannelPlugin, setOcwRuntime } from "./channel.js";

/**
 * OpenClaw native channel plugin for the Open Collaborative AI Workspace.
 * The plugin is the only OpenClaw code that knows our API exists; it talks exclusively to the
 * Agent Channel API (AGENTS principle 9).
 */
export default defineChannelPluginEntry({
  id: "ocw",
  name: "Open Collaborative AI Workspace",
  description: "Agent Channel API bridge: OCW bots as OpenClaw agents",
  plugin: ocwChannelPlugin,
  setRuntime: setOcwRuntime,
});
