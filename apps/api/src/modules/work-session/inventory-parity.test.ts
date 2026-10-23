import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_WORK_ZONE_POLICY,
  DEFERRED_EFFORTS,
  isExposed,
  KNOWN_EFFORTS,
  PermissionMode,
  RUNTIME_CONTROL_INVENTORY,
  type RuntimeCatalog,
  type RuntimeControls,
  type RuntimeId,
} from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { buildRuntimeControls, type ControlsContext } from "./controls";

/**
 * Inventory parity (WZC-06, P-09): the API never offers an option whose inventory row is not `exposed`, even with
 * every other layer wide open (a catalog offering every known capability, the most permissive policy, the device
 * opted in, the owner's cap and the grain). So the UI, which renders only what the controls allow, can never claim
 * an option the inventory has not confirmed.
 */

const RUNTIMES: readonly RuntimeId[] = ["claude-code", "codex"];

/** Every effort a runtime may report: the known ladder plus the deferred multi-agent ones. */
const ALL_EFFORTS = [...KNOWN_EFFORTS, ...DEFERRED_EFFORTS];

/** The inventory row of a deferred effort value (Claude's multi-agent level is Ultracode, Codex's is `ultra`). */
const DEFERRED_EFFORT_KEY: Record<RuntimeId, string> = {
  "claude-code": "effort.ultracode",
  codex: "effort.ultra",
};

function permissiveCatalog(runtime: RuntimeId): RuntimeCatalog {
  return {
    runtime,
    runtimeVersion: null,
    models: [
      {
        id: "every-capability",
        displayName: "Every capability",
        description: null,
        legacy: false,
        isDefault: true,
        badge: "new",
        efforts: ALL_EFFORTS.map((value) => ({ value, description: null })),
        defaultEffort: "medium",
        contextWindows: [200_000, 1_000_000],
        defaultContextWindow: 200_000,
        fastMode: { supported: true, reason: null },
        supportsAutoMode: true,
      },
    ],
    permissionModes: [...PermissionMode.options],
    fastModeCost: null,
    collectedAt: "2026-10-05T00:00:00.000Z",
  };
}

function permissiveContext(runtime: RuntimeId, exposed?: (uiKey: string) => boolean): ControlsContext {
  return {
    catalog: permissiveCatalog(runtime),
    otherCatalogs: [],
    policy: {
      ...DEFAULT_WORK_ZONE_POLICY,
      allowedPermissionModes: ["plan", "default", "acceptEdits", "auto"],
      allowFullAccess: true,
      allowFastMode: true,
    },
    deviceOptIn: true,
    modeCap: "fullAccess",
    fullAccessGrain: true,
    ...(exposed ? { exposed } : {}),
  };
}

interface Offered {
  uiKey: string;
  label: string;
  available: boolean;
  reason: string | null;
}

/** Every option of a controls value with the inventory row it stands for. */
function offered(runtime: RuntimeId, controls: RuntimeControls): Offered[] {
  const out: Offered[] = [];
  for (const m of controls.models) {
    out.push({ uiKey: "model.switch", label: `model ${m.id}`, available: m.available, reason: m.reason });
    for (const e of m.efforts) {
      const uiKey = DEFERRED_EFFORTS.includes(e.value) ? DEFERRED_EFFORT_KEY[runtime] : "effort";
      out.push({ uiKey, label: `effort ${e.value}`, available: e.available, reason: e.reason });
    }
    for (const w of m.contextWindows)
      out.push({
        uiKey: "context.window",
        label: `window ${w.value}`,
        available: w.available,
        reason: w.reason,
      });
    out.push({
      uiKey: "fast.mode",
      label: "fast mode",
      available: m.fastMode.available,
      reason: m.fastMode.reason,
    });
  }
  for (const p of controls.permissionModes)
    out.push({
      uiKey: `mode.${p.value}`,
      label: `mode ${p.value}`,
      available: p.available,
      reason: p.reason,
    });
  return out;
}

const rowOf = (runtime: RuntimeId, uiKey: string) =>
  RUNTIME_CONTROL_INVENTORY.find((r) => r.area === runtime && r.uiKey === uiKey);

