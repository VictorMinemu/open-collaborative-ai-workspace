import {
  BotCapabilities,
  DEFAULT_SANDBOX_SETTINGS,
  SANDBOX_LIMITS,
  type SandboxRuntime,
  type SandboxSettings,
  type SandboxState,
  type SandboxStopReason,
} from "@ocw/contracts";
import {
  agents,
  botSandboxes,
  orgMembers,
  orgUnits,
  sandboxPolicies,
  sandboxUsageDaily,
  type Tx,
  tenantOf,
} from "@ocw/db";
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { AuditService } from "../audit";
import { agentResource, type PermissionService } from "../organization";
import type { SandboxdClient } from "./client";
import { applyInstalls } from "./packages";

/**
 * The Sandbox domain (07.8-05; D-09, D-12; P-04, P-05): the organization's switch, kill state and caps, read from
 * `sandbox_policies`, and the bots' sandbox containers in `bot_sandboxes`. `sandboxAvailable` is the ONLY place the
 * conditions of a sandbox or browser call are combined: the resolver's grain for the agent acting for the human
 * (agent ∩ human, so a 07.3 module deny or any deny rule refuses), the organization switch, the kill switch and the
 * bot's own switch. Nothing here copies a resolver rule; the resolver is asked.
 *
 * Every function runs in the caller's transaction, under its tenant (RLS): ids that do not resolve there do not exist.
 */

/** Which confined family a call belongs to: the shell sandbox (`sbx`) or the browser (`brw`). */
export type ConfinedKind = "sandbox" | "browser";
/** The container a call needs. */
export type SandboxContainer = "sbx" | "brw";

/** Why a confined call is not available right now (codes of `SandboxRefusal` / `BrowserRefusal`). */
export type AvailabilityRefusal = "not_allowed" | "sandbox_off" | "killed" | "bot_off";

export type Availability = { ok: true } | { ok: false; reason: AvailabilityRefusal };

type PolicyRow = typeof sandboxPolicies.$inferSelect;

function settingsOf(row: PolicyRow | undefined, killedBy: { id: string; displayName: string } | null) {
  if (!row) return { ...structuredClone(DEFAULT_SANDBOX_SETTINGS), version: 0, updatedAt: null };
  const iso = (v: string | Date) => new Date(v).toISOString();
  return {
    enabled: row.enabled,
    sandboxEgress: row.sandboxEgressMode,
    browserEgress: row.browserEgressMode,
    allowHosts: [...row.egressAllowHosts],
    limits: {
      maxSandboxes: row.maxSandboxes,
      maxBrowsers: row.maxBrowsers,
      cpuMinutesPerDay: row.cpuMinutesPerDay,
      diskPerBotMb: row.diskPerBotMb,
      diskTotalMb: row.diskTotalMb,
    },
    browserSessionMaxDays: row.browserSessionMaxDays,
    killed: row.killedAt ? { at: iso(row.killedAt), by: killedBy } : null,
    version: row.version,
    updatedAt: iso(row.updatedAt),
  } satisfies SandboxSettings;
}

async function policyRow(tx: Tx): Promise<PolicyRow | undefined> {
  const [row] = await tx.select().from(sandboxPolicies).limit(1);
  return row;
}

/** The organization's sandbox settings (the column defaults when no row was saved yet; `version` 0 then). */
export async function loadSandboxPolicy(tx: Tx): Promise<SandboxSettings> {
  const row = await policyRow(tx);
  let by: { id: string; displayName: string } | null = null;
  if (row?.killedBy) {
    const [m] = await tx
      .select({ name: orgMembers.displayName })
      .from(orgMembers)
      .where(eq(orgMembers.userId, row.killedBy))
      .limit(1);
    by = m ? { id: row.killedBy, displayName: m.name } : null;
  }
  return settingsOf(row, by);
}

/**
 * A live bot as the resolver sees it (facts only: scope, owner, disabled, unit path), and its own switches. Data, never
 * a decision; null when the id is not a live bot of the transaction's organization (RLS).
 */
