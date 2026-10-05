import {
  type ControlDenialReason,
  type ControlOption,
  DEFERRED_EFFORTS,
  effortRank,
  type ModelControl,
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

/**
 * Work Zone session controls (PURE, Phase 03.2, D-07 … D-12, P-03, P-08). Everything a controller may pick is
 * the intersection of the runtime-reported catalog (D-08: never a hard-coded list) ∩ org policy ∩ device opt-in
 * ∩ the caller's cap on the device ∩ grain. The routes load a `ControlsContext`; Plan 04 replaces the loader
 * (policy, opt-in, grain) without changing these signatures.
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
  return {
    ...base,
    id: m.id,
    displayName: m.displayName,
    description: m.description,
    legacy: m.legacy,
    isDefault: m.isDefault,
    badge: m.badge,
    efforts: m.efforts.map((e) => ({
      ...(DEFERRED_EFFORTS.includes(e.value)
        ? no("not_confirmed", "Deferred to the multi-agent phase")
        : maxEffort !== null && effortRank(e.value) > effortRank(maxEffort)
          ? no("org_policy")
          : OK),
      value: e.value,
      description: e.description,
    })),
    defaultEffort: m.defaultEffort,
    contextWindows: m.contextWindows.map((value) => ({ ...OK, value })),
    defaultContextWindow: m.defaultContextWindow,
    fastMode: {
      ...(!ctx.policy.allowFastMode
        ? no("org_policy")
        : m.fastMode.supported
          ? OK
          : no("runtime", m.fastMode.reason)),
      supported: m.fastMode.supported,
    },
    supportsAutoMode: m.supportsAutoMode,
  };
}

function modeControl(
  mode: PermissionMode,
  ctx: ControlsContext,
  model: RuntimeModel | null,
): PermissionModeControl {
  const runtimeModes = ctx.catalog?.permissionModes ?? LEGACY_PERMISSION_MODES;
  const full = mode === "fullAccess";
  let option: ControlOption;
  // The organization's restriction is reported first: it wins over every lower layer (principle 6).
  if (full ? !ctx.policy.allowFullAccess : !ctx.policy.allowedPermissionModes.includes(mode))
    option = no("org_policy");
  else if (!runtimeModes.includes(mode)) option = no("runtime");
  else if (mode === "auto" && model && !model.supportsAutoMode)
    option = no("runtime", `${model.displayName} does not support Auto`);
  else if (full && !ctx.deviceOptIn) option = no("device_opt_in");
  else if (!modeWithin(mode, ctx.modeCap)) option = no("device_grant");
  else if (full && !ctx.fullAccessGrain) option = no("denied_for_you");
  else option = OK;
  return { ...option, value: mode };
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
      .map((mode) => modeControl(mode, scoped, current)),
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
