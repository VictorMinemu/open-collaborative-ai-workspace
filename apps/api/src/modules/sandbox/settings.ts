import {
  AllowHost,
  SANDBOX_LIMITS,
  type SandboxdOrgPolicy,
  type SandboxIsolationInfo,
  type SandboxSettings,
  type SandboxSettingsView,
  UpdateSandboxSettingsRequest,
} from "@ocw/contracts";
import { botSandboxes, sandboxPolicies, type Tx, tenantOf } from "@ocw/db";
import { eq, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { HttpError } from "../../lib/errors";
import type { AuditService } from "../audit";
import { loadPrivateHosts } from "../keychain";
import type { SandboxdClient } from "./client";
import { CONTAINER_LIMITS, cpuMsToday, diskBytesTotal, loadSandboxPolicy } from "./service";

/**
 * The organization's Sandbox & Browser settings (07.8-11; SBX-03, SBX-01; D-09, D-11, D-12): the switch, the egress
 * modes and allowlist, the limits and the session days, read as a view and written with an expected version. Every
 * accepted change is audited (field names, and the hosts when the allowlist changed) and pushed to sandboxd as the
 * organization's policy after the commit, together with 07.4's private hosts and the kill state. sandboxd and its
 * egress proxy enforce what the API pushed; they decide nothing (P-03, P-04).
 */

const MIB = 1024 * 1024;
const POLICY_TIMEOUT_MS = 15_000;
const INFO_TIMEOUT_MS = 5_000;

export type SettingsRefusal =
  | "settings_version_conflict"
  | "invalid_allow_host"
  | "limits_out_of_range"
  | "validation_error";

/** The 4xx of one settings refusal; a version conflict carries the current settings. */
export function settingsRefusal(code: SettingsRefusal, details?: unknown): HttpError {
  switch (code) {
    case "settings_version_conflict":
      return new HttpError(409, code, "The settings changed since you loaded them", details);
    case "invalid_allow_host":
      return new HttpError(400, code, "Use up to 64 hosts like api.example.com, host:port or *.example.com");
    case "limits_out_of_range":
      return new HttpError(400, code, "A limit is outside its allowed range");
    default:
      return new HttpError(400, code, "Request validation failed", details);
  }
}

/**
 * Validates a settings change and names the refusal: a host that is not an `AllowHost` or more than 64 →
 * `invalid_allow_host`; a limit or the session days outside their ranges → `limits_out_of_range`; anything else
 * (unknown key, bad egress mode, no change) → `validation_error`.
 */
export function parseSettingsUpdate(body: unknown): UpdateSandboxSettingsRequest {
  const parsed = UpdateSandboxSettingsRequest.safeParse(body);
  if (parsed.success) return parsed.data;
  const first = (key: string) => parsed.error.issues.some((i) => i.path[0] === key);
  if (first("allowHosts")) throw settingsRefusal("invalid_allow_host");
  if (first("limits") || first("browserSessionMaxDays")) throw settingsRefusal("limits_out_of_range");
  throw settingsRefusal(
    "validation_error",
    parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
  );
}

function pgError(err: unknown): { code?: string; constraint?: string } | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    const c = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof c.code === "string") {
      return { code: c.code, constraint: typeof c.constraint === "string" ? c.constraint : undefined };
    }
    e = c.cause;
  }
  return undefined;
}

/** The named constraints of 07.8-02 a settings write can hit, as their 4xx (never a 500). */
export function settingsConstraintRefusal(err: unknown): HttpError | null {
  const pg = pgError(err);
  if (!pg) return null;
  if (pg.code === "23505" && pg.constraint === "sandbox_policies_pkey")
    return settingsRefusal("settings_version_conflict");
  if (pg.code !== "23514") return null;
  switch (pg.constraint) {
    case "sandbox_policies_allow_hosts_check":
      return settingsRefusal("invalid_allow_host");
    case "sandbox_policies_limits_check":
    case "sandbox_policies_session_days_check":
      return settingsRefusal("limits_out_of_range");
    case "sandbox_policies_egress_mode_check":
    case "sandbox_policies_version_check":
      return settingsRefusal("validation_error");
    default:
      return null;
  }
}

