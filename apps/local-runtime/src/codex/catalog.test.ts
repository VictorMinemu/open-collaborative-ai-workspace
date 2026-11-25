import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RuntimeCatalog } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { buildCodexCatalog, CODEX_FAST_MODE_COST } from "./catalog.js";
import type { Model } from "./generated/v2/Model.js";
import type { ModelListResponse } from "./generated/v2/ModelListResponse.js";

const recorded = JSON.parse(
  readFileSync(join(import.meta.dirname, "__fixtures__", "codex-0.160.0.model-list.json"), "utf8"),
) as ModelListResponse;

const MODES = ["plan", "default", "acceptEdits", "auto"] as const;
const build = (models: Model[]) =>
  buildCodexCatalog({
    models,
    runtimeVersion: "0.160.0",
    permissionModes: [...MODES],
    collectedAt: "2026-10-05T12:00:00.000Z",
  });

const base = recorded.data[0] as Model;
const synthetic = (over: Partial<Model>): Model => ({ ...base, ...over });

describe("buildCodexCatalog — over model/list recorded at codex-cli 0.160.0", () => {
  const catalog = build(recorded.data);
  const byId = new Map(catalog.models.map((m) => [m.id, m]));

  it("parses as a RuntimeCatalog for codex with the adapter's modes and the 2.5x cost note", () => {
    expect(RuntimeCatalog.parse(catalog)).toEqual(catalog);
    expect(catalog.runtime).toBe("codex");
    expect(catalog.runtimeVersion).toBe("0.160.0");
    expect(catalog.permissionModes).toEqual([...MODES]);
    expect(catalog.fastModeCost).toBe(CODEX_FAST_MODE_COST);
    expect(catalog.fastModeCost).toContain("2.5x");
    expect(catalog.models.map((m) => m.id)).toEqual(recorded.data.filter((m) => !m.hidden).map((m) => m.id));
  });

  it("isDefault mirrors the runtime; the NEW badge comes only from availabilityNux", () => {
    for (const m of recorded.data) {
      expect(byId.get(m.id)?.isDefault).toBe(m.isDefault);
      expect(byId.get(m.id)?.badge).toBe(m.availabilityNux ? "new" : null);
    }
    expect(catalog.models.filter((m) => m.isDefault)).toHaveLength(1);
  });

  it("efforts = supportedReasoningEfforts minus ultra, with descriptions; defaultEffort from the runtime", () => {
    for (const m of recorded.data) {
      const row = byId.get(m.id);
      expect(row?.efforts).toEqual(
        m.supportedReasoningEfforts
          .filter((e) => e.reasoningEffort !== "ultra")
          .map((e) => ({ value: e.reasoningEffort, description: e.description || null })),
      );
      expect(row?.efforts.map((e) => e.value)).not.toContain("ultra");
      expect(row?.defaultEffort).toBe(m.defaultReasoningEffort);
    }
  });

  it("context window is display only: no selectable windows for any model (D-10)", () => {
    for (const m of catalog.models) {
      expect(m.contextWindows).toEqual([]);
      expect(m.defaultContextWindow).toBeNull();
    }
  });

  it("fast mode only where the model lists the priority tier; ultrafast is never offered", () => {
    for (const m of recorded.data) {
      expect(byId.get(m.id)?.fastMode.supported).toBe(m.serviceTiers.some((t) => t.id === "priority"));
    }
    expect(JSON.stringify(catalog)).not.toContain("ultrafast");
    // The recording has a model without tiers (Daybreak): fast mode is not supported there.
    expect(catalog.models.some((m) => !m.fastMode.supported)).toBe(true);
  });

  it("every recorded model reads images: imageInput from inputModalities (06.1, P-08)", () => {
    expect(recorded.data.every((m) => m.inputModalities.includes("image"))).toBe(true);
    for (const m of catalog.models) expect(m.imageInput).toBe(true);
  });
});

/**
 * The pinned codex-cli 0.172.0, recorded OFFLINE (07.13-25, PD-29): `initialize` + `model/list` of the real binary
 * with a throwaway CODEX_HOME and the fake model as its provider (`record-codex-fixture.ts --offline --scenario
 * model-list`, no turn). With no ChatGPT account the list is the binary's bundled catalog: no Daybreak row, no
 * `ultrafast` tier, every model on the priority tier.
 */
describe("buildCodexCatalog — over model/list recorded offline at codex-cli 0.172.0", () => {
  const rec = JSON.parse(
    readFileSync(join(import.meta.dirname, "__fixtures__", "codex-0.172.0.model-list.json"), "utf8"),
  ) as ModelListResponse;
  const catalog = buildCodexCatalog({
    models: rec.data,
    runtimeVersion: "0.172.0",
    permissionModes: [...MODES],
    collectedAt: "2026-11-25T12:00:00.000Z",
  });
  const byId = new Map(catalog.models.map((m) => [m.id, m]));

  it("parses as a RuntimeCatalog with the same rules as 0.160.0", () => {
    expect(RuntimeCatalog.parse(catalog)).toEqual(catalog);
    expect(catalog.runtimeVersion).toBe("0.172.0");
    expect(catalog.models.map((m) => m.id)).toEqual(rec.data.filter((m) => !m.hidden).map((m) => m.id));
    expect(catalog.models.filter((m) => m.isDefault)).toHaveLength(1);
    expect(byId.get("gpt-6-luna")).toBeDefined();
    for (const m of rec.data) {
      const row = byId.get(m.id);
      expect(row?.efforts.map((e) => e.value)).toEqual(
        m.supportedReasoningEfforts.map((e) => e.reasoningEffort).filter((e) => e !== "ultra"),
      );
      expect(row?.fastMode.supported).toBe(m.serviceTiers.some((t) => t.id === "priority"));
      expect(row?.imageInput).toBe(m.inputModalities.includes("image"));
      expect(row?.contextWindows).toEqual([]);
    }
    expect(JSON.stringify(catalog)).not.toContain("ultrafast");
  });
});

describe("buildCodexCatalog — rows the recording does not have", () => {
  it("excludes hidden models and marks upgradable ones as legacy", () => {
    const catalog = build([
      synthetic({ id: "visible", upgrade: null, hidden: false }),
      synthetic({ id: "secret", hidden: true, isDefault: false }),
      synthetic({ id: "old", upgrade: "visible", isDefault: false, availabilityNux: null }),
    ]);
    expect(catalog.models.map((m) => m.id)).toEqual(["visible", "old"]);
    expect(catalog.models.find((m) => m.id === "old")?.legacy).toBe(true);
    expect(catalog.models.find((m) => m.id === "visible")?.legacy).toBe(false);
  });

  it("a text-only model reports imageInput false (06.1, P-08)", () => {
    const models = build([
      synthetic({ id: "text-only", inputModalities: ["text"] }),
      synthetic({ id: "with-audio", inputModalities: ["text", "audio"], isDefault: false }),
      synthetic({ id: "vision", inputModalities: ["text", "image"], isDefault: false }),
    ]).models;
    expect(models.map((m) => [m.id, m.imageInput])).toEqual([
      ["text-only", false],
      ["with-audio", false],
      ["vision", true],
    ]);
    expect(
      RuntimeCatalog.parse(build([synthetic({ inputModalities: ["text"] })])).models[0]?.imageInput,
    ).toBe(false);
  });

  it("a default effort the platform does not offer (ultra) becomes null", () => {
    const [m] = build([synthetic({ defaultReasoningEffort: "ultra" })]).models;
    expect(m?.defaultEffort).toBeNull();
  });
});
