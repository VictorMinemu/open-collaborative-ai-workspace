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
import {
  BUNDLE_LICENSE_ALLOWLIST,
  RUNTIME_EXTERNAL_LOCK_FILE,
  RUNTIME_EXTERNAL_LOCK_ROOT,
  RuntimeDistManifest,
} from "@ocw/contracts";
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

  describe("pins the whole external tree with integrity (07.12 review ME-03)", () => {
    interface LockEntry {
      name?: string;
      version?: string;
      resolved?: string;
      integrity?: string;
      optional?: boolean;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    }
    const lockText = () => readFileSync(join(out, RUNTIME_EXTERNAL_LOCK_FILE), "utf8");
    const lock = () =>
      JSON.parse(lockText()) as { lockfileVersion: number; packages: Record<string, LockEntry> };
    /** What `name` resolves to from the package at `location`, through npm's nested node_modules layout. */
    const resolveIn = (packages: Record<string, LockEntry>, location: string, name: string) => {
      for (let loc = location; ; ) {
        const hit = packages[`${loc ? `${loc}/` : ""}node_modules/${name}`];
        if (hit) return hit;
        if (!loc) return undefined;
        const at = loc.lastIndexOf("/node_modules/");
        loc = at === -1 ? "" : loc.slice(0, at);
      }
    };

    it("writes npm-shrinkwrap.json, hashed in the manifest, rooted at the pins", () => {
      expect(manifest.externalLockSha256).toBe(createHash("sha256").update(lockText()).digest("hex"));
      const { lockfileVersion, packages } = lock();
      expect(lockfileVersion).toBe(3);
      expect(packages[""]).toEqual({
        name: RUNTIME_EXTERNAL_LOCK_ROOT,
        dependencies: Object.fromEntries(manifest.external.map((p) => [p.name, p.version])),
      });
    });

    it("every package has an exact version, its registry tarball and a sha512 integrity", () => {
      const { packages } = lock();
      const entries = Object.entries(packages).filter(([loc]) => loc !== "");
      // The SDK, its peers and their transitive dependencies (the MCP SDK alone pulls express, ajv, …).
      expect(entries.length).toBeGreaterThan(30);
      for (const name of ["ajv", "express", "zod-to-json-schema", "json-schema-to-ts"]) {
        expect(packages[`node_modules/${name}`], name).toBeDefined();
      }
      for (const [loc, entry] of entries) {
        expect(entry.version, loc).toMatch(/^\d+\.\d+\.\d+/);
        expect(entry.integrity, loc).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
        const name = loc.slice(loc.lastIndexOf("node_modules/") + "node_modules/".length);
        expect(entry.resolved, loc).toBe(
          `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${entry.version}.tgz`,
        );
      }
      for (const pin of manifest.external)
        expect(packages[`node_modules/${pin.name}`]?.version).toBe(pin.version);
    });

    it("every required dependency resolves inside the lockfile; optional platform packages are marked optional", () => {
      const { packages } = lock();
      for (const [loc, entry] of Object.entries(packages)) {
        if (loc === "" || entry.optional) continue;
        const required = [
          ...Object.keys(entry.dependencies ?? {}),
          ...Object.keys(entry.peerDependencies ?? {}).filter(
            (n) => entry.peerDependenciesMeta?.[n]?.optional !== true,
          ),
        ];
        for (const dep of required) expect(resolveIn(packages, loc, dep), `${loc} → ${dep}`).toBeDefined();
      }
      const platform = Object.entries(packages).filter(([loc]) => loc.includes(`${SDK}-`));
      expect(platform.length).toBeGreaterThan(0);
      for (const [loc, entry] of platform) expect(entry.optional, loc).toBe(true);
    });

    it("keeps the script's lockfile names equal to the contract's", async () => {
      const mod = (await import(pathToFileURL(join(PKG_ROOT, "scripts", "external-lock.mjs")).href)) as {
        EXTERNAL_LOCK_FILE: string;
        EXTERNAL_LOCK_ROOT_NAME: string;
      };
      expect(mod.EXTERNAL_LOCK_FILE).toBe(RUNTIME_EXTERNAL_LOCK_FILE);
      expect(mod.EXTERNAL_LOCK_ROOT_NAME).toBe(RUNTIME_EXTERNAL_LOCK_ROOT);
    });

    it("reads the block-style lockfile `turbo prune` writes for the image build as well as pnpm's flow style", async () => {
      const mod = (await import(pathToFileURL(join(PKG_ROOT, "scripts", "external-lock.mjs")).href)) as {
        readPnpmPackages: (
          text: string,
        ) => Map<string, { integrity?: string; os?: string[]; cpu?: string[] }>;
      };
      const flow = [
        "lockfileVersion: '9.0'",
        "packages:",
        "  '@scope/a@1.0.0':",
        "    resolution: {integrity: sha512-AAA=}",
        "    os: [darwin, linux]",
        "    cpu: [arm64]",
        "  b@2.0.0:",
        "    resolution: {integrity: sha512-BBB=}",
        "snapshots:",
        "  b@2.0.0: {}",
      ].join("\n");
      const block = [
        "lockfileVersion: '9.0'",
        "packages:",
        "  '@scope/a@1.0.0':",
        "    resolution:",
        "      integrity: sha512-AAA=",
        "    engines:",
        "      node: '>=18'",
        "    os:",
        "    - darwin",
        "    - linux",
        "    cpu:",
        "    - arm64",
        "  b@2.0.0:",
        "    resolution:",
        "      integrity: sha512-BBB=",
        "snapshots:",
        "  b@2.0.0: {}",
      ].join("\n");
      for (const text of [flow, block]) {
        const read = mod.readPnpmPackages(text);
        expect(read.get("@scope/a@1.0.0")).toMatchObject({
          integrity: "sha512-AAA=",
          os: ["darwin", "linux"],
          cpu: ["arm64"],
        });
        expect(read.get("b@2.0.0")).toMatchObject({ integrity: "sha512-BBB=" });
      }
    });
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
