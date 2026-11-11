// Phase 07.17.1 (ADR-0040, D-03, D-07, D-08, PD-06, PD-07, PD-08, PD-19): the daemon builds the served runtime beside
// the running one and switches to it. Every case runs on a scratch OCW_HOME (`scratchOcwHome`), against a loopback stub
// of the workspace's runtime routes (`startDistStub`) and the fake npm (`fakeNpm`, never the real one or its
// registry); nothing here touches the OS user's home or any non-loopback host.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_AGENT_SDK_PACKAGE, RUNTIME_ROUTES, runtimeExternalFiles } from "@ocw/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fetchServedManifest,
  NPM_CI_ARGS,
  type PrepareVersionOptions,
  prepareVersion,
} from "./self-update.js";
import {
  type DistStub,
  fakeNpm,
  HOST_PATH_TOKEN_RE,
  type ScratchHome,
  scratchOcwHome,
  startDistStub,
} from "./self-update-harness.js";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

let stub: DistStub;
let home: ScratchHome;
let npmPath: string;
let env: NodeJS.ProcessEnv;
const RUN_ID = "5b0f6a52-3c1e-4c55-9f0d-0f8f3f6c2a11";

beforeEach(async () => {
  stub = await startDistStub({ version: "0.3.2" });
  home = await scratchOcwHome({ installed: { version: "0.3.1", bundle: oldBundle() } });
  npmPath = await fakeNpm(join(home.ocwHome, "..", "fake-bin"));
  env = {
    PATH: ["/usr/bin", "/bin"].join(":"),
    HOME: join(home.ocwHome, ".."),
    // Must never reach npm or the preflight (D-03, E6).
    OCW_DEVICE_TOKEN: ["ocw", "dev", "test"].join("_"),
    ANTHROPIC_API_KEY: ["sk", "ant", "test"].join("-"),
  };
});

afterEach(async () => {
  await stub.close();
  home.cleanup();
});

function oldBundle(): string {
  return `import "${CLAUDE_AGENT_SDK_PACKAGE}";\nif (process.argv[2] === "version") console.log("0.3.1");\n`;
}

const runtime = () => join(home.ocwHome, "runtime");

async function options(over: Partial<PrepareVersionOptions> = {}): Promise<PrepareVersionOptions> {
  const manifest = over.manifest ?? (await fetchServedManifest({ serverUrl: stub.url, env }));
  return {
    ocwHome: home.ocwHome,
    serverUrl: stub.url,
    env,
    manifest,
    runId: RUN_ID,
    execPath: process.execPath,
    nodeVersion: process.versions.node,
    requireScratchHome: true,
    npmPath,
    ...over,
  };
}

function installJsonBytes(): Buffer {
  return readFileSync(join(runtime(), "install.json"));
}

describe("prepareVersion (07.17.1, D-03, PD-07)", () => {
  it("builds the served version beside the current one from the paired server only, through the fake npm", async () => {
    const before = installJsonBytes();
    const phases: string[] = [];
    const prepared = await prepareVersion(await options({ onPhase: (p) => phases.push(p) }));

    const new12 = stub.manifest.sha256.slice(0, 12);
    expect(prepared).toEqual({ manifest: stub.manifest, sha12: new12, reused: false });
    expect(phases).toEqual(["downloading", "installing"]);

    const dir = join(runtime(), "versions", new12);
    expect(sha256(readFileSync(join(dir, "ocw-runtime.mjs")))).toBe(stub.manifest.sha256);
    const files = runtimeExternalFiles(stub.manifest, stub.lock);
    expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(files.packageJson);
    expect(readFileSync(join(dir, "npm-shrinkwrap.json"), "utf8")).toBe(stub.lock);
    expect(existsSync(join(dir, "node_modules", CLAUDE_AGENT_SDK_PACKAGE, "package.json"))).toBe(true);

    // What runs is untouched (D-03): the switch is a separate step.
    expect(readlinkSync(join(runtime(), "current"))).toBe(`versions/${home.oldSha12}`);
    expect(installJsonBytes().equals(before)).toBe(true);
    expect(readdirSync(join(runtime(), "versions")).filter((n) => n.startsWith(".staging-"))).toEqual([]);

    // Only the three fixed routes of config.serverUrl (PD-06).
    expect(stub.requests).toEqual([
      RUNTIME_ROUTES.version,
      RUNTIME_ROUTES.bundle,
      RUNTIME_ROUTES.externalLock,
    ]);
  });

  it("runs npm as `node <npm> ci` with the fixed argv, a filtered env and node's directory first on PATH (E6)", async () => {
    await prepareVersion(await options());
    const report = JSON.parse(readFileSync(join(runtime(), "versions", "fake-npm-report.json"), "utf8")) as {
      argv: string[];
      names: string[];
      pathHead: string;
    };
    const staging = join(runtime(), "versions", `.staging-${RUN_ID}`);
    expect(report.argv).toEqual([...NPM_CI_ARGS(staging)]);
    expect(report.argv).toEqual([
      "ci",
      "--prefix",
      staging,
      "--no-audit",
      "--no-fund",
      "--omit=optional",
      "--ignore-scripts",
    ]);
    expect(report.names.filter((n) => n.startsWith("OCW_") || n.endsWith("_API_KEY"))).toEqual([]);
    expect(report.pathHead).toBe(join(process.execPath, ".."));
  });

  it("never writes anything for the new version outside <OCW_HOME>/runtime/versions", async () => {
    await prepareVersion(await options());
    expect(readdirSync(home.ocwHome)).toEqual(["runtime"]);
    expect(readdirSync(runtime()).sort()).toEqual(["current", "install.json", "versions"]);
    expect(realpathSync(join(runtime(), "current", "ocw-runtime.mjs"))).toBe(
      join(realpathSync(runtime()), "versions", home.oldSha12, "ocw-runtime.mjs"),
    );
  });

  it("keeps every thrown message and the npm report free of the scratch home's absolute path in what leaves", async () => {
    const prepared = await prepareVersion(await options());
    expect(JSON.stringify(prepared)).not.toMatch(HOST_PATH_TOKEN_RE);
  });

  it("leaves the npm report outside the new version directory (it is the staging directory's parent)", async () => {
    await prepareVersion(await options());
    mkdirSync(join(runtime(), "versions"), { recursive: true });
    expect(
      existsSync(join(runtime(), "versions", stub.manifest.sha256.slice(0, 12), "fake-npm-report.json")),
    ).toBe(false);
  });
});
