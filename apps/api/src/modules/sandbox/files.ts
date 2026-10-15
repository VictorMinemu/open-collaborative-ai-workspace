import {
  IdParams,
  SANDBOX_REFUSAL_STATUS,
  SandboxFileList,
  SandboxFilePath,
  type SandboxRefusal,
  SandboxRelativePath,
} from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { HttpError, notFound } from "../../lib/errors";
import { agentResource, type PermissionService } from "../organization";
import { type SandboxdClient, SandboxdRefusedError } from "./client";
import { loadSandboxBot } from "./service";

/**
 * People's file routes for a bot's sandbox (07.8-11; SBX-05; D-04, F-9; P-04). Who may use them is decided by the
 * resolver alone: `sandbox.files` on the bot, which needs the person's `bot.configure` on that bot and the Sandbox module
 * not denied for them (policy.ts PREREQUISITES). This file never reads a role, a relation or a rule. Anyone the resolver
 * refuses gets exactly the 404 of an unknown bot, so nobody learns the bot or its files exist.
 *
 * Bytes travel only through the API: a download is an attachment (`nosniff`, a sandboxing CSP, no cache), never a
 * sandbox URL, container, volume or host path. sandboxd's own errors are mapped to fixed codes and never echoed. Audit
 * rows carry the bot, counts and sizes only: never a path, a name or content. The Docker-side checks (the real path
 * under `/workspace`, the soft quota) stay sandboxd's (07.8-09); the API checks the shape first.
 */

const tags = ["sandbox"];
/** A plain JSON op (list, stat, delete, lifecycle). */
const CALL_TIMEOUT_MS = 30_000;
/** A transfer of up to 50 MiB (base64 on the wire to sandboxd). */
const TRANSFER_TIMEOUT_MS = 120_000;

/** Every code a people's file route can answer with besides the resolver's 404. */
export type FileRefusal = SandboxRefusal | "upload_exists";

const MESSAGES: Partial<Record<FileRefusal, string>> = {
  invalid_path: "That path is not inside the workspace",
  not_found: "Not found in the sandbox",
  too_large: "That file is too large",
  disk_full: "The bot's workspace does not have room for this",
  upload_exists: "A file with that name already exists",
  busy: "The sandbox is busy",
  killed: "An admin stopped every sandbox of this organization",
  sandbox_off: "Sandbox & Browser is off for this organization",
  bot_off: "The sandbox is off for this bot",
  cap_reached: "The organization runs as many sandboxes as it allows",
  cpu_budget: "The organization used its sandbox CPU time for today",
  timeout: "The sandbox did not answer in time",
  service_unavailable: "The sandbox service is not available",
};

/** A refusal with its contract status (`upload_exists` is the people's 409). */
export function fileRefusal(code: FileRefusal): HttpError {
  const status = code === "upload_exists" ? 409 : SANDBOX_REFUSAL_STATUS[code];
  return new HttpError(status, code, MESSAGES[code] ?? "The sandbox refused this");
}

/** sandboxd's answer to a decided call → a fixed people's code (anything unexpected is the service failing). */
export function fromSandboxd(err: unknown): HttpError {
  if (!(err instanceof SandboxdRefusedError)) return fileRefusal("service_unavailable");
  switch (err.code) {
    case "not_found":
    case "invalid_path":
    case "too_large":
    case "disk_full":
    case "busy":
    case "killed":
    case "timeout":
      return fileRefusal(err.code);
    case "exists":
      return fileRefusal("upload_exists");
    case "limit_reached":
      return fileRefusal("cap_reached");
    default:
      return fileRefusal("service_unavailable");
  }
}

/** A folder (`""` = the workspace root). */
export function folderPath(raw: string): string {
  const p = SandboxRelativePath.safeParse(raw);
  if (!p.success) throw fileRefusal("invalid_path");
  return p.data;
}

