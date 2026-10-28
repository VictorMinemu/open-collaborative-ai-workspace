// Phase 07.11 (D-01, D-05, D-08, PD-09): the install-method resolver on fake trees in temp homes. Nothing here looks
// at the real home, the real PATH or a real CLI (PD-19): every lookup goes through `scratchWhich` or a configured path.

import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DisplayCommand, HomeRelativeLocation } from "@ocw/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type InstallResolution,
  NOTE_MANUAL,
  NOTE_SDK_BUNDLED,
  publicInstallFields,
  type ResolveOptions,
  resolveInstall,
  updateCommandFor,
} from "./install-method.js";

const FAKE = fileURLToPath(new URL("./fake-cli/fake-cli.mjs", import.meta.url));
/** Root ignores file modes, so the not-writable cases only hold for a normal user. */
const IS_ROOT = process.getuid?.() === 0;

function installFake(layout: string, dir: string, version: string, extra?: string): void {
  execFileSync(process.execPath, [FAKE, "install-fake", layout, dir, version, ...(extra ? [extra] : [])]);
}

/** `which` limited to the given directories: never the real home's `~/.local/bin` or `/opt/homebrew/bin`. */
function scratchWhich(dirs: readonly string[]): (name: string) => string | null {
  return (name) => {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
    return null;
  };
}

let tmp: string;
let realTmp: string;
let home: string;
let readOnly: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ocw-install-"));
  realTmp = realpathSync(tmp);
  home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  readOnly = [];
});

afterEach(() => {
  for (const dir of readOnly) chmodSync(dir, 0o755);
  rmSync(tmp, { recursive: true, force: true });
});

/** An executable stand-in at `file` (a package manager or a CLI the resolver never runs). */
function exe(file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return file;
}

function link(target: string, path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  return path;
}

function lockDown(dir: string): void {
  chmodSync(dir, 0o555);
  readOnly.push(dir);
}

function resolveWith(
  runtime: "claude-code" | "codex",
  binDirs: readonly string[],
  extra: Partial<ResolveOptions> = {},
): InstallResolution {
  return resolveInstall(runtime, {
    home,
    env: { PATH: binDirs.join(":") },
    which: scratchWhich(binDirs),
    ...extra,
  });
}

/** Principle 7: nothing that may leave the device names a host path. */
function expectPathFree(r: InstallResolution): void {
  const fields = publicInstallFields(r);
  const json = JSON.stringify(fields);
  expect(json).not.toContain(tmp);
  expect(json).not.toContain(realTmp);
  expect(json).not.toContain("/usr/");
  expect(json).not.toContain("/private/");
  if (fields.display !== null) expect(DisplayCommand.safeParse(fields.display).success).toBe(true);
  if (fields.location !== null) expect(HomeRelativeLocation.safeParse(fields.location).success).toBe(true);
}

/** A global npm-style package tree under `<root>/node_modules/<pkg>` with its bin file. */
function packageTree(nodeModules: string, pkg: string, binName: string, version = "2.1.290"): string {
  const dir = join(nodeModules, pkg);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, version }));
  return exe(join(dir, "bin", binName));
}

