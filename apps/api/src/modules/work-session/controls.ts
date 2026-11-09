import {
  type ControlDenialReason,
  type ControlOption,
  DEFERRED_EFFORTS,
  effortRank,
  isExposed,
  type ModelControl,
  minMode,
  modeWithin,
  PERMISSION_MODE_RANK,
  PermissionMode,
  type PermissionModeControl,
  RuntimeCatalog,
  type RuntimeControls,
  type RuntimeId,
  type RuntimeModel,
  type SessionControls,
  type SessionSettings,
  type SessionSettingsPatch,
  type WorkSession,
  type WorkZonePolicy,
} from "@ocw/contracts";
import type { AgentControlsLayer } from "./context";

/**
 * Work Zone session controls (PURE, Phase 03.2, D-07 … D-12, P-03, P-07, P-08). Everything a controller may
 * pick is the intersection of the runtime-reported catalog (D-08: never a hard-coded list) ∩ org policy ∩ device
 * opt-in ∩ the caller's cap on the device ∩ grain ∩ the runtime controls inventory (WZC-06). `context.ts` loads a
 * `ControlsContext` for a member on a device; routes and the dispatcher only decide through these functions.
 *
 * Reason precedence (the upper layer wins, principle 6): `org_policy` → `device_opt_in` → `device_grant` →
 * `denied_for_you` → `runtime` / `not_in_catalog` → `not_confirmed` (an inventory row that is not exposed) →
 * `bot_profile` (07.16 PD-07: a bot's caps, checked last so a member's own limit keeps its reason).
 */

export interface ControlsContext {
  /** The catalog of the session's runtime on its device; null = the device reported none. */
  catalog: RuntimeCatalog | null;
  /** The device's other runtimes (shown disabled, D-08). */
  otherCatalogs: RuntimeCatalog[];
  policy: Omit<WorkZonePolicy, "updatedAt">;
  /** The device owner's local full-access opt-in (ADR-0012). */
  deviceOptIn: boolean;
  /** The caller's highest mode on the device; null = none (every mode is above it). */
  modeCap: PermissionMode | null;
  /** The caller holds `device.full_access` on the device. */
  fullAccessGrain: boolean;
  /**
   * The inventory confirms the option (`mode.<mode>`, `effort`, `context.window`, `fast.mode`); defaults to
   * `isExposed(<runtime>, uiKey)`. Nothing the inventory has not confirmed is ever offered (WZC-06, P-09).
   */
  exposed?: (uiKey: string) => boolean;
  /**
   * 07.16 PD-07: a bot starting or prompting in its sponsor's name; the sponsor's layers above stay as they are and
   * every builder adds the bot's caps as its last check (`bot_profile`). Absent on every human path.
   */
  agent?: AgentControlsLayer;
}

/** P-07: the upper bound of the floor for in-session controllers with no relation to the device. */
export const CONTROLLER_FLOOR: PermissionMode = "acceptEdits";

/** The inventory check of a context for `runtime`. */
function exposedFor(ctx: ControlsContext, runtime: RuntimeId): (uiKey: string) => boolean {
  return ctx.exposed ?? ((uiKey) => isExposed(runtime, uiKey));
}

/**
 * Modes every pre-03.2 adapter accepted. Used only when a device reported no catalog (an older daemon), so
 * sessions it already ran keep working; new modes always need the catalog to list them.
 */
export const LEGACY_PERMISSION_MODES: readonly PermissionMode[] = ["default", "acceptEdits", "plan"];

/** Every catalog in a `devices.runtime_catalog` value that still parses (tolerant of old or bad rows). */
export function catalogsOf(runtimeCatalog: unknown): RuntimeCatalog[] {
  if (!Array.isArray(runtimeCatalog)) return [];
  const out: RuntimeCatalog[] = [];
  for (const c of runtimeCatalog) {
    const parsed = RuntimeCatalog.safeParse(c);
    if (parsed.success && !out.some((o) => o.runtime === parsed.data.runtime)) out.push(parsed.data);
  }
  return out;
}

