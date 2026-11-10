import {
  DEFAULT_WORK_ZONE_POLICY,
  type PermissionMode,
  type RuntimeCatalog,
  type RuntimeModel,
} from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import type { AgentControlsLayer } from "./context";
import {
  buildRuntimeControls,
  CONTROLLER_FLOOR,
  type ControlsContext,
  clampToControls,
  decideSettings,
  highestAvailableMode,
  turnMode,
} from "./controls";

/** The controls intersection as a truth table (PURE, Phase 03.2 Plan 04, D-02, P-03, P-06 … P-08, WZC-06). */

const model = (id: string, extra: Partial<RuntimeModel> = {}): RuntimeModel => ({
  id,
  displayName: id.toUpperCase(),
  description: null,
  legacy: false,
  isDefault: false,
  badge: null,
  efforts: ["low", "medium", "high", "xhigh"].map((value) => ({ value, description: null })),
  defaultEffort: "medium",
  contextWindows: [200_000, 1_000_000],
  defaultContextWindow: 200_000,
  fastMode: { supported: true, reason: null },
  supportsAutoMode: true,
  ...extra,
});

const CATALOG: RuntimeCatalog = {
  runtime: "codex",
  runtimeVersion: "0.160.0",
  models: [
    model("big", { isDefault: true }),
    model("small", {
      efforts: [{ value: "low", description: null }],
      contextWindows: [],
      defaultContextWindow: 400_000,
      fastMode: { supported: false, reason: "model_not_allowed" },
      supportsAutoMode: false,
    }),
  ],
  permissionModes: ["plan", "default", "acceptEdits", "auto", "fullAccess"],
  fastModeCost: null,
  collectedAt: "2026-10-05T00:00:00.000Z",
};

/** Everything allowed; each test removes one input. */
function ctx(extra: Partial<ControlsContext> = {}): ControlsContext {
  return {
    catalog: CATALOG,
    otherCatalogs: [],
    policy: { ...DEFAULT_WORK_ZONE_POLICY, allowFullAccess: true, allowFastMode: true },
    deviceOptIn: true,
    modeCap: "fullAccess",
    fullAccessGrain: true,
    exposed: () => true,
    ...extra,
  };
}

const mode = (c: ControlsContext, m: PermissionMode, modelId: string | null = "big") =>
  buildRuntimeControls("codex", c, modelId).permissionModes.find((x) => x.value === m)!;

describe("Full access precedence (D-02)", () => {
  it("is available only when policy, opt-in, cap, grain and runtime all hold", () => {
    expect(mode(ctx(), "fullAccess")).toMatchObject({ available: true, reason: null });
  });

  it("org_policy first", () => {
    const c = ctx({
      policy: { ...ctx().policy, allowFullAccess: false },
      deviceOptIn: false,
      modeCap: "default",
      fullAccessGrain: false,
      catalog: { ...CATALOG, permissionModes: ["default"] },
      exposed: () => false,
    });
    expect(mode(c, "fullAccess")).toMatchObject({ available: false, reason: "org_policy" });
  });

  it("then device_opt_in", () => {
    const c = ctx({ deviceOptIn: false, modeCap: "default", fullAccessGrain: false });
    expect(mode(c, "fullAccess")).toMatchObject({ available: false, reason: "device_opt_in" });
  });

  it("then device_grant when the cap is below fullAccess", () => {
    const c = ctx({ modeCap: "auto", fullAccessGrain: false });
    expect(mode(c, "fullAccess")).toMatchObject({ available: false, reason: "device_grant" });
    expect(mode(ctx({ modeCap: null }), "fullAccess")).toMatchObject({ reason: "device_grant" });
  });

  it("then denied_for_you when the grain is false", () => {
    const c = ctx({ fullAccessGrain: false, catalog: { ...CATALOG, permissionModes: ["default"] } });
    expect(mode(c, "fullAccess")).toMatchObject({ available: false, reason: "denied_for_you" });
  });

  it("then runtime when the catalog lacks it", () => {
    const c = ctx({ catalog: { ...CATALOG, permissionModes: ["default", "acceptEdits"] } });
    expect(mode(c, "fullAccess")).toMatchObject({ available: false, reason: "runtime" });
  });

  it("then not_confirmed when the inventory row is not exposed", () => {
    const c = ctx({ exposed: (k) => k !== "mode.fullAccess" });
    expect(mode(c, "fullAccess")).toMatchObject({ available: false, reason: "not_confirmed" });
  });
});

