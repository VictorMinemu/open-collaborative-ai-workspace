import { randomUUID } from "node:crypto";
import {
  AgentChannelWorkSessionDownload,
  AgentChannelWorkSessionDownloadResponse,
  AgentChannelWorkSessionUpload,
  AgentChannelWorkSessionUploadResponse,
  type BotFileLimit,
  type BotProfileInactiveReason,
  type BotWorkSessionRefusal,
  type BotWorkSessionRefused,
  BUILTIN_TOOLS,
  botFileTooLargeSentence,
  workSessionFilePathRefusal,
} from "@ocw/contracts";
import { agentTurns, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { App, Core } from "../../core";
import { notFound } from "../../lib/errors";
import type { ObjectStorage } from "../artifact";
import { createPermissionService } from "../organization";
import {
  auditBotWorkSession,
  type BotFileFinished,
  type BotFilePrepared,
  type BotFiles,
  type BotFileUploadParams,
  loadBotProfile,
  ownBotSession,
  profileScopeRefusal,
  profileStatus,
  refusedAnswer,
  type WorkSessionModule,
} from "../work-session";
import { attachmentForTurn } from "./attachment-access";
import { type CellPrincipal, cellOf } from "./auth";
import { type AgentTurnRow, auditUnknownTurn, cellAuditBase, liveTurn } from "./claim";
import { type CallRecord, createWorkSessionCalls, readOnly } from "./work-session-calls";

/**
 * Phase 07.17.1.1 (D-01 … D-13; PD-06, PD-07, PD-09, PD-11 … PD-14, PD-16, PD-18): a bot moves files between the
 * conversation it started a Work Zone session from and that session, through the Agent Channel API.
 * `POST /agent-channel/v1/work-sessions/upload` (`ocw_work_session_upload`, 07.17.1.1-12) puts a file someone attached
 * in the turn's thread into the session's working tree; `POST /agent-channel/v1/work-sessions/download`
 * (`ocw_work_session_download`, 07.17.1.1-13) brings one file of the session back as a pending attachment of the turn,
 * which the bot's reply for that turn links (`linkTurnAttachments`) so the conversation's readers open it (D-03,
 * PD-17). Both run the same order (`runFileCall`, one copy); a direction is a `FileMove`. The body names the turn, the
 * bot, the session, (upload) the attachment and a repo-relative path only (strict: no device, user, conversation, URL,
 * absolute path or bytes; 400 otherwise, P6). A download works while the session runs; only an upload needs it idle
 * (D-13, decided by `botFiles.prepare*`).
 *
 * Decided like a prompt (07.16-16), in the PD-06 order:
 * - tx0, user-less: the delivered turn of THIS bot in the cell's organization (RLS hides another organization's) → 404
 *   `unknown_turn`; its profile; the bot's own session (`ownBotSession`); the per-file limit that applies now
 *   (`botFiles.limitFor`: the bot's, the organization's and the server's, the lowest wins, D-07).
 * - txA, AS THE ASKER (the turn's person): the live turn → the tool on the turn (`not_in_turn`) → storage configured
 *   (`storage_unavailable`) → upload: the attachment the turn may read (`attachmentForTurn`, the 07.15 rule; anything
 *   else answers `attachment_not_found` exactly like a missing id, D-02) and its size against the limit
 *   (`file_too_large` with the limit and the size, before any byte moves). Never resolved as the sponsor: RLS would
 *   decide on the wrong person's rights (ADR-0037 D-16, P4). A download has no step here: the device reports the file's
 *   size against the limit before any byte moves (`too_large: <n>` → `file_too_large`).
 * - The transfer id is created and its ack waiter subscribed BEFORE the command can exist (PD-18), aborted on any
 *   refusal.
 * - txB, AS THE SESSION'S SPONSOR (`bot_work_sessions.sponsor_user_id`): the live turn → the tool → the bot's own
 *   session (`not_your_session`) → the origin conversation (`not_your_session`, D-12) → the profile, its sponsor the
 *   session's and active (`profile_inactive` + reason) → the profile still covers the session (`profileScopeRefusal`)
 *   → the shared deny list (`path_not_allowed`, D-09) → outside content without the profile's flag
 *   (`outside_content`, D-10) → another session's output (`session_output`, D-11) → the claim (one of the turn's 8;
 *   `outsideContent` when tainted, `sessionOutputExempt` for the one session the turn read) → `botFiles.prepare*`
 *   (the session's state, the device, the sponsor's own right, the budgets, the ledger row and the command).
 * - The wait, outside any transaction; then txC as the sponsor: `botFiles.finish` → the answer and its record.
 *
 * Every outcome is a 200 `{ kind }` except an unknown or ended turn (404 `unknown_turn`, `auditUnknownTurn`), and each
 * is recorded exactly once: a refusal before the claim as a denied `agent_tool_calls` row (the turn not counted) plus
 * `bot.work_session_refused`; after it `bot.work_session_refused` or `bot.work_session_upload`. Ids, the size, the
 * sha256 and the path's length only: never a path, a file name or content in a record or a log line (P1).
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const UPLOAD = BUILTIN_TOOLS.workSessionUpload;
const DOWNLOAD = BUILTIN_TOOLS.workSessionDownload;
const UNKNOWN_TURN = "No delivered turn of this bot has that id";
const UNKNOWN: unique symbol = Symbol("unknown_turn");

/** The device's ack of a transfer, or null when the deadline passed (`botFiles.waitForAck`). */
type FileAck = Awaited<ReturnType<BotFiles["waitForAck"]>>;

/** The bot's own session as `ownBotSession` found it. */
type OwnSession = NonNullable<Awaited<ReturnType<typeof ownBotSession>>>;

/** What every file move's body names (the upload adds the attachment and `overwrite`). */
interface FileCallBody {
  eventId: string;
  agentId: string;
  workSessionId: string;
  path: string;
  attachmentId?: string;
}

/** What txB hands every `prepare*`: the decided turn, profile, session, path, limit and transfer id. */
type FileCallBase = Pick<BotFileUploadParams, "turn" | "profile" | "own" | "path" | "limit" | "transferId">;

/** A refusal before the claim, decided in txA (the asker's transaction): the code and, when richer, the answer. */
type RefuseBeforeClaim = (
  code: BotWorkSessionRefusal,
  answer?: BotWorkSessionRefused,
) => Promise<BotWorkSessionRefused>;

/** One direction of a file move: what differs between the upload and the download; the order is `runFileCall`'s. */
interface FileMove<S, A extends { kind: string }> {
  tool: typeof UPLOAD | typeof DOWNLOAD;
  done: {
    action: "bot.work_session_upload" | "bot.work_session_download";
    outcome: "uploaded" | "downloaded";
  };
  /** txA's own step, as the asker, after the tool and storage: what the move takes, or its refusal. */
  asAsker(
    tx: Tx,
    p: { turn: AgentTurnRow; limit: BotFileLimit; refuse: RefuseBeforeClaim },
  ): Promise<{ source: S } | { answer: BotWorkSessionRefused }>;
  /** The bytes the transfer's deadline is computed for (the attachment's size; the limit for a download). */
  deadlineBytes(source: S, limit: BotFileLimit): number;
  /** txB's last step, after the claim, as the sponsor. */
  prepare(tx: Tx, p: FileCallBase & { source: S }): Promise<BotFilePrepared>;
  /** txC, as the sponsor: the outcome of the device's ack (null = the deadline passed). */
  finish(tx: Tx, transferId: string, ack: FileAck): Promise<BotFileFinished<A>>;
}

export function registerBotWorkSessionFileRoutes(
  scope: App,
  core: Core,
  workSession: Pick<WorkSessionModule, "botFiles">,
  /** Attachment object storage; null = every move answers `storage_unavailable` (no byte can move). */
  storage: ObjectStorage | null,
): void {
  const perms = createPermissionService(core);
  const { auditRefusal, refuseBeforeClaim, claim } = createWorkSessionCalls(core);
  const { botFiles } = workSession;

  /** The shared order of both moves (PD-06), for one call of `move` with `body`. */
  async function runFileCall<S, A extends { kind: string }>(
    cell: CellPrincipal,
    body: FileCallBody,
    move: FileMove<S, A>,
  ): Promise<A | BotWorkSessionRefused> {
    const record = (own: OwnSession | null, sponsorUserId: string | null): CallRecord => ({
      tool: move.tool,
      target: body.workSessionId,
      // Ids and the path's length only: the path itself is never logged or recorded (P1).
      metadata: {
        eventId: body.eventId,
        workSessionId: body.workSessionId,
        ...(body.attachmentId ? { attachmentId: body.attachmentId } : {}),
        pathLength: body.path.length,
      },
      sponsorUserId,
      projectId: own?.session.projectId ?? null,
      deviceId: own?.session.deviceId ?? null,
      workSessionId: body.workSessionId,
      ...(body.attachmentId ? { attachmentId: body.attachmentId } : {}),
      pathLength: body.path.length,
    });
    const unknownTurn = async (tx: Tx): Promise<typeof UNKNOWN> => {
      await auditUnknownTurn(tx, core, {
        cell,
        tool: move.tool,
        reason: "unknown_turn",
        metadata: record(null, null).metadata,
      });
      return UNKNOWN;
    };
    const tenantAs = (userId: string | null) => ({ organizationId: cell.organizationId, userId });

    // tx0 (no user): the turn of this bot, its profile, its own session and the limit that applies now.
    const found = await core.db.withTenant(
      tenantAs(null),
      async (
        tx,
      ): Promise<
        | typeof UNKNOWN
        | { askerUserId: string; own: OwnSession; limit: BotFileLimit }
        | { answer: BotWorkSessionRefused }
      > => {
        const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, body.eventId));
        if (!turn || turn.agentId !== body.agentId) return unknownTurn(tx);
        const profile = await loadBotProfile(tx, turn.agentId);
        const own = await ownBotSession(tx, { agentId: turn.agentId, workSessionId: body.workSessionId });
        if (profile && own) {
          return { askerUserId: turn.userId, own, limit: await botFiles.limitFor(tx, profile) };
        }
        // No profile (deleted after delivery) or not the bot's own session: still only for a live turn.
        const live = await liveTurn(tx, core, body);
        if (!live) return unknownTurn(tx);
        const code: BotWorkSessionRefusal = !live.tools.includes(move.tool)
          ? "not_in_turn"
          : own
            ? "profile_inactive"
            : "not_your_session";
        const sponsorUserId = own?.bot.sponsorUserId ?? profile?.sponsorUserId ?? null;
        return {
          answer: await refuseBeforeClaim(tx, { cell, turn: live, call: record(own, sponsorUserId), code }),
        };
      },
    );
    if (found === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
    if ("answer" in found) return found.answer;
    const { own, limit } = found;
    // The session's sponsor: the person it was started under (WR-05), whose rights decide the session and the move.
    const sponsorUserId = own.bot.sponsorUserId;
    const call = record(own, sponsorUserId);

    // txA, AS THE ASKER: the live turn, the tool, storage, then the move's own step (the attachment rule).
    const asked = await core.db.withTenant(
      tenantAs(found.askerUserId),
      async (tx): Promise<typeof UNKNOWN | { source: S } | { answer: BotWorkSessionRefused }> => {
        const turn = await liveTurn(tx, core, body);
        if (!turn) return unknownTurn(tx);
        const refuse: RefuseBeforeClaim = (code, answer) =>
          refuseBeforeClaim(tx, { cell, turn, call, code, ...(answer ? { answer } : {}) });
        if (!turn.tools.includes(move.tool)) return { answer: await refuse("not_in_turn") };
        if (!storage) return { answer: await refuse("storage_unavailable") };
        return move.asAsker(tx, { turn, limit, refuse });
      },
    );
    if (asked === UNKNOWN) throw notFound(UNKNOWN_TURN, "unknown_turn");
    if ("answer" in asked) return asked.answer;
    const { source } = asked;

    // PD-18: the waiter subscribes before the command can be enqueued; any refusal or error below aborts it.
    const transferId = randomUUID();
    const ac = new AbortController();
    const wait = botFiles.waitForAck(
      transferId,
      botFiles.deadlineFor(move.deadlineBytes(source, limit)),
      ac.signal,
    );

    // txB, AS THE SESSION'S SPONSOR: the session, the path, taint, the claim, then the move.
    let decided: typeof UNKNOWN | BotWorkSessionRefused | { enqueued: AgentTurnRow };
    try {
      decided = await core.db.withTenant(
        tenantAs(sponsorUserId),
        async (tx): Promise<typeof UNKNOWN | BotWorkSessionRefused | { enqueued: AgentTurnRow }> => {
          const turn = await liveTurn(tx, core, body);
          if (!turn) return unknownTurn(tx);
          const refuse = (code: BotWorkSessionRefusal, reason?: BotProfileInactiveReason) =>
            refuseBeforeClaim(tx, { cell, turn, call, code, ...(reason ? { reason } : {}) });
          if (!turn.tools.includes(move.tool)) return refuse("not_in_turn");
          // The bot's own session as the sponsor sees it now.
          const ownNow = await ownBotSession(tx, {
            agentId: turn.agentId,
            workSessionId: body.workSessionId,
          });
          if (!ownNow) return refuse("not_your_session");
          // D-12 (PD-14): only from the conversation the bot started the session in; a file never hops conversations.
          if (ownNow.bot.originConversationId !== turn.conversationId) return refuse("not_your_session");
          // The profile as it is now; one re-saved by someone else since never moves files in the new sponsor's name
          // into a session started under another (WR-05).
          const profile = await loadBotProfile(tx, turn.agentId);
          if (!profile || profile.sponsorUserId !== sponsorUserId) return refuse("profile_inactive");
          const status = await profileStatus(tx, perms, profile);
          if (!status.active) return refuse("profile_inactive", status.reason);
          const outOfScope = profileScopeRefusal(profile, status, ownNow.session);
          if (outOfScope) return refuse(outOfScope);
          // D-09 (PD-09): the shared deny list before the claim, so a refused path costs no transfer (the device
          // re-checks, authoritative). The path's shape was decided by the strict body.
          if (workSessionFilePathRefusal(body.path) !== null) return refuse("path_not_allowed");
          // D-02, D-10 (PD-13): after outside content a move runs only with the profile's admin flag, like a prompt.
          if (turn.tainted && !profile.actOnOutsideContent) return refuse("outside_content");
          // D-11 (WR-02 shape): after a read, only the one session the turn read.
          const exempt = turn.sessionOutputRead && (await readOnly(tx, turn.eventId, body.workSessionId));
          if (turn.sessionOutputRead && !exempt) return refuse("session_output");

          const refused = await claim(tx, {
            cell,
            turn,
            call,
            ...(exempt ? { sessionOutputExempt: true } : {}),
            ...(turn.tainted ? { outsideContent: true } : {}),
          });
          if (refused) return refused;

          const prepared = await move.prepare(tx, {
            turn,
            profile,
            own: ownNow,
            path: body.path,
            limit,
            transferId,
            source,
          });
          if (prepared.kind === "refused") return auditRefusal(tx, { cell, turn, call, answer: prepared });
          return { enqueued: turn };
        },
      );
    } catch (err) {
      ac.abort();
      throw err;
    }
    if (decided === UNKNOWN) {
      ac.abort();
      throw notFound(UNKNOWN_TURN, "unknown_turn");
    }
    if (!("enqueued" in decided)) {
      ac.abort();
      return decided;
    }
    const turn = decided.enqueued;

    // The wait, outside any transaction; then txC as the sponsor: the outcome and its one record.
    const ack = await wait;
    return core.db.withTenant(tenantAs(sponsorUserId), async (tx): Promise<A | BotWorkSessionRefused> => {
      const { answer, audit } = await move.finish(tx, transferId, ack);
      if (answer.kind === "refused") {
        return auditRefusal(tx, { cell, turn, call, answer: answer as unknown as BotWorkSessionRefused });
      }
      await auditBotWorkSession(tx, core, {
        action: move.done.action,
        turn,
        auditBase: cellAuditBase(cell),
        outcome: move.done.outcome,
        sponsorUserId,
        projectId: own.session.projectId,
        deviceId: own.session.deviceId,
        workSessionId: body.workSessionId,
        // PD-16: ids, the size, the sha256, the direction and the path's length; never the path.
        ...(audit
          ? {
              attachmentId: audit.attachmentId,
              bytes: audit.bytes,
              sha256: audit.sha256,
              direction: audit.direction,
              pathLength: audit.pathLength,
            }
          : {}),
      });
      return answer;
    });
  }

  scope.post(
    "/work-sessions/upload",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelWorkSessionUpload,
        response: { 200: AgentChannelWorkSessionUploadResponse },
      },
    },
    async (req) => {
      const body = req.body;
      type Source = { id: string; sizeBytes: number; sha256: string | null };
      return runFileCall<Source, AgentChannelWorkSessionUploadResponse>(cellOf(req), body, {
        tool: UPLOAD,
        done: { action: "bot.work_session_upload", outcome: "uploaded" },
        async asAsker(tx, { turn, limit, refuse }) {
          // D-02 (07.15 rule): a live message of this turn's thread, no later than the turn, that the asker reads.
          const row = await attachmentForTurn(tx, turn, body.attachmentId);
          if (!row) return { answer: await refuse("attachment_not_found") };
          // D-07 (PD-11): the limit before any byte moves, naming whose limit applied and the file's size.
          if (row.sizeBytes > limit.bytes) {
            return {
              answer: await refuse("file_too_large", {
                ...refusedAnswer("file_too_large"),
                sentence: botFileTooLargeSentence({ sizeBytes: row.sizeBytes, limit }),
                limit,
                sizeBytes: row.sizeBytes,
              }),
            };
          }
          return { source: { id: row.id, sizeBytes: row.sizeBytes, sha256: row.sha256 } };
        },
        deadlineBytes: (source) => source.sizeBytes,
        prepare: (tx, p) =>
          botFiles.prepareUpload(tx, {
            turn: p.turn,
            profile: p.profile,
            own: p.own,
            attachment: p.source,
            path: p.path,
            ...(body.overwrite !== undefined ? { overwrite: body.overwrite } : {}),
            limit: p.limit,
            transferId: p.transferId,
            tainted: p.turn.tainted,
          }),
        finish: (tx, transferId, ack) => botFiles.finish(tx, { transferId, direction: "to_device", ack }),
      });
    },
  );

  scope.post(
    "/work-sessions/download",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelWorkSessionDownload,
        response: { 200: AgentChannelWorkSessionDownloadResponse },
      },
    },
    async (req) =>
      runFileCall<null, AgentChannelWorkSessionDownloadResponse>(cellOf(req), req.body, {
        tool: DOWNLOAD,
        done: { action: "bot.work_session_download", outcome: "downloaded" },
        // Nothing to take from the chat: the file comes from the session's tree.
        asAsker: async () => ({ source: null }),
        // PD-18: the file's size is unknown until the device reports it, so the deadline is the limit's.
        deadlineBytes: (_source, limit) => limit.bytes,
        // PD-17: the attachment id is chosen here; the device's PUT stores the bytes under it, pending for the turn.
        prepare: (tx, p) =>
          botFiles.prepareDownload(tx, {
            turn: p.turn,
            profile: p.profile,
            own: p.own,
            path: p.path,
            limit: p.limit,
            transferId: p.transferId,
          }),
        finish: (tx, transferId, ack) => botFiles.finish(tx, { transferId, direction: "from_device", ack }),
      }),
  );
}
