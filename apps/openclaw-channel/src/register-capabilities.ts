import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import {
  registerToolGate,
  TOOL_GATE_PRIORITY,
  TOOL_PIN_PRIORITY,
  type ToolGuard,
  toolGuard,
} from "./tool-guard.js";

/**
 * The plugin's capability registrations (`defineChannelPluginEntry({ registerCapabilities })`): the call-time
 * tool gate (D-08 guard 3, `before_tool_call` / `after_tool_call`).
 *
 * It MUST live here, not in `registerFull`. OpenClaw 2026.9.7 runs every agent turn inside a prepared plugin
 * generation, and the hook runner reads only that generation's registry. When the config differs from the one
 * the boot registry was activated with (always in an OCW cell: we write the cell's bots and providers right
 * after boot), that registry is a non-activated load in which plugins register in "discovery" mode, where
 * `defineChannelPluginEntry` calls `registerCapabilities` but skips `registerFull`. A gate registered from
 * `registerFull` was therefore absent from every turn and `web_search` ran ungated (CI cell-smoke). This
 * callback runs in "full", "discovery" and "tool-discovery", i.e. in every registry that can run a tool.
 * The handlers only touch process-wide gate state (tool-guard.ts), so registering them in several registries is
 * harmless: the hook runner reads exactly one registry per call.
 */
export function registerCapabilities(api: OpenClawPluginApi, guard: ToolGuard = toolGuard): void {
  registerToolGate(api, guard);
  announce(api);
}

const announced = new Set<string>();

/**
 * One line per registration mode and process, so a cell's log proves where the gate is wired, and at which priorities
 * (OpenClaw runs `before_tool_call` handlers highest first; the 07.5 params pin must be the last, 07.5-15 smoke).
 */
function announce(api: OpenClawPluginApi): void {
  const mode = api.registrationMode ?? "unknown";
  if (announced.has(mode)) return;
  announced.add(mode);
  api.logger?.info?.(
    `[ocw] tool gate registered (${mode} registry; gate priority ${TOOL_GATE_PRIORITY}, params pin priority ${TOOL_PIN_PRIORITY})`,
  );
}
