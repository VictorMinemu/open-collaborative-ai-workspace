import {
  IdParams,
  SANDBOX_LIMITS,
  SANDBOX_REFUSAL_STATUS,
  SandboxFileList,
  SandboxFilePath,
  SandboxFilePreview,
  type SandboxPreviewImageType,
  type SandboxRefusal,
  SandboxRelativePath,
  type SandboxRuntime,
  type SandboxState,
  SandboxStatusView,
} from "@ocw/contracts";
import { botSandboxes, sandboxPackageInstalls, type Tx } from "@ocw/db";
import { and, eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import { badRequest, HttpError, notFound } from "../../lib/errors";
import { agentResource, type PermissionService } from "../organization";
import { type SandboxdClient, SandboxdRefusedError } from "./client";
import { applyInstalls } from "./packages";
import {
  CONTAINER_LIMITS,
  cpuMsToday,
  diskRoom,
  lifecycleRefusal,
  loadSandboxBot,
  loadSandboxPolicy,
  markState,
  reserveSandbox,
} from "./service";

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
/** A restart may create the container. */
const RESTART_TIMEOUT_MS = 60_000;
const MIB = 1024 * 1024;

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

// ---------------------------------------------------------------- preview (server-side detection, never rendered)

/** Bytes of a file's start that decide "text": valid UTF-8 and no NUL there (UI-SPEC §3.1). */
const TEXT_SNIFF_BYTES = 8192;

/**
 * Raster images the bot page may show from the download route, by their magic bytes. A local copy of the four
 * signatures `artifact/sniff.ts` gets from `file-type` (that module's public index does not export `sniff`).
 */
export function imageTypeOf(bytes: Uint8Array): SandboxPreviewImageType | null {
  const at = (i: number, ...want: number[]) => want.every((b, k) => bytes[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (at(4, 0x37, 0x61) || at(4, 0x39, 0x61))) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/** Names and leading markup of documents a browser could render or run: never previewed (T-07.8-11-02). */
const ACTIVE_EXTENSIONS = /\.(svg|svgz|html?|xhtml|xht|mht|mhtml|xml|xsl|xslt)$/iu;
// `\s` also matches a leading byte order mark (U+FEFF).
const ACTIVE_MARKUP = /^\s*<(?:svg|!doctype\s+html|html|\?xml|head|body|script)\b/iu;

/** Valid UTF-8 with no NUL in the first 8 KB (a sequence cut at the end of the sample is not an error). */
export function looksText(bytes: Uint8Array): boolean {
  let sample = bytes.subarray(0, TEXT_SNIFF_BYTES);
  if (sample.includes(0)) return false;
  // Drop an incomplete trailing sequence (at most 3 bytes) cut by the sample's end.
  if (bytes.length > sample.length) {
    let cut = 0;
    while (cut < 3 && cut < sample.length && ((sample[sample.length - 1 - cut] ?? 0) & 0xc0) === 0x80) cut++;
    const lead = sample[sample.length - 1 - cut] ?? 0;
    if (lead >= 0xc0) sample = sample.subarray(0, sample.length - 1 - cut);
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the bot page shows for one file (D-04, UI-SPEC §3.1): text up to 256 KB (as JSON text, never markup), a raster
 * image up to 5 MB (its bytes come from the download route), `too_large` past those, `binary` for anything else,
 * including SVG and HTML, which are never rendered. `head` is the file's start (up to 256 KB), `size` its full size.
 */
export function classifyPreview(
  name: string,
  head: Uint8Array,
  size: number,
):
  | { kind: "text"; text: string }
  | { kind: "image"; mimeType: SandboxPreviewImageType }
  | { kind: "too_large" | "binary" } {
  const image = imageTypeOf(head);
  if (image)
    return size <= SANDBOX_LIMITS.previewImageMaxBytes
      ? { kind: "image", mimeType: image }
      : { kind: "too_large" };
  if (ACTIVE_EXTENSIONS.test(name)) return { kind: "binary" };
  if (!looksText(head)) return { kind: "binary" };
  const start = new TextDecoder("utf-8").decode(head.subarray(0, 512));
  if (ACTIVE_MARKUP.test(start)) return { kind: "binary" };
  if (size > SANDBOX_LIMITS.previewTextMaxBytes || head.length < size) return { kind: "too_large" };
  try {
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(head) };
  } catch {
    return { kind: "binary" };
  }
}

// ---------------------------------------------------------------- the status DTO (R4, UI-SPEC §3.1)

/**
 * The bot page's Sandbox header: the `sbx` container as last mirrored, the quota, today's CPU of the bot and of the
 * organization against its cap, the fixed limits and the installed packages. The kill switch shows as `killed` even
 * before sandboxd's own events arrive; without sandboxd configured the state is `unavailable` (`service_down`). The
 * viewer reached this through `sandbox.files`, so they may manage files and stop or restart it.
 */
export async function sandboxStatusView(
  tx: Tx,
  bot: FilesBot,
  opts: { configured: boolean },
): Promise<SandboxStatusView> {
  const settings = await loadSandboxPolicy(tx);
  const [row] = await tx
    .select()
    .from(botSandboxes)
    .where(and(eq(botSandboxes.agentId, bot.id), eq(botSandboxes.kind, "sbx")))
    .limit(1);
  let state: SandboxState = row?.state ?? "absent";
  let stopReason = row?.stopReason ?? null;
  if (settings.killed && (state === "running" || state === "starting")) {
    state = "killed";
    stopReason = "kill_switch";
  }
  if (!opts.configured) {
    state = "unavailable";
    stopReason = "service_down";
  }
  const [installed] = await tx
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(sandboxPackageInstalls)
    .where(and(eq(sandboxPackageInstalls.agentId, bot.id), eq(sandboxPackageInstalls.status, "installed")));
  const limits = CONTAINER_LIMITS.sbx;
  return {
    agentId: bot.id,
    state,
    runtime: row?.runtime ?? null,
    lastActiveAt: row?.lastActiveAt ? new Date(row.lastActiveAt).toISOString() : null,
    diskBytes: row?.diskBytes ?? 0,
    diskQuotaBytes: settings.limits.diskPerBotMb * MIB,
    cpuMsToday: await cpuMsToday(tx, bot.id),
    org: {
      cpuMinutesToday: (await cpuMsToday(tx)) / 60_000,
      cpuMinutesPerDay: settings.limits.cpuMinutesPerDay,
    },
    limits: {
      cpus: limits.cpus,
      memoryBytes: limits.memoryBytes,
      pids: limits.pids,
      idleStopMinutes: limits.idleStopMinutes,
    },
    packages: installed?.n ?? 0,
    teamBot: bot.scope === "team",
    stopReason,
    viewerCan: { files: true, control: true },
  };
}

const PathQuery = z.object({ path: z.string().max(4096).default("") });
const Flag = z
  .enum(["1", "0", "true", "false"])
  .default("0")
  .transform((v) => v === "1" || v === "true");
const UploadQuery = z.object({
  path: z.string().max(4096).default(""),
  name: z.string().max(255),
  replace: Flag,
});
const DeleteQuery = z.object({ path: z.string().max(4096).default(""), recursive: Flag });
const UploadedFile = z.object({ path: SandboxFilePath, size: z.number().int().nonnegative() });
const DeletedFiles = z.object({ path: SandboxFilePath, deleted: z.number().int().nonnegative() });

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

  // ---------------------------------------------------------------- Task 2: preview, upload, delete

  app.get(
    "/agents/:id/sandbox/files/content",
    {
      ...user,
      schema: { tags, params: IdParams, querystring: PathQuery, response: { 200: SandboxFilePreview } },
    },
    async (req) => {
      const { client, target } = await decided(req, req.params.id);
      const path = filePath(req.query.path);
      try {
        const entry = await client.call("filesStat", { target, path }, { timeoutMs: CALL_TIMEOUT_MS });
        if (entry.kind !== "file") throw fileRefusal("invalid_path");
        const size = entry.size ?? 0;
        const limit = Math.max(1, Math.min(size, SANDBOX_LIMITS.previewTextMaxBytes));
        const read = await client.call(
          "filesRead",
          { target, path, offset: 0, limit },
          { timeoutMs: TRANSFER_TIMEOUT_MS },
        );
        const head = Buffer.from(read.content, read.encoding === "base64" ? "base64" : "utf8");
        const kind = classifyPreview(entry.name, head, size);
        const modifiedAt = entry.modifiedAt;
        switch (kind.kind) {
          case "text":
            return { kind: "text" as const, text: kind.text, size, modifiedAt };
          case "image":
            return { kind: "image" as const, mimeType: kind.mimeType, size, modifiedAt };
          default:
            return { kind: kind.kind, size, modifiedAt };
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw fromSandboxd(err);
      }
    },
  );

  // Raw bytes, at most 50 MiB per file; refused before anything is read when the declared length is over (413).
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: SANDBOX_LIMITS.uploadMaxBytes },
    (_req, body, done) => done(null, body),
  );

  app.post(
    "/agents/:id/sandbox/files/upload",
    {
      ...user,
      bodyLimit: SANDBOX_LIMITS.uploadMaxBytes,
      onRequest: async (req) => {
        const declared = Number(req.headers["content-length"] ?? "0");
        if (Number.isFinite(declared) && declared > SANDBOX_LIMITS.uploadMaxBytes)
          throw fileRefusal("too_large");
      },
      errorHandler: (err, _req, _reply) => {
        // A body that grows past the limit without a declared length (chunked): the same refusal.
        if ((err as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") throw fileRefusal("too_large");
        throw err;
      },
      schema: { tags, params: IdParams, querystring: UploadQuery, response: { 200: UploadedFile } },
    },
    async (req) => {
      const body = req.body;
      if (!Buffer.isBuffer(body))
        throw badRequest("Send the file as application/octet-stream", "bad_request");
      if (body.length > SANDBOX_LIMITS.uploadMaxBytes) throw fileRefusal("too_large");
      const { bot, client, target } = await decided(req, req.params.id);
      const name = req.query.name;
      if (name.includes("/") || name.startsWith("..") || name === ".") throw fileRefusal("invalid_path");
      const folder = folderPath(req.query.path);
      const path = filePath(folder === "" ? name : `${folder}/${name}`);
      // F-9: refused before any byte is written when the bot's quota has no room (sandboxd re-checks on write).
      const room = await core.db.withTenant(tenant(req), (tx) => diskRoom(tx, bot.id));
      if (body.length > room) throw fileRefusal("disk_full");
      let out: { path: string; size: number };
      try {
        out = await client.call(
          "filesUpload",
          { target, path, data: body.toString("base64"), overwrite: req.query.replace },
          { timeoutMs: TRANSFER_TIMEOUT_MS },
        );
      } catch (err) {
        throw fromSandboxd(err);
      }
      await audit(req, bot.id, "sandbox.files_uploaded", { count: 1, totalBytes: out.size });
      return out;
    },
  );

  app.delete(
    "/agents/:id/sandbox/files",
    {
      ...user,
      schema: { tags, params: IdParams, querystring: DeleteQuery, response: { 200: DeletedFiles } },
    },
    async (req) => {
      const { bot, client, target } = await decided(req, req.params.id);
      const path = filePath(req.query.path);
      let out: { path: string; deleted: number };
      try {
        out = await client.call(
          "filesDelete",
          { target, path, recursive: req.query.recursive },
          { timeoutMs: CALL_TIMEOUT_MS },
        );
      } catch (err) {
        throw fromSandboxd(err);
      }
      await audit(req, bot.id, "sandbox.file_deleted", { count: out.deleted });
      return out;
    },
  );

  // ---------------------------------------------------------------- Task 2: status, stop, restart

  app.get(
    "/agents/:id/sandbox",
    { ...user, schema: { tags, params: IdParams, response: { 200: SandboxStatusView } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const bot = await filesBot(deps.perms, req, tx, req.params.id);
        return sandboxStatusView(tx, bot, { configured: deps.client !== null });
      }),
  );

  app.post(
    "/agents/:id/sandbox/stop",
    { ...user, schema: { tags, params: IdParams, response: { 200: SandboxStatusView } } },
    async (req) => {
      const { bot, client, target } = await decided(req, req.params.id);
      let existed = true;
      try {
        await client.call("stop", { target, reason: "user" }, { timeoutMs: CALL_TIMEOUT_MS });
      } catch (err) {
        // Nothing running (never started, already stopped or killed): stopping is a no-op, not an error.
        if (err instanceof SandboxdRefusedError && err.code === "not_found") existed = false;
        else if (!(err instanceof SandboxdRefusedError && err.code === "killed")) throw fromSandboxd(err);
      }
      return core.db.withTenant(tenant(req), async (tx) => {
        if (existed)
          await markState(tx, { agentId: bot.id, kind: "sbx", state: "stopped", stopReason: "user" });
        await core.audit.record(tx, {
          action: "sandbox.stopped",
          resourceType: "agent",
          resourceId: bot.id,
          agentId: bot.id,
          metadata: { kind: "sbx", reason: "user" },
        });
        return sandboxStatusView(tx, bot, { configured: true });
      });
    },
  );

  app.post(
    "/agents/:id/sandbox/restart",
    { ...user, schema: { tags, params: IdParams, response: { 200: SandboxStatusView } } },
    async (req) => {
      const { bot, client, target } = await decided(req, req.params.id);
      // Starting a container is a run: the organization switch, the kill switch, the bot's switch and the caps hold.
      const reserved = await core.db.withTenant(tenant(req), async (tx) => {
        const refusal = await lifecycleRefusal(tx, bot.id);
        if (refusal) throw fileRefusal(refusal);
        const r = await reserveSandbox(tx, { agentId: bot.id }, "sbx");
        if (!r.ok) throw fileRefusal(r.reason);
        return r;
      });
      let status: { state: SandboxState; runtime: SandboxRuntime | null } | null = null;
      let failure: HttpError | null = null;
      try {
        status = await client.call("restart", { target }, { timeoutMs: RESTART_TIMEOUT_MS });
        // 07.8-18: a start brings the bot's sandbox packages up to date (never failing the restart).
        await applyInstalls(core, client, target);
      } catch (err) {
        failure = fromSandboxd(err);
      }
      const view = await core.db.withTenant(tenant(req), async (tx) => {
        if (status) {
          await markState(tx, {
            agentId: bot.id,
            kind: "sbx",
            state: "running",
            runtime: status.runtime,
            active: true,
          });
          await core.audit.record(tx, {
            action: "sandbox.restarted",
            resourceType: "agent",
            resourceId: bot.id,
            agentId: bot.id,
            metadata: { kind: "sbx" },
          });
          return sandboxStatusView(tx, bot, { configured: true });
        }
        // A reserved slot is always released (07.8-05 `containerStateAfter`), committed before the refusal.
        if (reserved.ensure) {
          const full = failure?.code === "disk_full";
          await markState(tx, {
            agentId: bot.id,
            kind: "sbx",
            state: full ? "disk_full" : "unavailable",
            stopReason: full ? "disk_full" : "service_down",
          });
        }
        return null;
      });
      if (!view) throw failure ?? fileRefusal("service_unavailable");
      return view;
    },
  );
}
