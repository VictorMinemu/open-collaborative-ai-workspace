import { execFile } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_NPM, parsePairingPrompt, WORKSPACE_SDK } from "./headless-server";

/**
 * 07.12-09 (PD-19): the parts of the headless-server e2e helper that run without a stack: reading the pairing link out
 * of `ocw-runtime setup`'s output as it streams, and the fake `npm` the installed runtime gets its SDK from.
 */

const SDK = "@anthropic-ai/claude-agent-sdk";
const SETUP_OUTPUT = [
  "To pair this computer, open:",
  "  http://127.0.0.1:3290/settings/devices?pair=K7QD-3MXP",
  "or open http://127.0.0.1:3290/settings/devices and enter the code:",
  "  K7QD-3MXP",
  "Waiting for approval (expires in 10 minutes). Press Ctrl-C to cancel.",
  "",
].join("\n");

describe("parsePairingPrompt (07.12-09)", () => {
  it("finds the approval link and its code in setup's output", () => {
    expect(parsePairingPrompt(SETUP_OUTPUT)).toEqual({
      url: "http://127.0.0.1:3290/settings/devices?pair=K7QD-3MXP",
      code: "K7QD-3MXP",
    });
  });

  it("is null before the link's line is complete, whatever the chunk boundaries", () => {
    const end = SETUP_OUTPUT.indexOf("K7QD-3MXP\n") + "K7QD-3MXP".length;
    let seen = "";
    let found: ReturnType<typeof parsePairingPrompt> = null;
    // Feed the output three characters at a time, as a pipe may hand it over.
    for (let i = 0; i < SETUP_OUTPUT.length; i += 3) {
      seen += SETUP_OUTPUT.slice(i, i + 3);
      found = parsePairingPrompt(seen);
      if (seen.length <= end) expect(found, `after ${seen.length} characters`).toBeNull();
      if (found) break;
    }
    expect(found?.code).toBe("K7QD-3MXP");
    expect(parsePairingPrompt(SETUP_OUTPUT.slice(0, end))).toBeNull();
  });

  it("is null for output without a pairing link (already paired, or an error)", () => {
    expect(parsePairingPrompt('Already paired as "E2E headless" with Autofy Labs.\n')).toBeNull();
    expect(parsePairingPrompt("  http://127.0.0.1:3290/settings/devices\n")).toBeNull();
    expect(parsePairingPrompt("  http://127.0.0.1:3290/settings/devices?pair=k7qd-3mxp\n")).toBeNull();
  });
});

describe("fake-npm.mjs (07.12-09, PD-19)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const run = (args: string[]) =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      execFile(process.execPath, [FAKE_NPM, ...args], (err, _stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stderr });
      });
    });

  /** A version directory as install.sh leaves it before `npm ci`: package.json and the lockfile (07.12 review ME-03). */
  const versionDir = (deps: Record<string, string> = { [SDK]: "0.3.282", zod: "4.6.5" }, lockDeps = deps) => {
    const root = mkdtempSync(join(tmpdir(), "ocw-fake-npm-"));
    dirs.push(root);
    const prefix = join(root, "versions", "abcdef012345");
    mkdirSync(prefix, { recursive: true });
    writeFileSync(
      join(prefix, "package.json"),
      JSON.stringify({ name: "ocw-runtime-deps", dependencies: deps }),
    );
    const packages: Record<string, unknown> = { "": { name: "ocw-runtime-deps", dependencies: lockDeps } };
    for (const [name, version] of Object.entries(lockDeps)) {
      packages[`node_modules/${name}`] = { version, integrity: `sha512-${name.length}` };
    }
    writeFileSync(join(prefix, "npm-shrinkwrap.json"), JSON.stringify({ lockfileVersion: 3, packages }));
    return prefix;
  };
  const ciArgs = (prefix: string) => [
    "ci",
    "--prefix",
    prefix,
    "--no-audit",
    "--no-fund",
    "--omit=optional",
    "--ignore-scripts",
  ];

  it("npm ci --prefix links the workspace's SDK beside the bundle and records its arguments", async () => {
    const prefix = versionDir();
    const args = ciArgs(prefix);
    const r = await run(args);
    expect(r).toEqual({ code: 0, stderr: "" });
    const link = join(prefix, "node_modules", SDK);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(realpathSync(WORKSPACE_SDK));
    const log = readFileSync(join(prefix, "..", "fake-npm.log"), "utf8")
      .trimEnd()
      .split("\n");
    expect(log.map((l) => JSON.parse(l))).toEqual([args]);
  });

  it("refuses anything else, so a real npm call is never silently faked", async () => {
    for (const args of [
      ["view", SDK],
      ["install", `${SDK}@1.0.0`],
      ["install", "--prefix", "/x", "zod@4"],
      ["ci", "--prefix", "/x"],
      [],
    ]) {
      const r = await run(args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr).toContain("fake npm: unsupported");
    }
  });

  it("refuses what npm ci would: no lockfile, a lockfile out of sync, an SDK without integrity", async () => {
    const noLock = versionDir();
    rmSync(join(noLock, "npm-shrinkwrap.json"));
    const outOfSync = versionDir({ [SDK]: "0.3.282" }, { [SDK]: "0.3.281" });
    const noSdk = versionDir({ zod: "4.6.5" });
    for (const prefix of [noLock, outOfSync, noSdk]) {
      const r = await run(ciArgs(prefix));
      expect(r.code, prefix).toBe(1);
      expect(r.stderr).toContain("fake npm:");
    }
  });
});
