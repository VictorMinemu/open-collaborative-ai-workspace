import {
  type SessionRenameFrame,
  type SessionRenameRefusal,
  type SessionRenameResultFrame,
  SessionTitle,
  UpdateWorkSessionRequest,
  WorkSession,
} from "@ocw/contracts";
import { conversations, type Tx, workPrompts, workSessions } from "@ocw/db";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { conflict } from "../../lib/errors";
import type { AuditService } from "../audit";
import type { DeviceRef, SendResult } from "../device";
import { ACTIVE_STATES, IN_FLIGHT, type SessionRow, type WorkSessionService } from "./service";

/**
 * Renaming a Work Zone session (Phase 07.13.1.1, D-06, D-14, PD-07). A person's typed title is `titleSource = 'user'`
 * and nothing automatic replaces it afterwards (03.2 D-19: the device generator and the agent rename both write only
 * while the title is not `user`). `applyTitle` is the one place a title changes outside the automatic generator: the
 * manual route here and the agent's rename (`createSessionToolHandler`) both call it. The audit carries the length,
 * never the text.
 */

const SessionParams = z.object({ id: z.uuid() });

export interface ApplyTitleDeps {
  audit: AuditService;
  svc: Pick<WorkSessionService, "syncBotCard" | "emitSession" | "session">;
}

export interface ApplyTitleAudit {
  by: "user" | "agent";
  userId: string | null;
  agentId?: string | null;
  /** The turn an agent renamed the session in (agent renames only). */
  promptId?: string;
  /** `device` when the rename arrived from the session's device (the agent's tool); the actor is then the device. */
  actorKind?: "user" | "device";
}

/**
 * Sets the title of the LOCKED session `s`, in order: the same title is a no-op; one UPDATE (for `auto`, only while
 * the title is not a person's); the conversation's name; the `work_session.renamed` audit (`{ by, length }`, plus the
 * turn for an agent; never the text); the bot's live card; the session on `ws:` and to its readers. Answers whether
 * the title changed and the session as this transaction reads it.
 */
export async function applyTitle(
  tx: Tx,
  deps: ApplyTitleDeps,
  s: SessionRow,
  title: string,
  source: "user" | "auto",
  audit: ApplyTitleAudit,
): Promise<{ changed: boolean; session: WorkSession | null }> {
  const unchanged = async () => ({ changed: false, session: await deps.svc.session(tx, s.id) });
  if (s.title === title && (source === "auto" || s.titleSource === "user")) return unchanged();
  const [row] = await tx
    .update(workSessions)
    .set({ title, titleSource: source, updatedAt: sql`now()` })
    .where(
      source === "auto"
        ? and(eq(workSessions.id, s.id), ne(workSessions.titleSource, "user"))
        : eq(workSessions.id, s.id),
    )
    .returning({ conversationId: workSessions.conversationId });
  if (!row) return unchanged();
  s.title = title;
  s.titleSource = source;
  await tx.update(conversations).set({ name: title }).where(eq(conversations.id, row.conversationId));
  const device = audit.actorKind === "device";
  await deps.audit.record(tx, {
    action: "work_session.renamed",
    resourceType: "work_session",
    resourceId: s.id,
    sessionId: s.id,
    deviceId: s.deviceId,
    userId: audit.userId,
    ...(device ? { actorKind: "device" as const, actorId: s.deviceId } : {}),
    ...(audit.agentId ? { agentId: audit.agentId } : {}),
    metadata: {
      by: audit.by,
      length: title.length,
      ...(audit.promptId ? { promptId: audit.promptId } : {}),
    },
  });
  // A bot's session shows its title on its live card; the card follows the rename.
  await deps.svc.syncBotCard(tx, s);
  return { changed: true, session: await deps.svc.emitSession(tx, s.id) };
}

export interface RenameRouteDeps {
  svc: WorkSessionService;
  /** The route family's lock + audience 404 + grain assertion (routes.ts `lockedFor`). */
  lockedFor(
    req: FastifyRequest,
    tx: Tx,
    id: string,
    permission: "work_session.configure",
  ): Promise<SessionRow>;
}

