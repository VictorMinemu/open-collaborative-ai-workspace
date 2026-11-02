import {
  type DigestPreview,
  DigestSection,
  type DigestSettings,
  type DigestTestResponse,
  type DigestView,
  digestCron,
  EventTypes,
  ModelRef,
  type Weekday,
} from "@ocw/contracts";
import { automationRuns, automations, type TenantCtx, type Tx } from "@ocw/db";
import { and, count, desc, eq, gte, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { ApiModule, Core } from "../../core";
import { HttpError } from "../../lib/errors";
import {
  type BuildInput,
  backendClassOf,
  consumeGeneration,
  recordStandaloneUsage,
  runOneShot,
} from "../ai-chat";
import type { ApprovalService } from "../approval";
import {
  type ActionKindHandler,
  type AutomationActor,
  type AutomationRow,
  type AutomationService,
  canCreate,
  decideTarget,
  firstRunAt,
  type RunRow,
  refusalReason,
  type SettledFireResult,
  usableBots,
  validateSchedule,
} from "../automation";
import { createConversationAccess, ensureAgentDm } from "../chat";
import { loadAiChatPolicy, type ModelGateway, type ResolvedModel } from "../model-gateway";
import type { PermissionService } from "../organization";
import { composeDigest, type DigestItem, type DigestItems } from "./compose";
import {
  type DigestQueryDeps,
  digestMessageKey,
  followedCards,
  pendingDecisions,
  unreadMentions,
  workZoneSessions,
} from "./queries";
import { registerDigestRoutes } from "./routes";

/**
 * Phase 07.6 (AUTO-05, D-05, D-07, D-11, ADR-0028; plan 07.6-13): the personal digest. Each person may save one
 * digest: it is their one `digest` automation (schedule = `digestCron(days, time)` in their zone, target = their DM with
 * the bot they chose, run as them), so the runner (07.6-09) fires it like any automation, re-deciding the person
 * (`automation.create`) and the bot (`bot.read`, a personal bot only for its owner) at every fire. Firing composes the
 * four deterministic sections (queries.ts: each re-checks read access now, D-11 for sessions) into Markdown
 * (compose.ts), skips it when there is nothing new and skip-empty is on, optionally puts an AI summary on top (opt-in;
 * the person's model through the gateway, their AI chat cap, one `digest` usage record with the run as subject; the
 * model sees only the composed list), and posts it in the person's DM as the bot. Never a cell turn: the platform
 * posts the message itself, so the bot's model never reads it.
 *
 * With a summary, a send has three phases like a Work Zone summary (07.6 review C HI-01): compose, count the cap and
 * claim the run in a short transaction (the run stays `queued`); the model call with no transaction open; then the
 * usage record committed on its own (billed whatever happens next) and the post in a second short transaction that
 * re-locks the run. A test send is one at a time per person (a try-lock, then a still-queued test answers 409).
 *
 * Audit (ids, codes and counts only): `digest.saved`, `digest.sent` (section counts, summary state); the automation
 * service's own `automation.created` / `automation.paused` on the first save; the runner's `automation.run_skipped`
 * (`nothing_new`) and `automation.run_failed`.
 */
export interface DigestDeps {
  perms: PermissionService;
  approvals: ApprovalService;
  modelGateway: ModelGateway;
  automation: AutomationService;
}

/** What the digest stores in its automation's `config` (days and time live in the cron, the zone in `time_zone`). */
const DigestConfig = z.object({
  sections: z.array(DigestSection).min(1),
  skipEmpty: z.boolean(),
  summary: z.object({ enabled: z.boolean(), modelRef: ModelRef.nullable() }),
});
type DigestConfig = z.infer<typeof DigestConfig>;

/** Runs a digest may make per day: its scheduled one and a few tests (never above the organization's cap). */
const DIGEST_RUNS_PER_DAY = 5;
/** "Since the last digest": without one, the last 24 hours. */
const FIRST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The summary call's deadline (outside any transaction). */
const SUMMARY_TIMEOUT_MS = 20_000;
/** A test run still `queued` after this is a send that died: it no longer blocks the next test. */
const TEST_IN_FLIGHT_MS = 2 * 60_000;
const DIGEST_NAME = "Digest";

const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Days and time back from a digest's cron (`"30 8 * * 1,5"` → `["mon","fri"]`, `"08:30"`); never a free cron. */
export function scheduleOfCron(cron: string): { days: Weekday[]; time: string } {
  const [minute, hour, , , dow] = cron.trim().split(/\s+/);
  const days = (dow ?? "")
    .split(",")
    .map((d) => WEEKDAYS[Number(d) % 7])
    .filter((d): d is Weekday => d !== undefined);
  // Monday first, as the settings list them.
  const order: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  days.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return { days, time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

const notAllowed = () => new HttpError(403, "not_allowed", "You can't have a digest. Ask an admin.");
const botNotReadable = () =>
  new HttpError(400, "bot_not_readable", "Pick a bot you can message to deliver it.");
const testInProgress = () =>
  new HttpError(409, "test_in_progress", "A test digest is already on its way. Try again in a moment.");

function configOf(a: AutomationRow): DigestConfig {
  const parsed = DigestConfig.safeParse(a.config);
  // A digest row always has its config; an unreadable one sends the full list without a summary.
  return parsed.success
    ? parsed.data
    : { sections: [...DigestSection.options], skipEmpty: true, summary: { enabled: false, modelRef: null } };
}

const sameRef = (a: ModelRef, b: ModelRef) =>
  a.backend === b.backend && a.provider === b.provider && a.modelId === b.modelId;

export interface DigestService {
  view(tx: Tx, actor: AutomationActor): Promise<DigestView>;
  save(tx: Tx, actor: AutomationActor, settings: DigestSettings): Promise<DigestView>;
  preview(tx: Tx, actor: AutomationActor, settings: DigestSettings): Promise<DigestPreview>;
  /** Sends the saved digest now; opens its own short transactions (the summary's model call runs between them). */
  test(ctx: TenantCtx, actor: AutomationActor): Promise<DigestTestResponse>;
  /** The `digest` action kind the runner fires. */
  action: ActionKindHandler;
}

type Sent = { conversationId: string; messageId: string; summary: "off" | "added" | "skipped" };
type SummaryNote = "summary_skipped_limit" | "summary_failed";

/** A run composed and claimed, whose summary the model writes next (outside any transaction). */
interface PendingSummary {
  a: AutomationRow;
  run: RunRow;
  resolved: ResolvedModel;
  list: { markdown: string; empty: boolean };
  items: DigestItems;
  counts: Record<DigestSection, number>;
  sections: readonly DigestSection[];
  timeZone: string;
  now: Date;
}

/** Phase 1's outcome: nothing to send, sent already (no model call), or the summary to write. */
type Begun = { kind: "skip" } | { kind: "sent"; sent: Sent } | { kind: "summary"; pending: PendingSummary };

export function createDigestService(core: Core, deps: DigestDeps): DigestService {
  const { perms, automation, modelGateway } = deps;
  const queryDeps: DigestQueryDeps = {
    perms,
    approvals: deps.approvals,
    access: createConversationAccess(core),
  };

  async function own(tx: Tx, userId: string, lock = false): Promise<AutomationRow | null> {
    const q = tx
      .select()
      .from(automations)
      .where(and(eq(automations.runAsUserId, userId), eq(automations.actionKind, "digest")))
      .limit(1);
    const [row] = lock ? await q.for("update") : await q;
    return row ?? null;
  }

  /** When the last digest was sent (the end of its window), other than `exceptRunId`. */
  async function lastSent(tx: Tx, automationId: string, exceptRunId?: string): Promise<Date | null> {
    const [row] = await tx
      .select({ at: automationRuns.answeredAt })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, automationId),
          eq(automationRuns.status, "answered"),
          isNotNull(automationRuns.answeredAt),
          exceptRunId ? ne(automationRuns.id, exceptRunId) : undefined,
        ),
      )
      .orderBy(desc(automationRuns.answeredAt))
      .limit(1);
    return row?.at ? new Date(row.at) : null;
  }

  /** Each chosen section, queried only when chosen (an unchecked section reads nothing). */
  async function collect(
    tx: Tx,
    userId: string,
    sections: readonly DigestSection[],
    since: Date,
  ): Promise<{ items: DigestItems; counts: Record<DigestSection, number> }> {
    const items: Partial<Record<DigestSection, DigestItem[]>> = {};
    if (sections.includes("decisions"))
      items.decisions = await pendingDecisions(tx, queryDeps, userId, since);
    if (sections.includes("follows")) items.follows = await followedCards(tx, queryDeps, userId, since);
    if (sections.includes("mentions")) items.mentions = await unreadMentions(tx, queryDeps, userId, since);
    if (sections.includes("work_zone")) items.work_zone = await workZoneSessions(tx, perms, userId, since);
    const counts = {
      decisions: items.decisions?.length ?? 0,
      follows: items.follows?.length ?? 0,
      mentions: items.mentions?.length ?? 0,
      work_zone: items.work_zone?.length ?? 0,
    };
    return { items, counts };
  }

  /**
   * The optional AI summary's phase 1 (P-16), in the person's transaction: the person's chosen model (or their
   * default) through the gateway, on their credential, counted against their AI chat cap before any call. No model call
   * here: the caller makes it after this transaction commits.
   */
  async function claimSummary(
    tx: Tx,
    p: { userId: string; modelRef: ModelRef | null },
  ): Promise<{ resolved: ResolvedModel } | { skipped: SummaryNote }> {
    const models = await modelGateway.listModels(tx, p.userId);
    const ref = p.modelRef
      ? models.models.find((m) => m.available && sameRef(m.ref, p.modelRef as ModelRef))?.ref
      : (models.defaultRef ?? undefined);
    if (!ref) return { skipped: "summary_failed" };
    let resolved: ResolvedModel;
    try {
      resolved = await modelGateway.resolve(tx, ref, p.userId);
    } catch {
      return { skipped: "summary_failed" };
    }
    const counted = await consumeGeneration(tx, {
      userId: p.userId,
      backendClass: backendClassOf(resolved.ref.backend),
      policy: await loadAiChatPolicy(tx),
    });
    if (!counted.ok) return { skipped: "summary_skipped_limit" };
    return { resolved };
  }

  /**
   * Phase 1 of one run of `a` (in the person's transaction, the run row queued): composes it, then either skips it
   * (nothing new and skip-empty on; `force`, a test, always sends), posts it now (no summary, or the summary refused
   * before any model call), or returns the claimed summary for `finish` to write outside the transaction.
   */
  async function begin(
    tx: Tx,
    a: AutomationRow,
    run: RunRow,
    opts: { force: boolean; now: Date },
  ): Promise<Begun> {
    const cfg = configOf(a);
    const userId = a.runAsUserId;
    const since = (await lastSent(tx, a.id, run.id)) ?? new Date(opts.now.getTime() - FIRST_WINDOW_MS);
    const { items, counts } = await collect(tx, userId, cfg.sections, since);
    const timeZone = a.timeZone ?? "UTC";
    const list = composeDigest({ date: opts.now, timeZone, sections: cfg.sections, items });
    if (list.empty && cfg.skipEmpty && !opts.force) return { kind: "skip" };

    let note: SummaryNote | null = null;
    if (cfg.summary.enabled && !list.empty) {
      const claimed = await claimSummary(tx, { userId, modelRef: cfg.summary.modelRef });
      if ("resolved" in claimed) {
        return {
          kind: "summary",
          pending: {
            a,
            run,
            resolved: claimed.resolved,
            list,
            items,
            counts,
            sections: cfg.sections,
            timeZone,
            now: opts.now,
          },
        };
      }
      note = claimed.skipped;
    }
    const sent = await deliver(tx, a, run, {
      message: list.markdown,
      empty: list.empty,
      counts,
      summary: note ? "skipped" : "off",
      note,
      now: opts.now,
    });
    return { kind: "sent", sent };
  }

  /**
   * Phases 2 and 3 of a run with a summary, with no transaction open on entry: the model call under its deadline (the
   * model sees only the composed list, never a message body); the usage record in its own transaction, so every call
   * that answered is billed to the person once per run whatever happens to the post (ADR-0018); then the post in a
   * short transaction that re-locks the run. Null: the run was settled meanwhile (nothing posted). Throws when the post
   * is refused (the caller fails the run).
   */
  async function finish(p: PendingSummary): Promise<Sent | null> {
    const userId = p.a.runAsUserId;
    const ctx = { organizationId: p.a.organizationId, userId };
    let text = "";
    try {
      const out = await runOneShot(p.resolved, summaryInput(p.list.markdown), {
        timeoutMs: SUMMARY_TIMEOUT_MS,
      });
      await core.db.withTenant(ctx, (tx) =>
        recordStandaloneUsage(tx, {
          kind: "digest",
          subjectId: p.run.id,
          requesterUserId: userId,
          model: p.resolved.ref,
          reported: out.usage,
          promptText: out.promptText,
          outputText: out.text,
        }),
      );
      text = out.text.trim();
    } catch (err) {
      const code =
        err instanceof DOMException ? "model_timeout" : (modelGateway.classify(err).code ?? "error");
      core.log.warn({ runId: p.run.id, code }, "digest summary failed");
    }
    const message = text
      ? composeDigest({
          date: p.now,
          timeZone: p.timeZone,
          sections: p.sections,
          items: p.items,
          summary: text,
        }).markdown
      : p.list.markdown;
    return core.db.withTenant(ctx, async (tx) => {
      // Run first, then its automation (the runner's lock order). Settled meanwhile, or the digest deleted: no post.
      const [run] = await tx
        .select()
        .from(automationRuns)
        .where(eq(automationRuns.id, p.run.id))
        .for("update");
      if (run?.status !== "queued") return null;
      const [a] = await tx.select().from(automations).where(eq(automations.id, p.a.id)).for("update");
      if (!a) return null;
      return deliver(tx, p.a, run, {
        message,
        empty: p.list.empty,
        counts: p.counts,
        summary: text ? "added" : "skipped",
        note: text ? null : "summary_failed",
        now: p.now,
      });
    });
  }

  /** Fails a test run that `finish` could not send (fresh transaction; the run is left as it is once settled). */
  async function failTest(ctx: TenantCtx, p: PendingSummary, err: unknown): Promise<void> {
    await core.db.withTenant(ctx, async (tx) => {
      const reason = refusalReason(err);
      const [failed] = await tx
        .update(automationRuns)
        .set({ status: "failed", reason, updatedAt: sql`now()` })
        .where(and(eq(automationRuns.id, p.run.id), eq(automationRuns.status, "queued")))
        .returning({ id: automationRuns.id });
      if (!failed) return;
      await core.audit.record(tx, {
        action: "automation.run_failed",
        resourceType: "automation_run",
        resourceId: p.run.id,
        userId: p.a.runAsUserId,
        agentId: p.a.agentId,
        metadata: { automationId: p.a.id, runId: p.run.id, trigger: p.run.trigger, reason },
      });
      await core.realtime.appendEvent(tx, `user:${p.a.runAsUserId}`, EventTypes.automationRunUpdated, {
        automationId: p.a.id,
        runId: p.run.id,
      });
    });
  }

  /**
   * Posts a composed run of `a` in the person's DM as the bot (in the person's transaction, the run row queued and
   * locked). Marks the run answered, audits `digest.sent` and tells the person.
   */
  async function deliver(
    tx: Tx,
    a: AutomationRow,
    run: RunRow,
    m: {
      message: string;
      empty: boolean;
      counts: Record<DigestSection, number>;
      summary: Sent["summary"];
      note: SummaryNote | null;
      now: Date;
    },
  ): Promise<Sent> {
    const userId = a.runAsUserId;
    const { summary, note, counts } = m;
    const dm = await ensureAgentDm(
      tx,
      { audit: core.audit, realtime: core.realtime, perms },
      { agentId: a.agentId, userId },
    );
    // The platform posts it as the bot (no turn: the bot's model never reads or writes the digest).
    const posted = await core.chatAgent.postAgentMessageIn(tx, {
      agentId: a.agentId,
      conversationId: dm.conversationId,
      threadRootId: null,
      body: m.message,
      idempotencyKey: digestMessageKey(run.id),
      onBehalfOfUserId: userId,
    });
    const at = m.now.toISOString();
    await tx
      .update(automationRuns)
      .set({
        status: "answered",
        reason: note,
        anchorMessageId: posted.messageId,
        deliveredAt: at,
        answeredAt: at,
        updatedAt: sql`now()`,
      })
      .where(and(eq(automationRuns.id, run.id), eq(automationRuns.status, "queued")));
    // A sent digest is a success for the breaker.
    await tx.update(automations).set({ consecutiveFailures: 0 }).where(eq(automations.id, a.id));
    await core.audit.record(tx, {
      action: "digest.sent",
      resourceType: "automation_run",
      resourceId: run.id,
      actorKind: run.trigger === "manual" ? "user" : "system",
      userId,
      agentId: a.agentId,
      metadata: {
        automationId: a.id,
        runId: run.id,
        trigger: run.trigger,
        conversationId: dm.conversationId,
        messageId: posted.messageId,
        counts,
        empty: m.empty,
        summary,
        ...(note ? { reason: note } : {}),
      },
    });
    await core.realtime.appendEvent(tx, `user:${userId}`, EventTypes.automationRunUpdated, {
      automationId: a.id,
      runId: run.id,
    });
    return { conversationId: dm.conversationId, messageId: posted.messageId, summary };
  }

  function settingsOf(a: AutomationRow): DigestSettings {
    const cfg = configOf(a);
    const { days, time } = scheduleOfCron(a.scheduleCron ?? "0 8 * * 1");
    return {
      enabled: a.status === "active",
      days,
      time,
      timeZone: a.timeZone ?? "UTC",
      sections: cfg.sections,
      skipEmpty: cfg.skipEmpty,
      agentId: a.agentId,
      summary: cfg.summary,
    };
  }

  async function botsFor(tx: Tx, userId: string): Promise<DigestView["bots"]> {
    const bots = await usableBots(tx, perms, userId);
    // Personal bots first (preselected), then the team bots the person may read; each in name order.
    return [...bots.filter((b) => b.personal), ...bots.filter((b) => !b.personal)].map((b) => ({
      id: b.id,
      displayName: b.displayName,
      personal: b.personal,
      unitName: b.unitName,
    }));
  }

  async function allowed(tx: Tx, actor: AutomationActor): Promise<void> {
    if (!(await canCreate(perms, tx, actor))) throw notAllowed();
  }

  const service: DigestService = {
    async view(tx, actor) {
      await allowed(tx, actor);
      const row = await own(tx, actor.userId);
      const last = row ? await lastSent(tx, row.id) : null;
      return {
        settings: row ? settingsOf(row) : null,
        automationId: row?.id ?? null,
        nextRunAt: row?.status === "active" && row.nextRunAt ? new Date(row.nextRunAt).toISOString() : null,
        lastSentAt: last ? last.toISOString() : null,
        bots: await botsFor(tx, actor.userId),
      };
    },

    async save(tx, actor, s) {
      await allowed(tx, actor);
      const userId = actor.userId;
      // The bot: one the person may DM now (P-08, T-07.6-13-04); any refusal reads the same (no existence leak).
      const target = await decideTarget(tx, perms, { agentId: s.agentId, userId, target: { kind: "dm" } });
      if (!target.ok) throw botNotReadable();
      if (s.summary.enabled && s.summary.modelRef) {
        const models = await modelGateway.listModels(tx, userId);
        const ref = s.summary.modelRef;
        if (!models.models.some((m) => m.available && sameRef(m.ref, ref))) {
          throw new HttpError(400, "model_unavailable", "Pick one of your AI chat models.");
        }
      }
      const schedule = { cron: digestCron(s.days, s.time), timeZone: s.timeZone };
      const caps = await automation.caps(tx);
      const check = validateSchedule(schedule, caps.minScheduleMinutes);
      if (!check.ok) {
        throw check.code === "invalid_time_zone"
          ? new HttpError(400, "invalid_time_zone", "Pick a time zone from the list")
          : new HttpError(400, check.code, "That schedule isn't valid");
      }
      const config: DigestConfig = { sections: s.sections, skipEmpty: s.skipEmpty, summary: s.summary };
      // One digest per person (P-14): two first saves at once serialise here, then find the row.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`digest:${userId}`}, 0))`);
      const before = await own(tx, userId, true);
      let id: string;
      if (!before) {
        const created = await automation.create(
          tx,
          actor,
          {
            name: DIGEST_NAME,
            agentId: s.agentId,
            instructions: DIGEST_NAME,
            trigger: { kind: "schedule", schedule },
            target: { kind: "dm" },
            maxRunsPerDay: Math.min(DIGEST_RUNS_PER_DAY, caps.maxRunsPerDayCap),
          },
          { actionKind: "digest", config },
        );
        id = created.automation.id;
        // Saving with the switch off keeps the settings and pauses it (UI-SPEC Surface 6).
        if (!s.enabled) await automation.pause(tx, actor, id);
      } else {
        id = before.id;
        const sameSchedule = before.scheduleCron === schedule.cron && before.timeZone === schedule.timeZone;
        const reactivate = s.enabled && before.status !== "active";
        const [after] = await tx
          .update(automations)
          .set({
            agentId: s.agentId,
            scheduleCron: schedule.cron,
            timeZone: schedule.timeZone,
            config,
            // A changed schedule (or a digest turned back on) starts from now; an unchanged one keeps its grid.
            nextRunAt:
              sameSchedule && !reactivate && before.nextRunAt
                ? before.nextRunAt
                : firstRunAt(schedule).toISOString(),
            ...(s.enabled
              ? reactivate
                ? {
                    status: "active" as const,
                    pausedBy: null,
                    pausedAt: null,
                    pausedReason: null,
                    consecutiveFailures: 0,
                  }
                : {}
              : before.status === "paused"
                ? {}
                : {
                    status: "paused" as const,
                    pausedBy: userId,
                    pausedAt: new Date().toISOString(),
                    pausedReason: null,
                  }),
            version: before.version + 1,
            updatedAt: sql`now()`,
          })
          .where(and(eq(automations.id, before.id), eq(automations.version, before.version)))
          .returning();
        if (!after)
          throw new HttpError(409, "version", "Your digest changed while you were saving. Reload it.");
        await automation.announce(tx, after);
      }
      await core.audit.record(tx, {
        action: "digest.saved",
        resourceType: "automation",
        resourceId: id,
        userId,
        agentId: s.agentId,
        metadata: {
          automationId: id,
          agentId: s.agentId,
          enabled: s.enabled,
          created: !before,
          sections: s.sections,
          skipEmpty: s.skipEmpty,
          summary: s.summary.enabled,
        },
      });
      return service.view(tx, actor);
    },

    async preview(tx, actor, s) {
      await allowed(tx, actor);
      const now = new Date();
      const row = await own(tx, actor.userId);
      const since = (row ? await lastSent(tx, row.id) : null) ?? new Date(now.getTime() - FIRST_WINDOW_MS);
      const { items } = await collect(tx, actor.userId, s.sections, since);
      // The list as it would be sent now; nothing stored, nothing sent, no model call (no summary in a preview).
      return composeDigest({ date: now, timeZone: s.timeZone, sections: s.sections, items });
    },

    async test(ctx, actor) {
      const begun = await core.db.withTenant(ctx, async (tx) => {
        await allowed(tx, actor);
        // One test at a time per person: a concurrent one is refused now, never queued on the digest's row lock.
        const lock = await tx.execute(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${`digest:test:${actor.userId}`}, 0)) as ok`,
        );
        if (!(lock.rows[0] as { ok?: boolean } | undefined)?.ok) throw testInProgress();
        const a = await own(tx, actor.userId, true);
        if (!a) throw new HttpError(409, "not_saved", "Save your digest first.");
        const target = await decideTarget(tx, perms, {
          agentId: a.agentId,
          userId: actor.userId,
          target: { kind: "dm" },
        });
        if (!target.ok) throw botNotReadable();
        // A test whose summary is still being written (its run committed `queued`) finishes first.
        const [inFlight] = await tx
          .select({ id: automationRuns.id })
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.automationId, a.id),
              eq(automationRuns.trigger, "manual"),
              eq(automationRuns.status, "queued"),
              gte(automationRuns.createdAt, new Date(Date.now() - TEST_IN_FLIGHT_MS).toISOString()),
            ),
          )
          .limit(1);
        if (inFlight) throw testInProgress();
        // The same daily budget as its scheduled runs.
        const [today] = await tx
          .select({ n: count() })
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.automationId, a.id),
              ne(automationRuns.status, "skipped"),
              gte(automationRuns.createdAt, new Date(Date.now() - FIRST_WINDOW_MS).toISOString()),
            ),
          );
        if (Number(today?.n ?? 0) >= a.maxRunsPerDay) {
          throw new HttpError(
            429,
            "runs_per_day",
            "You've sent enough test digests today. Try again tomorrow.",
          );
        }
        const [run] = await tx
          .insert(automationRuns)
          .values({
            organizationId: a.organizationId,
            automationId: a.id,
            trigger: "manual",
            status: "queued",
          })
          .returning();
        return begin(tx, a, run as RunRow, { force: true, now: new Date() });
      });
      if (begun.kind === "skip") throw new Error("a forced digest is always sent");
      if (begun.kind === "sent") {
        return { conversationId: begun.sent.conversationId, messageId: begun.sent.messageId };
      }
      let sent: Sent | null;
      try {
        sent = await finish(begun.pending);
      } catch (err) {
        await failTest(ctx, begun.pending, err);
        throw err;
      }
      if (!sent) throw new HttpError(409, "test_in_progress", "This test digest was settled meanwhile.");
      return { conversationId: sent.conversationId, messageId: sent.messageId };
    },

    action: {
      async fire(tx, { run, automation: a }) {
        const begun = await begin(tx, a, run, { force: false, now: new Date() });
        if (begun.kind === "skip") return { status: "skipped", reason: "nothing_new" };
        if (begun.kind === "sent") return { status: "answered", anchorMessageId: begun.sent.messageId };
        // The model call after the runner's transaction commits (HI-01); the runner records a refused post.
        return {
          status: "continue",
          after: async (): Promise<SettledFireResult | null> => {
            const sent = await finish(begun.pending);
            return sent ? { status: "answered", anchorMessageId: sent.messageId } : null;
          },
        };
      },
    },
  };
  return service;
}

/** The prompt builder's input: the composed list as the single user row (ADR-0018, purpose `digest_summary`). */
function summaryInput(list: string): BuildInput & { purpose: "digest_summary" } {
  return {
    purpose: "digest_summary" as const,
    rows: [
      {
        id: "digest",
        role: "user" as const,
        body: list,
        status: "sent" as const,
        generationStatus: null,
        deleted: false,
      },
    ],
    viewer: { displayName: "", orgName: "", now: new Date() },
    chat: { instructions: "", usePersonalInstructions: false, humanMembers: 1 },
    personalInstructions: "",
    attachments: new Map(),
    maxContextTokens: 0,
  } satisfies BuildInput;
}

export function createDigestModule(core: Core, deps: DigestDeps): ApiModule {
  const digest = createDigestService(core, deps);
  // The runner (07.6-09) fires due digests like any automation, after its fire-time re-decision.
  deps.automation.registerActionKind("digest", digest.action);
  return {
    name: "digest",
    register(app) {
      registerDigestRoutes(app, core, digest);
    },
  };
}