describe("resolveInstall (Phase 07.11, PD-09)", () => {
  it("a native Claude Code install: native, ~/.local/bin, `claude update`, channel latest", () => {
    installFake("claude-native", home, "2.1.290");
    const bin = join(home, ".local", "bin");
    const r = resolveWith("claude-code", [bin]);
    expect(r).toMatchObject({
      runtime: "claude-code",
      method: "native",
      location: "~/.local/bin",
      canUpdate: true,
      reason: null,
      display: "claude update",
      channel: "latest",
      installRoot: realpathSync(join(home, ".local", "share", "claude")),
      binPath: join(bin, "claude"),
      realPath: realpathSync(join(home, ".local", "share", "claude", "versions", "2.1.290")),
    });
    expect(updateCommandFor(r, "2.1.300")).toEqual({ file: join(bin, "claude"), args: ["update"], env: {} });
    expectPathFree(r);
  });

  it("refuses a candidate that is not a plain version (D-05: nothing from outside the device reaches an argument)", () => {
    installFake("claude-native", home, "2.1.290");
    const r = resolveWith("claude-code", [join(home, ".local", "bin")]);
    expect(updateCommandFor(r, "2.1.300 --force")).toBeNull();
    expect(updateCommandFor(r, "latest")).toBeNull();
    expect(updateCommandFor(r, `2.1.${"9".repeat(80)}`)).toBeNull();
  });

  it("Codex standalone under the default ~/.codex: `codex update` with that CODEX_HOME", () => {
    installFake("codex-standalone", home, "0.164.0");
    const bin = join(home, ".local", "bin");
    const r = resolveWith("codex", [bin]);
    const codexHome = realpathSync(join(home, ".codex"));
    expect(r).toMatchObject({
      method: "codex_standalone",
      canUpdate: true,
      display: "codex update",
      location: "~/.local/bin",
      codexHome,
      installRoot: join(codexHome, "packages", "standalone"),
      channel: "latest",
    });
    expect(updateCommandFor(r, "0.165.0")).toEqual({
      file: join(bin, "codex"),
      args: ["update"],
      env: { CODEX_HOME: codexHome },
    });
    expectPathFree(r);
  });

  it("Codex standalone under a custom CODEX_HOME keeps that home for the update", () => {
    const custom = join(home, "work", "codex-home");
    installFake("codex-standalone", home, "0.164.0", custom);
    const r = resolveWith("codex", [join(home, ".local", "bin")], {
      env: { PATH: join(home, ".local", "bin"), CODEX_HOME: custom },
    });
    expect(r.method).toBe("codex_standalone");
    expect(r.codexHome).toBe(realpathSync(custom));
    expect(updateCommandFor(r, "0.165.0")?.env.CODEX_HOME).toBe(realpathSync(custom));
    expectPathFree(r);
  });

  it("a Claude Code npm global prefix outside the home: the prefix's own npm, exact candidate, prefix bin first on PATH", () => {
    const prefix = join(tmp, "prefix");
    installFake("claude-npm", prefix, "2.1.290");
    const r = resolveWith("claude-code", [join(prefix, "bin")]);
    const realPrefix = realpathSync(prefix);
    expect(r).toMatchObject({
      method: "npm",
      canUpdate: true,
      location: null,
      display: "npm install -g @anthropic-ai/claude-code@latest",
      installRoot: realPrefix,
      prefix: realPrefix,
      managerPath: join(realPrefix, "bin", "npm"),
    });
    const cmd = updateCommandFor(r, "2.1.300", { PATH: "/usr/bin:/bin" });
    expect(cmd).toMatchObject({
      file: join(realPrefix, "bin", "npm"),
      args: ["install", "-g", "--prefix", realPrefix, "@anthropic-ai/claude-code@2.1.300"],
    });
    expect(cmd?.env.PATH?.split(":")[0]).toBe(join(realPrefix, "bin"));
    expect(cmd?.env.PATH).toContain("/usr/bin");
    expectPathFree(r);
  });

  it("a Codex npm global prefix under the home: npm with `@openai/codex`, location ~-relative", () => {
    const prefix = join(home, ".npm-global");
    installFake("codex-npm", prefix, "0.164.0");
    const r = resolveWith("codex", [join(prefix, "bin")]);
    expect(r).toMatchObject({
      method: "npm",
      canUpdate: true,
      location: "~/.npm-global/bin",
      display: "npm install -g @openai/codex@latest",
    });
    expect(updateCommandFor(r, "0.165.0")?.args).toEqual([
      "install",
      "-g",
      "--prefix",
      realpathSync(prefix),
      "@openai/codex@0.165.0",
    ]);
    expectPathFree(r);
  });

  it.skipIf(IS_ROOT)(
    "an npm prefix whose node_modules is not writable: needs_admin, `sudo npm …`, never run",
    () => {
      const prefix = join(tmp, "usr-prefix");
      installFake("claude-npm", prefix, "2.1.290");
      lockDown(join(prefix, "lib", "node_modules"));
      const r = resolveWith("claude-code", [join(prefix, "bin")]);
      expect(r).toMatchObject({
        method: "npm",
        canUpdate: false,
        reason: "needs_admin",
        display: "sudo npm install -g @anthropic-ai/claude-code@latest",
      });
      expect(updateCommandFor(r, "2.1.300")).toBeNull();
      expectPathFree(r);
    },
  );

  it("Homebrew cask `claude-code` (stable): `brew upgrade --cask claude-code` with the prefix's brew", () => {
    const brew = join(tmp, "homebrew");
    exe(join(brew, "bin", "brew"));
    const real = exe(join(brew, "Caskroom", "claude-code", "2.1.290", "claude"));
    link(real, join(brew, "bin", "claude"));
    const r = resolveWith("claude-code", [join(brew, "bin")]);
    const realBrew = realpathSync(brew);
    expect(r).toMatchObject({
      method: "homebrew_cask",
      canUpdate: true,
      display: "brew upgrade --cask claude-code",
      brewName: "claude-code",
      installRoot: realBrew,
      location: null,
    });
    const cmd = updateCommandFor(r, "2.1.300");
    expect(cmd).toMatchObject({
      file: join(realBrew, "bin", "brew"),
      args: ["upgrade", "--cask", "claude-code"],
    });
    expect(cmd?.env.PATH?.split(":")[0]).toBe(join(realBrew, "bin"));
    expectPathFree(r);
  });

  it("Homebrew cask `claude-code@latest`: `brew upgrade --cask claude-code@latest`", () => {
    const brew = join(tmp, "homebrew");
    exe(join(brew, "bin", "brew"));
    link(exe(join(brew, "Caskroom", "claude-code@latest", "2.1.290", "claude")), join(brew, "bin", "claude"));
    const r = resolveWith("claude-code", [join(brew, "bin")]);
    expect(r).toMatchObject({
      method: "homebrew_cask",
      display: "brew upgrade --cask claude-code@latest",
      brewName: "claude-code@latest",
    });
    expect(updateCommandFor(r, "2.1.300")?.args).toEqual(["upgrade", "--cask", "claude-code@latest"]);
    expectPathFree(r);
  });

  it("Homebrew formula `codex` (Cellar): `brew upgrade codex`", () => {
    const brew = join(tmp, "homebrew");
    exe(join(brew, "bin", "brew"));
    link(exe(join(brew, "Cellar", "codex", "0.164.0", "bin", "codex")), join(brew, "bin", "codex"));
    const r = resolveWith("codex", [join(brew, "bin")]);
    expect(r).toMatchObject({ method: "homebrew_formula", canUpdate: true, display: "brew upgrade codex" });
    expect(updateCommandFor(r, "0.165.0")?.args).toEqual(["upgrade", "codex"]);
    expectPathFree(r);
  });

  it("a Caskroom tree without an executable brew is unknown (manual), never guessed", () => {
    const brew = join(tmp, "homebrew");
    link(exe(join(brew, "Caskroom", "claude-code", "2.1.290", "claude")), join(brew, "bin", "claude"));
    const r = resolveWith("claude-code", [join(brew, "bin")]);
    expect(r).toMatchObject({
      method: "unknown",
      canUpdate: false,
      reason: "manual",
      display: null,
      note: NOTE_MANUAL,
    });
    expect(updateCommandFor(r, "2.1.300")).toBeNull();
    expectPathFree(r);
  });

  it("a pnpm global install is recognised and left to pnpm (manual, `pnpm add -g …`)", () => {
    const pnpmHome = join(home, "Library", "pnpm");
    const real = packageTree(
      join(pnpmHome, "global", "5", ".pnpm", "@anthropic-ai+claude-code@2.1.290", "node_modules"),
      "@anthropic-ai/claude-code",
      "claude",
    );
    link(real, join(pnpmHome, "claude"));
    const r = resolveWith("claude-code", [pnpmHome]);
    expect(r).toMatchObject({
      method: "pnpm",
      canUpdate: false,
      reason: "manual",
      display: "pnpm add -g @anthropic-ai/claude-code@latest",
      location: "~/Library/pnpm",
    });
    expect(updateCommandFor(r, "2.1.300")).toBeNull();
    expectPathFree(r);
  });

  it("a bun global install is recognised and left to bun (manual, `bun add -g …`)", () => {
    const real = packageTree(
      join(home, ".bun", "install", "global", "node_modules"),
      "@anthropic-ai/claude-code",
      "claude",
    );
    link(real, join(home, ".bun", "bin", "claude"));
    const r = resolveWith("claude-code", [join(home, ".bun", "bin")]);
    expect(r).toMatchObject({
      method: "bun",
      reason: "manual",
      display: "bun add -g @anthropic-ai/claude-code@latest",
    });
    expect(updateCommandFor(r, "2.1.300")).toBeNull();
    expectPathFree(r);
  });

  it("a yarn classic global install is recognised and left to yarn (manual, `yarn global add …`)", () => {
    const real = packageTree(
      join(home, ".config", "yarn", "global", "node_modules"),
      "@openai/codex",
      "codex",
    );
    link(real, join(home, ".yarn", "bin", "codex"));
    const r = resolveWith("codex", [join(home, ".yarn", "bin")]);
    expect(r).toMatchObject({
      method: "yarn",
      reason: "manual",
      display: "yarn global add @openai/codex@latest",
    });
    expect(updateCommandFor(r, "0.165.0")).toBeNull();
    expectPathFree(r);
  });

  it("a Volta shim is recognised and left to Volta (manual, `volta install …`)", () => {
    const shim = exe(join(home, ".volta", "bin", "volta-shim"));
    link(shim, join(home, ".volta", "bin", "claude"));
    packageTree(
      join(
        home,
        ".volta",
        "tools",
        "image",
        "packages",
        "@anthropic-ai",
        "claude-code",
        "lib",
        "node_modules",
      ),
      "@anthropic-ai/claude-code",
      "claude",
    );
    const r = resolveWith("claude-code", [join(home, ".volta", "bin")]);
    expect(r).toMatchObject({
      method: "volta",
      reason: "manual",
      display: "volta install @anthropic-ai/claude-code@latest",
    });
    expect(updateCommandFor(r, "2.1.300")).toBeNull();
    expectPathFree(r);
  });

  it.skipIf(IS_ROOT)(
    "a root-owned system path (apt-style): system_package, needs_admin, `sudo apt …`",
    () => {
      const sys = join(tmp, "sys");
      exe(join(sys, "bin", "claude"));
      lockDown(join(sys, "bin"));
      const r = resolveWith("claude-code", [join(sys, "bin")], {
        systemDirs: [sys],
        systemPackageManager: "apt",
      });
      expect(r).toMatchObject({
        method: "system_package",
        canUpdate: false,
        reason: "needs_admin",
        location: null,
      });
      expect(r.display?.startsWith("sudo ")).toBe(true);
      expect(r.display).toBe("sudo apt update && sudo apt upgrade claude-code");
      expect(updateCommandFor(r, "2.1.300")).toBeNull();
      expectPathFree(r);
    },
  );

  it.skipIf(IS_ROOT)("a system path under dnf shows `sudo dnf upgrade claude-code`", () => {
    const sys = join(tmp, "sys");
    exe(join(sys, "bin", "claude"));
    lockDown(join(sys, "bin"));
    const r = resolveWith("claude-code", [join(sys, "bin")], {
      systemDirs: [sys],
      systemPackageManager: "dnf",
    });
    expect(r).toMatchObject({ method: "system_package", display: "sudo dnf upgrade claude-code" });
    expectPathFree(r);
  });

  it("a mise-managed Node global is manual: update it with the tool that installed it", () => {
    const node = join(home, ".local", "share", "mise", "installs", "node", "22.0.0");
    exe(join(node, "bin", "npm"));
    link(
      packageTree(join(node, "lib", "node_modules"), "@anthropic-ai/claude-code", "claude"),
      join(node, "bin", "claude"),
    );
    const r = resolveWith("claude-code", [join(node, "bin")]);
    expect(r).toMatchObject({
      method: "mise",
      canUpdate: false,
      reason: "manual",
      display: null,
      note: NOTE_MANUAL,
    });
    expect(updateCommandFor(r, "2.1.300")).toBeNull();
    expectPathFree(r);
  });

  it("an asdf shim is manual: update it with the tool that installed it", () => {
    exe(join(home, ".asdf", "shims", "codex"));
    const r = resolveWith("codex", [join(home, ".asdf", "shims")]);
    expect(r).toMatchObject({
      method: "asdf",
      canUpdate: false,
      reason: "manual",
      display: null,
      note: NOTE_MANUAL,
    });
    expectPathFree(r);
  });

  it("a project's own node_modules is project_local and manual", () => {
    const real = packageTree(join(tmp, "proj", "node_modules"), "@anthropic-ai/claude-code", "claude");
    const bin = link(real, join(tmp, "proj", "node_modules", ".bin", "claude"));
    const r = resolveInstall("claude-code", { home, env: {}, configuredPath: bin, which: () => null });
    expect(r).toMatchObject({ method: "project_local", reason: "manual", display: null, note: NOTE_MANUAL });
    expectPathFree(r);
  });

  it("Claude Code not found anywhere is the SDK-bundled CLI: updates with the OCW runtime", () => {
    const r = resolveWith("claude-code", [join(home, "nowhere")]);
    expect(r).toMatchObject({
      method: "sdk_bundled",
      canUpdate: false,
      reason: "manual",
      display: null,
      location: null,
      note: NOTE_SDK_BUNDLED,
    });
    expect(updateCommandFor(r, "2.1.300")).toBeNull();
    expectPathFree(r);
  });

  it("Codex not found anywhere is not_installed", () => {
    const r = resolveWith("codex", [join(home, "nowhere")]);
    expect(r).toMatchObject({
      method: "not_installed",
      canUpdate: false,
      reason: "not_installed",
      display: null,
    });
    expectPathFree(r);
  });

  it("DISABLE_UPDATES in the environment makes Claude Code updates_disabled", () => {
    installFake("claude-native", home, "2.1.290");
    const bin = join(home, ".local", "bin");
    const r = resolveWith("claude-code", [bin], { env: { PATH: bin, DISABLE_UPDATES: "1" } });
    expect(r).toMatchObject({ method: "native", canUpdate: false, reason: "updates_disabled" });
    expect(updateCommandFor(r, "2.1.300")).toBeNull();
    expectPathFree(r);
  });

  it("DISABLE_UPDATES in ~/.claude/settings.json env makes Claude Code updates_disabled too", () => {
    installFake("claude-native", home, "2.1.290");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { DISABLE_UPDATES: "1" } }));
    const r = resolveWith("claude-code", [join(home, ".local", "bin")]);
    expect(r).toMatchObject({ canUpdate: false, reason: "updates_disabled" });
  });

  it("on Windows every install is manual (D-01)", () => {
    installFake("claude-native", home, "2.1.290");
    const r = resolveWith("claude-code", [join(home, ".local", "bin")], { platform: "win32" });
    expect(r).toMatchObject({ method: "windows", canUpdate: false, reason: "manual", display: null });
    expect(updateCommandFor(r, "2.1.300")).toBeNull();
    expectPathFree(r);
  });
});