describe.each(RUNTIMES)("inventory parity for %s (WZC-06)", (runtime) => {
  const controls = buildRuntimeControls(runtime, permissiveContext(runtime), "every-capability");
  const options = offered(runtime, controls);

  it("every option stands for an inventory row", () => {
    expect(options.length).toBeGreaterThan(10);
    for (const o of options) expect(rowOf(runtime, o.uiKey), `${o.label} → ${o.uiKey}`).toBeDefined();
  });

  it("an available option always has an exposed row", () => {
    for (const o of options.filter((x) => x.available))
      expect(isExposed(runtime, o.uiKey), `${o.label} → ${o.uiKey}`).toBe(true);
  });

  it("every not_confirmed option has a non-exposed row", () => {
    const unconfirmed = options.filter((o) => o.reason === "not_confirmed");
    expect(unconfirmed.length).toBeGreaterThan(0); // the deferred multi-agent effort
    for (const o of unconfirmed) expect(isExposed(runtime, o.uiKey), `${o.label} → ${o.uiKey}`).toBe(false);
  });

  it("every non-exposed row the controls consult is unavailable", () => {
    const consulted = new Set(options.map((o) => o.uiKey));
    const nonExposed = RUNTIME_CONTROL_INVENTORY.filter(
      (r) => r.area === runtime && r.uiKey !== null && r.status !== "exposed" && consulted.has(r.uiKey),
    );
    for (const r of nonExposed)
      for (const o of options.filter((x) => x.uiKey === r.uiKey))
        expect(o.available, `${o.label} (${r.status})`).toBe(false);
  });

  it("with everything else open, only the inventory keeps an option from being offered", () => {
    for (const o of options.filter((x) => !x.available))
      expect(o.reason === "not_confirmed" && !isExposed(runtime, o.uiKey), o.label).toBe(true);
  });

  // The gate does not depend on today's statuses: demoting any row the controls read makes its options unavailable.
  it.each([
    ...new Set(["effort", "context.window", "fast.mode", ...PermissionMode.options.map((m) => `mode.${m}`)]),
  ])("demoting %s to non-exposed withdraws its options", (uiKey) => {
    const demoted = (k: string) => k !== uiKey && isExposed(runtime, k);
    const after = offered(
      runtime,
      buildRuntimeControls(runtime, permissiveContext(runtime, demoted), "every-capability"),
    );
    const affected = after.filter((o) => o.uiKey === uiKey);
    expect(affected.length, uiKey).toBeGreaterThan(0);
    for (const o of affected) expect(o, o.label).toMatchObject({ available: false, reason: "not_confirmed" });
  });
});

/**
 * One builder (Phase 07.9-05, C-01, Pitfall 3): a session resource is built only by `facts.ts`, from the SQL audience
 * facts, so no reader can decide on a session without its audience. A source scan of the API (tests excluded) finds
 * `workSessionResource(` only where it is defined (policy.ts) and in `work-session/facts.ts`.
 */
describe("session facts parity: one builder for every reader (07.9-05)", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
    );
  const sources = files(src).filter((f) => !f.endsWith(".test.ts"));

  it("only work-session/facts.ts builds a session resource", () => {
    const callers = sources
      .filter((f) => /\bworkSessionResource\(/.test(readFileSync(f, "utf8")))
      .map((f) => relative(src, f))
      .sort();
    expect(callers).toEqual(["modules/organization/permissions/policy.ts", "modules/work-session/facts.ts"]);
    expect(readFileSync(join(src, "modules/organization/permissions/policy.ts"), "utf8")).toMatch(
      /export function workSessionResource\(/,
    );
  });

  it("every work-session reader gets its facts from facts.ts (no module copies the audience rule)", () => {
    const moduleFiles = sources.filter((f) => f.includes(join("modules", "work-session")));
    expect(moduleFiles.length).toBeGreaterThan(5);
    for (const f of moduleFiles) {
      if (f.endsWith("facts.ts")) continue;
      expect(readFileSync(f, "utf8"), relative(src, f)).not.toMatch(/work_session_access/);
    }
  });
});
