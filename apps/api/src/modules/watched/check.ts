import {
  projectFields,
  type WatchedCheckSource,
  type WatchedField,
  type WatchedStatus,
} from "@ocw/contracts";
import { mcpServers, type Tx, watchedRecordChanges, watchedRecords, withSavepoint } from "@ocw/db";
import { and, eq, lte, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { CanonicalHashError, canonicalHash } from "../../lib/canonical-json";
import { egressFor } from "../../lib/egress";
import { ensureAgentDm } from "../chat";
import {
  type AccessToken,
  accessTokenFor,
  activeShare,
  ConnectorTokenUnavailableError,
  callTool,
  forceRefresh,
  type McpAuth,
  McpUpstreamError,
  markNeedsReconnect,
  touchConnection,
} from "../connectors";
import { orgSecretHeaders } from "../mcp";
import type { PermissionService } from "../organization";
import { changeCard, changedFields, reconnectCard } from "./cards";
import { emitUpdated, minutes, type ServerRow, type WatchedRow } from "./service";
import { refuseTools } from "./tools";

/** The check's code when the read tool is no longer allowed (fails closed, audited `denied` at every check). */
export const TOOL_NOT_ALLOWED = "tool_not_allowed";

/**
 * Watched-record checks (AUTO-04, D-04, D-07, P-13; Pattern 8, Pitfall 9). A check reads the record through the 07.4
 * connector (the workspace's org-secret headers, or the linker's own member credential under the share rule), projects
 * the watched fields, hashes them (`canonicalHash`, RFC 8785) and compares with the snapshot:
 *
 * - no snapshot yet → the baseline, silently;
 * - same hash → nothing; equal to `last_written_hash` → the bot's own write (07.6-14), silently;
 * - otherwise → a `watched_record_changes` row and a platform-owned change card in the card's thread by the watch's bot,
 *   then the snapshot moves on.
 *
 * No transaction is open during the network call (read the row in one short transaction, call, then write in another
 * that re-locks the row). Jobs carry ids and the source only; audits carry ids and counts, never a value.
 */

export interface WatchedJobDeps {
  perms: PermissionService;
  /** The zone the change card's "Detected" time is written in (the card is the same for every reader). */
  timeZone?: string;
}

const READ_TIMEOUT_MS = 30_000;
/** Due watches handled per tick (the tick runs every five minutes). */
const TICK_BATCH = 500;

export type ReadOutcome =
  | { ok: true; record: unknown }
  | { ok: false; status: Extract<WatchedStatus, "not_connected" | "unreachable" | "error">; code: string };

const fail = (status: Extract<ReadOutcome, { ok: false }>["status"], code: string): ReadOutcome => ({
  ok: false,
  status,
  code,
});

function targetOf(server: ServerRow) {
  return {
    url: server.url ?? "",
    transport: server.transport === "sse" ? ("sse" as const) : ("streamable-http" as const),
  };
}

function upstreamFailure(err: unknown): ReadOutcome {
  if (err instanceof ConnectorTokenUnavailableError) return fail("unreachable", "token_unavailable");
  if (err instanceof McpUpstreamError) {
    if (err.code === "timeout" || err.code === "upstream_error") return fail("unreachable", err.code);
    return fail("error", err.code);
  }
  return fail("error", "connector_error");
}

/** The tool's text as JSON (structured content when the server sent only that); never a partial document. */
function parseResult(result: { content: string; truncated: boolean; isError: boolean }): ReadOutcome {
  if (result.isError) {
    return fail(
      "error",
      /not[\s_-]?found|no such|unknown/iu.test(result.content) ? "record_not_found" : "connector_error",
    );
  }
  if (result.truncated) return fail("error", "unreadable");
  try {
    return { ok: true, record: JSON.parse(result.content) as unknown };
  } catch {
    return fail("error", "unreadable");
  }
}

/**
 * Reads one record through a connector as `userId` (the linker for checks, the caller for previews): an org-secret
 * server with the workspace's headers; a per-member one with that member's own credential (one forced refresh on a 401,
 * then `needs_reconnect`). Only 07.4's `callTool` through the egress guard (T-07.6-07-03). The share rule is the
 * caller's (checked before).
 */
export async function readWith(
  core: Core,
  p: {
    organizationId: string;
    userId: string;
    server: ServerRow;
    readTool: string;
    idArg: string;
    externalRef: string;
  },
): Promise<ReadOutcome> {
  const call = { name: p.readTool, arguments: { [p.idArg]: p.externalRef } };
  const target = targetOf(p.server);
  const egress = egressFor(core.env);
  const run = (auth: McpAuth, redact: readonly string[]) =>
    callTool(egress, target, auth, call, { timeoutMs: READ_TIMEOUT_MS, redact });

  if (p.server.authMode === "org_secret") {
    const headers = await core.db.withTenant({ organizationId: p.organizationId, userId: p.userId }, (tx) =>
      orgSecretHeaders(core, tx, p.server.id),
    );
    if (!headers) return fail("error", "connector_unavailable");
    try {
      return parseResult(await run({ headerName: "", headerValue: "", extraHeaders: headers }, []));
    } catch (err) {
      return upstreamFailure(err);
    }
  }

  const key = { organizationId: p.organizationId, userId: p.userId, serverId: p.server.id };
  const unauthorized = (err: unknown) => err instanceof McpUpstreamError && err.code === "unauthorized";
  const withToken = (t: Extract<AccessToken, { ok: true }>) =>
    run({ headerName: t.headerName, headerValue: t.headerValue }, t.secretParts);
  try {
    const token = await accessTokenFor(core, key);
    if (!token.ok) return fail("not_connected", token.reason);
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await withToken(token);
    } catch (err) {
      if (!unauthorized(err)) throw err;
      // A 401 on a token that still looked valid: exactly one forced refresh and one retry (07.4 D-01).
      const fresh = await forceRefresh(core, key);
      if (!fresh.ok) return fail("not_connected", "needs_reconnect");
      try {
        result = await withToken(fresh);
      } catch (retryErr) {
        if (!unauthorized(retryErr)) throw retryErr;
        await markNeedsReconnect(core, { ...key, code: "upstream_unauthorized" });
        return fail("not_connected", "needs_reconnect");
      }
    }
    await core.db.withTenant({ organizationId: p.organizationId, userId: p.userId }, (tx) =>
      touchConnection(tx, { userId: p.userId, serverId: p.server.id }),
    );
    return parseResult(result);
  } catch (err) {
    return upstreamFailure(err);
  }
}

