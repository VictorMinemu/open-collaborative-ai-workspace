import { PermissionMode, type RuntimeId } from "./session-events";
import { EffortLevel, type SessionSettingsPatch } from "./session-settings";

/**
 * Slash commands typed in a Work Zone prompt (Phase 03.2, D-13, P-10). The composer, the API
 * (`POST /work-sessions/:id/commands`, and `POST /prompts` refusing non-passthrough commands) and the adapters
 * (as a backstop) all use these functions, so a command can never change runtime state behind the platform's
 * back: settings commands go through the policy-checked, audited settings path; a short per-runtime allowlist
 * runs as a normal prompt; everything else is refused with a visible notice.
 */

/** Commands that change session settings: handled by the platform, never sent to the runtime. */
export const SETTINGS_SLASH_COMMANDS = ["model", "effort", "fast", "permissions"] as const;

/** Commands that run as a prompt on each runtime (read-only or session-housekeeping commands). */
export const PASSTHROUGH_SLASH_COMMANDS: Readonly<Record<RuntimeId, readonly string[]>> = {
  "claude-code": ["compact", "context", "usage", "cost", "init", "review"],
  // app-server has no slash-command API; `/compact` maps to `thread/compact/start` (Plan 03).
  codex: ["compact"],
};

const COMMAND = /^\/([a-z0-9:_-]+)(?:\s+(.*))?$/i;

/** `/name args` on the first line of `text`, or null when the prompt is not a command. */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  const line = (text.trimStart().split("\n")[0] ?? "").trimEnd();
  const m = COMMAND.exec(line);
  if (!m?.[1]) return null;
  return { name: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}

export type SlashDisposition =
  | { kind: "settings" | "passthrough"; name: string; args: string }
  | { kind: "refused"; name: string }
  | null;

/** What happens with a prompt that starts with a slash command on `runtime` (null = not a command). */
export function slashDisposition(text: string, runtime: RuntimeId): SlashDisposition {
  const cmd = parseSlashCommand(text);
  if (!cmd) return null;
  if ((SETTINGS_SLASH_COMMANDS as readonly string[]).includes(cmd.name)) return { kind: "settings", ...cmd };
  if (PASSTHROUGH_SLASH_COMMANDS[runtime].includes(cmd.name)) return { kind: "passthrough", ...cmd };
  return { kind: "refused", name: cmd.name };
}

/** Spoken / typed names of the permission modes (UI labels and the platform values). */
const PERMISSION_ALIASES: Readonly<Record<string, PermissionMode>> = {
  supervised: "default",
  default: "default",
  "auto-accept": "acceptEdits",
  "auto-accept edits": "acceptEdits",
  acceptedits: "acceptEdits",
  "accept-edits": "acceptEdits",
  auto: "auto",
  plan: "plan",
  "full access": "fullAccess",
  "full-access": "fullAccess",
  fullaccess: "fullAccess",
};

/** The settings patch of a settings command, or a short user-facing error. */
export function settingsFromSlash(
  name: string,
  args: string,
): { ok: true; patch: SessionSettingsPatch } | { ok: false; error: string } {
  const value = args.trim();
  switch (name) {
    case "model":
      if (!value || value.length > 200) return { ok: false, error: "Usage: /model <model>" };
      return { ok: true, patch: { model: value } };
    case "effort": {
      if (value.toLowerCase() === "default") return { ok: true, patch: { effort: null } };
      const effort = EffortLevel.safeParse(value.toLowerCase());
      if (!value || !effort.success) return { ok: false, error: "Usage: /effort <level|default>" };
      return { ok: true, patch: { effort: effort.data } };
    }
    case "fast": {
      const v = value.toLowerCase();
      if (v === "on" || v === "off") return { ok: true, patch: { fastMode: v === "on" } };
      return { ok: false, error: "Usage: /fast on|off" };
    }
    case "permissions": {
      const mode = PERMISSION_ALIASES[value.toLowerCase().replace(/\s+/g, " ")];
      if (!mode || !PermissionMode.safeParse(mode).success) {
        return { ok: false, error: "Usage: /permissions supervised|auto-accept|auto|plan|full access" };
      }
      return { ok: true, patch: { permissionMode: mode } };
    }
    default:
      return { ok: false, error: `/${name} is not a settings command` };
  }
}
