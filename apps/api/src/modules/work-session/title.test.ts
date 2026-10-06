import {
  DEFAULT_WORK_ZONE_POLICY,
  type RuntimeCatalog,
  type RuntimeId,
  type RuntimeModel,
  type WorkZonePolicy,
} from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { decideTitleRequest, heuristicTitle } from "./title";

/** The automatic title gate (PURE, Phase 03.2 Plan 12, D-18, D-19, P-18). */

const model = (id: string): RuntimeModel => ({
  id,
  displayName: id,
  description: null,
  legacy: false,
  isDefault: false,
  badge: null,
  efforts: [{ value: "low", description: null }],
  defaultEffort: "low",
  contextWindows: [],
  defaultContextWindow: null,
  fastMode: { supported: false, reason: null },
  supportsAutoMode: false,
});

const catalog = (runtime: RuntimeId, ids: string[]): RuntimeCatalog => ({
  runtime,
  runtimeVersion: "1",
  models: ids.map(model),
  permissionModes: ["default"],
  fastModeCost: null,
  collectedAt: "2026-10-05T00:00:00.000Z",
});

const policy = (allowed: Partial<WorkZonePolicy["allowedModels"]> = {}): WorkZonePolicy => ({
  ...DEFAULT_WORK_ZONE_POLICY,
  updatedAt: null,
  allowedModels: { ...DEFAULT_WORK_ZONE_POLICY.allowedModels, ...allowed },
});

describe("decideTitleRequest", () => {
  it("asks Claude Code for haiku when the catalog lists it and the policy allows any model", () => {
    expect(
      decideTitleRequest({
        runtime: "claude-code",
        catalog: catalog("claude-code", ["opus", "sonnet", "haiku"]),
        policy: policy(),
      }),
    ).toEqual({ ok: true, model: "haiku" });
  });

  it("asks Codex for gpt-6-luna", () => {
    expect(
      decideTitleRequest({
        runtime: "codex",
        catalog: catalog("codex", ["gpt-6.1-sol", "gpt-6-luna"]),
        policy: policy(),
      }),
    ).toEqual({ ok: true, model: "gpt-6-luna" });
  });

  it("skips when the device catalog is missing or lacks the small model", () => {
    expect(decideTitleRequest({ runtime: "claude-code", catalog: null, policy: policy() })).toEqual({
      ok: false,
      reason: "not_in_catalog",
    });
    expect(
      decideTitleRequest({ runtime: "codex", catalog: catalog("codex", ["gpt-5.5"]), policy: policy() }),
    ).toEqual({ ok: false, reason: "not_in_catalog" });
  });

  it("skips when the org policy restricts the runtime's models and leaves the small model out", () => {
    expect(
      decideTitleRequest({
        runtime: "claude-code",
        catalog: catalog("claude-code", ["opus", "sonnet", "haiku"]),
        policy: policy({ "claude-code": ["opus", "sonnet"] }),
      }),
    ).toEqual({ ok: false, reason: "org_policy" });
    expect(
      decideTitleRequest({
        runtime: "claude-code",
        catalog: catalog("claude-code", ["haiku"]),
        policy: policy({ "claude-code": ["haiku"] }),
      }),
    ).toEqual({ ok: true, model: "haiku" });
  });
});

describe("heuristicTitle (the first-line rule, unchanged)", () => {
  it("takes the first non-empty line", () => {
    expect(heuristicTitle("\n  Fix the login  \nmore")).toBe("Fix the login");
    expect(heuristicTitle(undefined)).toBeUndefined();
    expect(heuristicTitle("  \n ")).toBeUndefined();
  });

  it("keeps up to 80 characters and cuts longer lines to 77 + …", () => {
    expect(heuristicTitle("a".repeat(80))).toBe("a".repeat(80));
    expect(heuristicTitle("a".repeat(81))).toBe(`${"a".repeat(77)}…`);
  });
});