/** A watch's read: the share rule first for per-member connectors (Pitfall 8), then the connector. */
export async function readRecord(core: Core, w: WatchedRow, server: ServerRow): Promise<ReadOutcome> {
  // Before every call: the read tool is still read-only, not destructive, not a dangerous name and granted to the
  // watch's bot (a re-probe or a revoked grant since the link fails closed; `checkWatchedRecord` audits it).
  const refused = await core.db.withTenant({ organizationId: w.organizationId }, (tx) =>
    refuseTools(tx, { serverId: server.id, agentId: w.agentId, readTool: w.readTool }),
  );
  if (refused) return fail("error", TOOL_NOT_ALLOWED);
  if (server.authMode !== "org_secret") {
    const shared = await core.db.withTenant(
      { organizationId: w.organizationId, userId: w.checkAsUserId },
      (tx) =>
        activeShare(tx, {
          userId: w.checkAsUserId,
          conversationId: w.conversationId,
          resourceKind: "connector",
          resourceId: server.id,
        }),
    );
    if (!shared) return fail("not_connected", "share_revoked");
  }
  return readWith(core, {
    organizationId: w.organizationId,
    userId: w.checkAsUserId,
    server,
    readTool: w.readTool,
    idArg: w.idArg,
    externalRef: w.externalRef,
  });
}