/** A file or folder, never the root. */
export function filePath(raw: string): string {
  const p = SandboxFilePath.safeParse(raw);
  if (!p.success) throw fileRefusal("invalid_path");
  return p.data;
}

export interface FilesBot {
  id: string;
  scope: "team" | "personal";
}

/**
 * The bot whose sandbox the caller wants, decided by the resolver inside the request's tenant: an unknown id and a
 * refused `sandbox.files` answer the same 404 (`hideAs404`). The precondition that makes it "configurers only" is the
 * resolver's (policy.ts), never this module's.
 */
export async function filesBot(
  perms: PermissionService,
  req: FastifyRequest,
  tx: Tx,
  agentId: string,
): Promise<FilesBot> {
  const bot = await loadSandboxBot(tx, agentId);
  if (!bot) throw notFound();
  await perms.assertCan(req, tx, "sandbox.files", agentResource(bot.facts, authOf(req).userId), {
    hideAs404: true,
  });
  return { id: bot.id, scope: bot.facts.scope };
}

/**
 * RFC 6266 `Content-Disposition: attachment` with an ASCII fallback and the exact name as RFC 5987 `filename*`. A local
 * copy of `artifact/disposition.ts` `contentDisposition`, which the artifact module's public index does not export.
 */
export function attachmentDisposition(filename: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const clean = filename.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim() || "file";
  const ascii =
    clean
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^\x20-\x7e]|["\\]/g, "_")
      .trim() || "file";
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const PathQuery = z.object({ path: z.string().max(4096).default("") });

export interface FileRouteDeps {
  perms: PermissionService;
  client: SandboxdClient | null;
}

export function registerSandboxFileRoutes(app: App, core: Core, deps: FileRouteDeps): void {
  const user = { config: { authz: "user" as const }, preHandler: [core.identity.requireUser] };

  /** The decided bot and the sandboxd client; 503 when sandboxd is not configured. */
  async function decided(req: FastifyRequest, agentId: string) {
    const bot = await core.db.withTenant(tenant(req), (tx) => filesBot(deps.perms, req, tx, agentId));
    if (!deps.client) throw fileRefusal("service_unavailable");
    return { bot, client: deps.client, target: { orgId: authOf(req).organizationId, agentId: bot.id } };
  }

  async function audit(
    req: FastifyRequest,
    agentId: string,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    await core.db.withTenant(tenant(req), (tx) =>
      core.audit.record(tx, {
        action,
        resourceType: "agent",
        resourceId: agentId,
        agentId,
        metadata,
      }),
    );
  }

  app.get(
    "/agents/:id/sandbox/files",
    {
      ...user,
      schema: { tags, params: IdParams, querystring: PathQuery, response: { 200: SandboxFileList } },
    },
    async (req) => {
      const { client, target } = await decided(req, req.params.id);
      const path = folderPath(req.query.path);
      try {
        return await client.call("filesList", { target, path, hidden: true }, { timeoutMs: CALL_TIMEOUT_MS });
      } catch (err) {
        // A bot whose workspace was never created has an empty root.
        if (path === "" && err instanceof SandboxdRefusedError && err.code === "not_found") {
          return { path: "", entries: [], more: 0 };
        }
        throw fromSandboxd(err);
      }
    },
  );

  app.get(
    "/agents/:id/sandbox/files/download",
    { ...user, schema: { tags, params: IdParams, querystring: PathQuery } },
    async (req, reply) => {
      const { bot, client, target } = await decided(req, req.params.id);
      const path = filePath(req.query.path);
      let file: { name: string; size: number; data: string };
      try {
        file = await client.call("filesDownload", { target, path }, { timeoutMs: TRANSFER_TIMEOUT_MS });
      } catch (err) {
        throw fromSandboxd(err);
      }
      const bytes = Buffer.from(file.data, "base64");
      await audit(req, bot.id, "sandbox.file_downloaded", { size: bytes.length });
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", attachmentDisposition(file.name))
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'; sandbox")
        .header("cache-control", "no-store")
        .send(bytes);
    },
  );
}
