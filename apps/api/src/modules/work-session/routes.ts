import { randomUUID } from "node:crypto";
import {
  CreatePromptRequest,
  CreateWorkSessionRequest,
  Ok,
  onlyRelativePaths,
  ResolveApprovalRequest,
  RuntimeInfo,
  UpdatePromptRequest,
  WorkApproval,
  WorkPrompt,
  WorkSession,
  WorkSessionDetail,
  WorkSessionDiff,
  WorkSessionEventPayload,
  WorkSessionList,
} from "@ocw/contracts";
import {
  conversationMembers,
  conversations,
  devices,
  projects,
  streamEvents,
  type Tx,
  workApprovals,
  workPrompts,
  workSessions,
} from "@ocw/db";
import { and, asc, desc, eq, max, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, type AuthContext, authOf, type Core, tenant } from "../../core";
import { conflict, HttpError, notFound } from "../../lib/errors";
import { type DeviceHub, deviceFacts } from "../device";
import {
  AuthzDeniedError,
  createPermissionService,
  orgResource,
  type ResourceFacts,
  workSessionResource,
} from "../organization";
import { type SessionRow, type WorkSessionService, wsTopic } from "./service";

const SessionParams = z.object({ id: z.uuid() });
const PromptParams = z.object({ id: z.uuid(), pid: z.uuid() });
const ApprovalParams = z.object({ id: z.uuid(), aid: z.uuid() });
const ListQuery = z.object({ archived: z.enum(["0", "1"]).optional() });

const EVENT_WINDOW = 1500;
const DIFF_TIMEOUT_MS = 20_000;

const RUNTIME_LABEL = { "claude-code": "Claude Code", codex: "Codex" } as const;

/** Permissions a session view renders controls for (`WorkSessionDetail.viewerCan`). */
const SESSION_VIEWER_CAN = [
  "work_session.prompt",
  "work_session.interrupt",
  "work_session.approve",
  "work_session.archive",
] as const;

