import { MODULE_CATALOG, type ModuleId, type Permission } from "@ocw/contracts";

/**
 * Module visibility in the web (Phase 07.3, ADR-0024, P-08). Pure: the only input is the API's decision
 * (`/me/permissions`) and the catalog's entry grain. The browser never decides policy; hiding is cosmetic and the API
 * keeps refusing on its own.
 *
 * `loading`: no decision yet (render a skeleton, never the page or the off state).
 * `off`: the entry grain is decided missing (hide the entries, gate the pages).
 * `on`: held, or the fetch failed with no decision at all (a failed cosmetic check never locks a member out).
 */
export type ModuleStatus = "loading" | "on" | "off";

type Decision = { permissions: readonly Permission[] } | undefined;

/** The status of one grain. The last decision wins over a failed refetch after it. */
export function grainStatus(perms: Decision, failed: boolean, permission: Permission): ModuleStatus {
  if (perms) return perms.permissions.includes(permission) ? "on" : "off";
  return failed ? "on" : "loading";
}

/** The status of a module, from its catalog entry grain. */
export function moduleStatus(perms: Decision, failed: boolean, id: ModuleId): ModuleStatus {
  return grainStatus(perms, failed, MODULE_CATALOG[id].entry);
}

/**
 * Drops 1:1 bot DMs (`counterpart.kind === "agent"`) when `showBots` is false; people and groups stay, in order.
 * Callers pass `useModule("bots") !== "off"`, never `can("bot.read")` (false while loading or after a failed fetch).
 */
export function withoutBotDms<T extends { counterpart: { kind: string } }>(
  dms: readonly T[],
  showBots: boolean,
): T[] {
  return showBots ? [...dms] : dms.filter((d) => d.counterpart.kind !== "agent");
}
