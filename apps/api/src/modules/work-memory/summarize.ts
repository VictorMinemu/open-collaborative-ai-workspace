import { createHash, randomBytes } from "node:crypto";
import { EventTypes, MEMORY_LIMITS, type ModelRef } from "@ocw/contracts";
import {
  aiUsageRecords,
  approvalRequests,
  projects,
  streamEvents,
  type Tx,
  tenantOf,
  workMemoryPrefs,
  workPrompts,
  workSessionMemory,
  workSessions,
} from "@ocw/db";
import { and, asc, eq, gt, inArray, or, type SQL, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { JobData } from "../../lib/jobs";
import {
  type BuildInput,
  backendClassOf,
  consumeGeneration,
  pickTitleModel,
  recordStandaloneUsage,
  runOneShot,
} from "../ai-chat";
import type { CreateMemoryProposalInput, MemoryService, ProposalPrescan } from "../memory";
import { loadAiChatPolicy, type ModelGateway, type ResolvedModel } from "../model-gateway";
import type { PermissionService } from "../organization";
import { sessionFacts } from "../work-session";
import { memoryRecipients, type SessionRef, unitForSession } from "./session-unit";

/**
 * A finished Work Zone session's memory summary (Phase 07.6, AUTO-06; D-06, D-07, D-10, D-11; P-15, P-16).
 *
 * - Input (`collectSessionInput`): the prompts that ran, the assistant's messages, the tools' one-line summaries, the
 *   changed files and the diff stat, newest kept within 24 000 characters. Only repo-relative paths reach the model
 *   (principle 7): anything that looks absolute becomes the part after the repository's folder, or `<path>`.
 * - Consent and payment: the job runs on `completed` / `archived` (mode `auto`, only with the owner's preference on) or
 *   when the owner pressed Propose (mode `manual`). The owner pays: their model (their default, its small model as for
 *   titles), their credential, their AI chat cap (`consumeGeneration`), one `session_summary` usage record.
 * - Nothing is generated for a session whose repository is linked to no team project (07.9), or with nothing new since
 *   the last proposal. A later completion with new work proposes once more.
 * - The proposal is 07.2's, with the system origin: the detector and the deciders apply unchanged.
 * - Every state change reaches the session's readers on their own `user:` topics after commit (D-11).
 */

export const SUMMARY_INPUT_MAX_CHARS = 24_000;
/** One event's line before the total cap (a huge tool summary must not crowd out everything else). */
const LINE_MAX_CHARS = 4_000;
/** The model call's deadline. */
const SUMMARY_TIMEOUT_MS = 60_000;
/** A `writing` state older than this is a job that died: another run may take over (and the strip offers Try again). */
export const STALE_WRITING_MS = 10 * 60_000;
const STALE_WRITING = `${STALE_WRITING_MS / 60_000} minutes`;

/** Whether a `writing` claim last touched at `updatedAt` belongs to a job that died (07.6 review C ME-01). */
export function writingIsStale(updatedAt: string | Date, now: number = Date.now()): boolean {
  return new Date(updatedAt).getTime() < now - STALE_WRITING_MS;
}
const SUMMARY_TITLE_MAX = 120;

// ---------------------------------------------------------------- repo-relative text (principle 7)

const STOP = `\\s'"\`()<>,;|`;
/** `C:\\…` and `\\\\server\\share\\…`. */
const WINDOWS_PATH = new RegExp(`(?:\\b[A-Za-z]:\\\\|\\\\\\\\)[^${STOP}]*`, "g");
/** `~/…`. */
const HOME_PATH = new RegExp(`(?<![\\w.-])~\\/[^${STOP}]*`, "g");
/** `/a/b…` (two segments at least, so slash commands like `/compact` stay), never inside a URL or a relative path. */
const POSIX_PATH = new RegExp(`(?<![\\w.~:/\\\\-])\\/[^${STOP}/]+(?:\\/[^${STOP}]*)+`, "g");

/**
 * Rewrites every absolute-looking path in `text` to its part inside the repository (after the last segment named like
 * the repository's folder), or to `<path>` when that cannot be told. Sentence punctuation after a path is kept.
 */
export function toRepoRelative(text: string, repoName: string | null): string {
  const repo = repoName?.trim().toLowerCase() || null;
  const rewrite = (match: string): string => {
    const trailing = /[.:!?]+$/.exec(match)?.[0] ?? "";
    const body = trailing ? match.slice(0, -trailing.length) : match;
    const segments = body.split(/[\\/]+/).filter((s) => s.length > 0 && s !== "~" && !/^[A-Za-z]:$/.test(s));
    if (repo) {
      const at = segments.map((s) => s.toLowerCase()).lastIndexOf(repo);
      if (at >= 0 && at < segments.length - 1) return segments.slice(at + 1).join("/") + trailing;
    }
    return `<path>${trailing}`;
  };
  return text.replace(WINDOWS_PATH, rewrite).replace(HOME_PATH, rewrite).replace(POSIX_PATH, rewrite);
}

// ---------------------------------------------------------------- the input

/** One content event of the session's stream, as the summary reads it. */
export type SessionInputRow =
  | { seq: number; kind: "prompt"; text: string }
  | { seq: number; kind: "assistant"; text: string }
  | { seq: number; kind: "tool"; name: string; text: string }
  | {
      seq: number;
      kind: "changes";
      files: ReadonlyArray<{ path: string; additions: number; deletions: number }>;
    };

export interface SessionInput {
  text: string;
  /** The last content event the input covers (the previous `sinceSeq` when there is none). */
  lastSeq: number;
  /** Nothing happened after `sinceSeq`. */
  empty: boolean;
  /**
   * A tool ran in the covered range: its output (files, web pages, MCP results) shaped what the session said, so the
   * proposal is tainted like an agent turn that read untrusted content (07.6 review C LO-04).
   */
  usedTools: boolean;
}

const cap = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function lineOf(row: SessionInputRow, repoName: string | null): string | null {
  const clean = (s: string) => cap(toRepoRelative(s.trim(), repoName), LINE_MAX_CHARS);
  switch (row.kind) {
    case "prompt":
      return row.text.trim() ? `Prompt: ${clean(row.text)}` : null;
    case "assistant":
      return row.text.trim() ? `Assistant: ${clean(row.text)}` : null;
    case "tool":
      return `Tool ${clean(row.name)}: ${clean(row.text)}`;
    case "changes": {
      // Stored change lists are repo-relative already (the server drops anything else); rewritten again anyway.
      const files = row.files.map(
        (f) => `${toRepoRelative(f.path, repoName)} (+${f.additions} -${f.deletions})`,
      );
      return files.length > 0 ? cap(`Changed files: ${files.join(", ")}`, LINE_MAX_CHARS) : null;
    }
  }
}

/**
 * The summary's input from the session's content events after `sinceSeq` (pure; `collectSessionInput` reads them).
 * Only the latest change list counts; the newest lines are kept within `maxChars`, in their original order.
 */
export function buildSessionInput(
  rows: readonly SessionInputRow[],
  o: {
    sinceSeq: number | null;
    repoName: string | null;
    title: string;
    diffStat: { files: number; additions: number; deletions: number } | null;
    maxChars?: number;
  },
): SessionInput {
  const since = o.sinceSeq ?? 0;
  const fresh = [...rows].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
  if (fresh.length === 0) return { text: "", lastSeq: since, empty: true, usedTools: false };
  const usedTools = fresh.some((r) => r.kind === "tool");
  const lastSeq = fresh[fresh.length - 1]?.seq ?? since;
  const lastChanges = fresh.filter((r) => r.kind === "changes").at(-1);
  const head = [`Session: ${cap(toRepoRelative(o.title, o.repoName), SUMMARY_TITLE_MAX)}`];
  if (o.diffStat) {
    head.push(`Diff: ${o.diffStat.files} files, +${o.diffStat.additions} -${o.diffStat.deletions} lines`);
  }
  const headText = head.join("\n");
  const max = o.maxChars ?? SUMMARY_INPUT_MAX_CHARS;
  const lines = fresh
    .filter((r) => r.kind !== "changes" || r === lastChanges)
    .map((r) => lineOf(r, o.repoName))
    .filter((l): l is string => l !== null);
  const kept: string[] = [];
  let used = headText.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (used + line.length + 2 > max) break;
    kept.unshift(line);
    used += line.length + 2;
  }
  return { text: [headText, ...kept].join("\n\n"), lastSeq, empty: false, usedTools };
}

