import {
  DeleteMemoryFileQuery,
  EnsureMemoryScopeRequest,
  Id,
  MemoryFile,
  MemoryFileList,
  MemoryRevision,
  MemoryRevisionList,
  MemoryScope,
  MemoryScopeList,
  MemorySearchQuery,
  MemorySearchResult,
  Ok,
  RestoreMemoryRevisionRequest,
} from "@ocw/contracts";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { markDecided } from "../../authz";
import { type App, authOf, type Core, tenant } from "../../core";
import type { MemoryActor } from "./access";
import type { MemoryService } from "./index";
import { searchMemory } from "./search";

/**
 * The human memory API (MEM-01, MEM-02, MEM-07): `/api/v1/memory/*`, every route `authz: "user"`, decided by the
 * resolver inside the memory service (per scope and per file path). Unreadable or missing is 404 (another tenant's ids
 * and another person's private memory included); readable but not writable is 403.
 *
 * Paths and contents are read with loose schemas here on purpose: the service re-parses every path with the shared
 * grammar (400 `memory_path_invalid` with the reason) and owns the size limit (413 `memory_file_too_large`), so every
 * caller (REST, proposals, the Agent Channel) gets the same codes. A path in a query string never reaches the logs (the
 * request serializer drops query strings).
 */

const RawPath = z.string().max(1024);
const ExpectedVersion = z.number().int().positive();

const ScopeParams = z.object({ scopeId: Id });
const FileParams = z.object({ fileId: Id });
const RevisionParams = z.object({ fileId: Id, version: z.coerce.number().int().positive() });

const CreateBody = z.object({ path: RawPath, content: z.string() });
const UpdateBody = z.object({ content: z.string(), expectedVersion: ExpectedVersion });
const RenameBody = z.object({ path: RawPath, expectedVersion: ExpectedVersion });
const FolderQuery = z.object({ folder: RawPath.optional() });
const PathQuery = z.object({ path: RawPath });
const Forgotten = z.object({
  files: z.number().int().nonnegative(),
  revisions: z.number().int().nonnegative(),
});

