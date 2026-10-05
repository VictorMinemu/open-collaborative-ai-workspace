import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { DEFERRED_EFFORTS, type PermissionMode, RuntimeCatalog } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { buildClaudeCatalog, CLAUDE_FAST_MODE_COST, type ContextWindowProbe } from "./catalog.js";

const FIXTURE = join(import.meta.dirname, "__fixtures__", "claude-code-2.1.289.catalog.json");
const recorded = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  cliVersion: string;
  models: ModelInfo[];
  contextWindows: Record<string, ContextWindowProbe>;
};
const MODES: PermissionMode[] = ["plan", "default", "acceptEdits", "auto"];

const build = (over: Partial<Parameters<typeof buildClaudeCatalog>[0]> = {}) =>
  buildClaudeCatalog({
    models: recorded.models,
    contextWindows: recorded.contextWindows,
    runtimeVersion: recorded.cliVersion,
    permissionModes: MODES,
    collectedAt: "2026-10-05T12:00:00.000Z",
    ...over,
  });

describe("buildClaudeCatalog — recorded initializationResult + context probe at 2.1.289", () => {
  const catalog = build();
  const byId = new Map(catalog.models.map((m) => [m.id, m]));
  const raw = new Map(recorded.models.map((m) => [m.value, m]));

  it("parses as a RuntimeCatalog for claude-code at the recorded version", () => {
    expect(RuntimeCatalog.parse(catalog)).toEqual(catalog);
    expect(catalog).toMatchObject({ runtime: "claude-code", runtimeVersion: "2.1.289" });
    expect(recorded.models.length).toBeGreaterThanOrEqual(2);
  });

  it("drops the `default` alias and marks the row resolving to the same model as the default", () => {
    expect(byId.has("default")).toBe(false);
    const defaults = catalog.models.filter((m) => m.isDefault);
    expect(defaults).toHaveLength(1);
    const target = raw.get("default")?.resolvedModel;
    const row = raw.get(defaults[0]?.id ?? "");
    expect(target).toBeTruthy();
    expect(row?.value === target || row?.resolvedModel === target).toBe(true);
  });

  it("alias rows are current, explicit claude-* versions are legacy", () => {
    for (const m of catalog.models) expect(m.legacy).toBe(m.id.startsWith("claude-"));
    for (const alias of ["opus", "sonnet", "haiku"]) {
      if (byId.has(alias)) expect(byId.get(alias)?.legacy).toBe(false);
    }
  });

  it("never invents a NEW badge (D-08)", () => {
    for (const m of catalog.models) expect(m.badge).toBeNull();
  });

  it("efforts are the reported levels minus the deferred ones, with no invented default (D-09)", () => {
    for (const m of catalog.models) {
      const info = raw.get(m.id);
      const expected = info?.supportsEffort
        ? (info.supportedEffortLevels ?? []).filter((e) => !DEFERRED_EFFORTS.includes(e))
        : [];
      expect(m.efforts.map((e) => e.value)).toEqual(expected);
      expect(m.defaultEffort).toBeNull();
    }
    const noEffort = recorded.models.find((m) => m.value !== "default" && !m.supportsEffort);
    if (noEffort) expect(byId.get(noEffort.value)?.efforts).toEqual([]);
  });

  it("offers 200k/1M only where the probe accepted both; elsewhere the probed base is fixed (D-10)", () => {
    for (const m of catalog.models) {
      const probe = recorded.contextWindows[m.id];
      if (probe?.oneM && probe.base !== null && probe.base < 1_000_000) {
        expect(m.contextWindows).toEqual([probe.base, 1_000_000]);
      } else {
        expect(m.contextWindows).toEqual([]);
      }
      expect(m.defaultContextWindow).toBe(probe?.base ?? null);
    }
  });

  it("fast mode and auto mode mirror the runtime flags; the cost note names paid usage credits (D-11)", () => {
    for (const m of catalog.models) {
      const info = raw.get(m.id);
      expect(m.fastMode).toEqual({ supported: info?.supportsFastMode === true, reason: null });
      expect(m.supportsAutoMode).toBe(info?.supportsAutoMode === true);
    }
    expect(catalog.fastModeCost).toBe(CLAUDE_FAST_MODE_COST);
    expect(CLAUDE_FAST_MODE_COST).toMatch(/paid usage credits/);
    expect(catalog.permissionModes).toEqual(MODES);
  });
});

describe("buildClaudeCatalog — hand-written edges", () => {
  it("trims names and descriptions to the contract bounds and survives an empty probe", () => {
    const catalog = buildClaudeCatalog({
      models: [
        { value: "x", displayName: "  X  ", description: "d".repeat(900), supportsEffort: false },
        { value: "y", displayName: "", description: "" },
      ],
      contextWindows: {},
      runtimeVersion: null,
      permissionModes: ["default"],
      collectedAt: "2026-10-05T12:00:00.000Z",
    });
    expect(RuntimeCatalog.parse(catalog).models).toHaveLength(2);
    expect(catalog.models[0]).toMatchObject({ displayName: "X", isDefault: false, contextWindows: [] });
    expect(catalog.models[0]?.description).toHaveLength(500);
    expect(catalog.models[1]).toMatchObject({ displayName: "y", description: null, defaultContextWindow: null });
  });
});