export async function loadSandboxBot(tx: Tx, agentId: string) {
  const [row] = await tx
    .select({
      id: agents.id,
      scope: agents.scope,
      ownerUserId: agents.ownerUserId,
      status: agents.status,
      unitId: agents.unitId,
      capabilities: agents.capabilities,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
    .limit(1);
  if (!row) return null;
  const [unit] = row.unitId
    ? await tx.select({ path: orgUnits.path }).from(orgUnits).where(eq(orgUnits.id, row.unitId)).limit(1)
    : [];
  const stored =
    row.capabilities && typeof row.capabilities === "object"
      ? (row.capabilities as Record<string, unknown>)
      : {};
  const sandbox = BotCapabilities.shape.sandbox.safeParse(stored.sandbox);
  const browser = BotCapabilities.shape.browser.safeParse(stored.browser);
  return {
    id: row.id,
    facts: {
      scope: row.scope,
      ownerUserId: row.ownerUserId,
      disabled: row.status === "disabled",
      unitPath: unit?.path ?? [],
    },
    switches: {
      sandbox: sandbox.success && sandbox.data === true,
      browser: browser.success && browser.data === true,
    },
  };
}

/**
 * Whether this bot may use its sandbox (or browser) for this human right now. In order: the resolver's `sandbox.use`
 * (or `browser.use`) for the agent acting on behalf of the human (`not_allowed`: a module turned off for the human, at
 * their unit or for the organization, a deny rule for the bot, a disabled bot), then the organization switch
 * (`sandbox_off`) and the kill switch (`killed`), then the bot's own switch (`bot_off`). Asked at delivery (the turn
 * offering) and again at every call (P-04): a change bites mid-turn.
 */
export async function sandboxAvailable(
  tx: Tx,
  perms: Pick<PermissionService, "decide">,
  p: { agentId: string; userId: string },
  kind: ConfinedKind,
): Promise<Availability> {
  const bot = await loadSandboxBot(tx, p.agentId);
  if (!bot) return { ok: false, reason: "not_allowed" };
  const decision = await perms.decide(
    tx,
    { kind: "agent", agentId: p.agentId, onBehalfOfUserId: p.userId },
    kind === "sandbox" ? "sandbox.use" : "browser.use",
    agentResource(bot.facts, p.userId),
  );
  if (!decision.allowed) return { ok: false, reason: "not_allowed" };
  const policy = await policyRow(tx);
  if (!policy?.enabled) return { ok: false, reason: "sandbox_off" };
  if (policy.killedAt) return { ok: false, reason: "killed" };
  if (!bot.switches[kind]) return { ok: false, reason: "bot_off" };
  return { ok: true };
}

/** States that hold a slot of the organization's cap. */
const OCCUPYING: SandboxState[] = ["starting", "running"];

/**
 * The organization's caps (D-09), decided under a transaction-scoped advisory lock per organization, so two first calls
 * of two bots never both take the last slot:
 * - the daily CPU minutes (`cpu_minutes_per_day`, UTC day): at or over it, every call answers `cpu_budget`, a running
 *   bot's too (07.8-11);
 * - a bot whose container is already starting or running needs no slot;
 * - the total disk (`disk_total_mb`, the mirrored `sbx` disk): at or over it, a new sandbox answers `disk_full`
 *   (07.8-11);
 * - the running sandboxes (`max_sandboxes`) or browsers (`max_browsers`): `cap_reached`.
 * A `starting` row older than five minutes is an orphan (the API process died between the reservation and the outcome
 * of `ensure`): it is released to `unavailable` first, so it never holds a slot for good (WINDOWS #241). Otherwise,
 * unless `dryRun`, the bot's row becomes `starting`. `ensure` tells the caller to ask sandboxd for the container first.
 */
export async function reserveSandbox(
  tx: Tx,
  p: { agentId: string },
  container: SandboxContainer,
  opts: { dryRun?: boolean } = {},
): Promise<
  { ok: true; ensure: boolean } | { ok: false; reason: "cap_reached" | "cpu_budget" | "disk_full" }
> {
  const { organizationId } = tenantOf(tx);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`ocw.sandbox.cap:${container}:${organizationId}`}, 0))`,
  );
  await releaseStaleReservations(tx, container);
  const policy = await policyRow(tx);
  const cpuCapMs = (policy?.cpuMinutesPerDay ?? DEFAULT_SANDBOX_SETTINGS.limits.cpuMinutesPerDay) * 60_000;
  if ((await cpuMsToday(tx)) >= cpuCapMs) return { ok: false, reason: "cpu_budget" };
  const [own] = await tx
    .select({ state: botSandboxes.state })
    .from(botSandboxes)
    .where(and(eq(botSandboxes.agentId, p.agentId), eq(botSandboxes.kind, container)))
    .limit(1);
  if (own?.state === "running") return { ok: true, ensure: false };
  if (own?.state === "starting") return { ok: true, ensure: true };
  if (container === "sbx") {
    const diskCap = (policy?.diskTotalMb ?? DEFAULT_SANDBOX_SETTINGS.limits.diskTotalMb) * MIB;
    if ((await diskBytesTotal(tx)) >= diskCap) return { ok: false, reason: "disk_full" };
  }
  const limit =
    container === "sbx"
      ? (policy?.maxSandboxes ?? DEFAULT_SANDBOX_SETTINGS.limits.maxSandboxes)
      : (policy?.maxBrowsers ?? DEFAULT_SANDBOX_SETTINGS.limits.maxBrowsers);
  const [used] = await tx
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(botSandboxes)
    .where(
      and(
        eq(botSandboxes.kind, container),
        inArray(botSandboxes.state, OCCUPYING),
        ne(botSandboxes.agentId, p.agentId),
      ),
    );
  if ((used?.n ?? 0) >= limit) return { ok: false, reason: "cap_reached" };
  if (!opts.dryRun) await markState(tx, { agentId: p.agentId, kind: container, state: "starting" });
  return { ok: true, ensure: true };
}

/** How long a reservation may wait for the outcome of `ensure` (the API's own deadlines stay well under it). */
const STALE_RESERVATION = sql.raw("interval '5 minutes'");

/** Releases orphan `starting` rows of this container kind (the organization's, under the cap lock). */
async function releaseStaleReservations(tx: Tx, container: SandboxContainer): Promise<void> {
  await tx
    .update(botSandboxes)
    .set({ state: "unavailable", stopReason: null, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(botSandboxes.kind, container),
        eq(botSandboxes.state, "starting"),
        sql`${botSandboxes.updatedAt} < now() - ${STALE_RESERVATION}`,
      ),
    );
}

/**
 * Starts (or confirms) one bot's shell sandbox with sandboxd's `ensure`, then brings its sandbox packages up to date
 * (07.8-18, P-12: `applyInstalls` installs the approved set from the stored lockfiles and removes what is no longer
 * approved). The packages never fail the start: a refused or failed install is recorded per package and the call goes
 * on without it.
 */
export async function ensureSandbox(
  core: Pick<Core, "db" | "audit" | "log">,
  client: SandboxdClient,
  target: { orgId: string; agentId: string },
  opts: { timeoutMs: number },
): Promise<{ state: SandboxState; runtime: SandboxRuntime | null }> {
  const status = await client.call("ensure", { target }, { timeoutMs: opts.timeoutMs });
  await applyInstalls(core, client, target);
  return status;
}

/** Records what sandboxd reported (or what the API decided) for one bot's container. */
export async function markState(
  tx: Tx,
  p: {
    agentId: string;
    kind: SandboxContainer;
    state: SandboxState;
    runtime?: SandboxRuntime | null;
    stopReason?: SandboxStopReason | null;
    active?: boolean;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const set = {
    state: p.state,
    ...(p.runtime !== undefined ? { runtime: p.runtime } : {}),
    stopReason: p.stopReason ?? null,
    ...(p.active ? { lastActiveAt: now } : {}),
    updatedAt: now,
  };
  await tx
    .insert(botSandboxes)
    .values({
      organizationId: tenantOf(tx).organizationId,
      agentId: p.agentId,
      kind: p.kind,
      ...set,
    })
    .onConflictDoUpdate({
      target: [botSandboxes.organizationId, botSandboxes.agentId, botSandboxes.kind],
      set,
    });
}

/** Marks a container used now (after a call ran in it). */
export async function touchSandbox(tx: Tx, p: { agentId: string; kind: SandboxContainer }): Promise<void> {
  const now = new Date().toISOString();
  await tx
    .update(botSandboxes)
    .set({ lastActiveAt: now, updatedAt: now })
    .where(and(eq(botSandboxes.agentId, p.agentId), eq(botSandboxes.kind, p.kind)));
}

/**
 * The admins' kill switch (D-09): records who and when, marks every sandbox and browser of the organization `killed`
 * (`kill_switch`) and audits `sandbox.killed` with counts only. Idempotent: an organization already killed changes
 * nothing and is not audited again. The caller asks sandboxd to stop everything AFTER this commits (fail closed: the
 * organization stays killed whatever sandboxd answers).
 */
export async function killSandboxes(
  tx: Tx,
  audit: AuditService,
  actor: { userId: string },
): Promise<{ changed: boolean }> {
  const now = new Date().toISOString();
  const { organizationId } = tenantOf(tx);
  const updated = await tx
    .insert(sandboxPolicies)
    .values({ organizationId, killedAt: now, killedBy: actor.userId })
    .onConflictDoUpdate({
      target: sandboxPolicies.organizationId,
      // 07.8-11: the kill state is part of the versioned settings (a stale settings form cannot undo it).
      set: { killedAt: now, killedBy: actor.userId, version: sql`${sandboxPolicies.version} + 1` },
      setWhere: isNull(sandboxPolicies.killedAt),
    })
    .returning({ organizationId: sandboxPolicies.organizationId });
  if (updated.length === 0) return { changed: false };
  const stopped = await tx
    .update(botSandboxes)
    .set({ state: "killed", stopReason: "kill_switch", updatedAt: now })
    .where(ne(botSandboxes.state, "absent"))
    .returning({ kind: botSandboxes.kind });
  await audit.record(tx, {
    action: "sandbox.killed",
    resourceType: "sandbox_policy",
    resourceId: organizationId,
    actorKind: "user",
    actorId: actor.userId,
    userId: actor.userId,
    metadata: {
      sandboxes: stopped.filter((s) => s.kind === "sbx").length,
      browsers: stopped.filter((s) => s.kind === "brw").length,
    },
  });
  return { changed: true };
}

/** Clears the kill switch (D-09) and audits `sandbox.resumed`; idempotent like the kill. */
export async function resumeSandboxes(
  tx: Tx,
  audit: AuditService,
  actor: { userId: string },
): Promise<{ changed: boolean }> {
  const { organizationId } = tenantOf(tx);
  const updated = await tx
    .update(sandboxPolicies)
    .set({ killedAt: null, killedBy: null, version: sql`${sandboxPolicies.version} + 1` })
    .where(isNotNull(sandboxPolicies.killedAt))
    .returning({ organizationId: sandboxPolicies.organizationId });
  if (updated.length === 0) return { changed: false };
  await audit.record(tx, {
    action: "sandbox.resumed",
    resourceType: "sandbox_policy",
    resourceId: organizationId,
    actorKind: "user",
    actorId: actor.userId,
    userId: actor.userId,
    metadata: {},
  });
  return { changed: true };
}

// ---------------------------------------------------------------- limits and usage (07.8-11; D-01, D-09)

const MIB = 1024 * 1024;

/**
 * The fixed per-container limits (UI-SPEC §3.1 and §4: "Each sandbox: 1 CPU · 1 GB memory · 256 processes · stops after
 * 15 min without use. Each browser: 1 CPU · 2 GB memory · stops after 5"); sandboxd clamps them again to its own hard
 * bounds. The disk quota is the organization's `disk_per_bot_mb`.
 */
export const CONTAINER_LIMITS = {
  sbx: { cpus: 1, memoryBytes: 1024 * MIB, pids: 256, idleStopMinutes: SANDBOX_LIMITS.idleStopMinutes },
  brw: { cpus: 1, memoryBytes: 2048 * MIB, pids: 512, idleStopMinutes: 5 },
} as const;

/** Today's UTC day (`sandbox_usage_daily.day`). */
export const utcDay = (at: Date = new Date()): string => at.toISOString().slice(0, 10);

/** CPU used today (UTC) by the organization's sandboxes, or by one bot's. */
export async function cpuMsToday(tx: Tx, agentId?: string): Promise<number> {
  const [row] = await tx
    .select({ ms: sql<string | null>`sum(${sandboxUsageDaily.cpuMs})` })
    .from(sandboxUsageDaily)
    .where(
      and(eq(sandboxUsageDaily.day, utcDay()), ...(agentId ? [eq(sandboxUsageDaily.agentId, agentId)] : [])),
    );
  return Number(row?.ms ?? 0);
}

/** The organization's workspaces as last measured (the `sbx` mirror). */
export async function diskBytesTotal(tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ bytes: sql<string | null>`sum(${botSandboxes.diskBytes})` })
    .from(botSandboxes)
    .where(eq(botSandboxes.kind, "sbx"));
  return Number(row?.bytes ?? 0);
}

/** Bytes still free in one bot's workspace under the organization's per-bot quota (last measurement). */
export async function diskRoom(tx: Tx, agentId: string): Promise<number> {
  const policy = await policyRow(tx);
  const quota = (policy?.diskPerBotMb ?? DEFAULT_SANDBOX_SETTINGS.limits.diskPerBotMb) * MIB;
  const [row] = await tx
    .select({ disk: botSandboxes.diskBytes })
    .from(botSandboxes)
    .where(and(eq(botSandboxes.agentId, agentId), eq(botSandboxes.kind, "sbx")))
    .limit(1);
  return Math.max(0, quota - (row?.disk ?? 0));
}

/**
 * Whether a person may start one bot's sandbox now (restart): the organization switch, the kill switch and the bot's own
 * switch. Settings, not access: who may ask at all is the resolver's `sandbox.files` (files.ts).
 */
export async function lifecycleRefusal(
  tx: Tx,
  agentId: string,
): Promise<"sandbox_off" | "killed" | "bot_off" | null> {
  const policy = await policyRow(tx);
  if (!policy?.enabled) return "sandbox_off";
  if (policy.killedAt) return "killed";
  const bot = await loadSandboxBot(tx, agentId);
  return bot?.switches.sandbox ? null : "bot_off";
}

// ---------------------------------------------------------------- purge of a deleted bot (07.8-11; D-01, R11)

const PURGE_TIMEOUT_MS = 60_000;

/**
 * In the deletion's transaction: the bot's containers become a pending purge (`absent`, reason `user`) until sandboxd
 * confirms; then the rows go. A deleted bot with rows left is what the events consumer retries.
 */
export async function markPurgePending(tx: Tx, agentId: string): Promise<void> {
  const now = new Date().toISOString();
  const set = { state: "absent" as const, stopReason: "user" as const, updatedAt: now };
  await tx
    .insert(botSandboxes)
    .values({ organizationId: tenantOf(tx).organizationId, agentId, kind: "sbx", ...set })
    .onConflictDoUpdate({
      target: [botSandboxes.organizationId, botSandboxes.agentId, botSandboxes.kind],
      set,
    });
  await tx
    .update(botSandboxes)
    .set(set)
    .where(and(eq(botSandboxes.agentId, agentId), eq(botSandboxes.kind, "brw")));
}

/**
 * Asks sandboxd to remove a deleted bot's containers, volumes and network (by label); on success its rows go. A failure
 * is logged with ids only and left pending. Returns whether the purge was confirmed.
 */
export async function purgeBot(
  core: Pick<Core, "db" | "log">,
  client: SandboxdClient,
  organizationId: string,
  agentId: string,
): Promise<boolean> {
  try {
    await client.call(
      "purge",
      { target: { orgId: organizationId, agentId } },
      { timeoutMs: PURGE_TIMEOUT_MS },
    );
  } catch (err) {
    core.log.warn(
      { organizationId, agentId, error: err instanceof Error ? err.name : "unknown" },
      "sandboxd did not purge a deleted bot's sandbox; the events consumer retries it",
    );
    return false;
  }
  await core.db.withTenant({ organizationId }, (tx) =>
    tx.delete(botSandboxes).where(eq(botSandboxes.agentId, agentId)),
  );
  return true;
}

/** Retries the pending purges of one organization's deleted bots; returns how many are still pending. */
export async function retryPendingPurges(
  core: Pick<Core, "db" | "log">,
  client: SandboxdClient,
  organizationId: string,
): Promise<number> {
  const pending = await core.db.withTenant({ organizationId }, (tx) =>
    tx
      .selectDistinct({ agentId: botSandboxes.agentId })
      .from(botSandboxes)
      .innerJoin(agents, eq(agents.id, botSandboxes.agentId))
      .where(isNotNull(agents.deletedAt)),
  );
  let left = 0;
  for (const p of pending) if (!(await purgeBot(core, client, organizationId, p.agentId))) left++;
  return left;
}