/** The stream events a summary reads (and that count as new work): prompts that ran, messages, tools, changes. */
const contentEvents = (sessionId: string): SQL =>
  and(
    eq(streamEvents.streamId, `ws:${sessionId}`),
    or(
      and(
        eq(streamEvents.type, EventTypes.workSessionEvent),
        sql`${streamEvents.payload}->'event'->>'type' in ('prompt.started','assistant.message','tool.started')`,
      ),
      eq(streamEvents.type, EventTypes.workSessionChanges),
    ),
  ) as SQL;

/** Whether the session has content events after `sinceSeq` (null = any at all). */
export async function hasNewWork(tx: Tx, sessionId: string, sinceSeq: number | null): Promise<boolean> {
  const [row] = await tx
    .select({ seq: streamEvents.seq })
    .from(streamEvents)
    .where(and(contentEvents(sessionId), gt(streamEvents.seq, sinceSeq ?? 0)))
    .limit(1);
  return row !== undefined;
}

type MemoryRow = Pick<typeof workSessionMemory.$inferSelect, "status" | "summarizedSeq" | "approvalId">;

/**
 * The last content event a standing proposal covers: its `summarized_seq`, unless that proposal can no longer land
 * (its approval expired or failed), in which case the next summary covers the whole session again. Null = none.
 */