describe("other modes", () => {
  it("acceptEdits above a default cap → device_grant", () => {
    expect(mode(ctx({ modeCap: "default" }), "acceptEdits")).toMatchObject({ reason: "device_grant" });
    expect(mode(ctx({ modeCap: "default" }), "default")).toMatchObject({ available: true });
  });

  it("auto on a model without Auto → runtime", () => {
    expect(mode(ctx(), "auto", "small")).toMatchObject({ available: false, reason: "runtime" });
  });

  it("auto not exposed → not_confirmed even when everything else allows it; a policy refusal still wins", () => {
    const hidden = ctx({ exposed: (k) => k !== "mode.auto" });
    expect(mode(hidden, "auto")).toMatchObject({ available: false, reason: "not_confirmed" });
    const denied = ctx({
      exposed: (k) => k !== "mode.auto",
      policy: { ...ctx().policy, allowedPermissionModes: ["plan", "default"] },
    });
    expect(mode(denied, "auto")).toMatchObject({ available: false, reason: "org_policy" });
  });

  it("an unexposed option is unavailable whatever the other inputs say", () => {
    const c = ctx({ exposed: () => false });
    const controls = buildRuntimeControls("codex", c, "big");
    for (const m of controls.permissionModes) expect(m.available, m.value).toBe(false);
    const big = controls.models.find((m) => m.id === "big")!;
    expect(big.efforts.every((e) => !e.available && e.reason === "not_confirmed")).toBe(true);
    expect(big.contextWindows.every((w) => !w.available && w.reason === "not_confirmed")).toBe(true);
    expect(big.fastMode).toMatchObject({ available: false, reason: "not_confirmed" });
  });
});

describe("decideSettings", () => {
  const current = {
    model: "big",
    effort: "xhigh",
    contextWindow: null,
    fastMode: false,
    permissionMode: "default" as const,
  };

  it("switching to a model without xhigh drops the effort and reports it in adjusted", () => {
    const d = decideSettings(current, { model: "small" }, "codex", ctx());
    expect(d).toMatchObject({ ok: true, changed: ["model"], adjusted: ["effort"] });
    if (d.ok) expect(d.next.effort).toBeNull();
  });

  it("a 1M context window on a model with no 1M → not_in_catalog", () => {
    const d = decideSettings(
      { ...current, model: "small", effort: null },
      { contextWindow: 1_000_000 },
      "codex",
      ctx(),
    );
    expect(d).toEqual({ ok: false, field: "contextWindow", reason: "not_in_catalog" });
  });

  it("a context window that is not confirmed → not_confirmed", () => {
    const d = decideSettings(
      current,
      { contextWindow: 1_000_000 },
      "codex",
      ctx({ exposed: (k) => k !== "context.window" }),
    );
    expect(d).toEqual({ ok: false, field: "contextWindow", reason: "not_confirmed" });
  });

  it("fast mode with the policy on but the model unsupported → runtime, with the runtime reason as detail", () => {
    const c = ctx();
    const small = buildRuntimeControls("codex", c, "small").models.find((m) => m.id === "small")!;
    expect(small.fastMode).toMatchObject({
      available: false,
      reason: "runtime",
      detail: "model_not_allowed",
    });
    const d = decideSettings({ ...current, model: "small", effort: null }, { fastMode: true }, "codex", c);
    expect(d).toEqual({ ok: false, field: "fastMode", reason: "runtime" });
  });

  it("an effort that is not confirmed → not_confirmed", () => {
    const d = decideSettings(current, { effort: "low" }, "codex", ctx({ exposed: (k) => k !== "effort" }));
    expect(d).toEqual({ ok: false, field: "effort", reason: "not_confirmed" });
  });

  it("full access passes only with every input", () => {
    expect(decideSettings(current, { permissionMode: "fullAccess" }, "codex", ctx()).ok).toBe(true);
    expect(
      decideSettings(current, { permissionMode: "fullAccess" }, "codex", ctx({ fullAccessGrain: false })),
    ).toEqual({ ok: false, field: "permissionMode", reason: "denied_for_you" });
  });
});

