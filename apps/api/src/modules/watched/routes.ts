import {
  CheckWatchedRecordRequest,
  CreateWatchedRecordRequest,
  IdParams,
  Ok,
  PreviewWatchedRecordRequest,
  PreviewWatchedRecordResponse,
  UpdateWatchedRecordRequest,
  WATCHED_LIMITS,
  WatchedRecord,
  WatchedRecordList,
  WatchedRecordListQuery,
  WatchOptions,
  WatchOptionsQuery,
} from "@ocw/contracts";
import type { FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
import { HttpError } from "../../lib/errors";
import { previewOf } from "./cards";
import { readWith } from "./check";
import { watchOptions } from "./options";
import {
  getWatched,
  linkWatched,
  listWatched,
  previewGuard,
  unlinkWatched,
  updateWatched,
  type WatchedCtx,
} from "./service";

const tags = ["watched-records"];

/** Why a preview read failed, as the dialog says it (R9): never the connector's own text. */
const PREVIEW_REFUSALS: Record<string, { status: number; message: string }> = {
  record_not_found: { status: 404, message: "No record with that id in this connector." },
  not_connected: { status: 409, message: "Connect (or reconnect) your account to this connector first." },
  unreadable: { status: 502, message: "The connector's answer isn't a record OCW can read." },
};

/**
 * REST of watched records (`/api/v1`, `authz: "user"`). Every handler decides through the resolver on the request
 * (strict authz); the preview's network read runs outside any transaction.
 */
export function registerWatchedRoutes(app: App, core: Core, ctx: WatchedCtx): void {
  const user = { config: { authz: "user" as const }, preHandler: [core.identity.requireUser] };

  app.get(
    "/watched-records",
    { ...user, schema: { tags, querystring: WatchedRecordListQuery, response: { 200: WatchedRecordList } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => listWatched(req, tx, ctx, req.query.conversationId));
    },
  );

  // 07.6-17: the watch dialog's options, decided with the link's own rules (posting + `record.watch`).
  app.get(
    "/watched-records/options",
    { ...user, schema: { tags, querystring: WatchOptionsQuery, response: { 200: WatchOptions } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => watchOptions(req, tx, ctx, req.query.conversationId));
    },
  );

  app.post(
    "/watched-records",
    { ...user, schema: { tags, body: CreateWatchedRecordRequest, response: { 201: WatchedRecord } } },
    async (req, reply) => {
      const created = await core.db.withTenant(tenant(req), (tx) => linkWatched(req, tx, ctx, req.body));
      return reply.code(201).send(created);
    },
  );

  // R9: read the record once for the link dialog; nothing is stored. Same rights and audience rule as a link, through
  // a bot of the board (CR-01), and at most 30 reads a minute per person (Redis-counted), so it is no enumeration tool.
  const previewLimit = app.rateLimit({
    max: 30,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => `watched-preview:${req.auth?.userId ?? req.ip}`,
  });
  app.post(
    "/watched-records/preview",
    {
      ...user,
      // After requireUser, so the key is the person, not the IP.
      preHandler: [core.identity.requireUser, previewLimit],
      schema: { tags, body: PreviewWatchedRecordRequest, response: { 200: PreviewWatchedRecordResponse } },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const body = req.body;
      const { organizationId, userId } = authOf(req);
      const { server, conversationId } = await core.db.withTenant(tenant(req), (tx) =>
        previewGuard(req, tx, ctx, body),
      );
      const outcome = await readWith(core, {
        organizationId,
        userId,
        server,
        readTool: body.readTool,
        idArg: body.idArg,
        externalRef: body.externalRef,
      });
      await core.db.withTenant(tenant(req), (tx) =>
        core.audit.record(tx, {
          action: "watched_record.previewed",
          resourceType: "mcp_server",
          resourceId: server.id,
          result: outcome.ok ? "success" : "error",
          metadata: { conversationId, mcpServerId: server.id, code: outcome.ok ? null : outcome.code },
        }),
      );
      if (outcome.ok) return previewOf(outcome.record);
      const code =
        outcome.status === "not_connected"
          ? "not_connected"
          : outcome.code === "record_not_found" || outcome.code === "unreadable"
            ? outcome.code
            : "connector_error";
      const refusal = PREVIEW_REFUSALS[code] ?? {
        status: 502,
        message: "The connector couldn't be read. Try again in a moment.",
      };
      throw new HttpError(refusal.status, code, refusal.message);
    },
  );

  app.patch(
    "/watched-records/:id",
    {
      ...user,
      schema: { tags, params: IdParams, body: UpdateWatchedRecordRequest, response: { 200: WatchedRecord } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), (tx) => updateWatched(req, tx, ctx, req.params.id, req.body)),
  );

  app.delete("/watched-records/:id", { ...user, schema: { tags, params: IdParams } }, async (req, reply) => {
    await core.db.withTenant(tenant(req), (tx) => unlinkWatched(req, tx, ctx, req.params.id));
    return reply.code(204).send();
  });

  // "Check now" (posters) and the thread being opened (any reader): at most once a minute per watch (T-07.6-07-04).
  app.post(
    "/watched-records/:id/check",
    {
      ...user,
      schema: { tags, params: IdParams, body: CheckWatchedRecordRequest, response: { 202: Ok } },
    },
    async (req, reply) => {
      const source = req.body.source;
      const queued = await core.db.withTenant(tenant(req), async (tx) => {
        const { row } = await getWatched(req, tx, ctx, req.params.id, source === "manual" ? "write" : "read");
        const jobId = await core.jobs.sendInTx(
          tx,
          "watched.check",
          { organizationId: row.organizationId, watchedRecordId: row.id, source },
          { singletonKey: `watched-check:${row.id}`, singletonSeconds: WATCHED_LIMITS.checkSingletonSeconds },
        );
        return jobId !== null;
      });
      if (!queued) {
        throw new HttpError(429, "check_rate_limited", "Checked just now. Try again in a minute.");
      }
      return reply.code(202).send({ ok: true });
    },
  );
}
