import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  SANDBOX_LIMITS,
  type SandboxdDownloadRef,
  type SandboxdTarget,
  SandboxFilePath,
  sanitizeFilename,
} from "@ocw/contracts";
import { agentTurns, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { Core } from "../../core";
import { sha256Hex } from "../../lib/crypto";
import { type ObjectStorage, pendingTurnAttachmentCount, storeServerAttachment } from "../artifact";
import type { PermissionService } from "../organization";
import { loadSandboxBot, type SandboxdClient, SandboxdRefusedError, sandboxAvailable } from "../sandbox";

/**
 * Where a file the bot's browser downloaded goes (07.8-25; D-11 F-8, P-11; BRW-04). Data moves only from a broader
 * audience to a narrower one:
 * - **the conversation**, as a pending attachment of the turn that the reply links (`storeServerAttachment`), when the
 *   page has a member's sealed session, or when a team bot's turn already has member data (its workspace is read by
 *   other people's turns, P-11);
 * - **the workspace**, at `downloads/<name>` through sandboxd's `filesImport` (never overwriting: a free name is
 *   chosen), otherwise;
 * - **nowhere** when the bot cannot use its sandbox now (the same `sandboxAvailable` as every sandbox call), when no
 *   storage is configured, or when the file is too large or the reply already holds as many files as a message can.
 *
 * The decision runs in a transaction AS the turn's human; the bytes are fetched from sandboxd and written outside any
 * transaction (a workspace import) or with the storage's server credentials in the outcome transaction (an
 * attachment). Every routed or discarded download is audited with ids, the host and the size only (never its name or
 * path: the path is recorded by length and SHA-256).
 */

export type DownloadDiscard = "sandbox_off" | "too_large" | "service_unavailable" | "busy";

export type RoutedDownload =
  | { stored: "conversation"; name: string; size: number; attachmentId: string }
  | { stored: "workspace"; name: string; size: number; path: string }
  | { stored: null; name: string; size: number; reason: DownloadDiscard };

export interface DownloadTurn {
  eventId: string;
  agentId: string;
  userId: string;
  conversationId: string;
}

export interface DownloadDeps {
  core: Core;
  perms: Pick<PermissionService, "decide">;
  client: SandboxdClient;
  /** The artifact storage (server credentials); null = attachments are not configured. */
  storage: ObjectStorage | null;
  attachmentMaxBytes: number;
}

const DOWNLOAD_TIMEOUT_MS = 60_000;
/** How many free names are tried in `downloads/` before the download is refused as `busy`. */
const NAME_TRIES = 5;

/**
 * The place a download of this turn's page goes, decided now in `tx` (AS the turn's human): the page's member session,
 * the turn's member data on a team bot, then whether the bot may use its sandbox (module, switches, kill).
 */
export async function downloadPlace(
  tx: Tx,
  perms: Pick<PermissionService, "decide">,
  p: { turn: DownloadTurn; sessionId: string | null },
): Promise<"conversation" | "workspace" | { discard: DownloadDiscard }> {
  if (p.sessionId) return "conversation";
  const [row] = await tx
    .select({ memberData: agentTurns.memberData })
    .from(agentTurns)
    .where(eq(agentTurns.eventId, p.turn.eventId))
    .limit(1);
  if (row?.memberData) {
    const bot = await loadSandboxBot(tx, p.turn.agentId);
    if (bot?.facts.scope !== "personal") return "conversation";
  }
  const available = await sandboxAvailable(
    tx,
    perms,
    { agentId: p.turn.agentId, userId: p.turn.userId },
    "sandbox",
  );
  return available.ok ? "workspace" : { discard: "sandbox_off" };
}

/** `downloads/<name>`, then `downloads/<base>-2<ext>` … (the name is the site's: sanitized, never trusted). */
export function downloadPaths(name: string, tries = NAME_TRIES): string[] {
  const safe = sanitizeFilename(name);
  const dot = safe.lastIndexOf(".");
  const base = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  const out: string[] = [];
  for (let i = 1; i <= tries; i += 1) {
    const path = `downloads/${i === 1 ? safe : `${base}-${i}${ext}`}`;
    out.push(SandboxFilePath.safeParse(path).success ? path : `downloads/download-${i}`);
  }
  return out;
}

async function audit(
  tx: Tx,
  core: Core,
  p: { turn: DownloadTurn; context: { id: string; host: string }; result: RoutedDownload },
): Promise<void> {
  const r = p.result;
  await core.audit.record(tx, {
    action: r.stored === null ? "browser.download_discarded" : "browser.download_stored",
    actorKind: "agent",
    actorId: p.turn.agentId,
    agentId: p.turn.agentId,
    userId: p.turn.userId,
    resourceType: "browser_context",
    resourceId: p.context.id,
    result: r.stored === null ? "denied" : "success",
    metadata: {
      eventId: p.turn.eventId,
      contextId: p.context.id,
      host: p.context.host,
      size: r.size,
      ...(r.stored === null ? { reason: r.reason } : { stored: r.stored }),
      ...(r.stored === "conversation"
        ? { attachmentId: r.attachmentId, conversationId: p.turn.conversationId }
        : {}),
      ...(r.stored === "workspace" ? { pathLength: r.path.length, pathSha256: sha256Hex(r.path) } : {}),
    },
  });
}

/**
 * Routes one download the act reported (see the file comment). Never throws for the download itself: a failure is a
 * discarded download (`stored: null`) the act reports as `download: null`, and the act's own answer is unchanged.
 */
export async function routeDownload(
  deps: DownloadDeps,
  p: {
    tenant: { organizationId: string; userId: string };
    turn: DownloadTurn;
    context: { id: string; host: string; sessionId: string | null };
    target: SandboxdTarget;
    download: SandboxdDownloadRef;
  },
): Promise<RoutedDownload> {
  const { core } = deps;
  const name = sanitizeFilename(p.download.name);
  const discard = async (reason: DownloadDiscard, size = p.download.size): Promise<RoutedDownload> => {
    const result: RoutedDownload = { stored: null, name, size, reason };
    await core.db.withTenant(p.tenant, (tx) => audit(tx, core, { turn: p.turn, context: p.context, result }));
    return result;
  };

  // 1. Where it goes, and whether it can be kept there (decided before any byte is fetched).
  const place = await core.db.withTenant(p.tenant, async (tx) => {
    const where = await downloadPlace(tx, deps.perms, { turn: p.turn, sessionId: p.context.sessionId });
    if (typeof where !== "string") return where;
    if (where === "conversation") {
      if (!deps.storage) return { discard: "service_unavailable" as const };
      if (p.download.size > deps.attachmentMaxBytes) return { discard: "too_large" as const };
      if ((await pendingTurnAttachmentCount(tx, p.turn.eventId)) >= MAX_ATTACHMENTS_PER_MESSAGE) {
        return { discard: "too_large" as const };
      }
    } else if (p.download.size > SANDBOX_LIMITS.uploadMaxBytes) {
      return { discard: "too_large" as const };
    }
    return where;
  });
  if (typeof place !== "string") return discard(place.discard);

  // 2. The bytes, from the browser container, outside any transaction.
  let bytes: Buffer;
  try {
    const file = await deps.client.call(
      "contextDownload",
      { target: p.target, contextId: p.context.id, token: p.download.token },
      { timeoutMs: DOWNLOAD_TIMEOUT_MS },
    );
    bytes = Buffer.from(file.data, "base64");
  } catch {
    return discard("service_unavailable");
  }
  const cap = place === "conversation" ? deps.attachmentMaxBytes : SANDBOX_LIMITS.uploadMaxBytes;
  if (bytes.length > cap) return discard("too_large", bytes.length);

  // 3a. The conversation: a pending attachment of the turn, linked to the reply when it comes.
  if (place === "conversation") {
    const storage = deps.storage as ObjectStorage;
    try {
      return await core.db.withTenant(p.tenant, async (tx) => {
        const row = await storeServerAttachment(tx, storage, {
          conversationId: p.turn.conversationId,
          uploaderAgentId: p.turn.agentId,
          eventId: p.turn.eventId,
          name,
          bytes,
        });
        const result: RoutedDownload = {
          stored: "conversation",
          name: row.filename,
          size: row.sizeBytes,
          attachmentId: row.id,
        };
        await audit(tx, core, { turn: p.turn, context: p.context, result });
        return result;
      });
    } catch {
      return discard("service_unavailable", bytes.length);
    }
  }

  // 3b. The workspace: a free name under `downloads/`, never overwriting the bot's own files.
  const data = bytes.toString("base64");
  for (const path of downloadPaths(name)) {
    try {
      const put = await deps.client.call("filesImport", {
        target: p.target,
        path,
        data,
        overwrite: false,
      });
      const result: RoutedDownload = { stored: "workspace", name, size: put.size, path: put.path };
      await core.db.withTenant(p.tenant, (tx) =>
        audit(tx, core, { turn: p.turn, context: p.context, result }),
      );
      return result;
    } catch (err) {
      if (err instanceof SandboxdRefusedError && err.code === "exists") continue;
      const code = err instanceof SandboxdRefusedError ? err.code : null;
      return discard(
        code === "disk_full" || code === "too_large" ? "too_large" : "service_unavailable",
        bytes.length,
      );
    }
  }
  return discard("busy", bytes.length);
}