describe("per-turn mode (P-07)", () => {
  it("the controller floor is acceptEdits", () => {
    expect(CONTROLLER_FLOOR).toBe("acceptEdits");
  });

  it("highestAvailableMode is the author's highest available mode, optionally at or below a ceiling", () => {
    expect(highestAvailableMode(ctx())).toBe("fullAccess");
    expect(highestAvailableMode(ctx({ fullAccessGrain: false }))).toBe("auto");
    expect(highestAvailableMode(ctx({ modeCap: "acceptEdits" }), "big", "fullAccess")).toBe("acceptEdits");
    expect(highestAvailableMode(ctx({ modeCap: "acceptEdits" }), "big", "default")).toBe("default");
    expect(highestAvailableMode(ctx({ modeCap: null }))).toBeNull();
    // auto is model-bound.
    expect(highestAvailableMode(ctx({ fullAccessGrain: false }), "small")).toBe("acceptEdits");
  });

  it("skips modes the policy left out (non-contiguous policies never yield a disallowed mode)", () => {
    const c = ctx({ policy: { ...ctx().policy, allowedPermissionModes: ["plan", "acceptEdits"] } });
    expect(highestAvailableMode(c, "big", "default")).toBe("plan");
  });

  it("turnMode is min(session mode, author cap); a null cap refuses the turn", () => {
    expect(turnMode("fullAccess", "acceptEdits")).toBe("acceptEdits");
    expect(turnMode("default", "fullAccess")).toBe("default");
    expect(turnMode("fullAccess", "fullAccess")).toBe("fullAccess");
    expect(turnMode("plan", null)).toBeNull();
  });
});

describe("clampToControls", () => {
  it("lowers a requested patch to what is available", () => {
    const c = ctx({ policy: { ...ctx().policy, allowFullAccess: false, allowFastMode: false } });
    const controls = buildRuntimeControls("codex", c, "big");
    const { next, changed } = clampToControls(
      {
        model: "big",
        effort: "high",
        contextWindow: 1_000_000,
        fastMode: true,
        permissionMode: "fullAccess",
      },
      controls,
    );
    expect(next).toMatchObject({
      permissionMode: "auto",
      fastMode: false,
      effort: "high",
      contextWindow: 1_000_000,
    });
    expect(changed.sort()).toEqual(["fastMode", "permissionMode"]);
  });

  it("an unavailable model falls back to the catalog default; its efforts follow", () => {
    const c = ctx({
      policy: { ...ctx().policy, allowedModels: { "claude-code": [], codex: ["big"] } },
    });
    const controls = buildRuntimeControls("codex", c, "small");
    const { next, changed } = clampToControls(
      { model: "small", effort: "low", contextWindow: null, fastMode: false, permissionMode: "default" },
      controls,
    );
    expect(next.model).toBe("big");
    expect(changed).toEqual(["model"]);
  });

  it("an effort above the policy cap or not confirmed becomes the default", () => {
    const c = ctx({ policy: { ...ctx().policy, maxEffort: { "claude-code": null, codex: "medium" } } });
    const { next, changed } = clampToControls(
      { model: "big", effort: "xhigh", contextWindow: null, fastMode: false, permissionMode: "default" },
      buildRuntimeControls("codex", c, "big"),
    );
    expect(next.effort).toBeNull();
    expect(changed).toEqual(["effort"]);
  });

  it("a mode is never raised: with nothing available below it, it stays (turns are refused at dispatch)", () => {
    const c = ctx({ policy: { ...ctx().policy, allowedPermissionModes: ["acceptEdits"] } });
    const { next, changed } = clampToControls(
      { model: "big", effort: null, contextWindow: null, fastMode: false, permissionMode: "plan" },
      buildRuntimeControls("codex", c, "big"),
    );
    expect(next.permissionMode).toBe("plan");
    expect(changed).toEqual([]);
  });

  it("nothing to lower → no change", () => {
    const { changed } = clampToControls(
      { model: "big", effort: "low", contextWindow: null, fastMode: false, permissionMode: "default" },
      buildRuntimeControls("codex", ctx(), "big"),
    );
    expect(changed).toEqual([]);
  });
});