export async function coveredSeq(tx: Tx, mem: MemoryRow | undefined): Promise<number | null> {
  if (!mem || mem.summarizedSeq === null) return null;
  if (!mem.approvalId) return mem.summarizedSeq;
  const [approval] = await tx
    .select({ status: approvalRequests.status })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, mem.approvalId))
    .limit(1);
  return approval && (approval.status === "expired" || approval.status === "failed")
    ? null
    : mem.summarizedSeq;
}

/**
 * P-15 `nothingNew`: the session's last proposal already covers everything it did, so Propose has nothing to add (the
 * strip says so) and the job writes nothing. A restarted session that did more is no longer `nothingNew`.
 */
export async function nothingNew(tx: Tx, sessionId: string, mem: MemoryRow | undefined): Promise<boolean> {
  if (mem?.status !== "proposed") return false;
  const covered = await coveredSeq(tx, mem);
  return covered !== null && !(await hasNewWork(tx, sessionId, covered));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The session's content after `sinceSeq` (call after the caller read the session through its audience rule). */
export async function collectSessionInput(
  tx: Tx,
  sessionId: string,
  sinceSeq: number | null,
): Promise<SessionInput> {
  const [s] = await tx
    .select({ title: workSessions.title, diffStat: workSessions.diffStat, repoName: projects.name })
    .from(workSessions)
    .innerJoin(projects, eq(projects.id, workSessions.projectId))
    .where(eq(workSessions.id, sessionId))
    .limit(1);
  if (!s) return { text: "", lastSeq: sinceSeq ?? 0, empty: true, usedTools: false };
  const events = await tx
    .select({ seq: streamEvents.seq, type: streamEvents.type, payload: streamEvents.payload })
    .from(streamEvents)
    .where(and(contentEvents(sessionId), gt(streamEvents.seq, sinceSeq ?? 0)))
    .orderBy(asc(streamEvents.seq));
  type Ev = { type?: string; promptId?: string; text?: string; name?: string; summary?: string };
  const promptIds = events
    .map((e) => (e.payload as { event?: Ev }).event)
    .filter((e): e is Ev => e?.type === "prompt.started" && UUID_RE.test(e.promptId ?? ""))
    .map((e) => e.promptId as string);
  const bodies = new Map(
    promptIds.length === 0
      ? []
      : (
          await tx
            .select({ id: workPrompts.id, body: workPrompts.body })
            .from(workPrompts)
            .where(and(eq(workPrompts.workSessionId, sessionId), inArray(workPrompts.id, promptIds)))
        ).map((p) => [p.id, p.body]),
  );
  const rows: SessionInputRow[] = [];
  for (const e of events) {
    if (e.type === EventTypes.workSessionChanges) {
      const files = (e.payload as { files?: Array<{ path: string; additions: number; deletions: number }> })
        .files;
      rows.push({ seq: e.seq, kind: "changes", files: Array.isArray(files) ? files : [] });
      continue;
    }
    const ev = (e.payload as { event?: Ev }).event;
    if (ev?.type === "prompt.started") {
      const body = bodies.get(ev.promptId ?? "");
      if (body) rows.push({ seq: e.seq, kind: "prompt", text: body });
    } else if (ev?.type === "assistant.message") {
      rows.push({ seq: e.seq, kind: "assistant", text: ev.text ?? "" });
    } else if (ev?.type === "tool.started") {
      rows.push({ seq: e.seq, kind: "tool", name: ev.name ?? "tool", text: ev.summary ?? "" });
    }
  }
  return buildSessionInput(rows, {
    sinceSeq,
    repoName: s.repoName,
    title: s.title,
    diffStat: s.diffStat ?? null,
  });
}

// ---------------------------------------------------------------- the prompt

/**
 * The prompt builder's input for one session (ADR-0018: the prompt itself is built by `buildModelMessages`, purpose
 * `session_summary`): the repo-relative transcript as its single row; no viewer, organization or preference.
 */
export function summaryBuildInput(input: SessionInput): BuildInput & { purpose: "session_summary" } {
  return {
    purpose: "session_summary",
    rows: [
      {
        id: "session",
        role: "user",
        body: input.text,
        status: "sent",
        generationStatus: null,
        deleted: false,
      },
    ],
    viewer: { displayName: "", orgName: "", now: new Date() },
    chat: { instructions: "", usePersonalInstructions: false, humanMembers: 1 },
    personalInstructions: "",
    attachments: new Map(),
    maxContextTokens: 0,
  };
}

// ---------------------------------------------------------------- the model

/**
 * The model that writes the owner's summary: the owner's default model (their preference, else their plan, else the
 * organization's), moved to its small model as titles are (`pickTitleModel`), on the owner's own credential.
 */
export async function summaryModelFor(
  tx: Tx,
  gateway: ModelGateway,
  ownerId: string,
): Promise<{ ref: ModelRef; label: string; metered: boolean; plan: boolean } | null> {
  const list = await gateway.listModels(tx, ownerId);
  if (!list.defaultRef) return null;
  const policy = await loadAiChatPolicy(tx);
  let ref = list.defaultRef;
  try {
    ref = await pickTitleModel(tx, gateway, list.defaultRef, ownerId, policy);
  } catch {
    // The small-model choice is best effort: the default model stays.
  }
  const option = list.models.find(
    (m) => m.ref.backend === ref.backend && m.ref.provider === ref.provider && m.ref.modelId === ref.modelId,
  );
  return {
    ref,
    label: gateway.labelOf(ref),
    metered: option?.metered ?? ref.backend === "org_key",
    plan: ref.backend === "chatgpt_plan",
  };
}

/**
 * The `subject_id` of a summary's usage record (P-16). The table keeps one record per subject and kind, and a session
 * can be summarized more than once (new work after a restart, a retry after a failure), each call billed: the session
 * itself for its first billed summary, then an id derived from the session and the job that made the call (stable
 * across a retried delivery of the same job, so a retry that already committed adds nothing).
 */
export function summarySubjectId(sessionId: string, first: boolean, jobId: string): string {
  if (first) return sessionId;
  const h = createHash("sha256").update(`work_session_summary:${sessionId}:${jobId}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x80;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** `work-zone/<YYYY-MM-DD>-<slug>-<8 hex>.md`. */
export function summaryPath(title: string, now: Date): string {
  const slug =
    title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "session";
  return `work-zone/${now.toISOString().slice(0, 10)}-${slug}-${randomBytes(4).toString("hex")}.md`;
}

/** The memory file: the session's title, the model's summary (paths rewritten again), a provenance line. */
export function summaryFile(title: string, summary: string, repoName: string | null, now: Date): string {
  const heading = cap(
    toRepoRelative(title, repoName)
      .replace(/^#+\s*/, "")
      .trim() || "Work Zone session",
    120,
  );
  const footer = `_Summary of a Work Zone session, ${now.toISOString().slice(0, 10)}._`;
  const room = MEMORY_LIMITS.fileBytes - Buffer.byteLength(`# ${heading}\n\n\n\n${footer}\n`, "utf8") - 16;
  let body = toRepoRelative(summary.trim(), repoName);
  while (Buffer.byteLength(body, "utf8") > room) body = body.slice(0, Math.floor(body.length * 0.9));
  return `# ${heading}\n\n${body}\n\n${footer}\n`;
}

// ---------------------------------------------------------------- the job

export interface SummaryDeps {
  perms: PermissionService;
  memory: MemoryService;
  gateway: ModelGateway;
}

type SessionRow = typeof workSessions.$inferSelect;

interface Prepared {
  session: SessionRow;
  owner: string;
  unitId: string;
  scopeId: string;
  /** The memory file's path, decided (and checked) before the model call. */
  path: string;
  repoName: string | null;
  resolved: ResolvedModel;
  input: SessionInput;
  auto: boolean;
}

/** Announces a state change of the session's summary to its readers, each on their own `user:` topic, after commit. */
export async function announceAfterCommit(
  core: Core,
  perms: PermissionService,
  tx: Tx,
  session: SessionRef,
): Promise<void> {
  const recipients = await memoryRecipients(tx, perms, session);
  tenantOf(tx).afterCommit(async () => {
    try {
      await Promise.all(
        recipients.map((id) =>
          core.realtime.publishEphemeral(`user:${id}`, EventTypes.workSessionMemoryUpdated, {
            workSessionId: session.id,
          }),
        ),
      );
    } catch (err) {
      core.log.warn({ err, workSessionId: session.id }, "work session memory frame failed");
    }
  });
}

/** Upserts the session's summary state (one row per session). */
async function setState(
  tx: Tx,
  sessionId: string,
  v: Partial<Omit<typeof workSessionMemory.$inferInsert, "workSessionId" | "organizationId">> & {
    status: "writing" | "proposed" | "failed";
  },
): Promise<void> {
  await tx
    .insert(workSessionMemory)
    .values({ workSessionId: sessionId, organizationId: tenantOf(tx).organizationId, ...v })
    .onConflictDoUpdate({ target: workSessionMemory.workSessionId, set: { ...v, updatedAt: sql`now()` } });
}

/** Marks the summary failed with a short code, audits it (ids and the code only) and announces it. */
async function fail(
  core: Core,
  perms: PermissionService,
  tx: Tx,
  s: SessionRow,
  owner: string,
  unitId: string | null,
  code: string,
): Promise<void> {
  await setState(tx, s.id, { status: "failed", errorCode: code.slice(0, 64), unitId });
  await core.audit.record(tx, {
    action: "work_session.summary_failed",
    resourceType: "work_session",
    resourceId: s.id,
    result: "error",
    actorKind: "system",
    actorId: null,
    userId: owner,
    sessionId: s.id,
    deviceId: s.deviceId,
    metadata: { code: code.slice(0, 64), unitId },
  });
  await announceAfterCommit(core, perms, tx, s);
}

/**
 * Phase 1, in the owner's transaction: every check, the claim (`writing`), the model, whether the proposal may land in
 * the unit's memory for the owner (before anything is billed, 07.6 review C LO-05), then the cap.
 */
async function prepare(
  core: Core,
  deps: SummaryDeps,
  tx: Tx,
  owner: string,
  p: JobData<"work_session.summarize">,
): Promise<Prepared | null> {
  const [s] = await tx.select().from(workSessions).where(eq(workSessions.id, p.workSessionId)).limit(1);
  if (!s || s.createdBy !== owner) return null;
  // The owner still reads the session (the audience rule, through the resolver); a creator who left does not.
  const read = await deps.perms.decide(
    tx,
    { kind: "user", userId: owner },
    "work_session.read",
    await sessionFacts(tx, owner, s),
  );
  if (!read.allowed) return null;
  if (s.status !== "completed" && s.status !== "archived") return null;
  const auto = p.mode === "auto";
  if (auto) {
    const [prefs] = await tx
      .select({ autoPropose: workMemoryPrefs.autoPropose })
      .from(workMemoryPrefs)
      .where(eq(workMemoryPrefs.userId, owner))
      .limit(1);
    if (!prefs?.autoPropose) return null;
  }
  const unit = await unitForSession(tx, s.id);
  if (!unit) return null;
  const [mem] = await tx
    .select()
    .from(workSessionMemory)
    .where(eq(workSessionMemory.workSessionId, s.id))
    .limit(1);
  const input = await collectSessionInput(tx, s.id, await coveredSeq(tx, mem));
  // `nothingNew` (P-15): nothing happened since the last proposal, or nothing at all.
  if (input.empty) return null;
  // The claim: one run per session at a time (a dead run's `writing` is taken over after STALE_WRITING).
  const claimed = await tx
    .insert(workSessionMemory)
    .values({
      workSessionId: s.id,
      organizationId: tenantOf(tx).organizationId,
      unitId: unit.unitId,
      status: "writing",
      auto,
    })
    .onConflictDoUpdate({
      target: workSessionMemory.workSessionId,
      set: { status: "writing", unitId: unit.unitId, auto, errorCode: null, updatedAt: sql`now()` },
      setWhere: sql`${workSessionMemory.status} <> 'writing' or ${workSessionMemory.updatedAt} < now() - ${STALE_WRITING}::interval`,
    })
    .returning({ id: workSessionMemory.workSessionId });
  if (claimed.length === 0) return null;

  const model = await summaryModelFor(tx, deps.gateway, owner);
  if (!model) {
    await fail(core, deps.perms, tx, s, owner, unit.unitId, "model_unavailable");
    return null;
  }
  let resolved: ResolvedModel;
  try {
    resolved = await deps.gateway.resolve(tx, model.ref, owner);
  } catch {
    await fail(core, deps.perms, tx, s, owner, unit.unitId, "model_unavailable");
    return null;
  }
  // The proposal's scope and path, checked as `propose` will check them (an owner without read on the project's memory,
  // e.g. the Memory module off for them, is refused here, before the cap is counted or the model called).
  const scope = await deps.memory.ensureScope(tx, { kind: "unit", unitId: unit.unitId });
  const path = summaryPath(s.title, new Date());
  if (
    !(await deps.memory.systemProposalAllowed(tx, { requestedForUserId: owner, scopeId: scope.id, path }))
  ) {
    await fail(core, deps.perms, tx, s, owner, unit.unitId, "memory_denied");
    return null;
  }
  // The owner's AI chat cap, counted before any model call; a refusal bills nothing.
  const policy = await loadAiChatPolicy(tx);
  const counted = await consumeGeneration(tx, {
    userId: owner,
    backendClass: backendClassOf(resolved.ref.backend),
    policy,
  });
  if (!counted.ok) {
    await fail(core, deps.perms, tx, s, owner, unit.unitId, "limit_reached");
    return null;
  }
  const [repo] = await tx
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, s.projectId))
    .limit(1);
  await announceAfterCommit(core, deps.perms, tx, s);
  return {
    session: s,
    owner,
    unitId: unit.unitId,
    scopeId: scope.id,
    path,
    repoName: repo?.name ?? null,
    resolved,
    input,
    auto,
  };
}

