import { isOrgCredentialMode, isPerMemberMode, projectFields, type WatchedField } from "@ocw/contracts";
import {
  mcpServers,
  mcpServerTools,
  messages,
  type Tx,
  watchedRecordChanges,
  watchedRecords,
  withSavepoint,
} from "@ocw/db";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { CanonicalHashError, canonicalHash } from "../../lib/canonical-json";
import { activeShare, connectionStatusFor, credentialKeyOf, credentialStatusFor } from "../connectors";
import { changedFields, conflictCard } from "./cards";
import { type CallOutcome, callWith, type ReadOutcome, readRecord } from "./check";
import { emitUpdated, type ServerRow, type WatchedRow } from "./service";
import { refuseTools } from "./tools";

/**
 * Compare-and-set writes to a watched record (07.6-14; AUTO-04, D-04, D-07, P-13; research Pattern 8). The only path
 * that changes an outside record: the Agent Channel route `POST /records/update` (`ocw_record_update`) decides the
 * turn, the taint and the 07.5 approval first, then calls `compareAndSet`, which
 *
 *   1. re-checks the watch's rules (`preflight`: the watch's bot, its write tool, the tool rule of 07.6-07, the
 *      requester's connection and share for per-member connectors, only watched top-level fields);
 *   2. takes the record's write lease (`write_lease_until`, only while the snapshot is still the one the route decided
 *      on and no other write holds a live lease: a second write at the same time is refused `write_in_progress`, never
 *      run over the first; review HI-01), held until the write ends; then re-reads the record and compares its hash
 *      with the stored snapshot. Every comparison read (before and after the write) uses the account the checks read
 *      with (the linker's, under their share: `readRecord`), so a requester whose own account sees another projection
 *      of the record never reads as a change (review LO-02); only the write and the note use the requester's account.
 *      The checks' account unavailable is `watch_paused`. On a mismatch NOTHING is written, a Not saved card with
 *      before → after goes to the
 *      card's thread, and the snapshot moves to the new values (a change made elsewhere is never overwritten);
 *   3. marks the write in progress (`last_written_hash` = the expected result, only while the snapshot is still the
 *      one compared: a check that ran in between and moved it is a conflict too), then calls the write tool with
 *      `{[idArg]: externalRef, …fields}` and, when the record exposes `updated_at` and the tool takes it,
 *      `expectedUpdatedAt` (the ERP's own guard; its refusal is a conflict like ours);
 *   4. re-reads and stores the new snapshot and `last_written_hash` (the next check does not report the bot's own
 *      write), then notes the change back with the watch's note tool when it has one (a note failure never undoes the
 *      write).
 *
 * No transaction is open during an outside call. Audits carry ids, counts and codes only: never a value, a label, the
 * external id or the note.
 */

export type JsonScalar = string | number | boolean | null;
export type RecordChanges = Readonly<Record<string, JsonScalar>>;

export type CasRefusal =
  | "not_watched"
  | "not_connected"
  | "member_account"
  | "no_write_tool"
  | "field_not_watched"
  | "tool_not_allowed"
  | "not_checked"
  | "write_in_progress"
  | "watch_paused"
  | "connector_error";

export type CasResult =
  | { kind: "written"; recordId: string }
  | { kind: "conflict"; recordId: string }
  | { kind: "refused"; code: CasRefusal };

/** Each outside call of a write (read, write, read, note) gets this long: four fit the cell's 35 s budget. */
const CALL_TIMEOUT_MS = 8_000;
/** How long a write lease lasts: past the write and the re-read (2 × 8 s), so a crashed API frees the record soon. */
const WRITE_LEASE_MS = 40_000;
/** An ERP's own version guard refusing the write (a stale `expectedUpdatedAt`, an ETag, a 409/412). */
const ERP_CONFLICT = /conflict|changed since|stale|precondition|version mismatch|modified since/iu;
/** The note tool's text argument, by the names ERPs use (the first its schema declares; `text` by default). */
const NOTE_ARGS = ["text", "note", "body", "content", "comment", "message"] as const;

// ---------------------------------------------------------------- pure parts