/** The catalog of `runtime` in a `devices.runtime_catalog` value, or null. */
export function catalogFor(runtimeCatalog: unknown, runtime: RuntimeId): RuntimeCatalog | null {
  return catalogsOf(runtimeCatalog).find((c) => c.runtime === runtime) ?? null;
}

const OK: ControlOption = { available: true, reason: null, detail: null };
const no = (reason: ControlDenialReason, detail: string | null = null): ControlOption => ({
  available: false,
  reason,
  detail,
});

function modelControl(m: RuntimeModel, runtime: RuntimeId, ctx: ControlsContext): ModelControl {
  const allowed = ctx.policy.allowedModels[runtime];
  const base = allowed.length === 0 || allowed.includes(m.id) ? OK : no("org_policy");
  const maxEffort = ctx.policy.maxEffort[runtime];
  const exposed = exposedFor(ctx, runtime);
  const confirmed = (uiKey: string, option: ControlOption): ControlOption =>
    option.available && !exposed(uiKey) ? no("not_confirmed") : option;
  // 07.16 PD-07: a bot's profile sets are the last check, so the member's, the runtime's and the inventory's own
  // reasons are reported first; absent agent = no change.
  const agent = ctx.agent;
  const inProfile = (option: ControlOption, allows: (a: AgentControlsLayer) => boolean): ControlOption =>
    option.available && agent && !allows(agent) ? no("bot_profile") : option;
  return {
    ...inProfile(base, (a) => a.models.includes(m.id)),
    id: m.id,
    displayName: m.displayName,
    description: m.description,
    resolvedModel: m.resolvedModel ?? null,
    legacy: m.legacy,
    isDefault: m.isDefault,
    badge: m.badge,
    efforts: m.efforts.map((e) => ({
      ...inProfile(
        maxEffort !== null && effortRank(e.value) > effortRank(maxEffort)
          ? no("org_policy")
          : DEFERRED_EFFORTS.includes(e.value)
            ? no("not_confirmed", "Deferred to the multi-agent phase")
            : confirmed("effort", OK),
        (a) => a.efforts.includes(e.value),
      ),
      value: e.value,
      description: e.description,
    })),
    defaultEffort: m.defaultEffort,
    contextWindows: m.contextWindows.map((value) => ({
      ...inProfile(confirmed("context.window", OK), (a) => a.contextWindows.includes(value)),
      value,
    })),
    defaultContextWindow: m.defaultContextWindow,
    fastMode: {
      ...inProfile(
        !ctx.policy.allowFastMode
          ? no("org_policy")
          : m.fastMode.supported
            ? confirmed("fast.mode", OK)
            : no("runtime", m.fastMode.reason),
        (a) => a.fastMode !== "off",
      ),
      supported: m.fastMode.supported,
    },
    supportsAutoMode: m.supportsAutoMode,
    // 06.1 (P-08): passthrough; absent = the runtime did not say (unknown, allowed).
    ...(m.imageInput !== undefined ? { imageInput: m.imageInput } : {}),
  };
}

function modeControl(
  mode: PermissionMode,
  ctx: ControlsContext,
  model: RuntimeModel | null,
  runtime: RuntimeId,
): PermissionModeControl {
  const runtimeModes = ctx.catalog?.permissionModes ?? LEGACY_PERMISSION_MODES;
  const full = mode === "fullAccess";
  let option: ControlOption;
  // The organization's restriction is reported first: it wins over every lower layer (principle 6); then the
  // device (its owner's opt-in, the caller's cap), the caller's grain, the runtime, and the inventory last.
  if (full ? !ctx.policy.allowFullAccess : !ctx.policy.allowedPermissionModes.includes(mode))
    option = no("org_policy");
  else if (full && !ctx.deviceOptIn) option = no("device_opt_in");
  else if (!modeWithin(mode, ctx.modeCap)) option = no("device_grant");
  else if (full && !ctx.fullAccessGrain) option = no("denied_for_you");
  else if (!runtimeModes.includes(mode)) option = no("runtime");
  else if (mode === "auto" && model && !model.supportsAutoMode)
    option = no("runtime", `${model.displayName} does not support Auto`);
  else if (!exposedFor(ctx, runtime)(`mode.${mode}`)) option = no("not_confirmed");
  else if (ctx.agent && !agentAllowsMode(ctx.agent, mode)) option = no("bot_profile");
  else option = OK;
  return { ...option, value: mode };
}

