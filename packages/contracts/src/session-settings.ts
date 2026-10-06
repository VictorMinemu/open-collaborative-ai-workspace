import { z } from "zod";
import { IsoDateTime } from "./common";
import { FastModeState, PermissionMode, RuntimeId } from "./session-events";

/**
 * Work Zone session settings (Phase 03.2, D-07 … D-14). Defined ONCE here: the API intersects every request
 * with org policy ∩ device opt-in ∩ grain ∩ the runtime-reported catalog (`apps/api/.../controls.ts`), the
 * device applies the authorized values between turns (`session.configure`) and reports what it really runs
 * (`session.settings`), and the web renders only what the catalog and the controls allow.
 *
 * Nothing here is a hard-coded model list: every model, effort, context window and fast-mode option comes from
 * the `RuntimeCatalog` the device's runtime reported (D-08).
 */

// ---------------------------------------------------------------- effort, context window

/** Reasoning effort: an open set (Codex `ReasoningEffort` is a string); valid values come from the catalog. */
export const EffortLevel = z.string().trim().min(1).max(32);
export type EffortLevel = z.infer<typeof EffortLevel>;

/** Efforts with a known order and label (D-09). */
export const KNOWN_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** UI labels (D-09). */
export const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/** Efforts the runtimes report but the platform does not offer yet (D-09: multi-agent phase). */
export const DEFERRED_EFFORTS: readonly string[] = ["ultra"];

/** Position on the known ladder; an unknown effort ranks above `max` (never under a cap by accident). */
export function effortRank(e: string): number {
  const i = (KNOWN_EFFORTS as readonly string[]).indexOf(e);
  return i < 0 ? Number.POSITIVE_INFINITY : i;
}

/** Context window in tokens (D-10). */
export const ContextWindow = z.number().int().min(1000).max(10_000_000);
export type ContextWindow = z.infer<typeof ContextWindow>;

// ---------------------------------------------------------------- requested / effective settings

/** What a controller asks for. `null` = the runtime's default (send nothing). */
export const SessionSettings = z.object({
  model: z.string().trim().min(1).max(200).nullable(),
  effort: EffortLevel.nullable(),
  contextWindow: ContextWindow.nullable(),
  fastMode: z.boolean(),
  permissionMode: PermissionMode,
});
export type SessionSettings = z.infer<typeof SessionSettings>;

export const SessionSettingsPatch = SessionSettings.partial();
export type SessionSettingsPatch = z.infer<typeof SessionSettingsPatch>;

/** `PATCH /api/v1/work-sessions/:id/settings`. */
export const UpdateWorkSessionSettingsRequest = SessionSettingsPatch.refine(
  (p) => Object.keys(p).length > 0,
  {
    message: "Change at least one setting",
  },
);
export type UpdateWorkSessionSettingsRequest = z.infer<typeof UpdateWorkSessionSettingsRequest>;

/** What the device last reported (`session.settings` / `session.started`); runtime strings, bounded. */
export const EffectiveSessionSettings = z.object({
  model: z.string().max(200).nullable(),
  effort: z.string().max(32).nullable(),
  contextWindow: z.number().int().positive().nullable(),
  fastMode: z.boolean().nullable(),
  fastModeState: FastModeState.nullable(),
  fastModeReason: z.string().max(64).nullable(),
  permissionMode: z.string().max(32).nullable(),
  serviceTier: z.string().max(64).nullable(),
  at: IsoDateTime,
});
export type EffectiveSessionSettings = z.infer<typeof EffectiveSessionSettings>;

/** `WorkSession.settings`: requested (authorized) values, the effective ones, and whether a change is pending. */
export const WorkSessionSettings = z.object({
  requested: SessionSettingsPatch,
  effective: EffectiveSessionSettings.nullable(),
  /** A change was accepted but the device has not reported it yet (D-14: applies to the next turn). */
  pending: z.boolean(),
});
export type WorkSessionSettings = z.infer<typeof WorkSessionSettings>;

// ---------------------------------------------------------------- runtime catalog (device → server)

export const RuntimeEffortOption = z.object({
  value: EffortLevel,
  description: z.string().max(300).nullable(),
});
export type RuntimeEffortOption = z.infer<typeof RuntimeEffortOption>;