export function registerRenameRoutes(app: App, core: Core, deps: RenameRouteDeps): void {
  const { svc, lockedFor } = deps;
  const tags = ["work-session"];
  const user = { config: { authz: "user" as const }, preHandler: core.identity.requireUser };

  app.patch(
    "/work-sessions/:id",
    {
      ...user,
      schema: { tags, params: SessionParams, body: UpdateWorkSessionRequest, response: { 200: WorkSession } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const s = await lockedFor(req, tx, req.params.id, "work_session.configure");
        if (s.status === "archived") throw conflict("Archived sessions can't be renamed", "session_archived");
        const { session } = await applyTitle(tx, { audit: core.audit, svc }, s, req.body.title, "user", {
          by: "user",
          userId: authOf(req).userId,
        });
        return session!;
      }),
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the agent rename decision answers: the stored title, or one refusal. */
type RenameDecision = SessionRenameResultFrame["result"];

/**
 * Phase 07.13.1.1 (D-07, D-14, PD-09, PD-11, PD-12): the device's `session.rename` frames, the agent of a session
 * calling `ocw_session` › `rename`. Decided in the tenant of the device the link authenticated (never an organization
 * the frame names), under the session's lock, in this order: the session is this device's (else `not_available`, the
 * same answer as another organization's id, which RLS hides), it is active and the named prompt of this session is in
 * flight (else `no_turn`), a person did not type the title (`title_locked`), the title has the generated-title shape
 * (`invalid_title`, which does not use up the turn), the turn has not renamed yet (claimed once in
 * `work_prompts.title_renamed_at`, else `already_renamed`). Then `applyTitle` with `auto`: a late device title (which
 * replaces only `heuristic`) never overwrites it, and the agent may rename again in a later turn.
 *
 * The answer goes through `reply`, on the requesting socket only, after the transaction. A refusal writes nothing; an
 * error answers `not_available` and is logged by its name with the device and session ids only (never the title).
 */
export function createSessionToolHandler(
  core: Core,
  svc: WorkSessionService,
): {
  onSessionRename(
    device: DeviceRef,
    frame: SessionRenameFrame,
    reply: (frame: SessionRenameResultFrame) => SendResult,
  ): Promise<void>;
} {
  return {
    async onSessionRename(device, frame, reply) {
      let result: RenameDecision;
      try {
        result = await core.db.withTenant({ organizationId: device.organizationId, userId: null }, (tx) =>
          decideAgentRename(tx, core, svc, device, frame),
        );
      } catch (err) {
        core.log.warn(
          { deviceId: device.deviceId, sessionId: frame.sessionId, error: (err as Error | undefined)?.name },
          "work session agent rename failed",
        );
        result = { ok: false, reason: "not_available" };
      }
      try {
        reply({ type: "session.rename.result", requestId: frame.requestId, result });
      } catch (err) {
        core.log.warn(
          { deviceId: device.deviceId, sessionId: frame.sessionId, error: (err as Error | undefined)?.name },
          "work session agent rename reply failed",
        );
      }
    },
  };
}

async function decideAgentRename(
  tx: Tx,
  core: Core,
  svc: WorkSessionService,
  device: DeviceRef,
  frame: SessionRenameFrame,
): Promise<RenameDecision> {
  const refuse = (reason: SessionRenameRefusal): RenameDecision => ({ ok: false, reason });
  const s = await svc.lock(tx, frame.sessionId);
  if (!s || s.deviceId !== device.deviceId) return refuse("not_available");
  if (!ACTIVE_STATES.includes(s.status) || !UUID_RE.test(frame.promptId)) return refuse("no_turn");
  const [prompt] = await tx
    .select({
      status: workPrompts.status,
      authorUserId: workPrompts.authorUserId,
      authorAgentId: workPrompts.authorAgentId,
    })
    .from(workPrompts)
    .where(and(eq(workPrompts.id, frame.promptId), eq(workPrompts.workSessionId, s.id)));
  if (!prompt || !IN_FLIGHT.includes(prompt.status)) return refuse("no_turn");
  if (s.titleSource === "user") return refuse("title_locked");
  if (!SessionTitle.safeParse(frame.title).success) return refuse("invalid_title");
  const claimed = await tx
    .update(workPrompts)
    .set({ titleRenamedAt: sql`now()` })
    .where(and(eq(workPrompts.id, frame.promptId), isNull(workPrompts.titleRenamedAt)))
    .returning({ id: workPrompts.id });
  if (claimed.length === 0) return refuse("already_renamed");
  await applyTitle(tx, { audit: core.audit, svc }, s, frame.title, "auto", {
    by: "agent",
    userId: prompt.authorUserId,
    agentId: prompt.authorAgentId,
    promptId: frame.promptId,
    actorKind: "device",
  });
  return { ok: true, title: frame.title };
}
