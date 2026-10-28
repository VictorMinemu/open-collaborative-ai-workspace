import { z } from "zod";
import { IsoDateTime } from "./common";
import { RuntimeUpdatesLevel } from "./runtime-maintenance";
import { PermissionMode } from "./session-events";
import { EffortLevel } from "./session-settings";

/**
 * Organization Work Zone policy (Phase 03.2, D-02, D-11; ADR-0012). One row per organization
 * (`app.work_zone_policies`); an absent row means `DEFAULT_WORK_ZONE_POLICY`. Its restriction always wins
 * (Org ∩ … ∩ Device): it caps every session setting a controller may pick and every turn's mode.
 */
export const WorkZonePolicy = z.object({
  /** Modes controllers may pick; `fullAccess` is never listed here, it has its own switch. */
  allowedPermissionModes: z
    .array(PermissionMode.exclude(["fullAccess"]))
    .min(1)
    .max(4),
  /** ADR-0012: full access is denied by default. */
  allowFullAccess: z.boolean(),
  /** Per runtime; `[]` = every model the device reports. */
  allowedModels: z.object({
    "claude-code": z.array(z.string().max(200)).max(100),
    codex: z.array(z.string().max(200)).max(100),
  }),
  /** Per runtime; `null` = no cap. */
  maxEffort: z.object({ "claude-code": EffortLevel.nullable(), codex: EffortLevel.nullable() }),
  /** Fast mode is metered (D-11): off by default. */
  allowFastMode: z.boolean(),
  /**
   * Phase 07.11 (D-02): whether the organization's devices update their Claude Code / Codex CLIs on their own.
   * `automatic` by default; a device can only lower it (the effective level is the lower of the two). D-10: a device
   * that never received it behaves as `notify`.
   */
  runtimeUpdates: RuntimeUpdatesLevel,
  /** null = no policy saved yet (the defaults apply). */
  updatedAt: IsoDateTime.nullable(),
});
export type WorkZonePolicy = z.infer<typeof WorkZonePolicy>;

/** Defaults when an organization has no `work_zone_policies` row (D-02, D-11). */
export const DEFAULT_WORK_ZONE_POLICY: Omit<WorkZonePolicy, "updatedAt"> = {
  allowedPermissionModes: ["plan", "default", "acceptEdits", "auto"],
  allowFullAccess: false,
  allowedModels: { "claude-code": [], codex: [] },
  maxEffort: { "claude-code": null, codex: null },
  allowFastMode: false,
  runtimeUpdates: "automatic",
};

/** `PUT /api/v1/work-zone-policy`: any subset. */
export const UpdateWorkZonePolicyRequest = WorkZonePolicy.omit({ updatedAt: true }).partial();
export type UpdateWorkZonePolicyRequest = z.infer<typeof UpdateWorkZonePolicyRequest>;

const KnownModel = z.object({ id: z.string(), displayName: z.string() });

/** `GET/PUT /api/v1/work-zone-policy` response: the policy plus the models the org's devices reported. */
export const WorkZonePolicyView = WorkZonePolicy.extend({
  knownModels: z.object({ "claude-code": z.array(KnownModel), codex: z.array(KnownModel) }),
});
export type WorkZonePolicyView = z.infer<typeof WorkZonePolicyView>;
