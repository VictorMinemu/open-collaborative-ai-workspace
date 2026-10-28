import { describe, expect, it } from "vitest";
import { DaemonStatusPayload } from "./ipc";
import { runtimeUpdateLines, runtimeUpdatesMenuModel } from "./runtime-updates";

type Status = Record<string, unknown>;

const claude = (over: Status = {}): Status => ({
  runtime: "claude-code",
  installedVersion: "2.1.307",
  latestVersion: "2.1.307",
  advisory: "current",
  state: "idle",
  lastRun: null,
  reason: null,
  ...over,
});

function report(runtimeUpdates?: Status): DaemonStatusPayload {
  return DaemonStatusPayload.parse({
    paired: true,
    connected: true,
    ...(runtimeUpdates ? { runtimeUpdates } : {}),
  });
}

const withRuntimes = (...runtimes: Status[]) =>
  report({
    localLevel: "automatic",
    localLevelSource: "config",
    effectiveLevel: "automatic",
    orgLevelReceived: true,
    runtimes,
  });

const line = (over: Status) => runtimeUpdateLines(withRuntimes(claude(over)))[0];

describe("runtimeUpdateLines (07.11, D-09)", () => {
  it("one line per runtime: up to date, available, updating, waiting, failed", () => {
    expect(line({})).toBe("Claude Code 2.1.307 · up to date");
    expect(line({ latestVersion: "2.1.312", advisory: "behind" })).toBe(
      "Claude Code 2.1.307 · 2.1.312 available",
    );
    expect(line({ latestVersion: "2.1.312", advisory: "behind", state: "running" })).toBe(
      "Claude Code 2.1.307 · updating…",
    );
    expect(line({ latestVersion: "2.1.312", advisory: "behind", state: "queued" })).toBe(
      "Claude Code 2.1.307 · updating…",
    );
    for (const state of ["pending", "draining"]) {
      expect(line({ latestVersion: "2.1.312", advisory: "behind", state })).toBe(
        "Claude Code 2.1.307 · waiting for an idle moment",
      );
    }
    expect(
      line({
        latestVersion: "2.1.312",
        advisory: "behind",
        lastRun: { outcome: "failed", fromVersion: "2.1.307", toVersion: null },
      }),
    ).toBe("Claude Code 2.1.307 · update failed");
  });

  it("says why the device cannot update itself, and lists Codex too", () => {
    expect(line({ latestVersion: "2.1.312", advisory: "behind", reason: "manual" })).toBe(
      "Claude Code 2.1.307 · 2.1.312 available · update it with the tool that installed it",
    );
    const lines = runtimeUpdateLines(
      withRuntimes(
        claude(),
        claude({
          runtime: "codex",
          installedVersion: "0.160.0",
          latestVersion: "0.164.0",
          advisory: "behind",
          reason: "needs_admin",
        }),
      ),
    );
    expect(lines).toEqual([
      "Claude Code 2.1.307 · up to date",
      "Codex 0.160.0 · 0.164.0 available · needs admin on this machine",
    ]);
  });

  it("not installed, or not checked (level off), says only what is known", () => {
    expect(
      line({ installedVersion: null, latestVersion: null, advisory: "unknown", reason: "not_installed" }),
    ).toBe("Claude Code · not installed");
    expect(line({ latestVersion: null, advisory: "unknown" })).toBe("Claude Code 2.1.307");
  });

  it("an older daemon without runtimeUpdates, or no report at all, gives no lines", () => {
    expect(runtimeUpdateLines(report())).toEqual([]);
    expect(runtimeUpdateLines(null)).toEqual([]);
  });
});

describe("runtimeUpdatesMenuModel (07.11, D-02, D-09)", () => {
  it("three radio choices with the device's level checked", () => {
    const model = runtimeUpdatesMenuModel(
      report({
        localLevel: "notify",
        localLevelSource: "config",
        effectiveLevel: "notify",
        orgLevelReceived: true,
      }),
    );
    expect(model).toEqual({
      label: "Runtime updates",
      note: null,
      items: [
        { level: "automatic", label: "Automatic", checked: false, enabled: true },
        { level: "notify", label: "Notify only", checked: true, enabled: true },
        { level: "off", label: "Off", checked: false, enabled: true },
      ],
    });
  });

  it("set by OCW_RUNTIME_UPDATES: every choice disabled and the label says so", () => {
    const model = runtimeUpdatesMenuModel(
      report({ localLevel: "off", localLevelSource: "env", effectiveLevel: "off", orgLevelReceived: true }),
    );
    expect(model?.label).toBe("Runtime updates (set by OCW_RUNTIME_UPDATES)");
    expect(model?.items.every((i) => !i.enabled)).toBe(true);
    expect(model?.items.find((i) => i.checked)?.level).toBe("off");
  });

  it("notes when the organization keeps the effective level lower", () => {
    const limited = runtimeUpdatesMenuModel(
      report({
        localLevel: "automatic",
        localLevelSource: "config",
        effectiveLevel: "off",
        orgLevelReceived: true,
      }),
    );
    expect(limited?.note).toBe("Limited to Off by your organization");
    const waiting = runtimeUpdatesMenuModel(
      report({
        localLevel: "automatic",
        localLevelSource: "config",
        effectiveLevel: "notify",
        orgLevelReceived: false,
      }),
    );
    expect(waiting?.note).toBe("Notify only until your organization's policy arrives");
  });

  it("daemon unreachable: the level from runtime.json; an older running daemon: no submenu", () => {
    expect(runtimeUpdatesMenuModel(null, "off")?.items.find((i) => i.checked)?.level).toBe("off");
    expect(runtimeUpdatesMenuModel(null)).toBeNull();
    expect(runtimeUpdatesMenuModel(report(), "notify")).toBeNull();
  });
});
