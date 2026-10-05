import type { RuntimeControlRow } from "./index";

/** Inventory A: Claude Code through the Claude Agent SDK 0.3.282 / CLI 2.1.289 (03.2-RESEARCH.md). */
const row = (
  control: string,
  status: RuntimeControlRow["status"],
  uiKey: string | null,
  reason: string,
  evidence: string,
): RuntimeControlRow => ({ area: "claude-code", control, status, reason, evidence, uiKey });

/** Fixtures recorded at CLI 2.1.289 / SDK 0.3.282 (apps/local-runtime/src/claude/__fixtures__/). */
const SETTINGS_FIXTURE = "fixture claude-code-2.1.289.settings.sdk.jsonl";
const CATALOG_FIXTURE = "fixture claude-code-2.1.289.catalog.json";

export const CLAUDE_CODE_CONTROLS: readonly RuntimeControlRow[] = [
  row(
    "Model list (per subscription)",
    "exposed",
    "model.list",
    "Reported by the runtime per account; the picker renders only this catalog (D-08)",
    `Query.initializationResult().models / supportedModels(): sdk.d.ts:2998-3004; ${CATALOG_FIXTURE} (12 rows, no turn)`,
  ),
  row(
    "Switch model",
    "exposed",
    "model.switch",
    "Applied between turns with setModel in streaming input mode (D-07, D-14); every init reports the effective model (D-15)",
    `Query.setModel(): sdk.d.ts:2887-2893; ${SETTINGS_FIXTURE}: setModel("sonnet") → init model claude-sonnet-5-5`,
  ),
  row(
    "Effort (Low / Medium / High / Extra High / Max)",
    "exposed",
    "effort",
    "Levels from ModelInfo.supportedEffortLevels; applied between turns with applyFlagSettings({ effortLevel }) (only scalar keys, never permissions). The SDK init does not echo effort, so the readback is the applied value",
    `applyFlagSettings: sdk.d.ts:1905-1916, 2920-2944; ${SETTINGS_FIXTURE}: applyFlagSettings({effortLevel:"low"}) accepted, turn ran`,
  ),
  row(
    "Ultracode",
    "deferred",
    "effort.ultracode",
    "Starts multi-agent work inside the runtime; deferred to the multi-agent phase (D-09, Pitfall 6)",
    "Settings.ultracode: sdk.d.ts:8851-8853",
  ),
  row(
    "Ultrathink (prompt keyword)",
    "deferred",
    "effort.ultrathink",
    "A prompt keyword, not a setting; offered only if a recorded fixture proves it works through the SDK (D-09)",
    "CLI 2.1.282 strings (ultrathink_effort); code.claude.com/docs/en/model-config",
  ),
  row(
    "Thinking budget (on / off / tokens)",
    "deferred",
    null,
    "Start-only option and setMaxThinkingTokens is deprecated; not in the reference layout",
    "Options.thinking: sdk.d.ts:1891-1903, 2894-2919",
  ),
  row(
    "Context window 200k / 1M",
    "exposed",
    "context.window",
    "Only where the runtime accepts both values (at 2.1.289: claude-opus-4-6 only); elsewhere the fixed value is shown (D-10)",
    `Probe setModel(id / id[1m]) + getContextUsage().maxTokens; sdk.d.ts:1706-1713, 3716; ${CATALOG_FIXTURE}`,
  ),
  row(
    "Context usage indicator",
    "deferred",
    "context.usage",
    "Nice-to-have read-only indicator; not needed for the controls",
    "Query.getContextUsage(): sdk.d.ts:3938-3961",
  ),
  row(
    "Fast mode on / off",
    "exposed",
    "fast.mode",
    "Metered (paid usage credits, not the plan limits); org policy default off; applied with applyFlagSettings({ fastMode }) and shown disabled with the runtime's reason from init fast_mode_disabled_reason (sdk_opt_in_required before opt-in, extra_usage_disabled on this account per research) (D-11)",
    `Settings.fastMode / fast_mode_state: sdk.d.ts:766-776, 8861-8869, 4529-4532; ${SETTINGS_FIXTURE}: init fast_mode_state off / sdk_opt_in_required`,
  ),
  row(
    "Plan mode",
    "exposed",
    "mode.plan",
    "Already shipped; read-only planning",
    "permissionMode 'plan': sdk.d.ts:1982-1998; fixture claude-code-2.1.287.plan-read.sdk.jsonl",
  ),
  row(
    "Supervised (permission mode default)",
    "exposed",
    "mode.default",
    "Already shipped; every edit and command asks",
    "PermissionMode 'default': sdk.d.ts:2479-2481",
  ),
  row(
    "Auto-accept edits (permission mode acceptEdits)",
    "exposed",
    "mode.acceptEdits",
    "Already shipped; edits run, commands ask",
    "PermissionMode 'acceptEdits': sdk.d.ts:2479-2481",
  ),
  row(
    "Auto (permission mode auto)",
    "exposed",
    "mode.auto",
    "Offered only for models with supportsAutoMode; the runtime confirmed it: after setPermissionMode('auto') the status frame and the next system/init report permissionMode auto",
    `PermissionMode 'auto', ModelInfo.supportsAutoMode: sdk.d.ts:1420-1423, 2858-2864, 9019-9021; ${SETTINGS_FIXTURE}`,
  ),
  row(
    "Full access (bypassPermissions)",
    "exposed",
    "mode.fullAccess",
    "ADR-0012 path: org policy ∩ device opt-in ∩ grain; adapters report it only on opted-in devices (Plan 06)",
    "PermissionMode 'bypassPermissions' + allowDangerouslySkipPermissions: sdk.d.ts:2479-2481; ADR-0012",
  ),
  row(
    "dontAsk permission mode",
    "deferred",
    null,
    "Denies anything not pre-approved instead of asking; no platform mode maps to it yet",
    "PermissionMode 'dontAsk': sdk.d.ts:2479-2481",
  ),
  row(
    "Fallback model",
    "deferred",
    null,
    "Start-only option, not in the reference layout",
    "Options.fallbackModel: sdk.d.ts:1675-1681",
  ),
  row(
    "Slash commands that change settings (/model, /effort, /fast, /permissions)",
    "exposed",
    "slash.settings",
    "Intercepted and routed through the policy-checked, audited settings path (D-13, P-10); the adapter refuses them as a backstop (slash_command_refused)",
    "supportedCommands() / system/init.slash_commands: sdk.d.ts:2998, 3719, 9200-9222; refuseSlashCommand in claude-runtime.ts",
  ),
  row(
    "Slash commands passed through (/compact, /context, /usage, /cost, /init, /review)",
    "exposed",
    "slash.passthrough",
    "Allowlist sent as a prompt; every other command is refused with a notice (Pitfall 3)",
    "code.claude.com/docs/en/agent-sdk/slash-commands",
  ),
  row("Interrupt", "exposed", "interrupt", "Already shipped", "Query.interrupt(): sdk.d.ts:2851-2857"),
  row(
    "Rewind files",
    "deferred",
    null,
    "Changes the working tree outside a turn; needs its own approval design",
    "Query.rewindFiles(): sdk.d.ts:3010-3016",
  ),
  row(
    "MCP server status",
    "deferred",
    null,
    "Not part of the session controls",
    "Query.mcpServerStatus(): sdk.d.ts:3010-3016",
  ),
];
