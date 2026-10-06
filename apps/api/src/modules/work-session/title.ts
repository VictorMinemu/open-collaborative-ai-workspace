import { type RuntimeCatalog, type RuntimeId, TITLE_MODEL, type WorkZonePolicy } from "@ocw/contracts";
import { devices, type Tx } from "@ocw/db";
import { eq } from "drizzle-orm";
import { catalogFor } from "./controls";
import { loadWorkZonePolicy } from "./policy";

/**
 * Automatic session titles on the API side (Phase 03.2 Plan 12, D-18, D-19, P-18, ADR-0014): the first-line
 * fallback and the gate that decides whether the session's device is asked for a title.
 */

/** The prompt's first non-empty line, 80 characters at most (77 + "…" beyond): today's title rule and fallback. */
export function heuristicTitle(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const line = prompt
    .split("\n")
    .find((l) => l.trim())
    ?.trim();
  if (!line) return undefined;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

export type TitleDecision =
  | { ok: true; model: string }
  | { ok: false; reason: "not_in_catalog" | "org_policy" | "not_confirmed" };

/**
 * Ask for a title only with the session runtime's own small model, when the device reports it and the org
 * Work Zone policy allows it (an empty `allowedModels` list = any model). Never a hard-coded availability.
 */
export function decideTitleRequest(i: {
  runtime: RuntimeId;
  catalog: RuntimeCatalog | null;
  policy: WorkZonePolicy;
}): TitleDecision {
  const model = TITLE_MODEL[i.runtime];
  if (!i.catalog?.models.some((m) => m.id === model)) return { ok: false, reason: "not_in_catalog" };
  const allowed = i.policy.allowedModels[i.runtime];
  if (allowed.length > 0 && !allowed.includes(model)) return { ok: false, reason: "org_policy" };
  return { ok: true, model };
}

/** The decision inputs for a session's device and runtime (inside the caller's tenant transaction). */
export async function loadTitleContext(
  tx: Tx,
  deviceId: string,
  runtime: RuntimeId,
): Promise<{ catalog: RuntimeCatalog | null; policy: WorkZonePolicy }> {
  const [d] = await tx
    .select({ runtimeCatalog: devices.runtimeCatalog })
    .from(devices)
    .where(eq(devices.id, deviceId));
  return { catalog: catalogFor(d?.runtimeCatalog, runtime), policy: await loadWorkZonePolicy(tx) };
}