export function registerWorkSessionRoutes(
  app: App,
  core: Core,
  hub: DeviceHub,
  svc: WorkSessionService,
): void {
  const requireUser = core.identity.requireUser;
  const user = { config: { authz: "user" as const }, preHandler: requireUser };
  const tags = ["work-session"];
  const perms = createPermissionService(core);

  /** Lock + load a session and assert `permission` on it (404 when it is not in the caller's org). */
  async function lockedFor(
    req: FastifyRequest,
    tx: Tx,
    id: string,
    permission: "work_session.prompt" | "work_session.interrupt",
  ): Promise<SessionRow> {
    const s = await locked(tx, id);
    await perms.assertCan(req, tx, permission, await sessionFacts(tx, authOf(req), s));
    return s;
  }

  /** Lock + load a session visible in the caller's org (RLS), or 404. */
  async function locked(tx: Tx, id: string): Promise<SessionRow> {
    const s = await svc.lock(tx, id);
    if (!s) throw notFound("Work session not found");
    return s;
  }

  /**
   * Resolver facts for a session: the caller's relations (creator, device owner), the Device layer
   * (revoked device) and, for approvals, the tool the request would run (Tool layer).
   */
  async function sessionFacts(
    tx: Tx,
    auth: AuthContext,
    s: Pick<SessionRow, "createdBy" | "deviceId">,
    tool?: string,
  ): Promise<ResourceFacts> {
    const [d] = await tx
      .select({ owner: devices.ownerUserId, revokedAt: devices.revokedAt })
      .from(devices)
      .where(eq(devices.id, s.deviceId));
    return workSessionResource(
      {
        createdBy: s.createdBy,
        deviceOwnerUserId: d?.owner ?? null,
        deviceRevoked: !d || d.revokedAt !== null,
        tool: tool ?? null,
      },
      auth.userId,
    );
  }

  async function joinConversation(tx: Tx, auth: AuthContext, s: SessionRow) {
    await tx
      .insert(conversationMembers)
      .values({
        conversationId: s.conversationId,
        organizationId: auth.organizationId,
        memberKind: "user",
        memberId: auth.userId,
        role: s.createdBy === auth.userId ? "owner" : "member",
      })
      .onConflictDoNothing();
  }

  app.get(
    "/work-sessions",
    {
      config: { authz: "user" },
      preHandler: [requireUser, perms.requirePermission("work_session.read")],
      schema: { tags, querystring: ListQuery, response: { 200: WorkSessionList } },
    },
    async (req) => ({
      sessions: await core.db.withTenant(tenant(req), (tx) =>
        svc.sessions(tx, req.query.archived === "1" ? undefined : ne(workSessions.status, "archived")),
      ),
    }),
  );

  app.post(
    "/work-sessions",
    { ...user, schema: { tags, body: CreateWorkSessionRequest, response: { 200: WorkSession } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const body = req.body;
        await perms.assertCan(req, tx, "work_session.create", orgResource());
        const [row] = await tx
          .select({ p: projects, d: devices })
          .from(projects)
          .innerJoin(devices, eq(devices.id, projects.deviceId))
          .where(eq(projects.id, body.projectId));
        if (!row || row.p.removedAt) throw notFound("Project not found");
        const { p, d } = row;
        if (body.deviceId && body.deviceId !== d.id) throw conflict("The project belongs to another device");
        // Device layer: own or shared (device_not_shared), never revoked (device_revoked).
        await perms.assertCan(req, tx, "device.use", deviceFacts(d, auth.userId)).catch((err) => {
          if (!(err instanceof AuthzDeniedError)) throw err;
          throw new AuthzDeniedError(err.denial, {
            message:
              err.denial.reason === "device_revoked"
                ? `${d.name} was revoked. Pair it again to use it.`
                : "This device is not shared with you. Ask its owner to share it.",
          });
        });
        if (d.status !== "online")
          throw conflict(`${d.name} is offline. Start the desktop app.`, "device_offline");
        const runtime = z
          .array(RuntimeInfo)
          .catch([])
          .parse(d.runtimeInfo)
          .find((r) => r.id === body.runtime);
        if (!runtime?.installed) {
          throw conflict(
            `${RUNTIME_LABEL[body.runtime]} is not installed on ${d.name}`,
            "runtime_unavailable",
          );
        }
        if (!runtime.loggedIn) {
          throw conflict(
            `${RUNTIME_LABEL[body.runtime]} is not signed in on ${d.name}. Sign in from a terminal first.`,
            "runtime_unavailable",
          );
        }
        const title = body.title ?? firstLine(body.prompt) ?? `${p.name} · ${RUNTIME_LABEL[body.runtime]}`;
        const [conv] = await tx
          .insert(conversations)
          .values({
            organizationId: auth.organizationId,
            kind: "work_session",
            name: title,
            visibility: "public",
            createdBy: auth.userId,
          })
          .returning({ id: conversations.id });
        const [s] = await tx
          .insert(workSessions)
          .values({
            organizationId: auth.organizationId,
            conversationId: conv!.id,
            projectId: p.id,
            deviceId: d.id,
            runtime: body.runtime ?? "claude-code",
            model: body.model ?? null,
            permissionMode: body.permissionMode ?? "default",
            worktree: body.worktree ?? false,
            branch: body.worktree ? null : p.defaultBranch,
            status: "provisioning",
            title,
            createdBy: auth.userId,
          })
          .returning();
        await joinConversation(tx, auth, s!);
        await hub.enqueue(tx, {
          deviceId: d.id,
          workSessionId: s!.id,
          kind: "session.start",
          payload: await svc.startPayload(tx, s!),
        });
        await core.audit.record(tx, {
          action: "work_session.created",
          resourceType: "work_session",
          resourceId: s!.id,
          sessionId: s!.id,
          deviceId: d.id,
          clientKind: auth.clientKind,
          metadata: {
            projectId: p.id,
            runtime: s!.runtime,
            permissionMode: s!.permissionMode,
            worktree: s!.worktree,
          },
        });
        if (body.prompt) await queuePrompt(tx, auth, s!, body.prompt);
        const dto = await svc.emitSession(tx, s!.id);
        return dto!;
      }),
  );

  async function queuePrompt(tx: Tx, auth: AuthContext, s: SessionRow, body: string) {
    const [{ pos } = { pos: 0 }] = await tx
      .select({ pos: max(workPrompts.position) })
      .from(workPrompts)
      .where(eq(workPrompts.workSessionId, s.id));
    const [p] = await tx
      .insert(workPrompts)
      .values({
        organizationId: auth.organizationId,
        workSessionId: s.id,
        authorUserId: auth.userId,
        originDeviceId: null,
        body,
        position: Number(pos ?? 0) + 1,
      })
      .returning();
    await core.audit.record(tx, {
      action: "work_prompt.queued",
      resourceType: "work_prompt",
      resourceId: p!.id,
      sessionId: s.id,
      deviceId: s.deviceId,
      clientKind: auth.clientKind,
      metadata: {
        promptId: p!.id,
        authorUserId: auth.userId,
        originDeviceId: null,
        executionDeviceId: s.deviceId,
        workSessionId: s.id,
        length: body.length,
      },
    });
    await svc.emitPrompt(tx, p!);
    return p!;
  }

  app.get(
    "/work-sessions/:id",
    { ...user, schema: { tags, params: SessionParams, response: { 200: WorkSessionDetail } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const session = await svc.session(tx, req.params.id);
        if (!session) throw notFound("Work session not found");
        const facts = await sessionFacts(tx, authOf(req), session);
        await perms.assertCan(req, tx, "work_session.read", facts, { hideAs404: true });
        const viewerCan = await perms.viewerCan(req, tx, facts, SESSION_VIEWER_CAN);
        const topic = wsTopic(session.id);
        const [prompts, approvals, lastSeq, rows] = await Promise.all([
          svc.prompts(tx, session.id),
          svc.approvals(tx, session.id),
          core.realtime.lastSeq(tx, topic),
          tx
            .select({ seq: streamEvents.seq, payload: streamEvents.payload })
            .from(streamEvents)
            .where(and(eq(streamEvents.streamId, topic), eq(streamEvents.type, "work_session.event")))
            .orderBy(desc(streamEvents.seq))
            .limit(EVENT_WINDOW),
        ]);
        const events = rows
          .reverse()
          .map((r) => {
            const parsed = WorkSessionEventPayload.safeParse(r.payload);
            return parsed.success ? { seq: r.seq, at: parsed.data.at, event: parsed.data.event } : null;
          })
          .filter((e) => e !== null);
        return { session, prompts, approvals, events, lastSeq, viewerCan };
      }),
  );

  app.post(
    "/work-sessions/:id/prompts",
    {
      ...user,
      schema: { tags, params: SessionParams, body: CreatePromptRequest, response: { 200: WorkPrompt } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const s = await lockedFor(req, tx, req.params.id, "work_session.prompt");
        if (s.status === "archived") throw conflict("This session is archived", "session_archived");
        await joinConversation(tx, auth, s);
        const p = await queuePrompt(tx, auth, s, req.body.body);
        if (s.status === "failed" || s.status === "completed") await svc.restart(tx, s);
        else await svc.tryDispatch(tx, s);
        await svc.emitSession(tx, s.id);
        const [fresh] = await tx.select().from(workPrompts).where(eq(workPrompts.id, p.id));
        return (await svc.prompts(tx, s.id)).find((x) => x.id === fresh!.id)!;
      }),
  );

  async function updatePrompt(
    req: FastifyRequest,
    tx: Tx,
    sessionId: string,
    promptId: string,
    change: z.infer<typeof UpdatePromptRequest>,
  ) {
    const auth = authOf(req);
    const s = await lockedFor(req, tx, sessionId, "work_session.prompt");
    const [p] = await tx
      .select()
      .from(workPrompts)
      .where(and(eq(workPrompts.id, promptId), eq(workPrompts.workSessionId, s.id)));
    if (!p) throw notFound("Prompt not found");
    if (p.status !== "queued") throw conflict("Only queued prompts can be changed", "prompt_not_queued");
    if (change.status === "cancelled") {
      const [row] = await tx
        .update(workPrompts)
        .set({ status: "cancelled", completedAt: sql`now()` })
        .where(eq(workPrompts.id, p.id))
        .returning();
      await svc.emitPrompt(tx, row!);
      await core.audit.record(tx, {
        action: "work_prompt.cancelled",
        resourceType: "work_prompt",
        resourceId: p.id,
        sessionId: s.id,
        metadata: { promptId: p.id, authorUserId: p.authorUserId, cancelledBy: auth.userId },
      });
      await svc.emitSession(tx, s.id);
      return;
    }
    if (change.body !== undefined && change.body !== p.body) {
      const [row] = await tx
        .update(workPrompts)
        .set({ body: change.body })
        .where(eq(workPrompts.id, p.id))
        .returning();
      await svc.emitPrompt(tx, row!);
      await core.audit.record(tx, {
        action: "work_prompt.edited",
        resourceType: "work_prompt",
        resourceId: p.id,
        sessionId: s.id,
        metadata: { promptId: p.id, authorUserId: p.authorUserId, editedBy: auth.userId },
      });
    }
    if (change.index !== undefined) {
      const queued = await tx
        .select()
        .from(workPrompts)
        .where(and(eq(workPrompts.workSessionId, s.id), eq(workPrompts.status, "queued")))
        .orderBy(asc(workPrompts.position), asc(workPrompts.createdAt));
      const order = queued.filter((q) => q.id !== p.id);
      order.splice(Math.min(change.index, order.length), 0, p);
      const base = Math.min(...queued.map((q) => q.position));
      for (const [i, q] of order.entries()) {
        if (q.position === base + i) continue;
        const [row] = await tx
          .update(workPrompts)
          .set({ position: base + i })
          .where(eq(workPrompts.id, q.id))
          .returning();
        await svc.emitPrompt(tx, row!);
      }
    }
  }

  app.patch(
    "/work-sessions/:id/prompts/:pid",
    { ...user, schema: { tags, params: PromptParams, body: UpdatePromptRequest, response: { 200: Ok } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await updatePrompt(req, tx, req.params.id, req.params.pid, req.body);
        return { ok: true as const };
      }),
  );

  app.delete(
    "/work-sessions/:id/prompts/:pid",
    { ...user, schema: { tags, params: PromptParams, response: { 200: Ok } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await updatePrompt(req, tx, req.params.id, req.params.pid, { status: "cancelled" });
        return { ok: true as const };
      }),
  );

  app.post(
    "/work-sessions/:id/interrupt",
    { ...user, schema: { tags, params: SessionParams, response: { 200: Ok } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const s = await lockedFor(req, tx, req.params.id, "work_session.interrupt");
        if (s.status !== "running" && s.status !== "waiting_approval") {
          throw conflict("Nothing is running", "not_running");
        }
        await hub.enqueue(tx, { deviceId: s.deviceId, workSessionId: s.id, kind: "interrupt", payload: {} });
        await core.audit.record(tx, {
          action: "work_session.interrupted",
          resourceType: "work_session",
          resourceId: s.id,
          sessionId: s.id,
          deviceId: s.deviceId,
        });
        return { ok: true as const };
      }),
  );

  app.post(
    "/work-sessions/:id/approvals/:aid",
    {
      ...user,
      schema: { tags, params: ApprovalParams, body: ResolveApprovalRequest, response: { 200: WorkApproval } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const s = await locked(tx, req.params.id);
        const [approval] = await tx
          .select({ request: workApprovals.request })
          .from(workApprovals)
          .where(and(eq(workApprovals.id, req.params.aid), eq(workApprovals.workSessionId, s.id)));
        if (!approval) throw notFound("Approval not found");
        // Creator, device owner or admin; a Tool-layer rule on the requested tool still wins.
        await perms.assertCan(
          req,
          tx,
          "work_session.approve",
          await sessionFacts(tx, auth, s, approval.request.tool),
        );
        const { decision, comment } = req.body;
        // Decided exactly once: the conditional update is the arbiter between concurrent deciders.
        const [row] = await tx
          .update(workApprovals)
          .set({
            status: decision === "deny" ? "denied" : "approved",
            decision,
            decidedBy: auth.userId,
            comment: comment || null,
            decidedAt: sql`now()`,
          })
          .where(
            and(
              eq(workApprovals.id, req.params.aid),
              eq(workApprovals.workSessionId, s.id),
              eq(workApprovals.status, "pending"),
            ),
          )
          .returning();
        if (!row) {
          const [exists] = await tx
            .select({ id: workApprovals.id })
            .from(workApprovals)
            .where(and(eq(workApprovals.id, req.params.aid), eq(workApprovals.workSessionId, s.id)));
          if (!exists) throw notFound("Approval not found");
          throw conflict("This request was already decided", "approval_already_decided");
        }
        await hub.enqueue(tx, {
          deviceId: s.deviceId,
          workSessionId: s.id,
          kind: "approval.resolve",
          payload: { approvalId: row.id, decision, ...(comment ? { comment } : {}) },
        });
        await core.audit.record(tx, {
          action: "work_approval.resolved",
          resourceType: "work_approval",
          resourceId: row.id,
          sessionId: s.id,
          deviceId: s.deviceId,
          result: decision === "deny" ? "denied" : "success",
          metadata: { decision, tool: row.request.tool, paths: row.request.paths, comment: comment ?? null },
        });
        await svc.emitApproval(tx, row);
        await svc.emitSession(tx, s.id);
        return (await svc.approvals(tx, s.id)).find((a) => a.id === row.id)!;
      }),
  );

  app.get(
    "/work-sessions/:id/diff",
    { ...user, schema: { tags, params: SessionParams, response: { 200: WorkSessionDiff } } },
    async (req) => {
      const requestId = randomUUID();
      // Subscribe before the command can reach the device so the answer is never missed.
      const answer = hub.waitForDiff(requestId, DIFF_TIMEOUT_MS);
      await core.db
        .withTenant(tenant(req), async (tx) => {
          const [row] = await tx
            .select({ s: workSessions, d: devices, p: projects })
            .from(workSessions)
            .innerJoin(devices, eq(devices.id, workSessions.deviceId))
            .innerJoin(projects, eq(projects.id, workSessions.projectId))
            .where(eq(workSessions.id, req.params.id));
          if (!row) throw notFound("Work session not found");
          await perms.assertCan(
            req,
            tx,
            "work_session.read",
            workSessionResource(
              {
                createdBy: row.s.createdBy,
                deviceOwnerUserId: row.d.ownerUserId,
                deviceRevoked: row.d.revokedAt !== null,
              },
              authOf(req).userId,
            ),
            { hideAs404: true },
          );
          if (row.d.status !== "online" || row.d.revokedAt) {
            throw conflict(`${row.d.name} is offline`, "device_offline");
          }
          await hub.enqueue(tx, {
            id: requestId,
            deviceId: row.d.id,
            workSessionId: row.s.id,
            kind: "diff.request",
            payload: { projectLocalId: row.p.localId },
          });
        })
        .catch(async (err) => {
          void answer.catch(() => null);
          throw err;
        });
      const result = await answer;
      if (!result) throw new HttpError(504, "device_timeout", "The device did not answer in time");
      return {
        files: result.files.filter((f) => onlyRelativePaths([f.path]).length === 1),
        patch: result.patch,
        truncated: result.truncated ?? false,
        branch: result.branch ?? null,
        headSha: result.headSha ?? null,
        generatedAt: new Date().toISOString(),
      };
    },
  );

  app.post(
    "/work-sessions/:id/archive",
    { ...user, schema: { tags, params: SessionParams, response: { 200: Ok } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const s = await locked(tx, req.params.id);
        await perms.assertCan(req, tx, "work_session.archive", await sessionFacts(tx, auth, s));
        if (s.status === "archived") return { ok: true as const };
        const cancelled = await tx
          .update(workPrompts)
          .set({ status: "cancelled", completedAt: sql`now()` })
          .where(and(eq(workPrompts.workSessionId, s.id), eq(workPrompts.status, "queued")))
          .returning();
        for (const p of cancelled) await svc.emitPrompt(tx, p);
        await hub.enqueue(tx, {
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
        });
        await svc.setStatus(tx, s, "archived");
        return { ok: true as const };
      }),
  );
}

function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text
    .split("\n")
    .find((l) => l.trim())
    ?.trim();
  if (!line) return undefined;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
