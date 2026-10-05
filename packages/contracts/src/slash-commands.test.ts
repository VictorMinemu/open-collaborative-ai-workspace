import { describe, expect, it } from "vitest";
import {
  PASSTHROUGH_SLASH_COMMANDS,
  parseSlashCommand,
  SETTINGS_SLASH_COMMANDS,
  settingsFromSlash,
  slashDisposition,
} from "./index";

describe("slash commands (P-10, D-13)", () => {
  it("parses only a leading command on the first line", () => {
    expect(parseSlashCommand("/model sonnet")).toEqual({ name: "model", args: "sonnet" });
    expect(parseSlashCommand("/Compact")).toEqual({ name: "compact", args: "" });
    expect(parseSlashCommand("/effort  high  \nand more")).toEqual({ name: "effort", args: "high" });
    expect(parseSlashCommand("hello /model x")).toBeNull();
    expect(parseSlashCommand("/ ")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });

  it("settings commands go through the settings path; an allowlist passes through; the rest is refused", () => {
    expect(SETTINGS_SLASH_COMMANDS).toEqual(["model", "effort", "fast", "permissions"]);
    expect(slashDisposition("/model opus", "claude-code")).toEqual({
      kind: "settings",
      name: "model",
      args: "opus",
    });
    for (const runtime of ["claude-code", "codex"] as const) {
      expect(slashDisposition("/compact", runtime)).toMatchObject({ kind: "passthrough", name: "compact" });
      expect(PASSTHROUGH_SLASH_COMMANDS[runtime]).toContain("compact");
    }
    expect(slashDisposition("/context", "claude-code")).toMatchObject({ kind: "passthrough" });
    expect(slashDisposition("/context", "codex")).toEqual({ kind: "refused", name: "context" });
    for (const cmd of ["/config", "/mcp", "/agents", "/login", "/update-config", "/hooks", "/ultracode"]) {
      expect(slashDisposition(cmd, "claude-code"), cmd).toMatchObject({ kind: "refused" });
      expect(slashDisposition(cmd, "codex"), cmd).toMatchObject({ kind: "refused" });
    }
    expect(slashDisposition("no command", "codex")).toBeNull();
  });

  it("maps settings commands onto a settings patch", () => {
    expect(settingsFromSlash("permissions", "full access")).toEqual({
      ok: true,
      patch: { permissionMode: "fullAccess" },
    });
    expect(settingsFromSlash("permissions", "supervised")).toEqual({
      ok: true,
      patch: { permissionMode: "default" },
    });
    expect(settingsFromSlash("permissions", "acceptEdits")).toEqual({
      ok: true,
      patch: { permissionMode: "acceptEdits" },
    });
    expect(settingsFromSlash("permissions", "Auto")).toEqual({ ok: true, patch: { permissionMode: "auto" } });
    expect(settingsFromSlash("fast", "on")).toEqual({ ok: true, patch: { fastMode: true } });
    expect(settingsFromSlash("fast", "off")).toEqual({ ok: true, patch: { fastMode: false } });
    expect(settingsFromSlash("effort", "default")).toEqual({ ok: true, patch: { effort: null } });
    expect(settingsFromSlash("effort", "xhigh")).toEqual({ ok: true, patch: { effort: "xhigh" } });
    expect(settingsFromSlash("model", "sonnet")).toEqual({ ok: true, patch: { model: "sonnet" } });
    for (const [name, args] of [
      ["permissions", "bypassPermissions"],
      ["permissions", "dontAsk"],
      ["fast", "maybe"],
      ["model", ""],
      ["effort", ""],
      ["config", "x"],
    ] as const) {
      const r = settingsFromSlash(name, args);
      expect(r.ok, `${name} ${args}`).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(5);
    }
  });
});