export function registerMemoryRoutes(app: App, ctx: { core: Core; memory: MemoryService }): void {
  const { core, memory } = ctx;
  const tags = ["memory"];
  const user = { config: { authz: "user" as const }, onRequest: core.identity.requireUser };
  const me = (req: Parameters<typeof authOf>[0]): MemoryActor => ({
    kind: "user",
    userId: authOf(req).userId,
  });

  // Search (MEM-02, D-03): the per-user budget of the chat search (its own store), checked after requireUser so the
  // key is the user. The query text is never logged (the request serializer drops query strings).
  const searchLimit = app.rateLimit({
    max: core.env.OCW_SEARCH_RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: (req: FastifyRequest) => `memory-search:${req.auth?.userId ?? req.ip}`,
  });

  app.get(
    "/memory/search",
    {
      ...user,
      preHandler: searchLimit,
      schema: { tags, querystring: MemorySearchQuery, response: { 200: MemorySearchResult } },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), async (tx) => {
        const result = await searchMemory(
          tx,
          { core, memory },
          authOf(req).userId,
          req.query.q,
          req.query.scopeId,
        );
        // The hits are exactly the files the resolver let the viewer read (listScopes, listReadableFiles).
        markDecided(req);
        return result;
      });
    },
  );

  app.get(
    "/memory/scopes",
    { ...user, schema: { tags, response: { 200: MemoryScopeList } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), async (tx) => {
        const scopes = await memory.listScopes(tx, authOf(req).userId);
        markDecided(req);
        return { scopes };
      });
    },
  );

  app.post(
    "/memory/scopes",
    { ...user, schema: { tags, body: EnsureMemoryScopeRequest, response: { 200: MemoryScope } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const scope = await memory.openScope(tx, authOf(req).userId, req.body);
        markDecided(req);
        return scope;
      }),
  );

  app.delete(
    "/memory/scopes/:scopeId",
    { ...user, schema: { tags, params: ScopeParams, response: { 200: Forgotten } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const out = await memory.forgetScope(tx, me(req), req.params.scopeId);
        markDecided(req);
        return out;
      }),
  );

  app.get(
    "/memory/scopes/:scopeId/files",
    {
      ...user,
      schema: { tags, params: ScopeParams, querystring: FolderQuery, response: { 200: MemoryFileList } },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), async (tx) => {
        const actor = me(req);
        const files = await memory.listReadableFiles(tx, actor, req.params.scopeId, req.query.folder);
        const scope = await memory.scopeView(tx, actor, req.params.scopeId);
        markDecided(req);
        return { scope, files };
      });
    },
  );

  app.get(
    "/memory/scopes/:scopeId/file",
    { ...user, schema: { tags, params: ScopeParams, querystring: PathQuery, response: { 200: MemoryFile } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), async (tx) => {
        const file = await memory.readFile(tx, me(req), {
          scopeId: req.params.scopeId,
          path: req.query.path,
        });
        markDecided(req);
        return file;
      });
    },
  );

  app.post(
    "/memory/scopes/:scopeId/files",
    { ...user, schema: { tags, params: ScopeParams, body: CreateBody, response: { 200: MemoryFile } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const file = await memory.writeFile(tx, me(req), {
          op: "create",
          scopeId: req.params.scopeId,
          path: req.body.path,
          content: req.body.content,
        });
        markDecided(req);
        return file as MemoryFile;
      }),
  );

  app.get(
    "/memory/files/:fileId",
    { ...user, schema: { tags, params: FileParams, response: { 200: MemoryFile } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), async (tx) => {
        const file = await memory.readFile(tx, me(req), { fileId: req.params.fileId });
        markDecided(req);
        return file;
      });
    },
  );

  app.put(
    "/memory/files/:fileId",
    { ...user, schema: { tags, params: FileParams, body: UpdateBody, response: { 200: MemoryFile } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const file = await memory.writeFile(tx, me(req), {
          op: "update",
          fileId: req.params.fileId,
          content: req.body.content,
          expectedVersion: req.body.expectedVersion,
        });
        markDecided(req);
        return file as MemoryFile;
      }),
  );

  app.post(
    "/memory/files/:fileId/rename",
    { ...user, schema: { tags, params: FileParams, body: RenameBody, response: { 200: MemoryFile } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const file = await memory.writeFile(tx, me(req), {
          op: "rename",
          fileId: req.params.fileId,
          path: req.body.path,
          expectedVersion: req.body.expectedVersion,
        });
        markDecided(req);
        return file as MemoryFile;
      }),
  );

  app.delete(
    "/memory/files/:fileId",
    {
      ...user,
      schema: { tags, params: FileParams, querystring: DeleteMemoryFileQuery, response: { 200: Ok } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await memory.writeFile(tx, me(req), {
          op: "delete",
          fileId: req.params.fileId,
          expectedVersion: req.query.expectedVersion,
        });
        markDecided(req);
        return { ok: true as const };
      }),
  );

  app.get(
    "/memory/files/:fileId/revisions",
    { ...user, schema: { tags, params: FileParams, response: { 200: MemoryRevisionList } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), async (tx) => {
        const revisions = await memory.listRevisions(tx, me(req), req.params.fileId);
        markDecided(req);
        return { revisions };
      });
    },
  );

  app.get(
    "/memory/files/:fileId/revisions/:version",
    { ...user, schema: { tags, params: RevisionParams, response: { 200: MemoryRevision } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), async (tx) => {
        const revision = await memory.readRevision(tx, me(req), req.params.fileId, req.params.version);
        markDecided(req);
        return revision;
      });
    },
  );

  app.post(
    "/memory/files/:fileId/restore",
    {
      ...user,
      schema: { tags, params: FileParams, body: RestoreMemoryRevisionRequest, response: { 200: MemoryFile } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const file = await memory.writeFile(tx, me(req), {
          op: "restore",
          fileId: req.params.fileId,
          version: req.body.version,
          expectedVersion: req.body.expectedVersion,
        });
        markDecided(req);
        return file as MemoryFile;
      }),
  );
}