/** Phase 2, no transaction: the model call under its deadline, through ai-chat's one-shot door (ADR-0018). */
function callModel(p: Prepared, signal: AbortSignal | undefined) {
  return runOneShot(p.resolved, summaryBuildInput(p.input), {
    timeoutMs: SUMMARY_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
  });
}

/**
 * The job handler of `work_session.summarize` (at least once; idempotent through the session's summary state). Re-opens
 * the tenant as the session's owner and reads the session through its audience rule; ids only in the job.
 */
export async function summarizeSession(
  core: Core,
  deps: SummaryDeps,
  p: JobData<"work_session.summarize">,
  job: { jobId: string; signal?: AbortSignal },
): Promise<void> {
  const { organizationId, workSessionId } = p;
  const { signal } = job;
  // Who owns it: the job has no user yet (a user-less read; RLS still scopes it to the organization).
  const owner = await core.db.withTenant({ organizationId, userId: null }, async (tx) => {
    const [row] = await tx
      .select({ createdBy: workSessions.createdBy })
      .from(workSessions)
      .where(eq(workSessions.id, workSessionId))
      .limit(1);
    return row?.createdBy ?? null;
  });
  if (!owner) return;
  const prepared = await core.db.withTenant({ organizationId, userId: owner }, (tx) =>
    prepare(core, deps, tx, owner, p),
  );
  if (!prepared) return;
  const { session: s } = prepared;

  let out: Awaited<ReturnType<typeof callModel>>;
  try {
    out = await callModel(prepared, signal);
  } catch (err) {
    const code =
      err instanceof DOMException ? "model_timeout" : (deps.gateway.classify(err).code ?? "model_error");
    core.log.warn({ workSessionId, code }, "work session summary failed");
    await core.db.withTenant({ organizationId, userId: owner }, (tx) =>
      fail(core, deps.perms, tx, s, owner, prepared.unitId, String(code)),
    );
    return;
  }

  const now = new Date();
  const proposal: CreateMemoryProposalInput = {
    origin: {
      kind: "system",
      source: "work_session",
      workSessionId,
      requestedForUserId: owner,
      tainted: prepared.input.usedTools,
    },
    scope: prepared.scopeId,
    path: prepared.path,
    op: "create",
    content: summaryFile(s.title, out.text, prepared.repoName, now),
  };
  // The detector runs before the transaction (WINDOWS 145); a failed scan leaves the proposal to refuse itself.
  let prescan: ProposalPrescan = null;
  if (out.text.trim()) {
    try {
      prescan = await deps.memory.prescan(organizationId, proposal);
    } catch (err) {
      // A code only: the error may carry the scanned text.
      core.log.warn(
        { workSessionId, code: (err as { name?: string })?.name ?? "unknown" },
        "summary scan failed",
      );
    }
  }

  const ctx = { organizationId, userId: owner };
  try {
    // Every model call that answered is billed to the owner, whatever happens to the proposal: its own transaction.
    await core.db.withTenant(ctx, async (tx) => {
      const [billedBefore] = await tx
        .select({ id: aiUsageRecords.id })
        .from(aiUsageRecords)
        .where(and(eq(aiUsageRecords.subjectId, s.id), eq(aiUsageRecords.kind, "session_summary")))
        .limit(1);
      await recordStandaloneUsage(tx, {
        kind: "session_summary",
        subjectId: summarySubjectId(s.id, billedBefore === undefined, job.jobId),
        requesterUserId: owner,
        model: prepared.resolved.ref,
        reported: out.usage,
        promptText: out.promptText,
        outputText: out.text,
      });
    });
    await core.db.withTenant(ctx, async (tx) => {
      if (!out.text.trim()) return fail(core, deps.perms, tx, s, owner, prepared.unitId, "empty_summary");
      const result = await deps.memory.propose(tx, proposal, prescan);
      if ("refused" in result) return fail(core, deps.perms, tx, s, owner, prepared.unitId, result.refused);
      await setState(tx, s.id, {
        status: "proposed",
        unitId: prepared.unitId,
        approvalId: result.approvalId,
        summarizedSeq: prepared.input.lastSeq,
        auto: prepared.auto,
        errorCode: null,
      });
      await core.audit.record(tx, {
        action: "work_session.summary_proposed",
        resourceType: "work_session",
        resourceId: s.id,
        actorKind: "system",
        actorId: null,
        userId: owner,
        sessionId: s.id,
        deviceId: s.deviceId,
        metadata: { approvalId: result.approvalId, unitId: prepared.unitId, auto: prepared.auto },
      });
      await announceAfterCommit(core, deps.perms, tx, s);
    });
  } catch (err) {
    // 07.6 review C ME-01: never leave the claim in `writing` (a retry could not take it for 10 minutes and the strip
    // would spin). Failed in a fresh transaction; not rethrown, so a deterministic error is not re-billed by retries
    // (the owner's Try again proposes once more). If even this fails, the job is retried and the stale claim recovers.
    core.log.warn(
      { workSessionId, code: (err as { code?: string; name?: string })?.code ?? (err as Error)?.name },
      "work session summary proposal failed",
    );
    await core.db.withTenant(ctx, (tx) =>
      fail(core, deps.perms, tx, s, owner, prepared.unitId, "propose_error"),
    );
  }
}