/**
 * 07.16 PD-07, PD-08 (ADR-0012): a bot's mode is at most its profile's max, and Full access also needs the per-bot
 * consent (`allowFullAccess`) and a session that never read outside content unless the host is an isolated server.
 */
function agentAllowsMode(agent: AgentControlsLayer, mode: PermissionMode): boolean {
  if (PERMISSION_MODE_RANK[mode] > PERMISSION_MODE_RANK[agent.maxMode]) return false;
  if (mode === "fullAccess") return agent.allowFullAccess && (!agent.tainted || agent.isolated);
  return true;
}

/** The model a session runs when it names none (or a model the catalog no longer lists). */
function effectiveModel(catalog: RuntimeCatalog | null, id: string | null | undefined): RuntimeModel | null {
  if (!catalog) return null;
  return (
    (id ? catalog.models.find((m) => m.id === id) : null) ?? catalog.models.find((m) => m.isDefault) ?? null
  );
}

/** What a caller may pick for `runtime` (`model` = the session's current model, for model-bound modes). */
export function buildRuntimeControls(
  runtime: RuntimeId,
  ctx: ControlsContext,
  model?: string | null,
): RuntimeControls {
  const catalog = ctx.catalog && ctx.catalog.runtime === runtime ? ctx.catalog : null;
  const scoped = { ...ctx, catalog };
  const current = model === undefined ? null : effectiveModel(catalog, model);
  return {
    runtime,
    catalog: catalog ? { runtimeVersion: catalog.runtimeVersion, collectedAt: catalog.collectedAt } : null,
    models: catalog ? catalog.models.map((m) => modelControl(m, runtime, scoped)) : [],
    otherRuntimes: ctx.otherCatalogs
      .filter((c) => c.runtime !== runtime)
      .map((c) => ({
        runtime: c.runtime,
        models: c.models.map((m) => ({ id: m.id, displayName: m.displayName })),
      })),
    permissionModes: [...PermissionMode.options]
      .sort((a, b) => PERMISSION_MODE_RANK[a] - PERMISSION_MODE_RANK[b])
      .map((mode) => modeControl(mode, scoped, current, runtime)),
    fastModeCost: catalog?.fastModeCost ?? null,
  };
}

/** `GET /work-sessions/:id/controls`. */
export function buildSessionControls(session: WorkSession, ctx: ControlsContext): SessionControls {
  return { ...buildRuntimeControls(session.runtime, ctx, session.model), settings: session.settings };
}

type Decision =
  | { ok: true; next: SessionSettingsPatch; changed: string[]; adjusted: string[] }
  | { ok: false; field: string; reason: ControlDenialReason };

const SETTING_KEYS = ["model", "effort", "contextWindow", "fastMode", "permissionMode"] as const;

/**
 * Validate a settings change against the controls. Only keys that change are checked (an unchanged value the
 * caller could no longer pick stays). On a model switch, the effort, context window and fast mode the new model
 * does not offer are dropped and reported in `adjusted`.
 */
