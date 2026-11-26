import type { RuntimeId, WorkPrompt } from "@ocw/contracts";
import { type Tx, workPrompts } from "@ocw/db";
import { and, eq, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { conflict, HttpError } from "../../lib/errors";
import type { SessionRow, WorkSessionService } from "./service";
import {
  isSessionCommand,
  joinConversation,
  queueWorkPrompt,
  SLASH_COMMAND_MESSAGE,
  type WorkSessionActor,
  type WorkSessionStartDeps,
} from "./start";

/**
 * Phase 07.16 (PD-13, PD-23): the bodies people and bots share. `POST /work-sessions/:id/prompts` (and the slash
 * passthrough of `/commands`) and `POST /work-sessions/:id/archive` call these, and so do the bot's Work Zone routes,
 * so a bot's prompt or stop runs exactly the checks a person's does (no copy). The caller has locked the session row
 * and asserted the right (`work_session.prompt` / `work_session.archive`, or the bot's own-session rule).
 */

export interface WorkSessionControllerDeps {
  core: Pick<Core, "audit">;
  svc: WorkSessionService;
  startDeps: WorkSessionStartDeps;
}

export interface SubmitWorkPromptOptions {
  attachmentIds?: readonly string[];
  /** 07.16 D-06: the bot that wrote the prompt in its sponsor's (`actor`'s) name; the arbiter applies its caps. */
  authorAgentId?: string;
  /** 07.16 D-08: the prompt was written after outside content was read. */
  tainted?: boolean;
}

/**
 * D-13: a prompt body that starts with a settings or refused slash command never enters the queue; it must go
 * through `POST /work-sessions/:id/commands`. Passthrough commands and slashes later in the text are prompts.
 */
export function assertNotSlashCommand(body: string, runtime: RuntimeId): void {
  if (isSessionCommand(body, runtime)) throw new HttpError(400, "slash_command", SLASH_COMMAND_MESSAGE);
}

/**
 * Queue a prompt from `actor` and dispatch it (or restart a finished session). Call with the session LOCKED and the
 * right to prompt it decided. Archived → 409 `session_archived`; a slash command → 400 `slash_command`; then the actor
 * joins the conversation and the prompt is queued with its attachments decided (ADR-0045: inline images, files into
 * the working tree, or the file's refusal).
 */
export async function submitWorkPrompt(
  tx: Tx,
  deps: WorkSessionControllerDeps,
  actor: WorkSessionActor,
  s: SessionRow,
  body: string,
  opts: SubmitWorkPromptOptions = {},
): Promise<WorkPrompt> {
  const { svc, startDeps } = deps;
  const attachmentIds = opts.attachmentIds ?? [];
  if (s.status === "archived") throw conflict("This session is archived", "session_archived");
  assertNotSlashCommand(body, s.runtime);
  // ADR-0045 (supersedes 06.1's `images_not_supported` at submit): an image the model cannot read is copied into the
  // working tree like any other file; `queueWorkPrompt` decides every attachment (`decidePromptAttachments`).
  await joinConversation(tx, actor, s);
  const p = await queueWorkPrompt(tx, startDeps, actor, s, body, attachmentIds, {
    ...(opts.authorAgentId ? { authorAgentId: opts.authorAgentId } : {}),
    ...(opts.tainted ? { tainted: true } : {}),
  });
  if (s.status === "failed" || s.status === "completed") await svc.restart(tx, s);
  else await svc.tryDispatch(tx, s);
  await svc.emitSession(tx, s.id);
  return (await svc.prompts(tx, s.id)).find((x) => x.id === p.id)!;
}

/**
 * Archive the LOCKED session (the right decided by the caller): queued prompts cancelled, the device told to stop,
 * `work_session.archived` audited (with `byAgentId` only when a bot ended its own session), the status set. Archiving
 * an archived session does nothing.
 */
export async function archiveWorkSession(
  tx: Tx,
  deps: WorkSessionControllerDeps,
  s: SessionRow,
  opts: { byAgentId?: string } = {},
): Promise<void> {
  const { core, svc, startDeps } = deps;
  if (s.status === "archived") return;
  const cancelled = await tx
    .update(workPrompts)
    .set({ status: "cancelled", completedAt: sql`now()` })
    .where(and(eq(workPrompts.workSessionId, s.id), eq(workPrompts.status, "queued")))
    .returning();
  for (const p of cancelled) await svc.emitPrompt(tx, p);
  await startDeps.hub.enqueue(tx, {
    deviceId: s.deviceId,
    workSessionId: s.id,
    kind: "session.stop",
    payload: {},
  });
  await core.audit.record(tx, {
    action: "work_session.archived",
    resourceType: "work_session",
    resourceId: s.id,
    sessionId: s.id,
    deviceId: s.deviceId,
    ...(opts.byAgentId ? { agentId: opts.byAgentId, metadata: { byAgentId: opts.byAgentId } } : {}),
  });
  await svc.setStatus(tx, s, "archived");
}