/** "Reconnect to keep watching" for the linker only, in their DM with the watch's bot; never in the shared thread. */
async function tellLinker(core: Core, deps: WatchedJobDeps, tx: Tx, w: WatchedRow, server: ServerRow) {
  try {
    await withSavepoint(
      tx,
      async (sp) => {
        const dm = await ensureAgentDm(
          sp,
          { audit: core.audit, realtime: core.realtime, perms: deps.perms },
          { agentId: w.agentId, userId: w.checkAsUserId },
        );
        const card = reconnectCard({
          recordId: w.externalRef,
          connectorName: server.name,
          serverId: server.id,
        });
        await core.chatAgent.postAgentMessageIn(sp, {
          agentId: w.agentId,
          conversationId: dm.conversationId,
          threadRootId: null,
          body: card.summary,
          idempotencyKey: `watched:${w.id}:reconnect:${Date.now()}`,
          onBehalfOfUserId: w.checkAsUserId,
          card,
          cardPlatformOwned: true,
        });
      },
      () => true,
    );
  } catch (err) {
    // A courtesy: the watch is paused either way (status `not_connected`, shown on the strip).
    core.log.warn(
      { watchedRecordId: w.id, code: (err as { code?: string })?.code ?? "error" },
      "watched record: reconnect notice not posted",
    );
  }
}

/**
 * One check of one watch (the `watched.check` job; idempotent: a retry after commit finds the same hash). The row may
 * be gone (unlinked) or hidden by RLS (a forged cross-tenant id): then nothing happens.
 */
export async function checkWatchedRecord(
  core: Core,
  deps: WatchedJobDeps,
  p: { organizationId: string; watchedRecordId: string; source: WatchedCheckSource },
): Promise<void> {
  const loaded = await core.db.withTenant({ organizationId: p.organizationId }, async (tx) => {
    const [w] = await tx
      .select()
      .from(watchedRecords)
      .where(eq(watchedRecords.id, p.watchedRecordId))
      .limit(1);
    if (!w) return null;
    const [server] = await tx.select().from(mcpServers).where(eq(mcpServers.id, w.mcpServerId)).limit(1);
    return server ? { w, server } : null;
  });
  if (!loaded) return;
  const { server } = loaded;

  // Outside any transaction: the network read.
  const outcome = await readRecord(core, loaded.w, server);

  await core.db.withTenant(
    { organizationId: p.organizationId, userId: loaded.w.checkAsUserId },
    async (tx) => {
      const [w] = await tx
        .select()
        .from(watchedRecords)
        .where(eq(watchedRecords.id, p.watchedRecordId))
        .for("update")
        .limit(1);
      if (!w) return;
      const now = new Date();
      const timing = {
        checkedAt: now.toISOString(),
        nextCheckAt: new Date(now.getTime() + minutes(w.checkIntervalMinutes)).toISOString(),
      };
      const auditMeta = {
        conversationId: w.conversationId,
        cardMessageId: w.cardMessageId,
        source: p.source,
      };

      const failed = async (status: Extract<ReadOutcome, { ok: false }>["status"], code: string) => {
        await tx
          .update(watchedRecords)
          .set({ lastStatus: status, ...timing })
          .where(eq(watchedRecords.id, w.id));
        const transition = w.lastStatus !== status;
        // A refused tool is audited at every check (a call the platform would not make); others once per transition.
        if (transition || code === TOOL_NOT_ALLOWED) {
          await core.audit.record(tx, {
            action: status === "not_connected" ? "watched_record.paused" : "watched_record.check_failed",
            resourceType: "watched_record",
            resourceId: w.id,
            userId: w.checkAsUserId,
            result: code === TOOL_NOT_ALLOWED ? "denied" : "error",
            metadata: { ...auditMeta, status, code },
          });
        }
        // Only the linker can fix their own connection; a revoked share is their own choice (nothing to tell).
        if (transition && status === "not_connected" && code !== "share_revoked") {
          await tellLinker(core, deps, tx, w, server);
        }
        await emitUpdated(core, tx, w);
      };

      if (!outcome.ok) return failed(outcome.status, outcome.code);

      const fields = w.fields as unknown as WatchedField[];
      const projection = projectFields(outcome.record, fields);
      let hash: string;
      try {
        hash = canonicalHash(projection);
      } catch (err) {
        if (err instanceof CanonicalHashError) return failed("error", err.code);
        throw err;
      }

      const quiet = async () => {
        await tx
          .update(watchedRecords)
          .set({ snapshot: projection.fields, snapshotHash: hash, lastStatus: "ok", ...timing })
          .where(eq(watchedRecords.id, w.id));
        await emitUpdated(core, tx, w);
      };
      // The baseline, an unchanged record, or the bot's own last write (07.6-14): nothing to report.
      if (w.snapshotHash === null || hash === w.snapshotHash || hash === w.lastWrittenHash) return quiet();
      const before = (w.snapshot ?? {}) as Record<string, unknown>;
      const changed = changedFields(fields, before, projection.fields);
      if (changed.length === 0) return quiet();

      const card = changeCard({
        recordId: w.externalRef,
        connectorName: server.name,
        fields,
        before,
        after: projection.fields,
        source: p.source,
        detectedAt: now,
        timeZone: deps.timeZone ?? "UTC",
        conversationId: w.conversationId,
        cardMessageId: w.cardMessageId,
      });
      let messageId: string;
      try {
        messageId = await withSavepoint(
          tx,
          async (sp) =>
            (
              await core.chatAgent.postAgentMessageIn(sp, {
                agentId: w.agentId,
                conversationId: w.conversationId,
                threadRootId: w.cardMessageId,
                body: card.summary,
                idempotencyKey: `watched:${w.id}:${hash}:${w.snapshotHash}`,
                onBehalfOfUserId: w.checkAsUserId,
                card,
                cardPlatformOwned: true,
              })
            ).messageId,
          () => true,
        );
      } catch (err) {
        // The bot can no longer post here (removed, disabled, the linker lost the board): the snapshot stays, so the
        // change is reported once it can.
        core.log.warn(
          { watchedRecordId: w.id, code: (err as { code?: string })?.code ?? "error" },
          "watched record: change card not posted",
        );
        return failed("error", "bot_cannot_post");
      }
      await tx.insert(watchedRecordChanges).values({
        organizationId: w.organizationId,
        watchedRecordId: w.id,
        detectedAt: now.toISOString(),
        source: p.source,
        before,
        after: projection.fields,
        beforeHash: w.snapshotHash,
        afterHash: hash,
        messageId,
      });
      await tx
        .update(watchedRecords)
        .set({
          snapshot: projection.fields,
          snapshotHash: hash,
          lastStatus: "changed",
          lastChangedAt: now.toISOString(),
          ...timing,
        })
        .where(eq(watchedRecords.id, w.id));
      await core.audit.record(tx, {
        action: "watched_record.changed",
        resourceType: "watched_record",
        resourceId: w.id,
        userId: w.checkAsUserId,
        metadata: { ...auditMeta, fieldCount: changed.length },
      });
      await emitUpdated(core, tx, w);
    },
  );
}

