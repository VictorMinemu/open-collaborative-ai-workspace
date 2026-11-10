import {
  type ContextWindow,
  type EffortLevel,
  isExposed,
  type PermissionMode,
  type RuntimeId,
  type WorkZonePolicy,
} from "@ocw/contracts";
import { devices, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import { type DeviceAccess, loadDeviceAccess } from "../device";
import type { PermissionService, ResourceFacts } from "../organization";
import { authorModeCap, type ControlsContext, catalogsOf } from "./controls";
import { loadWorkZonePolicy } from "./policy";

/**
 * Loads the ONE `ControlsContext` every decision uses (Phase 03.2 Plan 04, D-02, P-06 … P-08): the organization's
 * policy, the device's own opt-in and catalog, the member's cap on the device (owner / everyone-share / grants;
 * inside a session the controller floor for unlisted members, nothing for revoked ones) and the member's
 * `device.full_access` grain from the resolver (deny rules apply). Routes and the per-turn dispatcher call it.
 */

export interface MemberControls {
  ctx: ControlsContext;
  /** The member's own cap on the device (no floor applied); null = no access of their own. */
  cap: PermissionMode | null;
  /** A revoked grant on the device names the member. */
  revoked: boolean;
  /** Resolver facts of the device for the member (with the cap). */
  facts: ResourceFacts;
}

/**
 * 07.16 (PD-05, PD-07): a bot's Work Zone caps, intersected into the ONE controls context so a bot's start or prompt
 * never goes above its profile (refusals carry `bot_profile`). Built only by `profileStatus` / `botLayerForSession`
 * in `bot-profile.ts`; `loadControlsContext` copies it into `ControlsContext.agent` and the control builders decide
 * against it (07.16-06).
 */
export interface AgentControlsLayer {
  agentId: string;
  /** The profile's highest permission mode. */
  maxMode: PermissionMode;
  /** The device owner's consent allows Full access for this bot and the profile's max mode is Full access (PD-05). */
  allowFullAccess: boolean;
  /** The session (`tainted_at`) or the start turn read outside content (D-08). */
  tainted: boolean;
  /** A service host whose owner marked it an isolated server (D-19). */
  isolated: boolean;
  /** The profile's model, effort and context window sets and its fast mode (PD-07 decides against them). */
  models: readonly string[];
  efforts: readonly EffortLevel[];
  contextWindows: readonly ContextWindow[];
  fastMode: "off" | "allowed" | "on";
}

export interface LoadControlsOptions {
  deviceId: string;
  runtime: RuntimeId;
  userId: string;
  /** Inside an existing session: unlisted members get the device's controller floor (P-07). */
  inSession: boolean;
  /** Preloaded inputs (loops over many sessions). */
  policy?: WorkZonePolicy;
  access?: DeviceAccess;
  /** 07.16 PD-07: the bot's caps when a bot starts or prompts in its sponsor's name; absent on every human path. */
  agent?: AgentControlsLayer;
}

/** null when the device is not visible in this tenant. */
export async function loadControlsContext(
  tx: Tx,
  perms: PermissionService,
  o: LoadControlsOptions,
): Promise<MemberControls | null> {
  const [d] = await tx
    .select({
      id: devices.id,
      ownerUserId: devices.ownerUserId,
      shared: devices.shared,
      shareMaxMode: devices.shareMaxMode,
      revokedAt: devices.revokedAt,
      optIn: devices.fullAccessOptIn,
      catalog: devices.runtimeCatalog,
    })
    .from(devices)
    .where(eq(devices.id, o.deviceId));
  if (!d) return null;
  const policy = o.policy ?? (await loadWorkZonePolicy(tx));
  const access = o.access ?? (await loadDeviceAccess(tx, o.userId));
  const cap = access.capOf(d);
  const revoked = access.revokedOn(d);
  const facts = access.facts(d);
  const grain = await perms.decide(tx, { kind: "user", userId: o.userId }, "device.full_access", facts);
  const catalogs = catalogsOf(d.catalog);
  return {
    ctx: {
      catalog: catalogs.find((c) => c.runtime === o.runtime) ?? null,
      otherCatalogs: catalogs.filter((c) => c.runtime !== o.runtime),
      policy,
      deviceOptIn: d.optIn,
      modeCap: authorModeCap({ cap, revoked, floor: access.floorOf(d) }, o.inSession),
      fullAccessGrain: grain.allowed,
      exposed: (uiKey) => isExposed(o.runtime, uiKey),
      // The member's own computations above are unchanged (`modeCap` stays the sponsor's); the bot's caps come last.
      ...(o.agent ? { agent: o.agent } : {}),
    },
    cap,
    revoked,
    facts,
  };
}