export function decideSettings(
  current: SessionSettingsPatch,
  patch: SessionSettingsPatch,
  runtime: RuntimeId,
  ctx: ControlsContext,
): Decision {
  const next: SessionSettingsPatch = { ...current };
  const changed: Array<(typeof SETTING_KEYS)[number]> = [];
  for (const key of SETTING_KEYS) {
    if (!(key in patch) || patch[key] === undefined) continue;
    if (patch[key] === (current[key] ?? defaultOf(key))) continue;
    changed.push(key);
    (next as Record<string, unknown>)[key] = patch[key];
  }
  const target = buildRuntimeControls(runtime, ctx, next.model ?? null);
  const model =
    target.models.find((m) => m.id === next.model) ?? target.models.find((m) => m.isDefault) ?? null;

  for (const key of changed) {
    const value = next[key];
    if (key === "model") {
      if (value === null) continue;
      const m = target.models.find((x) => x.id === value);
      if (!m) return { ok: false, field: key, reason: "not_in_catalog" };
      if (!m.available) return { ok: false, field: key, reason: m.reason ?? "runtime" };
    } else if (key === "effort") {
      if (value === null) continue;
      const e = model?.efforts.find((x) => x.value === value);
      if (!e) return { ok: false, field: key, reason: "not_in_catalog" };
      if (!e.available) return { ok: false, field: key, reason: e.reason ?? "runtime" };
    } else if (key === "contextWindow") {
      if (value === null) continue;
      const w = model?.contextWindows.find((x) => x.value === value);
      if (!w) return { ok: false, field: key, reason: "not_in_catalog" };
      if (!w.available) return { ok: false, field: key, reason: w.reason ?? "runtime" };
    } else if (key === "fastMode") {
      if (value === false) continue;
      if (!model) return { ok: false, field: key, reason: "not_in_catalog" };
      if (!model.fastMode.available)
        return { ok: false, field: key, reason: model.fastMode.reason ?? "runtime" };
    } else if (key === "permissionMode") {
      const option = target.permissionModes.find((x) => x.value === value);
      if (!option) return { ok: false, field: key, reason: "runtime" };
      if (!option.available) return { ok: false, field: key, reason: option.reason ?? "runtime" };
    }
  }

  const adjusted: string[] = [];
  if (changed.includes("model") && model) {
    if (!changed.includes("effort") && next.effort && !model.efforts.some((e) => e.value === next.effort)) {
      next.effort = null;
      adjusted.push("effort");
    }
    if (
      !changed.includes("contextWindow") &&
      next.contextWindow &&
      !model.contextWindows.some((w) => w.value === next.contextWindow)
    ) {
      next.contextWindow = null;
      adjusted.push("contextWindow");
    }
    if (!changed.includes("fastMode") && next.fastMode && !model.fastMode.supported) {
      next.fastMode = false;
      adjusted.push("fastMode");
    }
  }
  return { ok: true, next, changed, adjusted };
}

function defaultOf(key: (typeof SETTING_KEYS)[number]): unknown {
  return key === "fastMode" ? false : key === "permissionMode" ? undefined : null;
}

/** The full requested settings of a session row (P-04): absent keys are the runtime default. */
export function requestedSettings(row: {
  model: string | null;
  permissionMode: PermissionMode;
  settings: Record<string, unknown> | null;
}): SessionSettings {
  const s = row.settings ?? {};
  return {
    model: row.model,
    effort: typeof s.effort === "string" ? s.effort : null,
    contextWindow: typeof s.contextWindow === "number" ? s.contextWindow : null,
    fastMode: s.fastMode === true,
    permissionMode: row.permissionMode,
  };
}

/** The `work_sessions.settings` jsonb for a full settings value (the keys other than model and mode). */
export function storedSettings(s: SessionSettingsPatch): Record<string, unknown> {
  return { effort: s.effort ?? null, contextWindow: s.contextWindow ?? null, fastMode: s.fastMode ?? false };
}

/** Pick `keys` of a settings value (nulls kept: they mean "back to the runtime default"). */
export function pickSettings(s: SessionSettingsPatch, keys: readonly string[]): SessionSettingsPatch {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = (s as Record<string, unknown>)[k] ?? (k === "fastMode" ? false : null);
  return out as SessionSettingsPatch;
}

// ---------------------------------------------------------------- per-turn mode and downgrades (P-07)

/**
 * The cap of a member on a device for the mode decision. A current cap (owner, everyone-share, grant) is the cap;
 * otherwise a member named by a revoked grant gets nothing (refused, never the floor); otherwise, inside an
 * existing session, the pre-03.2 multiplayer right at min(CONTROLLER_FLOOR, the device's floor); outside a
 * session (a new session, the New session dialog) nothing.
 */
