import {
  BotCapabilities,
  DEFAULT_SANDBOX_SETTINGS,
  type SandboxRuntime,
  type SandboxSettings,
  type SandboxState,
  type SandboxStopReason,
} from "@ocw/contracts";
import { agents, botSandboxes, orgMembers, orgUnits, sandboxPolicies, type Tx, tenantOf } from "@ocw/db";
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { AuditService } from "../audit";
import { agentResource, type PermissionService } from "../organization";

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
 * The organization cap on running sandboxes (`max_sandboxes`) or browsers (`max_browsers`), decided under a
 * transaction-scoped advisory lock per organization, so two first calls of two bots never both take the last slot.
 * A bot whose container is already starting or running needs no slot. Otherwise, unless `dryRun`, its row becomes
 * `starting` (the slot is taken until the API records the outcome of `ensure`). `ensure` tells the caller to ask
 * sandboxd for the container before using it.
 */
export async function reserveSandbox(
  tx: Tx,
  p: { agentId: string },
  container: SandboxContainer,
  opts: { dryRun?: boolean } = {},
): Promise<{ ok: true; ensure: boolean } | { ok: false; reason: "cap_reached" }> {
  const { organizationId } = tenantOf(tx);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`ocw.sandbox.cap:${container}:${organizationId}`}, 0))`,
  );
  const [own] = await tx
    .select({ state: botSandboxes.state })
    .from(botSandboxes)
    .where(and(eq(botSandboxes.agentId, p.agentId), eq(botSandboxes.kind, container)))
    .limit(1);
  if (own?.state === "running") return { ok: true, ensure: false };
  if (own?.state === "starting") return { ok: true, ensure: true };
  const policy = await policyRow(tx);
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
      set: { killedAt: now, killedBy: actor.userId },
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
    .set({ killedAt: null, killedBy: null })
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
