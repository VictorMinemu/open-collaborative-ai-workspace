import {
  EFFORT_LABELS,
  type PermissionMode,
  type SessionCommandResult,
  type SessionSettingsPatch,
  settingsFromSlash,
  slashDisposition,
  type WorkPrompt,
  type WorkSession,
} from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import type { FastifyRequest } from "fastify";
import type { Core } from "../../core";
import { HttpError } from "../../lib/errors";
import { buildRuntimeControls, type ControlsContext } from "./controls";
import type { SessionRow } from "./service";

/**
 * Slash commands typed in a Work Zone prompt (Phase 03.2, D-13, P-10, ADR-0012 §4). One server decision for every
 * leading `/command`: settings commands go through the same policy-checked, audited path as `PATCH /settings`
 * (`applySettingsChange`), the runtime's passthrough allowlist runs as a normal prompt, and everything else is
 * refused with a visible notice. Nothing here talks to the runtime directly; the adapters refuse again as a backstop.
 */

type SessionPermission = "work_session.prompt" | "work_session.configure";

/** The route helpers a command reuses, so there is exactly one settings path and one prompt path. */
export interface SessionCommandDeps {
  core: Core;
  /** Lock + load a session visible in the caller's org (RLS), or 404. */
  locked(tx: Tx, id: string): Promise<SessionRow>;
  /** Lock + load a session and assert `permission` on it through the resolver. */
  lockedFor(req: FastifyRequest, tx: Tx, id: string, permission: SessionPermission): Promise<SessionRow>;
  applySettingsChange(
    req: FastifyRequest,
    tx: Tx,
    s: SessionRow,
    patch: SessionSettingsPatch,
    source: "user" | "slash_command",
  ): Promise<{ session: WorkSession; ctx: ControlsContext; changed: boolean }>;
  submitPrompt(req: FastifyRequest, tx: Tx, s: SessionRow, body: string): Promise<WorkPrompt>;
}

const MODE_LABEL: Record<PermissionMode, string> = {
  default: "Supervised",
  acceptEdits: "Auto-accept edits",
  auto: "Auto",
  plan: "Plan",
  fullAccess: "Full access",
};

const RUNTIME_LABEL = { "claude-code": "Claude Code", codex: "Codex" } as const;

const NEXT_TURN = "applies to the next turn";

/** The command name as stored and returned (bounded, `SessionCommandResult.command`). */
const nameOf = (name: string) => name.slice(0, 64);

/** One-line notice of an applied settings command. */
function settingsNotice(
  patch: SessionSettingsPatch,
  s: SessionRow,
  ctx: ControlsContext,
  changed: boolean,
): string {
  const suffix = changed ? ` — ${NEXT_TURN}` : " (unchanged)";
  if (patch.model !== undefined) {
    const model = buildRuntimeControls(s.runtime, ctx, patch.model).models.find((m) => m.id === patch.model);
    return `Model set to ${model?.displayName ?? patch.model}${suffix}`;
  }
  if (patch.effort !== undefined) {
    const label = patch.effort === null ? "Default" : (EFFORT_LABELS[patch.effort] ?? patch.effort);
    return `Reasoning set to ${label}${suffix}`;
  }
  if (patch.fastMode !== undefined) return `Fast mode ${patch.fastMode ? "on" : "off"}${suffix}`;
  if (patch.permissionMode !== undefined) {
    return `Permission mode set to ${MODE_LABEL[patch.permissionMode]}${suffix}`;
  }
  return `Settings updated${suffix}`;
}

/** Run a `/command` typed by the caller in session `sessionId` (`POST /work-sessions/:id/commands`). */
export async function runSessionCommand(
  req: FastifyRequest,
  tx: Tx,
  deps: SessionCommandDeps,
  sessionId: string,
  text: string,
): Promise<SessionCommandResult> {
  const session = await deps.locked(tx, sessionId);
  const disposition = slashDisposition(text, session.runtime);
  if (!disposition) throw new HttpError(400, "bad_command", "Commands start with /");
  const command = nameOf(disposition.name);

  if (disposition.kind === "settings") {
    const s = await deps.lockedFor(req, tx, sessionId, "work_session.configure");
    const parsed = settingsFromSlash(disposition.name, disposition.args);
    if (!parsed.ok) throw new HttpError(400, "bad_command", parsed.error);
    const applied = await deps.applySettingsChange(req, tx, s, parsed.patch, "slash_command");
    return {
      kind: "settings",
      command,
      notice: settingsNotice(parsed.patch, s, applied.ctx, applied.changed),
      session: applied.session,
    };
  }

  const s = await deps.lockedFor(req, tx, sessionId, "work_session.prompt");
  if (disposition.kind === "passthrough") {
    const prompt = await deps.submitPrompt(req, tx, s, text);
    return { kind: "prompt", command, notice: `/${command} sent to ${RUNTIME_LABEL[s.runtime]}`, prompt };
  }

  return {
    kind: "refused",
    command,
    notice: `/${command} is not available from the workspace. Use the session controls.`,
  };
}