/**
 * The global tick: due watches (ids only, `app.due_watched_records`), each claimed in its organization's transaction
 * (its next check moves on) and enqueued there, so a slow check never makes the next tick enqueue it twice.
 */
export async function watchedTick(core: Core, now = new Date()): Promise<number> {
  const due = await core.db.pool.query<{ id: string; organization_id: string }>(
    "select id, organization_id from app.due_watched_records($1, $2)",
    [TICK_BATCH, now.toISOString()],
  );
  let queued = 0;
  for (const row of due.rows) {
    try {
      const sent = await core.db.withTenant({ organizationId: row.organization_id }, async (tx) => {
        const claimed = await tx
          .update(watchedRecords)
          .set({
            nextCheckAt: sql`now() + make_interval(mins => ${watchedRecords.checkIntervalMinutes})`,
          })
          .where(and(eq(watchedRecords.id, row.id), lte(watchedRecords.nextCheckAt, now.toISOString())))
          .returning({ id: watchedRecords.id });
        if (claimed.length === 0) return false;
        await core.jobs.sendInTx(tx, "watched.check", {
          organizationId: row.organization_id,
          watchedRecordId: row.id,
          source: "schedule",
        });
        return true;
      });
      if (sent) queued++;
    } catch (err) {
      core.log.warn({ watchedRecordId: row.id, err: { name: (err as Error)?.name } }, "watched tick failed");
    }
  }
  return queued;
}

/** `watched.tick` every five minutes (UTC) → `watched.check` per due watch; both handlers. */
export function registerWatchedJobs(core: Core, deps: WatchedJobDeps): void {
  core.jobs.schedule("watched.tick", "*/5 * * * *");
  core.jobs.work("watched.tick", async () => {
    await watchedTick(core);
  });
  core.jobs.work("watched.check", (data) => checkWatchedRecord(core, deps, data));
}
