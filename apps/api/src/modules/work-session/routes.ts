import { randomUUID } from "node:crypto";
import {
  CreatePromptRequest,
  CreateWorkSessionRequest,
  Ok,
  onlyRelativePaths,
  ResolveApprovalRequest,
  RuntimeControls,
  RuntimeId,
  SessionCommandRequest,
  SessionCommandResult,
  SessionControls,
  type SessionSettingsPatch,
  UpdatePromptRequest,
  UpdateWorkSessionSettingsRequest,
  UpdateWorkZonePolicyRequest,
  WorkApproval,
  WorkPrompt,
  WorkSession,
  WorkSessionDetail,
  WorkSessionDiff,
  WorkSessionEventPayload,
  WorkSessionList,
  type WorkZonePolicy,
  WorkZonePolicyView,
} from "@ocw/contracts";
import { devices, projects, streamEvents, type Tx, workApprovals, workPrompts, workSessions } from "@ocw/db";
import { and, asc, desc, eq, inArray, lte, ne, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { markDecided } from "../../authz";
import { type App, type AuthContext, authOf, type Core, tenant } from "../../core";
import { conflict, HttpError, notFound } from "../../lib/errors";
import { type DeviceAccess, type DeviceHub, deviceFacts, loadDeviceAccess } from "../device";
import {
  AuthzDeniedError,
  createPermissionService,
  type ResourceFacts,
  workSessionResource,
} from "../organization";
import { loadControlsContext } from "./context";
import {
  buildRuntimeControls,
  buildSessionControls,
  type ControlsContext,
  catalogFor,
  decideSettings,
  pickSettings,
  requestedSettings,
  storedSettings,
} from "./controls";
import { sessionFacts as sharedSessionFacts } from "./facts";
import { currentSessionModel, imagesNotSupported } from "./images";
import { knownModels, loadWorkZonePolicy, saveWorkZonePolicy } from "./policy";
import { type SessionRow, type WorkSessionService, wsTopic } from "./service";
import { runSessionCommand } from "./slash";
import {
  createWorkSession,
  deviceUnusableMessage,
  isSessionCommand,
  joinConversation,
  queueWorkPrompt,
  SLASH_COMMAND_MESSAGE,
  settingsDenied,
  type WorkSessionStartDeps,
  type WorkSessionStartFailure,
} from "./start";

const SessionParams = z.object({ id: z.uuid() });
const PromptParams = z.object({ id: z.uuid(), pid: z.uuid() });
const ApprovalParams = z.object({ id: z.uuid(), aid: z.uuid() });
const ListQuery = z.object({ archived: z.enum(["0", "1"]).optional() });
const WorkZoneControlsQuery = z.object({ deviceId: z.uuid(), runtime: RuntimeId });

const EVENT_WINDOW = 1500;
const DIFF_TIMEOUT_MS = 20_000;

/** Permissions a session view renders controls for (`WorkSessionDetail.viewerCan`). */
const SESSION_VIEWER_CAN = [
  "work_session.prompt",
  "work_session.configure",
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
  /** Session creation (07.5-05): the route and Work Zone proposals start sessions through `createWorkSession`. */
  const startDeps: WorkSessionStartDeps = { core, perms, svc, hub };

  /** Lock + load a session and assert `permission` on it (404 when it is not in the caller's org). */
  async function lockedFor(
    req: FastifyRequest,
    tx: Tx,
    id: string,
    permission: "work_session.prompt" | "work_session.interrupt" | "work_session.configure",
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
  function sessionFacts(
    tx: Tx,
    auth: AuthContext,
    s: Pick<SessionRow, "createdBy" | "deviceId">,
    tool?: string,
  ): Promise<ResourceFacts> {
    return sharedSessionFacts(tx, auth.userId, s, tool);
  }

  /**
   * What the caller may pick on a device (context.ts): org policy ∩ device opt-in ∩ the caller's cap ∩ grain ∩
   * catalog ∩ inventory. Inside a session unlisted controllers get the device's floor (P-07); a 404 when the
   * device is not visible (never happens for a session of this tenant).
   */
  async function controlsFor(
    tx: Tx,
    auth: AuthContext,
    deviceId: string,
    runtime: RuntimeId,
    inSession: boolean,
    access?: DeviceAccess,
  ) {
    const loaded = await loadControlsContext(tx, perms, {
      deviceId,
      runtime,
      userId: auth.userId,
      inSession,
      ...(access ? { access } : {}),
    });
    if (!loaded) throw notFound("Device not found");
    return loaded.ctx;
  }

  /** Device layer for a new session: own, shared or granted (device_not_shared), never revoked (device_revoked). */
  async function assertDeviceUsable(
    req: FastifyRequest,
    tx: Tx,
    d: typeof devices.$inferSelect,
    access: DeviceAccess,
  ): Promise<void> {
    await perms.assertCan(req, tx, "device.use", deviceFacts(d, authOf(req).userId, access)).catch((err) => {
      if (!(err instanceof AuthzDeniedError)) throw err;
      throw new AuthzDeniedError(err.denial, { message: deviceUnusableMessage(err.denial, d.name) });
    });
  }

  // ---------------------------------------------------------------- organization Work Zone policy (D-02, D-11)

  const manage = {
    config: { authz: "user" as const },
    preHandler: [requireUser, perms.requirePermission("work_zone.manage")],
  };
  const policyView = async (tx: Tx, policy: WorkZonePolicy): Promise<WorkZonePolicyView> => ({
    ...policy,
    knownModels: await knownModels(tx),
  });

  app.get(
    "/work-zone-policy",
    { ...manage, schema: { tags, response: { 200: WorkZonePolicyView } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => policyView(tx, await loadWorkZonePolicy(tx))),
  );

  app.put(
    "/work-zone-policy",
    { ...manage, schema: { tags, body: UpdateWorkZonePolicyRequest, response: { 200: WorkZonePolicyView } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const { policy, changed } = await saveWorkZonePolicy(tx, req.body, auth.userId);
        if (changed.length > 0) {
          await core.audit.record(tx, {
            action: "work_zone_policy.updated",
            resourceType: "work_zone_policy",
            resourceId: auth.organizationId,
            clientKind: auth.clientKind,
            metadata: { changed },
          });
          // ADR-0012: a tighter policy reaches live sessions at once (downgrade, audited, device told).
          await svc.reauthorizeOrg(tx, "policy");
        }
        return policyView(tx, policy);
      }),
  );

  app.get(
    "/work-sessions",
    {
      config: { authz: "user" },
      preHandler: [requireUser, perms.requirePermission("work_session.read")],
      schema: { tags, querystring: ListQuery, response: { 200: WorkSessionList } },
    },
    async (req) => ({
      sessions: await core.db.withTenant(tenant(req), async (tx) => {
        const rows = await svc.sessions(
          tx,
          req.query.archived === "1" ? undefined : ne(workSessions.status, "archived"),
        );
        // Per-session decision (same facts as GET /work-sessions/:id): a unit/device deny rule or a revoked
        // host must hide a session from the list exactly as it does from the detail route.
        const deviceIds = [...new Set(rows.map((r) => r.deviceId))];
        const hosts = deviceIds.length
          ? await tx
              .select({ id: devices.id, owner: devices.ownerUserId, revokedAt: devices.revokedAt })
              .from(devices)
              .where(inArray(devices.id, deviceIds))
          : [];
        const byId = new Map(hosts.map((h) => [h.id, h]));
        const userId = authOf(req).userId;
        return perms.filter(req, tx, rows, "work_session.read", (r) => {
          const host = byId.get(r.deviceId);
          return workSessionResource(
            {
              createdBy: r.createdBy,
              deviceOwnerUserId: host?.owner ?? null,
              deviceRevoked: !host || host.revokedAt !== null,
              tool: null,
            },
            userId,
          );
        });
      }),
    }),
  );

  app.post(
    "/work-sessions",
    { ...user, schema: { tags, body: CreateWorkSessionRequest, response: { 200: WorkSession } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const result = await createWorkSession(tx, startDeps, authOf(req), req.body);
        // The resolver decided `work_session.create` (and `device.use`) inside createWorkSession.
        markDecided(req);
        if (!result.ok) throw startError(result);
        return result.session;
      }),
  );

  /**
   * The one settings path (D-07, D-13, ADR-0012): `PATCH /settings` and settings slash commands. Call with the
   * session LOCKED and `work_session.configure` asserted. Policy ∩ opt-in ∩ cap ∩ grain ∩ catalog decide; the
   * change is stored, sent to the device as `session.configure`, audited (with its `source`) and emitted live.
   */
  async function applySettingsChange(
    req: FastifyRequest,
    tx: Tx,
    s: SessionRow,
    patch: SessionSettingsPatch,
    source: "user" | "slash_command",
  ): Promise<{ session: WorkSession; ctx: ControlsContext; changed: boolean }> {
    const auth = authOf(req);
    if (s.status === "archived") throw conflict("This session is archived", "session_archived");
    const current = requestedSettings(s);
    const ctx = await controlsFor(tx, auth, s.deviceId, s.runtime, true);
    const decision = decideSettings(current, patch, s.runtime, ctx);
    if (!decision.ok) throw settingsDenied(decision.field, decision.reason);
    const keys = [...decision.changed, ...decision.adjusted];
    if (keys.length === 0) return { session: (await svc.session(tx, s.id))!, ctx, changed: false };
    const next = decision.next;
    await tx
      .update(workSessions)
      .set({
        model: next.model ?? null,
        permissionMode: next.permissionMode ?? s.permissionMode,
        settings: storedSettings(next),
        settingsPending: true,
        updatedAt: sql`now()`,
      })
      .where(eq(workSessions.id, s.id));
    // D-14: the device holds the change until the running turn ends and applies it before the next one.
    await hub.enqueue(tx, {
      deviceId: s.deviceId,
      workSessionId: s.id,
      kind: "session.configure",
      payload: { settings: pickSettings(next, keys), reason: source },
    });
    await core.audit.record(tx, {
      action: "work_session.settings_changed",
      resourceType: "work_session",
      resourceId: s.id,
      sessionId: s.id,
      deviceId: s.deviceId,
      clientKind: auth.clientKind,
      metadata: {
        changed: decision.changed,
        from: pickSettings(current, keys),
        to: pickSettings(next, keys),
        adjusted: decision.adjusted,
        source,
      },
    });
    // D-04: entering and leaving Full access are audited on their own (actor, device, session, org).
    const from = current.permissionMode;
    const to = next.permissionMode ?? from;
    if ((from === "fullAccess") !== (to === "fullAccess")) {
      await core.audit.record(tx, {
        action: to === "fullAccess" ? "work_session.full_access_entered" : "work_session.full_access_left",
        resourceType: "work_session",
        resourceId: s.id,
        sessionId: s.id,
        deviceId: s.deviceId,
        clientKind: auth.clientKind,
        metadata: { from, to, source },
      });
    }
    return { session: (await svc.emitSession(tx, s.id))!, ctx, changed: true };
  }

  /**
   * Queue a prompt from the caller and dispatch it (or restart a finished session). Call with the session LOCKED
   * and `work_session.prompt` asserted.
   */
  async function submitPrompt(
    req: FastifyRequest,
    tx: Tx,
    s: SessionRow,
    body: string,
    attachmentIds: readonly string[] = [],
  ): Promise<WorkPrompt> {
    const auth = authOf(req);
    if (s.status === "archived") throw conflict("This session is archived", "session_archived");
    assertNotSlashCommand(body, s.runtime);
    if (attachmentIds.length > 0) {
      // D-05, P-08: a model that says it cannot read images is refused before anything is queued or linked.
      const [d] = await tx
        .select({ catalog: devices.runtimeCatalog })
        .from(devices)
        .where(eq(devices.id, s.deviceId));
      const current = currentSessionModel(catalogFor(d?.catalog, s.runtime), s);
      if (current?.imageInput === false) throw imagesNotSupported(current);
    }
    await joinConversation(tx, auth, s);
    const p = await queueWorkPrompt(tx, startDeps, auth, s, body, attachmentIds);
    if (s.status === "failed" || s.status === "completed") await svc.restart(tx, s);
    else await svc.tryDispatch(tx, s);
    await svc.emitSession(tx, s.id);
    return (await svc.prompts(tx, s.id)).find((x) => x.id === p.id)!;
  }

  app.get(
    "/work-sessions/:id",
    { ...user, schema: { tags, params: SessionParams, response: { 200: WorkSessionDetail } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const found = await svc.session(tx, req.params.id);
        if (!found) throw notFound("Work session not found");
        const facts = await sessionFacts(tx, authOf(req), found);
        await perms.assertCan(req, tx, "work_session.read", facts, { hideAs404: true });
        const viewerCan = await perms.viewerCan(req, tx, facts, SESSION_VIEWER_CAN);
        const topic = wsTopic(found.id);
        // Snapshot cut: read lastSeq FIRST, then state and only events up to it. Each statement sees its own
        // snapshot, so an event committed in between would otherwise be both in `events` and replayed after
        // `lastSeq` (rendered twice); anything newer than the cut arrives through the topic replay instead.
        const lastSeq = await core.realtime.lastSeq(tx, topic);
        const session = (await svc.session(tx, found.id)) ?? found;
        const prompts = await svc.prompts(tx, session.id);
        const approvals = await svc.approvals(tx, session.id);
        const rows = await tx
          .select({ seq: streamEvents.seq, payload: streamEvents.payload })
          .from(streamEvents)
          .where(
            and(
              eq(streamEvents.streamId, topic),
              eq(streamEvents.type, "work_session.event"),
              lte(streamEvents.seq, lastSeq),
            ),
          )
          .orderBy(desc(streamEvents.seq))
          .limit(EVENT_WINDOW);
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
        const s = await lockedFor(req, tx, req.params.id, "work_session.prompt");
        return submitPrompt(req, tx, s, req.body.body, req.body.attachmentIds ?? []);
      }),
  );

  app.post(
    "/work-sessions/:id/commands",
    {
      ...user,
      schema: {
        tags,
        params: SessionParams,
        body: SessionCommandRequest,
        response: { 200: SessionCommandResult },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), (tx) =>
        runSessionCommand(
          req,
          tx,
          { core, locked, lockedFor, applySettingsChange, submitPrompt },
          req.params.id,
          req.body.text,
        ),
      ),
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
      assertNotSlashCommand(change.body, s.runtime);
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

  app.get(
    "/work-sessions/:id/controls",
    { ...user, schema: { tags, params: SessionParams, response: { 200: SessionControls } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const session = await svc.session(tx, req.params.id);
        if (!session) throw notFound("Work session not found");
        await perms.assertCan(req, tx, "work_session.read", await sessionFacts(tx, auth, session), {
          hideAs404: true,
        });
        return buildSessionControls(
          session,
          await controlsFor(tx, auth, session.deviceId, session.runtime, true),
        );
      }),
  );

  app.patch(
    "/work-sessions/:id/settings",
    {
      ...user,
      schema: {
        tags,
        params: SessionParams,
        body: UpdateWorkSessionSettingsRequest,
        response: { 200: WorkSession },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const s = await lockedFor(req, tx, req.params.id, "work_session.configure");
        return (await applySettingsChange(req, tx, s, req.body, "user")).session;
      }),
  );

  app.get(
    "/work-zone/controls",
    { ...user, schema: { tags, querystring: WorkZoneControlsQuery, response: { 200: RuntimeControls } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const [d] = await tx.select().from(devices).where(eq(devices.id, req.query.deviceId));
        if (!d) throw notFound("Device not found");
        const access = await loadDeviceAccess(tx, auth.userId);
        await assertDeviceUsable(req, tx, d, access);
        return buildRuntimeControls(
          req.query.runtime,
          await controlsFor(tx, auth, d.id, req.query.runtime, false, access),
        );
      }),
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

/**
 * D-13: a prompt body that starts with a settings or refused slash command never enters the queue; it must go
 * through `POST /work-sessions/:id/commands`. Passthrough commands and slashes later in the text are prompts.
 */
function assertNotSlashCommand(body: string, runtime: RuntimeId): void {
  if (isSessionCommand(body, runtime)) throw new HttpError(400, "slash_command", SLASH_COMMAND_MESSAGE);
}

/** A refused start as the error `POST /work-sessions` has always answered with (status, code, message, denial). */
function startError(r: WorkSessionStartFailure): HttpError {
  switch (r.code) {
    case "not_allowed":
      return new AuthzDeniedError(r.denial);
    case "device_not_shared":
      return new AuthzDeniedError(r.denial, { message: r.message });
    case "project_not_found":
      return r.reason === "other_device" ? conflict(r.message) : notFound(r.message);
    case "device_offline":
    case "runtime_unavailable":
      return conflict(r.message, r.code);
    case "settings_denied":
      return settingsDenied(r.field, r.reason);
    case "prompt_not_allowed":
      return new HttpError(400, "slash_command", r.message);
  }
}
