// 07.12-01 (D-01, D-10, PD-03, PD-19): the Local Runtime as one file that runs outside this monorepo with only the
// Claude Agent SDK installed beside it. Builds once into a temp dir, then runs the file from a scratch directory with a
// scratch HOME / OCW_HOME, PATH=/usr/bin:/bin, the fake runtimes and runtime updates off (nothing real is touched).

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BUNDLE_LICENSE_ALLOWLIST, RuntimeDistManifest } from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUNTIME_VERSION } from "./version.js";

const PKG_ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(PKG_ROOT, "scripts", "build-bundle.mjs");
const SDK = "@anthropic-ai/claude-agent-sdk";
const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
  version: string;
  dependencies: Record<string, string>;
};

const dirs: string[] = [];
const children: ChildProcess[] = [];
let out = "";
let bundleText = "";
let manifest: RuntimeDistManifest;

function tempDir(prefix: string): string {
  // Short names: a Unix socket path must stay under 104 bytes on macOS.
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function run(
  file: string,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [file, ...args],
      { env, encoding: "utf8", timeout: 30_000 },
      (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

beforeAll(async () => {
  out = tempDir("ocwb-");
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [SCRIPT, "--out", out], { encoding: "utf8" }, (err, _stdout, stderr) =>
      err ? reject(new Error(`build failed: ${stderr}`)) : resolve(),
    );
  });
  bundleText = readFileSync(join(out, "ocw-runtime.mjs"), "utf8");
  manifest = RuntimeDistManifest.parse(JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")));
}, 120_000);

afterAll(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the runtime bundle build (07.12, D-01, D-10)", () => {
  it("writes the file and a manifest whose sha256, bytes and version match it", () => {
    const bytes = readFileSync(join(out, "ocw-runtime.mjs"));
    expect(manifest.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(manifest.bytes).toBe(bytes.length);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.file).toBe("ocw-runtime.mjs");
    expect(manifest.minNode).toBe(24);
  });

  it("pins the SDK and its peer dependencies at this package's exact versions, and never bundles the SDK", () => {
    const sdkPkg = JSON.parse(
      readFileSync(
        join(PKG_ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"),
        "utf8",
      ),
    ) as { peerDependencies: Record<string, string> };
    const expected = [SDK, ...Object.keys(sdkPkg.peerDependencies)].map((name) => ({
      name,
      version: pkg.dependencies[name],
    }));
    expect(manifest.external).toEqual(expected);
    expect(manifest.bundled.map((p) => p.name)).not.toContain(SDK);
    expect(manifest.bundled.every((p) => !p.name.startsWith(SDK))).toBe(true);
    for (const p of manifest.bundled) expect(BUNDLE_LICENSE_ALLOWLIST).toContain(p.license);
    expect(bundleText).not.toContain("node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs");
  });

  it("names the runtime, its version and its license on line 1 and ends with the third-party notices", () => {
    const first = bundleText.split("\n", 1)[0] ?? "";
    expect(first).toMatch(/^\/\/ ocw-runtime /);
    expect(first).toContain(pkg.version);
    expect(first).toContain("AGPL-3.0-only");
    const tail = bundleText.slice(bundleText.lastIndexOf("/*\n * Third-party software"));
    expect(tail).toMatch(/\*\/\n$/);
    expect(tail).toMatch(/ \* ws \d+\.\d+\.\d+ \(MIT\)/);
    expect(tail).toMatch(/ \* zod \d+\.\d+\.\d+ \(MIT\)/);
  });

  it("keeps the script's license allowlist equal to the contract's", async () => {
    const url = pathToFileURL(SCRIPT).href;
    const mod = (await import(url)) as { BUNDLE_LICENSE_ALLOWLIST: string[]; RUNTIME_BUNDLE_FILE: string };
    expect(mod.BUNDLE_LICENSE_ALLOWLIST).toEqual([...BUNDLE_LICENSE_ALLOWLIST]);
    expect(mod.RUNTIME_BUNDLE_FILE).toBe("ocw-runtime.mjs");
  });
});

describe("the bundle outside the repository (07.12, D-01, D-10, PD-19)", () => {
  function scratch(withSdk: boolean): {
    file: string;
    env: Record<string, string>;
    ocwHome: string;
    root: string;
  } {
    const root = tempDir("ocwr-");
    const app = join(root, "app");
    mkdirSync(app);
    const file = join(app, "ocw-runtime.mjs");
    // A copy, not a symlink: Node resolves packages from the real path of the main module.
    copyFileSync(join(out, "ocw-runtime.mjs"), file);
    if (withSdk) {
      mkdirSync(join(app, "node_modules", "@anthropic-ai"), { recursive: true });
      const real = realpathSync(join(PKG_ROOT, "node_modules", "@anthropic-ai", "claude-agent-sdk"));
      symlinkSync(real, join(app, "node_modules", "@anthropic-ai", "claude-agent-sdk"), "dir");
    }
    const home = join(root, "u");
    const ocwHome = join(root, "h");
    mkdirSync(home);
    return {
      file,
      ocwHome,
      root,
      env: {
        HOME: home,
        OCW_HOME: ocwHome,
        PATH: "/usr/bin:/bin",
        OCW_RUNTIME_FAKE: "1",
        OCW_RUNTIME_UPDATES: "off",
      },
    };
  }

  it("prints its version, runs the daemon, answers status and registers a project; SIGTERM exits 0", async () => {
    const s = scratch(true);
    for (const arg of ["version", "--version"]) {
      const r = await run(s.file, [arg], s.env);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toBe(`${pkg.version}\n`);
    }

    const daemon = spawn(process.execPath, [s.file, "run"], {
      env: s.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(daemon);
    let logs = "";
    daemon.stdout?.on("data", (d: Buffer) => {
      logs += d.toString();
    });
    daemon.stderr?.on("data", (d: Buffer) => {
      logs += d.toString();
    });
    const socket = join(s.ocwHome, "runtime.sock");
    const deadline = Date.now() + 20_000;
    while (!existsSync(socket)) {
      if (daemon.exitCode !== null) throw new Error(`daemon exited early: ${logs}`);
      if (Date.now() > deadline) throw new Error(`no control socket after 20 s: ${logs}`);
      await new Promise((r) => setTimeout(r, 100));
    }

    const status = await run(s.file, ["status"], s.env);
    expect(status.code, status.stderr).toBe(0);
    const body = JSON.parse(status.stdout) as { runtimes: { id: string }[]; paired: boolean };
    expect(body.paired).toBe(false);
    expect(body.runtimes.map((r) => r.id).sort()).toEqual(["claude-code", "codex"]);

    const project = join(s.root, "repo");
    mkdirSync(project);
    const added = await run(s.file, ["add-project", project, "--name", "scratch-repo"], s.env);
    expect(added.code, added.stderr).toBe(0);
    expect(JSON.parse(added.stdout)).toMatchObject({ name: "scratch-repo" });

    const exited = new Promise<number | null>((resolve) => daemon.once("exit", (code) => resolve(code)));
    daemon.kill("SIGTERM");
    expect(await exited).toBe(0);
  }, 60_000);

  it("fails naming the Claude Agent SDK when nothing is installed beside it (the SDK is not inside)", async () => {
    const s = scratch(false);
    const r = await run(s.file, ["version"], s.env);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain(SDK);
  });
});

describe("RUNTIME_VERSION under tsx", () => {
  it("is 0.0.0-dev when no build defines it", () => {
    expect(RUNTIME_VERSION).toBe("0.0.0-dev");
  });
});