export function authorModeCap(
  a: { cap: PermissionMode | null; revoked: boolean; floor: PermissionMode },
  inSession: boolean,
): PermissionMode | null {
  if (a.cap !== null) return a.cap;
  if (a.revoked || !inSession) return null;
  return minMode(CONTROLLER_FLOOR, a.floor);
}

/**
 * The highest mode the context allows (for `model`, since Auto is model-bound), at or below `ceiling` when given.
 * Walking down the ladder skips every mode the intersection refuses, so a non-contiguous policy never yields a
 * mode it left out. null = no mode at all.
 */
export function highestAvailableMode(
  ctx: ControlsContext,
  model?: string | null,
  ceiling?: PermissionMode,
): PermissionMode | null {
  const runtime = ctx.catalog?.runtime;
  const current = effectiveModel(ctx.catalog, model);
  const ladder = [...PermissionMode.options].sort(
    (a, b) => PERMISSION_MODE_RANK[b] - PERMISSION_MODE_RANK[a],
  );
  for (const mode of ladder) {
    if (ceiling !== undefined && PERMISSION_MODE_RANK[mode] > PERMISSION_MODE_RANK[ceiling]) continue;
    const option = runtime
      ? modeControl(mode, ctx, current, runtime)
      : // No catalog (older daemon): legacy modes, judged against the Claude Code inventory rows they share.
        modeControl(mode, ctx, null, "claude-code");
    if (option.available) return mode;
  }
  return null;
}

/** The mode a turn runs in: min(session mode, the author's cap); null refuses the turn (P-07). */
export function turnMode(
  sessionMode: PermissionMode,
  authorCap: PermissionMode | null,
): PermissionMode | null {
  return authorCap === null ? null : minMode(sessionMode, authorCap);
}

/**
 * Lower a requested settings value to what `controls` (built for the session's model) allow: the mode to the
 * highest available mode at or below it (never raised: when none is below it stays, and every turn is refused at
 * dispatch until a controller picks an allowed mode), the model to the catalog
 * default when it is no longer available, and effort / context window / fast mode back to the runtime default
 * when unavailable. Used when a policy, an opt-in or a member's access tightens (ADR-0012).
 */
export function clampToControls(
  requested: SessionSettingsPatch,
  controls: RuntimeControls,
): { next: SessionSettingsPatch; changed: string[] } {
  const next: SessionSettingsPatch = { ...requested };
  const changed: string[] = [];

  if (next.model) {
    const m = controls.models.find((x) => x.id === next.model);
    if (m && !m.available) {
      const fallback =
        controls.models.find((x) => x.isDefault && x.available) ?? controls.models.find((x) => x.available);
      next.model = fallback?.id ?? null;
      changed.push("model");
    }
  }
  const model =
    controls.models.find((x) => x.id === next.model) ?? controls.models.find((x) => x.isDefault) ?? null;
  if (next.effort) {
    const e = model?.efforts.find((x) => x.value === next.effort);
    if (model && !e?.available) {
      next.effort = null;
      changed.push("effort");
    }
  }
  if (next.contextWindow) {
    const w = model?.contextWindows.find((x) => x.value === next.contextWindow);
    if (model && !w?.available) {
      next.contextWindow = null;
      changed.push("contextWindow");
    }
  }
  if (next.fastMode && model && !model.fastMode.available) {
    next.fastMode = false;
    changed.push("fastMode");
  }
  if (next.permissionMode) {
    const requestedMode = next.permissionMode;
    const available = controls.permissionModes.filter((m) => m.available).map((m) => m.value);
    if (!available.includes(requestedMode)) {
      const target = available
        .filter((m) => PERMISSION_MODE_RANK[m] < PERMISSION_MODE_RANK[requestedMode])
        .sort((a, b) => PERMISSION_MODE_RANK[b] - PERMISSION_MODE_RANK[a])[0];
      if (target) {
        next.permissionMode = target;
        changed.push("permissionMode");
      }
    }
  }
  return { next, changed };
}