/** The key of a top-level JSON pointer (`/status` → `status`), or null for the whole record or a nested field. */
export function topLevelKey(pointer: string): string | null {
  if (!pointer.startsWith("/")) return null;
  const token = pointer.slice(1);
  if (token === "" || token.includes("/")) return null;
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

export type WritePlan =
  | { ok: true; fields: Record<string, JsonScalar>; labels: string[] }
  | { ok: false; code: Extract<CasRefusal, "no_write_tool" | "field_not_watched"> };

/**
 * What the write tool receives besides the id: each change must name a watched field (by its pointer) at the top level
 * of the record, never the id argument or the version guard. Labels follow the watch's order.
 */
export function writePlan(
  w: Pick<WatchedRow, "writeTool" | "idArg"> & { fields: readonly WatchedField[] },
  changes: RecordChanges,
): WritePlan {
  if (!w.writeTool) return { ok: false, code: "no_write_tool" };
  const watched = new Map(w.fields.map((f) => [f.pointer, f]));
  const fields: Record<string, JsonScalar> = {};
  const entries = Object.entries(changes);
  if (entries.length === 0) return { ok: false, code: "field_not_watched" };
  for (const [pointer, value] of entries) {
    const key = topLevelKey(pointer);
    if (!watched.has(pointer) || key === null || key === w.idArg || key === "expectedUpdatedAt") {
      return { ok: false, code: "field_not_watched" };
    }
    fields[key] = value;
  }
  const labels = w.fields.filter((f) => Object.hasOwn(changes, f.pointer)).map((f) => f.label);
  return { ok: true, fields, labels };
}

/** "Updated from OCW by Ops helper for Víctor Ruiz: Status, Delivery date" (bounded). */
export function noteText(botName: string, personName: string, labels: readonly string[]): string {
  return `Updated from OCW by ${botName} for ${personName}: ${labels.join(", ")}`.slice(0, 1000);
}

/** The note tool's text argument from its input schema (`text` when the schema is unknown or names none of them). */
export function noteArgOf(inputSchema: Record<string, unknown> | null | undefined, idArg: string): string {
  const props = inputSchema?.properties;
  if (props && typeof props === "object") {
    for (const name of NOTE_ARGS) if (name !== idArg && Object.hasOwn(props, name)) return name;
  }
  return "text";
}

/** Whether the write tool takes `expectedUpdatedAt` (unknown schema: yes, the plan's rule; a schema without it: no). */
export function takesExpectedUpdatedAt(inputSchema: Record<string, unknown> | null | undefined): boolean {
  const props = inputSchema?.properties;
  if (!props || typeof props !== "object") return true;
  return Object.hasOwn(props, "expectedUpdatedAt");
}

/** The outside calls and the bookkeeping of one compare-and-set (the DB side in `compareAndSet`, fakes in tests). */
export interface CasIo {
  /** The record, read with the account the checks read it with (LO-02). */
  read(): Promise<ReadOutcome>;
  /** The write tool with these arguments. */
  write(args: Record<string, unknown>): Promise<CallOutcome>;
  /** The note tool with this text (only when the watch has one). */
  note(text: string): Promise<CallOutcome>;
  /**
   * Takes the record's write lease, only while the snapshot is still `expected` (else `record_changed`) and no other
   * write holds a live lease (else `write_in_progress`).
   */
  lease(expected: string): Promise<"ok" | "record_changed" | "write_in_progress">;
  /** Gives the lease back (always, after `lease` returned `ok`). */
  release(): Promise<void>;
  /** Marks the write in progress: `last_written_hash` = `predicted`, only while the snapshot is still `expected`. */
  begin(expected: string, predicted: string): Promise<boolean>;
  /** Undoes `begin` after a write that did not happen. */
  abort(predicted: string): Promise<void>;
  /** The record changed elsewhere: the Not saved card and the snapshot moved to `after` (`erp`: the ERP refused). */
  conflict(after: Record<string, unknown>, afterHash: string, by: "snapshot" | "erp"): Promise<void>;
  /** The write happened: the new snapshot and `last_written_hash`. */
  written(after: Record<string, unknown>, afterHash: string, fieldCount: number): Promise<void>;
  /** The note-back's outcome (audited; never undoes the write). */
  noted(ok: boolean, code: string | null): Promise<void>;
}

export interface CasRow {
  externalRef: string;
  idArg: string;
  writeTool: string | null;
  noteTool: string | null;
  fields: readonly WatchedField[];
  snapshotHash: string | null;
}

const refused = (code: CasRefusal): CasResult => ({ kind: "refused", code });
/** The comparison read's code when the checks' account (the linker's) is unavailable to another requester. */
export const WATCH_PAUSED = "watch_paused";

const readRefusal = (r: Extract<ReadOutcome, { ok: false }>): CasResult =>
  refused(
    r.code === WATCH_PAUSED
      ? "watch_paused"
      : r.status === "not_connected"
        ? "not_connected"
        : "connector_error",
  );

function hashOf(record: unknown, fields: readonly WatchedField[]) {
  const projection = projectFields(record, fields);
  return { fields: projection.fields, hash: canonicalHash(projection) };
}

/** The compare-and-set itself, over `io` (see the file comment for the order). */
export async function runCompareAndSet(
  io: CasIo,
  w: CasRow,
  changes: RecordChanges,
  opts: { botName: string; personName: string; expectedUpdatedAt: boolean },
): Promise<CasResult> {
  const plan = writePlan(w, changes);
  if (!plan.ok) return refused(plan.code);
  // Nothing seen yet (the first check has not run): there is nothing to compare with, so nothing is written.
  if (w.snapshotHash === null) return refused("not_checked");
  const expected = w.snapshotHash;

  // One write at a time per record (HI-01): another write in flight is never run over, and the outcome of that write
  // is not reported as a change made elsewhere.
  const lease = await io.lease(expected);
  if (lease === "write_in_progress") return refused("write_in_progress");
  // A check moved the snapshot since the route decided: it reported that change, so this is a conflict too.
  if (lease === "record_changed") return { kind: "conflict", recordId: w.externalRef };
  try {
    return await leasedCompareAndSet(io, w, changes, opts, plan, expected);
  } finally {
    await io.release();
  }
}

/** Steps 2 to 4, under the record's write lease. */
async function leasedCompareAndSet(
  io: CasIo,
  w: CasRow,
  changes: RecordChanges,
  opts: { botName: string; personName: string; expectedUpdatedAt: boolean },
  plan: Extract<WritePlan, { ok: true }>,
  expected: string,
): Promise<CasResult> {
  const before = await io.read();
  if (!before.ok) return readRefusal(before);
  let now: { fields: Record<string, unknown>; hash: string };
  let predicted: string;
  try {
    now = hashOf(before.record, w.fields);
    predicted = canonicalHash({ v: 1, fields: { ...now.fields, ...changes } });
  } catch (err) {
    if (err instanceof CanonicalHashError) return refused("connector_error");
    throw err;
  }
  // Changed elsewhere since the last check: never overwritten (AUTO-04).
  if (now.hash !== expected) {
    await io.conflict(now.fields, now.hash, "snapshot");
    return { kind: "conflict", recordId: w.externalRef };
  }
  // A check moved the snapshot between our read and now: it reported a change, so this is a conflict too.
  if (!(await io.begin(expected, predicted))) return { kind: "conflict", recordId: w.externalRef };

  const updatedAt = (before.record as { updated_at?: unknown } | null)?.updated_at;
  const args: Record<string, unknown> = {
    ...plan.fields,
    [w.idArg]: w.externalRef,
    ...(opts.expectedUpdatedAt && typeof updatedAt === "string" ? { expectedUpdatedAt: updatedAt } : {}),
  };
  const wrote = await io.write(args);
  if (!wrote.ok) {
    await io.abort(predicted);
    return readRefusal(wrote);
  }
  if (wrote.result.isError) {
    await io.abort(predicted);
    if (!ERP_CONFLICT.test(wrote.result.content)) return refused("connector_error");
    // The ERP's own guard: it changed between our read and the write. Report the new values like any conflict.
    const again = await io.read();
    if (again.ok) {
      try {
        const latest = hashOf(again.record, w.fields);
        await io.conflict(latest.fields, latest.hash, "erp");
      } catch (err) {
        if (!(err instanceof CanonicalHashError)) throw err;
      }
    }
    return { kind: "conflict", recordId: w.externalRef };
  }

  // Written: the new snapshot from a fresh read (the expected values when that read fails).
  const after = await io.read();
  let stored: { fields: Record<string, unknown>; hash: string } = {
    fields: { ...now.fields, ...changes },
    hash: predicted,
  };
  if (after.ok) {
    try {
      stored = hashOf(after.record, w.fields);
    } catch (err) {
      if (!(err instanceof CanonicalHashError)) throw err;
    }
  }
  await io.written(stored.fields, stored.hash, plan.labels.length);

  if (w.noteTool) {
    const noted = await io.note(noteText(opts.botName, opts.personName, plan.labels));
    if (noted.ok && !noted.result.isError) await io.noted(true, null);
    else await io.noted(false, noted.ok ? "note_refused" : noted.code);
  }
  return { kind: "written", recordId: w.externalRef };
}

// ---------------------------------------------------------------- the DB side

const rowFields = (w: WatchedRow) => w.fields as unknown as WatchedField[];

/**
 * The watched record of a turn: the one whose card is the thread root of the turn's message (a mention in the card's
 * thread, or a 07.5 re-run on an approval card posted there), on the same board, watched by this bot. Null otherwise.
 */
export async function watchedForTurn(
  tx: Tx,
  turn: { messageId: string; agentId: string },
): Promise<{ w: WatchedRow; server: ServerRow } | null> {
  const [m] = await tx
    .select({ id: messages.id, threadId: messages.threadId, conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, turn.messageId))
    .limit(1);
  if (!m) return null;
  const [w] = await tx
    .select()
    .from(watchedRecords)
    .where(
      and(
        eq(watchedRecords.cardMessageId, m.threadId ?? m.id),
        eq(watchedRecords.conversationId, m.conversationId),
        eq(watchedRecords.agentId, turn.agentId),
      ),
    )
    .limit(1);
  if (!w) return null;
  const [server] = await tx.select().from(mcpServers).where(eq(mcpServers.id, w.mcpServerId)).limit(1);
  return server ? { w, server } : null;
}

/**
 * The watch's rules for one write, inside the caller's transaction (the route's claim transaction, and again before
 * the outside calls): its write tool, the changes, the tool rule (read and write tools still allowed for this bot), the
 * connector on, and for a per-member connector the requester's connection and their share on the board (07.4 D-03:
 * values read with their account land in the shared thread); for an organization-account connector (07.14) the
 * organization's connection instead. Null when every rule holds. The calls themselves go through `callWith`, which
 * picks the credential by the stored mode (the organization's key for the organization modes).
 */
export async function preflight(
  tx: Tx,
  p: { w: WatchedRow; server: ServerRow; requesterUserId: string; agentId: string; changes: RecordChanges },
): Promise<CasRefusal | null> {
  const { w, server } = p;
  if (w.agentId !== p.agentId) return "not_watched";
  const plan = writePlan({ writeTool: w.writeTool, idArg: w.idArg, fields: rowFields(w) }, p.changes);
  if (!plan.ok) return plan.code;
  // Every workspace connector (organization headers or the organization's own account) is the admin's to switch off.
  if (!isPerMemberMode(server.authMode) && !server.orgEnabled) return "connector_error";
  const tools = await refuseTools(tx, {
    serverId: server.id,
    agentId: p.agentId,
    readTool: w.readTool,
    otherTools: [w.writeTool],
  });
  if (tools) return "tool_not_allowed";
  // 07.14 (D-04, D-08): the organization's own account needs no member connection or share, only a usable
  // organization connection. Its refusal is never "connect your account": no member can fix it.
  if (isOrgCredentialMode(server.authMode)) {
    const key = credentialKeyOf(server, { organizationId: w.organizationId, userId: p.requesterUserId });
    if ((await credentialStatusFor(tx, key)) !== "connected") return "connector_error";
  }
  if (isPerMemberMode(server.authMode)) {
    const status = (await connectionStatusFor(tx, p.requesterUserId, [server.id])).get(server.id);
    if (status !== "connected") return "not_connected";
    const shared = await activeShare(tx, {
      userId: p.requesterUserId,
      conversationId: w.conversationId,
      resourceKind: "connector",
      resourceId: server.id,
    });
    if (!shared) return "member_account";
  }
  return null;
}

export interface CompareAndSetInput {
  organizationId: string;
  watchedRecordId: string;
  /**
   * The snapshot hash the route decided on (and any approval was given against, HI-02): the write happens only while
   * the stored snapshot is still this one (the lease checks it), so a change reported since is a conflict.
   */
  base: string | null;
  requesterUserId: string;
  /** The requester's display name (the note-back). */
  requesterName: string;
  agent: { id: string; displayName: string };
  changes: RecordChanges;
  /** The turn's event (audit metadata only). */
  eventId?: string | null;
}

export interface WriteDeps {
  /** The zone the conflict card's "Detected" time is written in (UTC by default, like the change card). */
  timeZone?: string;
}

export async function compareAndSet(core: Core, deps: WriteDeps, p: CompareAndSetInput): Promise<CasResult> {
  const ctx = { organizationId: p.organizationId, userId: p.requesterUserId };
  const loaded = await core.db.withTenant(ctx, async (tx) => {
    const [w] = await tx
      .select()
      .from(watchedRecords)
      .where(eq(watchedRecords.id, p.watchedRecordId))
      .limit(1);
    if (!w) return { ok: false as const, refused: "not_watched" as const };
    const [server] = await tx.select().from(mcpServers).where(eq(mcpServers.id, w.mcpServerId)).limit(1);
    if (!server) return { ok: false as const, refused: "not_watched" as const };
    // Before any outside call: every rule again (a grant revoked or a share withdrawn since the route decided).
    const code = await preflight(tx, {
      w,
      server,
      requesterUserId: p.requesterUserId,
      agentId: p.agent.id,
      changes: p.changes,
    });
    if (code) return { ok: false as const, refused: code };
    const noteAllowed =
      w.noteTool !== null &&
      (await refuseTools(tx, {
        serverId: server.id,
        agentId: p.agent.id,
        readTool: w.readTool,
        otherTools: [w.noteTool],
      })) === null;
    const named = [w.writeTool, w.noteTool].filter((t): t is string => t !== null);
    const schemas = new Map(
      (
        await tx
          .select({ name: mcpServerTools.name, inputSchema: mcpServerTools.inputSchema })
          .from(mcpServerTools)
          .where(and(eq(mcpServerTools.serverId, server.id), inArray(mcpServerTools.name, named)))
      ).map((t) => [t.name, t.inputSchema]),
    );
    return { ok: true as const, w, server, noteAllowed, schemas };
  });
  if (!loaded.ok) return refused(loaded.refused);
  const { w, server, noteAllowed, schemas } = loaded;
  const fields = rowFields(w);
  const audit = {
    conversationId: w.conversationId,
    cardMessageId: w.cardMessageId,
    agentId: p.agent.id,
    ...(p.eventId ? { eventId: p.eventId } : {}),
  };
  const record = (tx: Tx, action: string, metadata: Record<string, unknown>, result?: "denied" | "error") =>
    core.audit.record(tx, {
      action,
      actorKind: "agent",
      actorId: p.agent.id,
      agentId: p.agent.id,
      userId: p.requesterUserId,
      resourceType: "watched_record",
      resourceId: w.id,
      ...(result ? { result } : {}),
      metadata: { ...audit, ...metadata },
    });
  const call = (tool: string, args: Record<string, unknown>) =>
    callWith(core, {
      organizationId: p.organizationId,
      userId: p.requesterUserId,
      server,
      tool,
      arguments: args,
      timeoutMs: CALL_TIMEOUT_MS,
    });
  const fieldCount = Object.keys(p.changes).length;
  /** This write's lease, while held (its expiry doubles as the owner's token: `release` frees only its own). */
  let held: string | null = null;

  const io: CasIo = {
    // LO-02: compared with the account the snapshot was read with (the checks' own read: the linker's, under their
    // share for a per-member connector), never the requester's, which may see another projection of the record.
    read: async () => {
      const out = await readRecord(core, w, server, { timeoutMs: CALL_TIMEOUT_MS });
      if (!out.ok && out.status === "not_connected" && w.checkAsUserId !== p.requesterUserId) {
        return { ok: false, status: "error", code: WATCH_PAUSED };
      }
      return out;
    },
    write: (args) => call(w.writeTool ?? "", args),
    note: (text) =>
      call(w.noteTool ?? "", {
        [w.idArg]: w.externalRef,
        [noteArgOf(schemas.get(w.noteTool ?? ""), w.idArg)]: text,
      }),
    lease: (expected) =>
      core.db.withTenant(ctx, async (tx) => {
        const until = new Date(Date.now() + WRITE_LEASE_MS).toISOString();
        const taken = await tx
          .update(watchedRecords)
          .set({ writeLeaseUntil: until })
          .where(
            and(
              eq(watchedRecords.id, w.id),
              eq(watchedRecords.snapshotHash, expected),
              or(isNull(watchedRecords.writeLeaseUntil), lte(watchedRecords.writeLeaseUntil, sql`now()`)),
            ),
          )
          .returning({ id: watchedRecords.id });
        if (taken.length > 0) {
          held = until;
          return "ok";
        }
        const [now] = await tx
          .select({ snapshotHash: watchedRecords.snapshotHash })
          .from(watchedRecords)
          .where(eq(watchedRecords.id, w.id))
          .limit(1);
        const code = now && now.snapshotHash === expected ? "write_in_progress" : "record_changed";
        await record(
          tx,
          "watched_record.write_refused",
          { code, ...(code === "record_changed" ? { by: "check" } : {}), fieldCount },
          "denied",
        );
        return code;
      }),
    release: async () => {
      const mine = held;
      if (!mine) return;
      held = null;
      await core.db.withTenant(ctx, (tx) =>
        tx
          .update(watchedRecords)
          .set({ writeLeaseUntil: null })
          .where(and(eq(watchedRecords.id, w.id), eq(watchedRecords.writeLeaseUntil, mine))),
      );
    },
    begin: (expected, predicted) =>
      core.db.withTenant(ctx, async (tx) => {
        const marked = await tx
          .update(watchedRecords)
          .set({ lastWrittenHash: predicted })
          .where(and(eq(watchedRecords.id, w.id), eq(watchedRecords.snapshotHash, expected)))
          .returning({ id: watchedRecords.id });
        if (marked.length === 0) {
          await record(
            tx,
            "watched_record.write_refused",
            { code: "record_changed", by: "check", fieldCount },
            "denied",
          );
        }
        return marked.length > 0;
      }),
    abort: (predicted) =>
      core.db.withTenant(ctx, async (tx) => {
        await tx
          .update(watchedRecords)
          .set({ lastWrittenHash: w.lastWrittenHash })
          .where(and(eq(watchedRecords.id, w.id), eq(watchedRecords.lastWrittenHash, predicted)));
      }),
    conflict: (after, afterHash, by) =>
      core.db.withTenant(ctx, async (tx) => {
        const [locked] = await tx
          .select()
          .from(watchedRecords)
          .where(eq(watchedRecords.id, w.id))
          .for("update")
          .limit(1);
        await record(
          tx,
          "watched_record.write_refused",
          {
            code: "record_changed",
            by,
            fieldCount,
            changedCount: changedFields(fields, (locked?.snapshot ?? {}) as Record<string, unknown>, after)
              .length,
          },
          "denied",
        );
        // Only while the snapshot is still the one compared: a check that moved it already reported the change.
        if (!locked || locked.snapshotHash !== w.snapshotHash || afterHash === locked.snapshotHash) return;
        const now = new Date();
        const before = (locked.snapshot ?? {}) as Record<string, unknown>;
        const card = conflictCard({
          recordId: w.externalRef,
          connectorName: server.name,
          fields,
          before,
          after,
          source: "write",
          detectedAt: now,
          timeZone: deps.timeZone ?? "UTC",
          conversationId: w.conversationId,
          cardMessageId: w.cardMessageId,
          botName: p.agent.displayName,
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
                  idempotencyKey: `watched:${w.id}:conflict:${afterHash}:${w.snapshotHash}`,
                  onBehalfOfUserId: p.requesterUserId,
                  card,
                  cardPlatformOwned: true,
                })
              ).messageId,
            () => true,
          );
        } catch (err) {
          // The bot can no longer post here: the snapshot stays, so the next check reports the change.
          core.log.warn(
            { watchedRecordId: w.id, code: (err as { code?: string })?.code ?? "error" },
            "watched record: conflict card not posted",
          );
          return;
        }
        await tx.insert(watchedRecordChanges).values({
          organizationId: w.organizationId,
          watchedRecordId: w.id,
          detectedAt: now.toISOString(),
          source: "write",
          before,
          after,
          beforeHash: locked.snapshotHash,
          afterHash,
          messageId,
        });
        await tx
          .update(watchedRecords)
          .set({
            snapshot: after,
            snapshotHash: afterHash,
            lastStatus: "changed",
            lastChangedAt: now.toISOString(),
            checkedAt: now.toISOString(),
            // ME-01: an outside state was seen, so an earlier write of the bot no longer stands for the record.
            lastWrittenHash: null,
          })
          .where(eq(watchedRecords.id, w.id));
        await emitUpdated(core, tx, w);
      }),
    written: (after, afterHash, count) =>
      core.db.withTenant(ctx, async (tx) => {
        const now = new Date().toISOString();
        const moved = await tx
          .update(watchedRecords)
          .set({
            snapshot: after,
            snapshotHash: afterHash,
            lastWrittenHash: afterHash,
            lastStatus: "ok",
            checkedAt: now,
          })
          .where(
            and(
              eq(watchedRecords.id, w.id),
              inArray(watchedRecords.snapshotHash, [w.snapshotHash ?? "", afterHash]),
            ),
          )
          .returning({ id: watchedRecords.id });
        // A check reported someone else's change after our write: its snapshot stays, our write is still remembered.
        if (moved.length === 0) {
          await tx
            .update(watchedRecords)
            .set({ lastWrittenHash: afterHash })
            .where(eq(watchedRecords.id, w.id));
        }
        await record(tx, "watched_record.written", { fieldCount: count });
        await emitUpdated(core, tx, w);
      }),
    noted: (ok, code) =>
      core.db.withTenant(ctx, (tx) =>
        ok
          ? record(tx, "watched_record.note_written", {})
          : record(tx, "watched_record.note_failed", { code: code ?? "error" }, "error"),
      ),
  };

  const out = await runCompareAndSet(
    {
      ...io,
      note: noteAllowed ? io.note : async () => ({ ok: false, status: "error", code: "tool_not_allowed" }),
    },
    {
      externalRef: w.externalRef,
      idArg: w.idArg,
      writeTool: w.writeTool,
      noteTool: w.noteTool,
      fields,
      // The decided base, not the row as re-read here: a snapshot moved in between fails the lease (a conflict).
      snapshotHash: p.base,
    },
    p.changes,
    {
      botName: p.agent.displayName,
      personName: p.requesterName,
      expectedUpdatedAt: takesExpectedUpdatedAt(schemas.get(w.writeTool ?? "")),
    },
  );
  if (out.kind === "refused") {
    await core.db.withTenant(ctx, (tx) =>
      record(tx, "watched_record.write_refused", { code: out.code, fieldCount }, "denied"),
    );
  }
  return out;
}

/** What the Agent Channel route uses (injected: the agent-channel module never imports this one, no module cycle). */
export interface RecordWrites {
  watchedForTurn: typeof watchedForTurn;
  preflight: typeof preflight;
  compareAndSet(p: CompareAndSetInput): Promise<CasResult>;
}

export function createRecordWrites(core: Core, deps: WriteDeps = {}): RecordWrites {
  return {
    watchedForTurn,
    preflight,
    compareAndSet: (p) => compareAndSet(core, deps, p),
  };
}