/** Field names of a change that differ from the current settings (the audit lists these, no other values). */
function changedFields(current: SandboxSettings, next: UpdateSandboxSettingsRequest): string[] {
  const out: string[] = [];
  if (next.enabled !== undefined && next.enabled !== current.enabled) out.push("enabled");
  if (next.sandboxEgress !== undefined && next.sandboxEgress !== current.sandboxEgress)
    out.push("sandboxEgress");
  if (next.browserEgress !== undefined && next.browserEgress !== current.browserEgress)
    out.push("browserEgress");
  if (next.allowHosts !== undefined && JSON.stringify(next.allowHosts) !== JSON.stringify(current.allowHosts))
    out.push("allowHosts");
  if (next.limits !== undefined && JSON.stringify(next.limits) !== JSON.stringify(current.limits))
    out.push("limits");
  if (
    next.browserSessionMaxDays !== undefined &&
    next.browserSessionMaxDays !== current.browserSessionMaxDays
  )
    out.push("browserSessionMaxDays");
  return out;
}

/**
 * One versioned write of the organization's settings (T-07.8-11-04): the row is locked, the version compared (0 when no
 * row was saved yet), the change written with `version + 1` and audited. The caller pushes the policy after the commit.
 */
export async function updateSandboxSettings(
  tx: Tx,
  audit: AuditService,
  actor: { userId: string },
  body: UpdateSandboxSettingsRequest,
): Promise<SandboxSettings> {
  const { organizationId } = tenantOf(tx);
  const [locked] = await tx
    .select({ version: sandboxPolicies.version })
    .from(sandboxPolicies)
    .for("update")
    .limit(1);
  const current = await loadSandboxPolicy(tx);
  if ((locked?.version ?? 0) !== body.expectedVersion) {
    throw settingsRefusal("settings_version_conflict", { settings: current });
  }
  const hosts = body.allowHosts ? [...new Set(body.allowHosts)] : undefined;
  const now = new Date().toISOString();
  const values = {
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.sandboxEgress !== undefined ? { sandboxEgressMode: body.sandboxEgress } : {}),
    ...(body.browserEgress !== undefined ? { browserEgressMode: body.browserEgress } : {}),
    ...(hosts !== undefined ? { egressAllowHosts: hosts } : {}),
    ...(body.limits !== undefined
      ? {
          maxSandboxes: body.limits.maxSandboxes,
          maxBrowsers: body.limits.maxBrowsers,
          cpuMinutesPerDay: body.limits.cpuMinutesPerDay,
          diskPerBotMb: body.limits.diskPerBotMb,
          diskTotalMb: body.limits.diskTotalMb,
        }
      : {}),
    ...(body.browserSessionMaxDays !== undefined
      ? { browserSessionMaxDays: body.browserSessionMaxDays }
      : {}),
    updatedBy: actor.userId,
    updatedAt: now,
  };
  try {
    if (locked) {
      await tx
        .update(sandboxPolicies)
        .set({ ...values, version: sql`${sandboxPolicies.version} + 1` })
        .where(eq(sandboxPolicies.organizationId, organizationId));
    } else {
      const inserted = await tx
        .insert(sandboxPolicies)
        .values({ organizationId, ...values, version: 1 })
        .onConflictDoNothing()
        .returning({ organizationId: sandboxPolicies.organizationId });
      // Another first save won the race: this one read version 0, which is no longer current.
      if (inserted.length === 0) throw settingsRefusal("settings_version_conflict", { settings: current });
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const refusal = settingsConstraintRefusal(err);
    if (refusal) throw refusal;
    throw err;
  }
  const changed = changedFields(current, { ...body, ...(hosts ? { allowHosts: hosts } : {}) });
  await audit.record(tx, {
    action: "sandbox.settings_updated",
    resourceType: "sandbox_policy",
    resourceId: organizationId,
    actorKind: "user",
    actorId: actor.userId,
    userId: actor.userId,
    metadata: { changed, ...(changed.includes("allowHosts") ? { allowHosts: hosts } : {}) },
  });
  return loadSandboxPolicy(tx);
}

