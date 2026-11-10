import {
  BOT_WORK_ZONE_LIMITS,
  type BotWorkSessionReadModel,
  onlyRelativePaths,
  type PromptStatus,
  redactSecrets,
  SessionEvent,
  userHandle,
  WorkSessionChanges,
  type WorkSessionDecider,
} from "@ocw/contracts";
import { orgMembers, projects, streamEvents, type Tx, workApprovals, workPrompts } from "@ocw/db";
import { and, asc, count, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { PermissionService, ResourceFacts } from "../organization";
import { sessionFactsForUsers } from "./facts";
import { type SessionRow, wsTopic } from "./service";

/**
 * Phase 07.16-17 (D-05, D-10, PD-14, principle 7): what `ocw_work_session_read` answers about a bot's own session.
 * Called in the sponsor's tenant transaction after the Agent Channel route found the bot's own session and claimed the
 * call. Sources, all cut at one snapshot (the stream's `lastSeq` read FIRST, then rows `≤ lastSeq`, the detail route's
 * order, so nothing committed in between is half in the answer):
 *
 * - `stream_events` of `ws:<id>`, type `work_session.event`: the `assistant.message` texts with `seq > cursor`, newest
 *   last, Σ ≤ `readOutputChars` with the tail kept (`truncated`); the latest `tool.started` (name, summary) with their
 *   `tool.completed` (ok), never their output. `assistant.delta` is never persisted, so it never shows here.
 * - the latest `work_session.changes`: ≤ `readFiles` files, every path re-filtered with `onlyRelativePaths` (the
 *   device's `contain()` ran first; the server never trusts it alone).
 * - `work_approvals` pending: tool, ≤ `readApprovalPaths` relative paths, summary. The bot cannot decide them (P3): the
 *   answer names up to three `deciders` instead (D-10, `sessionDeciders`).
 * - `work_prompts`: counts by status and the bot's own prompts (`author_agent_id`), by id: never a person's prompt text.
 * - the session's `lastError` when it failed (≤ `errorChars`).
 *
 * Every text passes `redactSecrets` before it is measured or cut, so the bounds hold on what is returned. No absolute
 * host path, URL or person's prompt can be expressed by the answer (the contract's `RelativePath` fields).
 */

export interface BotReadDeps {
  core: Pick<Core, "realtime">;
  perms: PermissionService;
}

export interface BotReadParams {
  /** The bot's own session (`ownBotSession`). */
  session: SessionRow;
  /** The session's sponsor (`bot_work_sessions.sponsor_user_id`): the first decider. */
  sponsorUserId: string;
  /** The bot reading: only its own prompts are listed. */
  agentId: string;
  /** A stream seq; absent = from the start. */
  cursor?: number;
}

/** How many tool events one read looks at (the newest first): enough to name the latest `readTools` tool uses. */
const TOOL_WINDOW = 200;

const L = BOT_WORK_ZONE_LIMITS;
const NAME_MAX = 200;
/** The contract's bound on the number of output texts. */
const OUTPUT_TEXTS_MAX = 50;

/** A text as the bot may read it: secrets redacted first, then bounded. */
const clean = (text: string, max: number) => redactSecrets(text).slice(0, max);

/**
 * The `assistant.message` texts of `rows` (newest first) cut to `budget` characters, the tail kept: the newest text is
 * always whole when it fits, an older one loses its head, anything older is dropped (`truncated`).
 */
function tailTexts(
  rows: ReadonlyArray<{ seq: number; text: string }>,
  budget: number,
  maxTexts: number,
): { texts: Array<{ seq: number; text: string }>; truncated: boolean } {
  const out: Array<{ seq: number; text: string }> = [];
  let left = budget;
  let truncated = rows.length > maxTexts;
  for (const r of rows.slice(0, maxTexts)) {
    if (left <= 0) {
      truncated = true;
      break;
    }
    const text = redactSecrets(r.text);
    if (text.length <= left) {
      out.push({ seq: r.seq, text });
      left -= text.length;
    } else {
      out.push({ seq: r.seq, text: text.slice(text.length - left) });
      left = 0;
      truncated = true;
    }
  }
  return { texts: out.reverse(), truncated };
}

export async function readBotWorkSession(
  tx: Tx,
  deps: BotReadDeps,
  p: BotReadParams,
): Promise<BotWorkSessionReadModel> {
  const s = p.session;
  const topic = wsTopic(s.id);
  // Snapshot cut: lastSeq FIRST, then only rows up to it.
  const lastSeq = await deps.core.realtime.lastSeq(tx, topic);
  const after = Math.min(p.cursor ?? 0, lastSeq);
  const eventType = sql<string>`${streamEvents.payload}->'event'->>'type'`;
  const inSnapshot = and(
    eq(streamEvents.streamId, topic),
    eq(streamEvents.type, "work_session.event"),
    lte(streamEvents.seq, lastSeq),
  );

  const [project] = await tx
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, s.projectId))
    .limit(1);

  // Output: the newest `assistant.message` texts after the cursor (one more than the cap tells whether any was left).
  const messageRows = await tx
    .select({ seq: streamEvents.seq, payload: streamEvents.payload })
    .from(streamEvents)
    .where(and(inSnapshot, gt(streamEvents.seq, after), eq(eventType, "assistant.message")))
    .orderBy(desc(streamEvents.seq))
    .limit(OUTPUT_TEXTS_MAX + 1);
  const messages = messageRows.flatMap((r) => {
    const ev = eventOf(r.payload);
    return ev?.type === "assistant.message" ? [{ seq: r.seq, text: ev.text }] : [];
  });
  const output = tailTexts(messages, L.readOutputChars, OUTPUT_TEXTS_MAX);

  // Tools: the latest uses after the cursor, names and summaries, ok from their completion; never their output.
  const toolRows = await tx
    .select({ seq: streamEvents.seq, payload: streamEvents.payload })
    .from(streamEvents)
    .where(
      and(inSnapshot, gt(streamEvents.seq, after), sql`${eventType} in ('tool.started', 'tool.completed')`),
    )
    .orderBy(desc(streamEvents.seq))
    .limit(TOOL_WINDOW);
  const completed = new Map<string, boolean>();
  const started: Array<{ toolUseId: string; name: string; summary: string }> = [];
  for (const r of toolRows) {
    const ev = eventOf(r.payload);
    if (ev?.type === "tool.completed") {
      if (!completed.has(ev.toolUseId)) completed.set(ev.toolUseId, ev.ok);
    } else if (ev?.type === "tool.started" && started.length < L.readTools) {
      started.push({ toolUseId: ev.toolUseId, name: ev.name, summary: ev.summary });
    }
  }
  const tools = started.reverse().map((t) => ({
    name: clean(t.name, 100),
    ok: completed.get(t.toolUseId) ?? null,
    summary: clean(t.summary, L.toolSummaryChars),
  }));

  // Changes: the latest persisted summary of the working tree (whatever the cursor), relative paths only.
  const [changesRow] = await tx
    .select({ payload: streamEvents.payload })
    .from(streamEvents)
    .where(
      and(
        eq(streamEvents.streamId, topic),
        eq(streamEvents.type, "work_session.changes"),
        lte(streamEvents.seq, lastSeq),
      ),
    )
    .orderBy(desc(streamEvents.seq))
    .limit(1);
  const parsedChanges = changesRow ? WorkSessionChanges.safeParse(changesRow.payload) : null;
  let changes: BotWorkSessionReadModel["changes"] = null;
  if (parsedChanges?.success) {
    const relative = parsedChanges.data.files.filter((f) => onlyRelativePaths([f.path]).length === 1);
    changes = {
      files: relative.slice(0, L.readFiles).map((f) => ({
        path: f.path,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      })),
      branch: parsedChanges.data.branch === null ? null : clean(parsedChanges.data.branch, NAME_MAX),
      truncated: parsedChanges.data.truncated || relative.length > L.readFiles,
    };
  }

  // Pending runtime approvals, oldest first (the order the runtime waits on them).
  const approvalRows = await tx
    .select({ id: workApprovals.id, request: workApprovals.request })
    .from(workApprovals)
    .where(and(eq(workApprovals.workSessionId, s.id), eq(workApprovals.status, "pending")))
    .orderBy(asc(workApprovals.createdAt))
    .limit(L.readApprovals);
  const approvals = approvalRows.map((a) => ({
    id: a.id,
    tool: clean(a.request.tool, 100),
    paths: onlyRelativePaths(a.request.paths ?? []).slice(0, L.readApprovalPaths),
    summary: clean(a.request.summary, L.toolSummaryChars),
  }));

  // The queue: counts by status, and the bot's own prompts by id (never a person's text, never any text).
  const counts = await tx
    .select({ status: workPrompts.status, n: count() })
    .from(workPrompts)
    .where(eq(workPrompts.workSessionId, s.id))
    .groupBy(workPrompts.status);
  const n = (...statuses: PromptStatus[]) =>
    counts.filter((c) => statuses.includes(c.status)).reduce((t, c) => t + Number(c.n), 0);
  const mine = await tx
    .select({ id: workPrompts.id, status: workPrompts.status, position: workPrompts.position })
    .from(workPrompts)
    .where(and(eq(workPrompts.workSessionId, s.id), eq(workPrompts.authorAgentId, p.agentId)))
    .orderBy(desc(workPrompts.position), desc(workPrompts.createdAt))
    .limit(L.readMine);

  return {
    session: {
      id: s.id,
      status: s.status,
      runtime: s.runtime,
      model: s.model === null ? null : s.model.slice(0, NAME_MAX),
      mode: s.permissionMode,
      worktree: s.worktree,
      title: clean(s.title, NAME_MAX),
      projectName: (project?.name ?? "").slice(0, NAME_MAX),
      updatedAt: new Date(s.updatedAt).toISOString(),
    },
    queue: {
      queued: n("queued"),
      running: n("dispatched", "running"),
      completed: n("completed"),
      failed: n("failed"),
      cancelled: n("cancelled"),
      mine: mine.reverse(),
    },
    output,
    tools,
    changes,
    approvals,
    deciders: await sessionDeciders(tx, deps.perms, { session: s, sponsorUserId: p.sponsorUserId }),
    error: s.status === "failed" && s.lastError ? clean(s.lastError, L.errorChars) : null,
    cursor: lastSeq,
  };
}

