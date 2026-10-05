import { describe, expect, it } from "vitest";
import {
  controlStatus,
  isExposed,
  PINNED_RUNTIME_VERSIONS,
  RUNTIME_CONTROL_INVENTORY,
  RuntimeControlArea,
  RuntimeControlStatus,
} from "../index";

const rows = (area: string) => RUNTIME_CONTROL_INVENTORY.filter((r) => r.area === area);
const controls = (area: string) => rows(area).map((r) => r.control.toLowerCase());
const has = (area: string, needle: string) => controls(area).some((c) => c.includes(needle.toLowerCase()));

describe("runtime controls inventory (WZC-06, P-09)", () => {
  it("every row is complete and uiKeys are unique per area", () => {
    expect(RUNTIME_CONTROL_INVENTORY.length).toBeGreaterThan(40);
    for (const r of RUNTIME_CONTROL_INVENTORY) {
      expect(RuntimeControlArea.safeParse(r.area).success, r.control).toBe(true);
      expect(RuntimeControlStatus.safeParse(r.status).success, r.control).toBe(true);
      expect(r.reason.trim().length, r.control).toBeGreaterThan(5);
      expect(r.evidence.trim().length, r.control).toBeGreaterThan(5);
    }
    for (const area of RuntimeControlArea.options) {
      const keys = rows(area)
        .map((r) => r.uiKey)
        .filter((k) => k !== null);
      expect(new Set(keys).size, area).toBe(keys.length);
    }
    expect(PINNED_RUNTIME_VERSIONS).toEqual({
      "claude-code": { cli: "2.1.289", sdk: "0.3.282" },
      codex: { cli: "0.160.0" },
    });
  });

  it("lists every Claude Code control of Inventory A", () => {
    for (const c of [
      "model list",
      "switch model",
      "effort",
      "ultracode",
      "ultrathink",
      "thinking budget",
      "context window",
      "context usage",
      "fast mode",
      "plan",
      "supervised",
      "auto-accept edits",
      "auto",
      "full access",
      "dontask",
      "fallback model",
      "slash commands",
      "interrupt",
      "rewind",
    ]) {
      expect(has("claude-code", c), c).toBe(true);
    }
    expect(controlStatus("claude-code", "effort.ultracode")).toBe("deferred");
    expect(controlStatus("claude-code", "effort.ultrathink")).toBe("deferred");
    const dontAsk = rows("claude-code").find((r) => r.control.toLowerCase().includes("dontask"));
    expect(["impossible", "deferred"]).toContain(dontAsk?.status);
  });

  it("lists every Codex control of Inventory B", () => {
    for (const c of [
      "model/list",
      "model",
      "reasoning effort",
      "ultra",
      "reasoning summary",
      "fast mode",
      "ultrafast",
      "context window",
      "approval policy",
      "sandbox",
      "auto review",
      "permission profiles",
      "plan collaboration mode",
      "personality",
      "slash commands",
    ]) {
      expect(has("codex", c), c).toBe(true);
    }
    expect(controlStatus("codex", "effort.ultra")).toBe("deferred");
    expect(rows("codex").find((r) => r.control.toLowerCase().includes("personality"))?.status).toBe(
      "impossible",
    );
  });

  it("Codex rows say what the 0.160.0 fixtures confirmed (Plan 03)", () => {
    const row = (k: string) => rows("codex").find((r) => r.uiKey === k);
    expect(row("mode.default")).toMatchObject({ status: "exposed" });
    expect(row("mode.default")?.evidence).toContain("codex-0.160.0.supervised-write.rpc.jsonl");
    expect(row("mode.default")?.reason).toMatch(/approval .*before .*write/i);
    expect(row("mode.auto")).toMatchObject({ status: "exposed" });
    expect(row("mode.auto")?.reason).toMatch(/runtime review \(auto_review\); behaviour not fixtured/);
    expect(row("effort")?.status).toBe("exposed");
    expect(row("effort")?.evidence).toContain("codex-0.160.0.model-list.json");
    expect(row("effort.ultra")?.status).toBe("deferred");
    expect(row("fast.mode")).toMatchObject({ status: "exposed" });
    expect(row("fast.mode")?.reason).toContain("2.5x");
    expect(row("context.window")).toMatchObject({ status: "exposed" });
    expect(row("context.window")?.reason).toMatch(/display only/i);
    expect(row("slash.passthrough")?.reason).toMatch(/\/compact/);
    expect(row("model.list")?.evidence).toContain("codex-0.160.0.model-list.json");
    expect(rows("codex").some((r) => r.control.toLowerCase().includes("readback"))).toBe(true);
  });

  it("lists every D-17 layout element, deferring those that need new data", () => {
    for (const k of ["ui.stream.subagents", "ui.header.actions", "ui.composer.attach", "ui.minimap"]) {
      expect(controlStatus("workzone-ui", k), k).toBe("deferred");
    }
    for (const k of [
      "ui.sidebar.groups",
      "ui.sidebar.status",
      "ui.sidebar.diffstat",
      "ui.header.breadcrumb",
      "ui.stream.turn-summary",
      "ui.stream.tool-groups",
      "ui.stream.changes-card",
      "ui.agent-bar",
      "ui.composer.chips",
      "ui.footer.strip",
    ]) {
      expect(isExposed("workzone-ui", k), k).toBe(true);
    }
  });

  it("controls awaiting a recorded fixture are not exposed yet; shipped modes and full access are", () => {
    expect(isExposed("claude-code", "effort")).toBe(false);
    expect(isExposed("claude-code", "mode.auto")).toBe(false);
    for (const r of ["claude-code", "codex"] as const) {
      for (const m of ["mode.plan", "mode.default", "mode.acceptEdits", "mode.fullAccess", "model.list"]) {
        expect(isExposed(r, m), `${r} ${m}`).toBe(true);
      }
    }
    for (const r of rows("claude-code").concat(rows("codex"))) {
      if (r.uiKey === "effort" && r.area === "claude-code")
        expect(r.reason).toMatch(/awaiting recorded fixture/);
      if (r.uiKey === "mode.auto" && r.area === "claude-code")
        expect(r.reason).toMatch(/awaiting recorded fixture/);
    }
    expect(isExposed("codex", "no.such.key")).toBe(false);
    expect(controlStatus("codex", "no.such.key")).toBeNull();
  });
});