/** The isolation in use, from sandboxd's `info` (status `service_down` when it does not answer). */
export async function loadIsolation(tx: Tx, client: SandboxdClient | null): Promise<SandboxIsolationInfo> {
  const running = await runningCounts(tx);
  if (!client)
    return { status: "service_down", runtime: null, dockerVersion: null, running, browserSandbox: null };
  try {
    const info = await client.call("info", {}, { timeoutMs: INFO_TIMEOUT_MS });
    return {
      status: info.dockerOk ? "ok" : "docker_too_old",
      runtime: info.runtime,
      dockerVersion: info.dockerVersion,
      running,
      browserSandbox: info.browserSandbox ?? null,
    };
  } catch {
    return { status: "service_down", runtime: null, dockerVersion: null, running, browserSandbox: null };
  }
}

async function runningCounts(tx: Tx): Promise<{ sandboxes: number; browsers: number }> {
  const rows = await tx
    .select({ kind: botSandboxes.kind, n: sql<number>`count(*)`.mapWith(Number) })
    .from(botSandboxes)
    .where(eq(botSandboxes.state, "running"))
    .groupBy(botSandboxes.kind);
  return {
    sandboxes: rows.find((r) => r.kind === "sbx")?.n ?? 0,
    browsers: rows.find((r) => r.kind === "brw")?.n ?? 0,
  };
}

/** `GET /api/v1/sandbox/settings`: the settings, the isolation and today's usage. */
export async function loadSettingsView(tx: Tx, client: SandboxdClient | null): Promise<SandboxSettingsView> {
  const settings = await loadSandboxPolicy(tx);
  const isolation = await loadIsolation(tx, client);
  return {
    settings,
    isolation,
    usage: { cpuMinutesToday: (await cpuMsToday(tx)) / 60_000, diskBytesTotal: await diskBytesTotal(tx) },
  };
}

/** The policy sandboxd and the egress proxy enforce for one organization (D-09, D-11, 07.4 private hosts). */
export async function buildPolicy(tx: Tx): Promise<SandboxdOrgPolicy> {
  const settings = await loadSandboxPolicy(tx);
  const privateHosts = (await loadPrivateHosts(tx)).slice(0, SANDBOX_LIMITS.allowHostsMax);
  const quota = settings.limits.diskPerBotMb * MIB;
  const limitsOf = (l: (typeof CONTAINER_LIMITS)["sbx" | "brw"]) => ({
    nanoCpus: l.cpus * 1_000_000_000,
    memoryBytes: l.memoryBytes,
    pids: l.pids,
    diskQuotaBytes: quota,
    idleStopMs: l.idleStopMinutes * 60_000,
  });
  return {
    orgId: tenantOf(tx).organizationId,
    sandboxEgress: settings.sandboxEgress,
    browserEgress: settings.browserEgress,
    allowHosts: settings.allowHosts.filter((h) => AllowHost.safeParse(h).success),
    privateHosts,
    limits: limitsOf(CONTAINER_LIMITS.sbx),
    browserLimits: limitsOf(CONTAINER_LIMITS.brw),
    killed: settings.killed !== null,
    // sandboxd keeps the newest version it was sent, so a stale push never undoes a kill (every kill/resume bumps it).
    version: settings.version,
  };
}

/** The organization's current policy for sandboxd, read in its own tenant transaction (the client's re-push). */
export function loadOrgPolicy(deps: Pick<Core, "db">, organizationId: string): Promise<SandboxdOrgPolicy> {
  return deps.db.withTenant({ organizationId }, (tx) => buildPolicy(tx));
}

/**
 * Sends the organization's policy to sandboxd, after the commit that changed it (settings, kill, resume) or when the
 * events consumer sees sandboxd restarted. Never throws: a failure is logged with ids only and the next push (or the
 * consumer's) repairs it; the kill state itself is enforced by the API whatever sandboxd holds.
 */
export async function pushPolicy(
  deps: Pick<Core, "db" | "log">,
  client: SandboxdClient | null,
  organizationId: string,
): Promise<boolean> {
  if (!client) return false;
  try {
    const policy = await loadOrgPolicy(deps, organizationId);
    await client.call("policy", policy, { timeoutMs: POLICY_TIMEOUT_MS });
    return true;
  } catch (err) {
    deps.log.warn(
      { organizationId, error: err instanceof Error ? err.name : "unknown" },
      "could not push the sandbox policy to sandboxd",
    );
    return false;
  }
}