/** A persisted `work_session.event` payload's event, or null when it does not parse (skipped, never guessed). */
function eventOf(payload: unknown) {
  const ev = (payload as { event?: unknown } | null)?.event;
  const parsed = SessionEvent.safeParse(ev);
  return parsed.success ? parsed.data : null;
}

/**
 * The people who may decide the session's runtime approvals (D-10): up to `deciders` active members the resolver allows
 * `work_session.approve` on the session's own facts (`sessionFactsForUsers`, the one builder), the sponsor first, then
 * the device's owner, then the others by display name. The bot names them; it never decides (P3). 07.16-20's wake
 * reuses this list.
 */
export async function sessionDeciders(
  tx: Tx,
  perms: PermissionService,
  p: { session: Pick<SessionRow, "id" | "createdBy" | "deviceId">; sponsorUserId: string },
): Promise<WorkSessionDecider[]> {
  const members = await tx
    .select({ userId: orgMembers.userId, displayName: orgMembers.displayName, email: orgMembers.email })
    .from(orgMembers)
    .where(isNull(orgMembers.deactivatedAt));
  if (members.length === 0) return [];
  const ids = members.map((m) => m.userId);
  const facts = await sessionFactsForUsers(tx, p.session, ids);
  const allowed = new Set(
    await perms.usersAllowed(tx, {
      candidates: ids,
      permission: "work_session.approve",
      resourceFor: (id) => facts.get(id) as ResourceFacts,
    }),
  );
  const ownerRow = await tx.execute(
    sql`select sh.owner::text as owner from app.work_session_shape(${p.session.id}::uuid) sh`,
  );
  const owner = (ownerRow.rows[0] as { owner: string | null } | undefined)?.owner ?? null;
  const rank = (id: string) => (id === p.sponsorUserId ? 0 : id === owner ? 1 : 2);
  return members
    .filter((m) => allowed.has(m.userId))
    .sort(
      (a, b) =>
        rank(a.userId) - rank(b.userId) ||
        a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" }),
    )
    .slice(0, L.deciders)
    .map((m) => ({
      id: m.userId,
      handle: userHandle({ displayName: m.displayName, email: m.email }).slice(0, 64),
      displayName: m.displayName.slice(0, NAME_MAX),
    }));
}