/** One model as the runtime reported it (Claude `ModelInfo`, Codex `model/list`). */
export const RuntimeModel = z.object({
  id: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  description: z.string().max(500).nullable(),
  /**
   * The concrete model id the runtime runs for this row when `id` is an alias (Claude `sonnet` →
   * `claude-sonnet-5-5`). The effective settings report the concrete id, so this maps them back to the row.
   * Optional: older daemons and runtimes without aliases omit it.
   */
  resolvedModel: z.string().min(1).max(200).nullable().optional(),
  /** Explicit version rows (Claude `claude-*`) or hidden/upgradable rows (Codex): the "Legacy models" group. */
  legacy: z.boolean(),
  isDefault: z.boolean(),
  /** Only when the runtime provides it (Codex `availabilityNux`); never invented (D-08). */
  badge: z.literal("new").nullable(),
  efforts: z.array(RuntimeEffortOption).max(16),
  defaultEffort: EffortLevel.nullable(),
  /** Selectable windows; empty or one value = fixed (D-10). */
  contextWindows: z.array(ContextWindow).max(4),
  defaultContextWindow: ContextWindow.nullable(),
  fastMode: z.object({ supported: z.boolean(), reason: z.string().max(64).nullable() }),
  supportsAutoMode: z.boolean(),
});
export type RuntimeModel = z.infer<typeof RuntimeModel>;

/** Everything one runtime on the device offers (`capabilities` frame; `devices.runtime_catalog`). */
export const RuntimeCatalog = z.object({
  runtime: RuntimeId,
  runtimeVersion: z.string().max(64).nullable(),
  models: z.array(RuntimeModel).max(100),
  /** Modes the adapter accepts on this device (its `capabilities.supportsPermissionModes`). */
  permissionModes: z.array(PermissionMode).max(5),
  /** What fast mode costs, in the runtime's terms (D-11). */
  fastModeCost: z.string().max(200).nullable(),
  collectedAt: IsoDateTime,
});
export type RuntimeCatalog = z.infer<typeof RuntimeCatalog>;

// ---------------------------------------------------------------- controls (server → web)

/** Why an option is shown unavailable (P-08). */
export const ControlDenialReason = z.enum([
  /** The organization's Work Zone policy does not allow it. */
  "org_policy",
  /** Full access is off on the device itself (its owner's local opt-in). */
  "device_opt_in",
  /** Above the caller's cap on this device (share / grant). */
  "device_grant",
  /** The caller lacks the grain (e.g. `device.full_access`). */
  "denied_for_you",
  /** The runtime does not offer it (or reports it unavailable). */
  "runtime",
  /** Not in the catalog the device reported. */
  "not_in_catalog",
  /** Awaiting confirmation by a recorded fixture (inventory row deferred). */
  "not_confirmed",
]);
export type ControlDenialReason = z.infer<typeof ControlDenialReason>;

export const ControlOption = z.object({
  available: z.boolean(),
  reason: ControlDenialReason.nullable(),
  detail: z.string().max(300).nullable(),
});
export type ControlOption = z.infer<typeof ControlOption>;

export const EffortControl = ControlOption.extend({
  value: EffortLevel,
  description: z.string().max(300).nullable(),
});
export type EffortControl = z.infer<typeof EffortControl>;

export const ContextWindowControl = ControlOption.extend({ value: ContextWindow });
export type ContextWindowControl = z.infer<typeof ContextWindowControl>;

export const FastModeControl = ControlOption.extend({ supported: z.boolean() });
export type FastModeControl = z.infer<typeof FastModeControl>;

export const ModelControl = ControlOption.extend({
  id: RuntimeModel.shape.id,
  displayName: RuntimeModel.shape.displayName,
  description: RuntimeModel.shape.description,
  resolvedModel: RuntimeModel.shape.resolvedModel,
  legacy: RuntimeModel.shape.legacy,
  isDefault: RuntimeModel.shape.isDefault,
  badge: RuntimeModel.shape.badge,
  efforts: z.array(EffortControl),
  defaultEffort: EffortLevel.nullable(),
  contextWindows: z.array(ContextWindowControl),
  defaultContextWindow: ContextWindow.nullable(),
  fastMode: FastModeControl,
  supportsAutoMode: z.boolean(),
});
export type ModelControl = z.infer<typeof ModelControl>;

export const PermissionModeControl = ControlOption.extend({ value: PermissionMode });
export type PermissionModeControl = z.infer<typeof PermissionModeControl>;

/** What a caller may pick for one runtime on one device. */
export const RuntimeControls = z.object({
  runtime: RuntimeId,
  /** null = the device reported no catalog for this runtime (no model choices are shown). */
  catalog: z.object({ runtimeVersion: z.string().max(64).nullable(), collectedAt: IsoDateTime }).nullable(),
  models: z.array(ModelControl),
  /** The device's other runtimes, shown disabled (switching provider inside a chat is out of scope, D-08). */
  otherRuntimes: z.array(
    z.object({
      runtime: RuntimeId,
      models: z.array(z.object({ id: z.string(), displayName: z.string() })),
    }),
  ),
  permissionModes: z.array(PermissionModeControl),
  fastModeCost: z.string().max(200).nullable(),
});
export type RuntimeControls = z.infer<typeof RuntimeControls>;

/** `GET /api/v1/work-sessions/:id/controls`. */
export const SessionControls = RuntimeControls.extend({ settings: WorkSessionSettings });
export type SessionControls = z.infer<typeof SessionControls>;