describe("07.16 agent layer (PD-07, PD-08)", () => {
  /** A bot whose profile allows everything the catalog offers; each test narrows one cap. */
  const open: AgentControlsLayer = {
    agentId: "00000000-0000-4000-8000-000000000001",
    maxMode: "fullAccess",
    allowFullAccess: true,
    tainted: false,
    isolated: false,
    models: ["big", "small"],
    efforts: ["low", "medium", "high", "xhigh"],
    contextWindows: [200_000, 1_000_000],
    fastMode: "allowed",
  };
  const bot = (over: Partial<AgentControlsLayer> = {}, extra: Partial<ControlsContext> = {}) =>
    ctx({ agent: { ...open, ...over }, ...extra });
  const big = (c: ControlsContext) =>
    buildRuntimeControls("codex", c, "big").models.find((m) => m.id === "big")!;
  const current = {
    model: "big",
    effort: null,
    contextWindow: null,
    fastMode: false,
    permissionMode: "default" as const,
  };

  it("a profile that allows everything changes nothing", () => {
    expect(buildRuntimeControls("codex", bot(), "big")).toEqual(buildRuntimeControls("codex", ctx(), "big"));
    expect(highestAvailableMode(bot())).toBe("fullAccess");
  });

  it("modes above maxMode report bot_profile; the highest available mode and the turn mode stay at or below it", () => {
    const c = bot({ maxMode: "plan" });
    for (const m of ["default", "acceptEdits", "auto", "fullAccess"] as const) {
      expect(mode(c, m), m).toMatchObject({ available: false, reason: "bot_profile" });
    }
    expect(mode(c, "plan")).toMatchObject({ available: true, reason: null });
    const cap = highestAvailableMode(c, "big", "fullAccess");
    expect(cap).toBe("plan");
    expect(turnMode("fullAccess", cap)).toBe("plan");
    expect(highestAvailableMode(bot({ maxMode: "acceptEdits" }), "big", "fullAccess")).toBe("acceptEdits");
  });

  it("Full access needs the per-bot consent", () => {
    expect(mode(bot({ allowFullAccess: false }), "fullAccess")).toMatchObject({
      available: false,
      reason: "bot_profile",
    });
    expect(highestAvailableMode(bot({ allowFullAccess: false }))).toBe("auto");
  });

  it("Full access after outside content only on an isolated server (D-08)", () => {
    expect(mode(bot({ tainted: true, isolated: false }), "fullAccess")).toMatchObject({
      available: false,
      reason: "bot_profile",
    });
    expect(mode(bot({ tainted: true, isolated: true }), "fullAccess")).toMatchObject({
      available: true,
      reason: null,
    });
    expect(mode(bot({ tainted: false, isolated: true }), "fullAccess")).toMatchObject({ available: true });
    // A tainted bot keeps every mode below Full access.
    expect(mode(bot({ tainted: true }), "auto")).toMatchObject({ available: true });
  });

  it("a member's own limit keeps its reason (org_policy, device_opt_in, device_grant, denied_for_you)", () => {
    const capped = { allowFullAccess: false, tainted: true, maxMode: "plan" as const };
    expect(
      mode(bot(capped, { policy: { ...ctx().policy, allowFullAccess: false } }), "fullAccess"),
    ).toMatchObject({ reason: "org_policy" });
    expect(mode(bot(capped, { deviceOptIn: false }), "fullAccess")).toMatchObject({
      reason: "device_opt_in",
    });
    expect(mode(bot(capped, { modeCap: "acceptEdits" }), "fullAccess")).toMatchObject({
      reason: "device_grant",
    });
    expect(mode(bot(capped, { fullAccessGrain: false }), "fullAccess")).toMatchObject({
      reason: "denied_for_you",
    });
    expect(mode(bot(capped, { exposed: (k) => k !== "mode.auto" }), "auto")).toMatchObject({
      reason: "not_confirmed",
    });
  });

  it("a catalog model outside the profile's set reports bot_profile; inside it is as without the agent", () => {
    const c = bot({ models: ["big"] });
    const models = buildRuntimeControls("codex", c, "big").models;
    expect(models.find((m) => m.id === "small")).toMatchObject({ available: false, reason: "bot_profile" });
    expect(models.find((m) => m.id === "big")).toEqual(big(ctx()));
    expect(decideSettings(current, { model: "small" }, "codex", c)).toEqual({
      ok: false,
      field: "model",
      reason: "bot_profile",
    });
    // A listed model the device did not report is not in the catalog (the device decides first).
    expect(decideSettings(current, { model: "ghost" }, "codex", bot({ models: ["big", "ghost"] }))).toEqual({
      ok: false,
      field: "model",
      reason: "not_in_catalog",
    });
    // The org policy's model list keeps its reason.
    const policy = { ...ctx().policy, allowedModels: { "claude-code": [], codex: ["small"] } };
    expect(big(bot({ models: ["small"] }, { policy }))).toMatchObject({
      available: false,
      reason: "org_policy",
    });
  });

  it("efforts outside the profile's set report bot_profile; an effort above the org maxEffort stays org_policy", () => {
    const c = bot({ efforts: ["low", "medium"] });
    const efforts = big(c).efforts;
    expect(efforts.filter((e) => e.available).map((e) => e.value)).toEqual(["low", "medium"]);
    expect(efforts.find((e) => e.value === "high")).toMatchObject({
      available: false,
      reason: "bot_profile",
    });
    expect(decideSettings(current, { effort: "high" }, "codex", c)).toEqual({
      ok: false,
      field: "effort",
      reason: "bot_profile",
    });
    const policy = { ...ctx().policy, maxEffort: { "claude-code": null, codex: "medium" as const } };
    expect(big(bot({ efforts: ["low"] }, { policy })).efforts.find((e) => e.value === "xhigh")).toMatchObject(
      {
        available: false,
        reason: "org_policy",
      },
    );
    expect(big(bot({ efforts: ["low"] }, { exposed: (k) => k !== "effort" })).efforts[0]).toMatchObject({
      reason: "not_confirmed",
    });
  });

  it("context windows outside the profile's set report bot_profile", () => {
    const c = bot({ contextWindows: [200_000] });
    expect(big(c).contextWindows).toEqual([
      { available: true, reason: null, detail: null, value: 200_000 },
      { available: false, reason: "bot_profile", detail: null, value: 1_000_000 },
    ]);
    expect(decideSettings(current, { contextWindow: 1_000_000 }, "codex", c)).toEqual({
      ok: false,
      field: "contextWindow",
      reason: "bot_profile",
    });
    const unconfirmed = bot({ contextWindows: [] }, { exposed: (k) => k !== "context.window" });
    expect(big(unconfirmed).contextWindows.every((w) => w.reason === "not_confirmed")).toBe(true);
  });

  it("fast mode off in the profile reports bot_profile; allowed and on are as without the agent", () => {
    expect(big(bot({ fastMode: "off" })).fastMode).toMatchObject({ available: false, reason: "bot_profile" });
    expect(decideSettings(current, { fastMode: true }, "codex", bot({ fastMode: "off" }))).toEqual({
      ok: false,
      field: "fastMode",
      reason: "bot_profile",
    });
    expect(big(bot({ fastMode: "allowed" })).fastMode).toEqual(big(ctx()).fastMode);
    expect(big(bot({ fastMode: "on" })).fastMode).toEqual(big(ctx()).fastMode);
    // The org policy and the runtime keep their reasons.
    const noFast = { policy: { ...ctx().policy, allowFastMode: false } };
    expect(big(bot({ fastMode: "off" }, noFast)).fastMode).toMatchObject({ reason: "org_policy" });
    const small = buildRuntimeControls("codex", bot({ fastMode: "off" }), "small").models.find(
      (m) => m.id === "small",
    )!;
    expect(small.fastMode).toMatchObject({ reason: "runtime" });
  });

  it("clampToControls lowers a session to the bot's caps (re-authorization reads the same context)", () => {
    const c = bot({ maxMode: "acceptEdits", models: ["big"], efforts: ["low"], fastMode: "off" });
    const { next, changed } = clampToControls(
      { model: "small", effort: "high", contextWindow: null, fastMode: true, permissionMode: "fullAccess" },
      buildRuntimeControls("codex", c, "small"),
    );
    expect(next).toMatchObject({
      model: "big",
      effort: null,
      fastMode: false,
      permissionMode: "acceptEdits",
    });
    expect(changed.sort()).toEqual(["effort", "fastMode", "model", "permissionMode"]);
  });
});
