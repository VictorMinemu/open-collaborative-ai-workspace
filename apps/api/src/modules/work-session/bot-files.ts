import { randomUUID } from "node:crypto";
import {
  type AgentChannelWorkSessionDownloadResponse,
  type AgentChannelWorkSessionUploadResponse,
  BOT_FILE_LIMITS,
  type BotFileLimit,
  type BotFileLimitSource,
  type BotWorkSessionRefusal,
  type BotWorkSessionRefused,
  botFileTooLargeSentence,
  MAX_ATTACHMENTS_PER_MESSAGE,
  parseSessionFileAck,
  type SessionFileReadPayload,
  SessionFileReadPayload as SessionFileReadPayloadSchema,
  type SessionFileWritePayload,
  SessionFileWritePayload as SessionFileWritePayloadSchema,
  transferDeadlineMs,
  WorkSessionFilePath,
  workSessionFilePathRefusal,
} from "@ocw/contracts";
import {
  type agentTurns,
  attachments,
  botWorkSessionFiles,
  deviceCommands,
  devices,
  type Tx,
  tenantOf,
  workPrompts,
  workSessions,
} from "@ocw/db";
import { and, count, eq, gt, inArray, isNull, type SQL, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { type ObjectStorage, pendingTurnAttachmentCount } from "../artifact";
import type { DeviceHub, FileCommandAck } from "../device";
import type { PermissionService } from "../organization";
import type { BotProfileRow } from "./bot-profile";
import { type BotWorkSessionRow, botSessionLoad, lockBot, refusedAnswer } from "./bot-sessions";
import { sessionFacts } from "./facts";
import { loadBotFileLimit } from "./policy";
import type { SessionRow, WorkSessionService } from "./service";

/**
 * The bot file transfer ledger (`app.bot_work_session_files`, 07.17.1.1 D-05, D-06, D-08, PD-05): one row per transfer
 * the API enqueued for a bot's move of one file between a chat and its Work Zone session. The transfer id IS the device
 * command id, so the daemon names the transfer by the command it received and nothing else. The row stores the bounds
 * and the ids, never the repo-relative path or a file name (only its length, P1).
 *
 * A device may use a row only while it is `pending`, before `expires_at`, and only once: the claim moves it to
 * `streaming` under `FOR UPDATE`, so a replay finds it gone.
 */

export type TransferRow = typeof botWorkSessionFiles.$inferSelect;
export type NewTransfer = typeof botWorkSessionFiles.$inferInsert;
export type TransferDirection = TransferRow["direction"];
export type TransferStatus = TransferRow["status"];

/** Which row a device asks for: its id, the device the JWT names and the direction of the route it called. */
export interface TransferFor {
  id: string;
  deviceId: string;
  direction: TransferDirection;
}

/**
 * Insert one ledger row in the caller's tenant transaction (the row's organization is the tenant's). `expiresAt` may be
 * SQL (`createBotFiles` computes it from the database's own clock, which the transfer routes compare it with).
 */
export async function insertTransfer(
  tx: Tx,
  row: Omit<NewTransfer, "expiresAt"> & { expiresAt: string | SQL },
): Promise<TransferRow> {
  const [inserted] = await tx.insert(botWorkSessionFiles).values(row).returning();
  return inserted!;
}

async function selectFor(
  tx: Tx,
  p: TransferFor,
  lock: boolean,
): Promise<{ row: TransferRow; expired: boolean } | null> {
  const query = tx
    .select({ row: botWorkSessionFiles, expired: sql<boolean>`${botWorkSessionFiles.expiresAt} <= now()` })
    .from(botWorkSessionFiles)
    .where(eq(botWorkSessionFiles.id, p.id))
    .limit(1);
  const [found] = lock ? await query.for("update") : await query;
  return found ?? null;
}

/**
 * The rule both reads share: null when the row is absent (RLS hides another organization's), names another device or
 * the other direction (so a stranger learns nothing about the id); `"gone"` when it is no longer `pending` or its
 * deadline passed.
 */
function decide(
  found: { row: TransferRow; expired: boolean } | null,
  p: TransferFor,
): TransferRow | "gone" | null {
  if (!found) return null;
  const { row, expired } = found;
  if (row.deviceId !== p.deviceId || row.direction !== p.direction) return null;
  if (row.status !== "pending" || expired) return "gone";
  return row;
}

/** The row a device may use, without a lock (a pre-check; the claim decides). */
export async function readTransferForDevice(tx: Tx, p: TransferFor): Promise<TransferRow | "gone" | null> {
  return decide(await selectFor(tx, p, false), p);
}

/**
 * The same rule under `FOR UPDATE`, then the row moves to `streaming`: the single use of a transfer. Returns the row as
 * it was claimed (status `streaming`).
 */
export async function claimTransferForDevice(tx: Tx, p: TransferFor): Promise<TransferRow | "gone" | null> {
  const decided = decide(await selectFor(tx, p, true), p);
  if (decided === null || decided === "gone") return decided;
  const [claimed] = await tx
    .update(botWorkSessionFiles)
    .set({ status: "streaming" })
    .where(eq(botWorkSessionFiles.id, decided.id))
    .returning();
  return claimed!;
}

export type TransferPatch = Partial<
  Pick<NewTransfer, "status" | "failure" | "sizeBytes" | "sha256" | "completedAt">
>;

/**
 * Update one row. With `opts.from`, only while the row is in one of those statuses (a stream that ends after the
 * deadline sweep already failed the row never brings it back). Returns whether a row changed.
 */
export async function markTransfer(
  tx: Tx,
  id: string,
  patch: TransferPatch,
  opts: { from?: readonly TransferStatus[] } = {},
): Promise<boolean> {
  const where = opts.from
    ? and(eq(botWorkSessionFiles.id, id), inArray(botWorkSessionFiles.status, [...opts.from]))
    : eq(botWorkSessionFiles.id, id);
  const rows = await tx
    .update(botWorkSessionFiles)
    .set(patch)
    .where(where)
    .returning({ id: botWorkSessionFiles.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------- the service (07.17.1.1-11)

type AgentTurnRow = typeof agentTurns.$inferSelect;

/** The bot's own session as the routes found it (`ownBotSession`). */
export interface OwnSession {
  session: SessionRow;
  bot: BotWorkSessionRow;
}

export interface BotFilesDeps {
  core: Pick<Core, "log">;
  hub: Pick<DeviceHub, "enqueue" | "waitForFileAck">;
  svc: Pick<WorkSessionService, "lock">;
  perms: PermissionService;
  /** Attachment object storage; null when the server has none (every move answers `storage_unavailable`). */
  storage: ObjectStorage | null;
  /** The server's attachment ceiling (`serverFileMaxBytes(env)`, `OCW_ATTACHMENT_MAX_BYTES`). */
  serverMaxBytes: number;
  /**
   * The transfer deadline for a size in bytes. Absent in production (`transferDeadlineMs`); a test stack shortens it
   * through its `botFileDeadlineMs` option (PD-18), never through an environment variable.
   */
  deadlineMs?: (bytes: number) => number;
}

/** What both moves are given by the route, in the sponsor's transaction (PD-06 txB). */
export interface BotFileCallParams {
  turn: AgentTurnRow;
  /** The bot's profile, active (the route decided its status). */
  profile: BotProfileRow;
  own: OwnSession;
  /** The repo-relative path inside the session's working tree (never stored; only its length is, P1). */
  path: string;
  /** The effective per-file limit (`limitFor`), computed by the route for this call. */
  limit: BotFileLimit;
  /** The transfer id the route created and subscribed to (`waitForAck`) before this call. */
  transferId: string;
}

export interface BotFileDownloadParams extends BotFileCallParams {}

export interface BotFileUploadParams extends BotFileCallParams {
  /** The chat attachment the turn may read (`attachmentForTurn`), its size and sha256. */
  attachment: { id: string; sizeBytes: number; sha256: string | null };
  overwrite?: boolean;
  /** The turn read outside content (default `turn.tainted`): the upload marks the session's `tainted_at` (PD-13). */
  tainted?: boolean;
}

/** A move the API enqueued (the waiter now waits for its ack), or why it refused before any row or command. */
export type BotFilePrepared = { kind: "enqueued"; transferId: string } | BotWorkSessionRefused;

/**
 * What the routes audit about a finished move (PD-16): ids, the size, the sha256, the direction and the path's length.
 * Never a path, a file name or content.
 */
export interface BotFileAuditFacts {
  attachmentId: string;
  bytes: number | null;
  sha256: string | null;
  direction: TransferDirection;
  pathLength: number;
  limitSource: BotFileLimitSource;
}

/** `finish`'s result: the bot's answer and the facts the route audits (null when no ledger row was found). */
export interface BotFileFinished<A> {
  answer: A;
  audit: BotFileAuditFacts | null;
}

export interface BotFileFinishParams<D extends TransferDirection> {
  transferId: string;
  direction: D;
  /** The device's ack the route waited for; null when the wait timed out (PD-18). */
  ack: FileCommandAck | null;
}

export interface BotFiles {
  /** The per-file limit of one call (`loadBotFileLimit` bound to the server's ceiling), recomputed at every call. */
  limitFor(tx: Tx, profile: { fileMaxBytes: number | null } | null): Promise<BotFileLimit>;
  /** The transfer deadline for `bytes` (the waiter's timeout and the ledger's `expires_at`). */
  deadlineFor(bytes: number): number;
  /** Wait for the device's ack of `transferId` (the hub's `waitForFileAck`; the Agent Channel never holds the hub). */
  waitForAck(transferId: string, timeoutMs: number, signal?: AbortSignal): Promise<FileCommandAck | null>;
  /** One chat attachment into the bot's own idle session (D-02, D-13), in the sponsor's transaction. */
  prepareUpload(tx: Tx, p: BotFileUploadParams): Promise<BotFilePrepared>;
  /** One file of the bot's own active session into a pending attachment of its turn (D-03), in the sponsor's tx. */
  prepareDownload(tx: Tx, p: BotFileDownloadParams): Promise<BotFilePrepared>;
  /** The move's outcome from the device's ack (or its absence), in the sponsor's transaction. */
  finish(
    tx: Tx,
    p: BotFileFinishParams<"to_device">,
  ): Promise<BotFileFinished<AgentChannelWorkSessionUploadResponse>>;
  finish(
    tx: Tx,
    p: BotFileFinishParams<"from_device">,
  ): Promise<BotFileFinished<AgentChannelWorkSessionDownloadResponse>>;
}

const COMMAND_KIND = { to_device: "session.file.write", from_device: "session.file.read" } as const;

/**
 * PD-15: the device's ack code (`parseSessionFileAck`) as the bot's refusal. Anything not listed (a mismatch, no space,
 * an expired transfer, free text) is `transfer_failed`.
 */
const ACK_REFUSAL: Partial<Record<ReturnType<typeof parseSessionFileAck>["code"], BotWorkSessionRefusal>> = {
  runtime_too_old: "runtime_too_old",
  too_large: "file_too_large",
  exists: "file_exists",
  not_found: "file_not_found",
  not_a_file: "not_a_file",
  invalid_path: "path_not_allowed",
  path_not_allowed: "path_not_allowed",
  busy: "session_busy",
  not_running: "session_not_running",
};

/** The stored outcome of a command the route did not hear about (an ack published before it subscribed). */
function storedAck(command: { status: string; error: string | null } | undefined): FileCommandAck | null {
  if (command?.status === "acked") return { ok: true, error: null };
  if (command?.status === "failed") return { ok: false, error: command.error };
  return null;
}

/**
 * 07.17.1.1 (D-02 … D-07, D-13; PD-06 … PD-08, PD-12, PD-13, PD-15 … PD-18): the work-session module decides and runs
 * one file move for a bot's own session. `prepare*` run in the sponsor's tenant transaction after the Agent Channel
 * route decided the turn, the tool, the profile, the path's deny list, taint and the claim: the bot's lock, the session
 * row's lock, its state, the sponsor's own right on it (principle 6: never above the sponsor), the device, then one
 * ledger row and one `session.file.read|write` command whose id is the transfer id. The route waits for the ack outside
 * any transaction (`waitForAck`), then `finish` maps it to one fixed answer. Every refusal is `refusedAnswer(code)`:
 * a fixed sentence, never device text. Nothing here stores, logs or audits a path or a file name (P1).
 */
export function createBotFiles(deps: BotFilesDeps): BotFiles {
  const { core, hub, svc, perms } = deps;
  const deadlineFor = (bytes: number) => (deps.deadlineMs ?? transferDeadlineMs)(bytes);

  /**
   * PD-08: the session's state and the sponsor's right, under the bot's lock then the session row's lock (the order
   * `bots.prompt` takes them). Returns the locked row, or the refusal.
   */
  async function decideSession(
    tx: Tx,
    p: BotFileCallParams,
    direction: TransferDirection,
  ): Promise<{ session: SessionRow } | BotWorkSessionRefused> {
    const { turn, own } = p;
    await lockBot(tx, turn.agentId);
    const s = await svc.lock(tx, own.session.id);
    // Hidden from the sponsor (the audience backstop): the sponsor may not act on it.
    if (!s) return refusedAnswer("not_allowed");
    if (
      s.startedByAgentId !== turn.agentId ||
      own.bot.agentId !== turn.agentId ||
      own.bot.workSessionId !== s.id
    ) {
      return refusedAnswer("not_your_session");
    }
    // D-12: only from the conversation where the bot started the session, so a file never hops between conversations.
    if (own.bot.originConversationId !== turn.conversationId) return refusedAnswer("not_your_session");
    if (s.status === "archived") return refusedAnswer("session_ended");
    if (s.status === "completed" || s.status === "failed") return refusedAnswer("session_not_running");
    if (s.status === "host_offline") return refusedAnswer("device_offline");
    // Before the rights: a revoked device would read as the sponsor's refusal, but the cause is the device.
    const [device] = await tx
      .select({ status: devices.status, revokedAt: devices.revokedAt })
      .from(devices)
      .where(eq(devices.id, s.deviceId))
      .limit(1);
    if (device?.status !== "online" || device.revokedAt !== null) return refusedAnswer("device_offline");
    // PD-07: writing into the tree is acting on the session like a prompt; reading a file is what the diff route asks.
    const sponsorUserId = own.bot.sponsorUserId;
    const { allowed } = await perms.decide(
      tx,
      { kind: "user", userId: sponsorUserId },
      direction === "to_device" ? "work_session.prompt" : "work_session.read",
      await sessionFacts(tx, sponsorUserId, s),
    );
    if (!allowed) return refusedAnswer("not_allowed");
    // A session still starting has no tree to read from yet.
    if (s.status === "provisioning") return refusedAnswer("session_busy");
    return { session: s };
  }

  /**
   * PD-12 (D-06), under the bot's lock (taken first by `decideSession`), counted in the same transaction as the insert
   * so two calls never both take the last slot: one unit of the bot's hourly prompt budget per move (the hour's load
   * counts the ledger with the prompts), at most five moves per turn in each direction, and for a download at most
   * `MAX_ATTACHMENTS_PER_MESSAGE` files waiting for the turn's reply (the pending ones and the downloads in flight).
   */
  async function budgetRefusal(
    tx: Tx,
    p: BotFileCallParams,
    s: SessionRow,
    direction: TransferDirection,
  ): Promise<BotWorkSessionRefused | null> {
    const load = await botSessionLoad(tx, p.turn.agentId, s.projectId);
    if (load.botPromptsHour >= p.profile.promptsPerHour) return refusedAnswer("prompt_rate");
    const [moved] = await tx
      .select({ n: count() })
      .from(botWorkSessionFiles)
      .where(
        and(eq(botWorkSessionFiles.eventId, p.turn.eventId), eq(botWorkSessionFiles.direction, direction)),
      );
    if (Number(moved?.n ?? 0) >= BOT_FILE_LIMITS.filesPerTurnEachWay)
      return refusedAnswer("file_cap_reached");
    if (direction === "from_device") {
      const [inFlight] = await tx
        .select({ n: count() })
        .from(botWorkSessionFiles)
        .where(
          and(
            eq(botWorkSessionFiles.eventId, p.turn.eventId),
            eq(botWorkSessionFiles.direction, "from_device"),
            inArray(botWorkSessionFiles.status, ["pending", "streaming"]),
            gt(botWorkSessionFiles.expiresAt, sql`now()`),
          ),
        );
      const waiting = (await pendingTurnAttachmentCount(tx, p.turn.eventId)) + Number(inFlight?.n ?? 0);
      if (waiting >= MAX_ATTACHMENTS_PER_MESSAGE) return refusedAnswer("file_cap_reached");
    }
    return null;
  }

  /** The checks every move makes before any lock: storage, then the path (the route decided both already). */
  function precheck(p: BotFileCallParams): BotWorkSessionRefused | null {
    if (!deps.storage) return refusedAnswer("storage_unavailable");
    if (!WorkSessionFilePath.safeParse(p.path).success || workSessionFilePathRefusal(p.path) !== null) {
      return refusedAnswer("path_not_allowed");
    }
    return null;
  }

  async function insertRow(
    tx: Tx,
    p: BotFileCallParams,
    s: SessionRow,
    row: {
      direction: TransferDirection;
      attachmentId: string;
      sizeBytes: number | null;
      sha256: string | null;
    },
    deadlineBytes: number,
  ): Promise<void> {
    await insertTransfer(tx, {
      id: p.transferId,
      organizationId: tenantOf(tx).organizationId,
      workSessionId: s.id,
      agentId: p.turn.agentId,
      eventId: p.turn.eventId,
      deviceId: s.deviceId,
      conversationId: p.turn.conversationId,
      direction: row.direction,
      attachmentId: row.attachmentId,
      maxBytes: p.limit.bytes,
      limitSource: p.limit.source,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      pathLength: p.path.length,
      // The database's clock: the transfer routes compare `expires_at` with its `now()`.
      expiresAt: sql`now() + ${deadlineFor(deadlineBytes)} * interval '1 millisecond'`,
    });
  }

  async function finishTransfer(
    tx: Tx,
    p: BotFileFinishParams<TransferDirection>,
  ): Promise<
    BotFileFinished<AgentChannelWorkSessionUploadResponse | AgentChannelWorkSessionDownloadResponse>
  > {
    const [row] = await tx
      .select()
      .from(botWorkSessionFiles)
      .where(eq(botWorkSessionFiles.id, p.transferId))
      .for("update")
      .limit(1);
    if (!row || row.direction !== p.direction)
      return { answer: refusedAnswer("transfer_failed"), audit: null };
    const audit: BotFileAuditFacts = {
      attachmentId: row.attachmentId,
      bytes: row.sizeBytes,
      sha256: row.sha256,
      direction: row.direction,
      pathLength: row.pathLength,
      limitSource: row.limitSource,
    };
    const [command] = await tx
      .select({ status: deviceCommands.status, error: deviceCommands.error, payload: deviceCommands.payload })
      .from(deviceCommands)
      .where(and(eq(deviceCommands.id, row.id), eq(deviceCommands.kind, COMMAND_KIND[row.direction])))
      .for("update")
      .limit(1);
    // An ack published before the route subscribed is still in the command row (the hub's `onAck` stored it).
    const ack = p.ack ?? storedAck(command);
    const path = (command?.payload as { path?: unknown } | undefined)?.path;
    const fail = async (failure: string, sizeBytes?: number) => {
      await markTransfer(
        tx,
        row.id,
        {
          status: "failed",
          failure,
          completedAt: new Date().toISOString(),
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        },
        { from: ["pending", "streaming", "streamed"] },
      );
      // T-07.17.1.1-11-07: a download whose PUT stored the file but whose move failed leaves nothing a reply links.
      if (row.direction === "from_device") {
        await tx
          .update(attachments)
          .set({ status: "rejected" })
          .where(and(eq(attachments.id, row.attachmentId), eq(attachments.status, "pending")));
      }
    };
    if (!ack) {
      // PD-18: the deadline passed. The command is never delivered again and the transfer is over (a late GET or PUT
      // answers 410, the daemon acks `expired`).
      await tx
        .update(deviceCommands)
        .set({ status: "failed", error: "timeout", ackedAt: sql`now()` })
        .where(and(eq(deviceCommands.id, row.id), inArray(deviceCommands.status, ["pending", "sent"])));
      await fail("timeout");
      core.log.info({ transferId: row.id, code: "transfer_timeout" }, "bot file move finished");
      return { answer: refusedAnswer("transfer_timeout"), audit };
    }
    if (!ack.ok) {
      // PD-15: the device's free text becomes one closed code; the bot reads only its fixed (or composed) sentence.
      const parsed = parseSessionFileAck(ack.error);
      const code = ACK_REFUSAL[parsed.code] ?? "transfer_failed";
      const failure = parsed.code === "unknown" ? "transfer_failed" : parsed.code;
      core.log.info({ transferId: row.id, code, failure }, "bot file move finished");
      if (code === "file_too_large") {
        const sizeBytes = parsed.sizeBytes ?? row.sizeBytes ?? undefined;
        await fail(failure, sizeBytes);
        const limit: BotFileLimit = { bytes: row.maxBytes, source: row.limitSource };
        return {
          answer: {
            ...refusedAnswer("file_too_large"),
            sentence: botFileTooLargeSentence({ sizeBytes: sizeBytes ?? null, limit }),
            limit,
            ...(sizeBytes !== undefined ? { sizeBytes } : {}),
          },
          audit: { ...audit, bytes: sizeBytes ?? audit.bytes },
        };
      }
      await fail(failure);
      return { answer: refusedAnswer(code), audit };
    }
    if (row.status === "streamed" && typeof path === "string") {
      if (row.direction === "to_device") {
        await markTransfer(tx, row.id, { status: "done", completedAt: new Date().toISOString() });
        core.log.debug({ transferId: row.id, code: "uploaded" }, "bot file move finished");
        return {
          answer: { kind: "uploaded", workSessionId: row.workSessionId, path, sizeBytes: row.sizeBytes ?? 0 },
          audit,
        };
      }
      const [att] = await tx
        .select({
          id: attachments.id,
          filename: attachments.filename,
          sizeBytes: attachments.sizeBytes,
          contentType: attachments.contentType,
          status: attachments.status,
        })
        .from(attachments)
        .where(eq(attachments.id, row.attachmentId))
        .limit(1);
      if (att && att.status === "pending") {
        await markTransfer(tx, row.id, { status: "done", completedAt: new Date().toISOString() });
        core.log.debug({ transferId: row.id, code: "downloaded" }, "bot file move finished");
        return {
          answer: {
            kind: "downloaded",
            workSessionId: row.workSessionId,
            attachmentId: att.id,
            name: att.filename,
            sizeBytes: att.sizeBytes,
            contentType: att.contentType ?? "application/octet-stream",
          },
          audit,
        };
      }
    }
    // The device said ok, but the bytes never moved through the transfer route (or the file is gone): not a success.
    await fail("transfer_failed");
    core.log.info({ transferId: row.id, code: "transfer_failed" }, "bot file move finished");
    return { answer: refusedAnswer("transfer_failed"), audit };
  }

  return {
    limitFor: (tx, profile) => loadBotFileLimit(tx, profile, deps.serverMaxBytes),
    deadlineFor,
    waitForAck: (transferId, timeoutMs, signal) => hub.waitForFileAck(transferId, timeoutMs, signal),

    async prepareUpload(tx, p) {
      const pre = precheck(p);
      if (pre) return pre;
      // The route compared the size already (txA); a limit lowered since is still honoured here.
      if (p.attachment.sizeBytes > p.limit.bytes) {
        return {
          ...refusedAnswer("file_too_large"),
          sentence: botFileTooLargeSentence({ sizeBytes: p.attachment.sizeBytes, limit: p.limit }),
          limit: p.limit,
          sizeBytes: p.attachment.sizeBytes,
        };
      }
      const decided = await decideSession(tx, p, "to_device");
      if ("kind" in decided) return decided;
      const s = decided.session;
      // D-13, principle 4: never a second writer on the tree. Only an idle session with nothing in its queue.
      if (s.status !== "idle") return refusedAnswer("session_busy");
      const [busy] = await tx
        .select({ id: workPrompts.id })
        .from(workPrompts)
        .where(
          and(
            eq(workPrompts.workSessionId, s.id),
            inArray(workPrompts.status, ["queued", "dispatched", "running"]),
          ),
        )
        .limit(1);
      if (busy) return refusedAnswer("session_busy");
      const over = await budgetRefusal(tx, p, s, "to_device");
      if (over) return over;
      await insertRow(
        tx,
        p,
        s,
        {
          direction: "to_device",
          attachmentId: p.attachment.id,
          sizeBytes: p.attachment.sizeBytes,
          sha256: p.attachment.sha256,
        },
        p.attachment.sizeBytes,
      );
      const payload: SessionFileWritePayload = SessionFileWritePayloadSchema.parse({
        path: p.path,
        sizeBytes: p.attachment.sizeBytes,
        sha256: p.attachment.sha256,
        overwrite: p.overwrite ?? false,
      });
      await hub.enqueue(tx, {
        id: p.transferId,
        deviceId: s.deviceId,
        workSessionId: s.id,
        kind: "session.file.write",
        payload,
      });
      // PD-13 (D-02): a file written after outside content taints the session for good, exactly as a tainted prompt
      // does (`bots.prompt`); the first mark is kept.
      if (p.tainted ?? p.turn.tainted) {
        await tx
          .update(workSessions)
          .set({ taintedAt: sql`now()` })
          .where(and(eq(workSessions.id, s.id), isNull(workSessions.taintedAt)));
      }
      return { kind: "enqueued", transferId: p.transferId };
    },

    async prepareDownload(tx, p) {
      const pre = precheck(p);
      if (pre) return pre;
      const decided = await decideSession(tx, p, "from_device");
      if ("kind" in decided) return decided;
      const s = decided.session;
      const over = await budgetRefusal(tx, p, s, "from_device");
      if (over) return over;
      // PD-17: the attachment's id is chosen now; the device's PUT stores the bytes under it.
      await insertRow(
        tx,
        p,
        s,
        { direction: "from_device", attachmentId: randomUUID(), sizeBytes: null, sha256: null },
        p.limit.bytes,
      );
      const payload: SessionFileReadPayload = SessionFileReadPayloadSchema.parse({
        path: p.path,
        maxBytes: p.limit.bytes,
      });
      await hub.enqueue(tx, {
        id: p.transferId,
        deviceId: s.deviceId,
        workSessionId: s.id,
        kind: "session.file.read",
        payload,
      });
      return { kind: "enqueued", transferId: p.transferId };
    },

    finish: finishTransfer as BotFiles["finish"],
  };
}
