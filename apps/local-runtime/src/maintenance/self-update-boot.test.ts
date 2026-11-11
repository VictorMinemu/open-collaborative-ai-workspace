// Phase 07.17.1 (ADR-0040, D-07, PD-12, PD-19, PD-25, E16): the daemon that comes back after a switch reports the run
// that restarted it, rewrites a stale install record and prunes old versions. Every case runs on a scratch OCW_HOME
// (`scratchOcwHome`) with a loopback stub and the fake npm; nothing touches the OS user's home or a non-loopback host.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_AGENT_SDK_PACKAGE, DeviceToServerFrame, runtimeBuildOf } from "@ocw/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeInstallInfo } from "../install-info.js";
import {
  fetchServedManifest,
  type PreparedVersion,
  prepareVersion,
  readSelfUpdateMarker,
  type SelfUpdateMarker,
  selfUpdateMarkerPath,
  switchToVersion,
} from "./self-update.js";
import {
  CAME_BACK_ON_PREVIOUS,
  clearStaging,
  pruneRuntimeVersions,
  reconcileSelfUpdate,
} from "./self-update-boot.js";
import {
  type DistStub,
  fakeNpm,
  HOST_PATH_TOKEN_RE,
  SCRATCH_NODE_PATH,
  type ScratchHome,
  scratchOcwHome,
  startDistStub,
} from "./self-update-harness.js";

const RUN_ID = "5b0f6a52-3c1e-4c55-9f0d-0f8f3f6c2a11";
const COMMAND_ID = "0d6c7b9e-8a2f-4f4e-b1d3-6a5e2c7f9a10";
const NOW = new Date("2026-11-11T12:05:00.000Z");

let stub: DistStub;
let home: ScratchHome;
let prepared: PreparedVersion;

const runtime = () => join(home.ocwHome, "runtime");
const oldBundle = () =>
  `import "${CLAUDE_AGENT_SDK_PACKAGE}";\nif (process.argv[2] === "version") console.log("0.3.1");\n`;

function marker(over: Partial<SelfUpdateMarker> = {}): SelfUpdateMarker {
  return {
    runId: RUN_ID,
    commandId: COMMAND_ID,
    trigger: "manual",
    from: { version: "0.3.1", sha256: home.oldSha256 },
    to: { version: "0.3.2", sha256: stub.manifest.sha256 },
    startedAt: "2026-11-11T12:00:00.000Z",
    ...over,
  };
}

beforeEach(async () => {
  stub = await startDistStub({ version: "0.3.2" });
  home = await scratchOcwHome({ installed: { version: "0.3.1", bundle: oldBundle() } });
  const npmPath = await fakeNpm(join(home.ocwHome, "..", "fake-bin"));
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: join(home.ocwHome, "..") };
  prepared = await prepareVersion({
    ocwHome: home.ocwHome,
    serverUrl: stub.url,
    env,
    manifest: await fetchServedManifest({ serverUrl: stub.url, env }),
    runId: RUN_ID,
    execPath: process.execPath,
    nodeVersion: process.versions.node,
    requireScratchHome: true,
    npmPath,
  });
});

afterEach(async () => {
  await stub.close();
  home.cleanup();
});

async function switched(over: Partial<SelfUpdateMarker> = {}): Promise<void> {
  await switchToVersion({
    ocwHome: home.ocwHome,
    prepared,
    marker: marker(over),
    serverUrl: stub.url,
    now: () => new Date("2026-11-11T12:01:00.000Z"),
  });
}

describe("reconcileSelfUpdate (07.17.1, D-07, PD-12, E16)", () => {
  it("reports started and finished succeeded with the marker's run when the new build runs", async () => {
    await switched();
    const boot = await reconcileSelfUpdate({
      ocwHome: home.ocwHome,
      running: { version: "0.3.2", sha256: stub.manifest.sha256 },
      now: () => NOW,
    });
    expect(boot).not.toBeNull();
    if (!boot) return;
    expect(boot.outcome).toBe("succeeded");
    expect(boot.marker).toEqual(marker());
    const newBuild = runtimeBuildOf(stub.manifest.sha256);
    const common = {
      type: "runtime.update.run",
      runId: RUN_ID,
      commandId: COMMAND_ID,
      runtime: "ocw-runtime",
      trigger: "manual",
      fromVersion: "0.3.1",
      toVersion: "0.3.2",
      candidate: "0.3.2",
      method: "ocw_bundle",
      fromBuild: home.oldSha12,
      toBuild: newBuild,
      at: NOW.toISOString(),
    };
    expect(boot.frames[0]).toEqual({ ...common, phase: "started" });
    expect(boot.frames[1]).toEqual({ ...common, phase: "finished", outcome: "succeeded" });
    for (const f of boot.frames) expect(DeviceToServerFrame.parse(f)).toEqual(f);
    expect(boot.lastRun).toEqual({
      runId: RUN_ID,
      outcome: "succeeded",
      at: NOW.toISOString(),
      fromVersion: "0.3.1",
      toVersion: "0.3.2",
      fromBuild: home.oldSha12,
      toBuild: newBuild,
    });
    // The caller removes the marker once the frames were sent (PD-12).
    expect(existsSync(selfUpdateMarkerPath(home.ocwHome))).toBe(true);
  });

  it("reports failed with CAME_BACK_ON_PREVIOUS when the previous build runs", async () => {
    await switched();
    const boot = await reconcileSelfUpdate({
      ocwHome: home.ocwHome,
      running: { version: "0.3.1", sha256: home.oldSha256 },
      now: () => NOW,
    });
    expect(boot?.outcome).toBe("failed");
    expect(boot?.frames[0].phase).toBe("started");
    expect(boot?.frames[1]).toMatchObject({
      phase: "finished",
      outcome: "failed",
      output: CAME_BACK_ON_PREVIOUS,
      runId: RUN_ID,
      commandId: COMMAND_ID,
    });
    expect(boot?.lastRun.outcome).toBe("failed");
    for (const f of boot?.frames ?? []) DeviceToServerFrame.parse(f);
  });

  it("omits commandId when the run was automatic and had no command", async () => {
    await switched({ commandId: null, trigger: "automatic" });
    const boot = await reconcileSelfUpdate({
      ocwHome: home.ocwHome,
      running: { version: "0.3.2", sha256: stub.manifest.sha256 },
      now: () => NOW,
    });
    expect(boot?.frames[0]).not.toHaveProperty("commandId");
    expect(boot?.frames[1].trigger).toBe("automatic");
    for (const f of boot?.frames ?? []) DeviceToServerFrame.parse(f);
  });

  it("answers null without a marker, and leaves an unreadable marker for the doctor", async () => {
    expect(
      await reconcileSelfUpdate({
        ocwHome: home.ocwHome,
        running: { version: "0.3.1", sha256: home.oldSha256 },
      }),
    ).toBeNull();
    writeFileSync(selfUpdateMarkerPath(home.ocwHome), "{ not json", { mode: 0o600 });
    expect(
      await reconcileSelfUpdate({
        ocwHome: home.ocwHome,
        running: { version: "0.3.1", sha256: home.oldSha256 },
      }),
    ).toBeNull();
    expect(readFileSync(selfUpdateMarkerPath(home.ocwHome), "utf8")).toBe("{ not json");
  });

  it("rewrites an install.json that still names the old build from the running one (0600, nodePath kept)", async () => {
    await switched();
    const file = join(runtime(), "install.json");
    // A crash between the link and the record: install.json still names the old build.
    writeFileSync(
      file,
      `${JSON.stringify({
        serverUrl: "https://ocw.example",
        version: "0.3.1",
        sha256: home.oldSha256,
        installedAt: "2026-11-01T10:00:00.000Z",
        nodePath: SCRATCH_NODE_PATH,
      })}\n`,
      { mode: 0o644 },
    );
    await reconcileSelfUpdate({
      ocwHome: home.ocwHome,
      running: { version: "0.3.2", sha256: stub.manifest.sha256 },
      now: () => NOW,
    });
    const info = RuntimeInstallInfo.parse(JSON.parse(readFileSync(file, "utf8")));
    expect(info).toMatchObject({
      serverUrl: "https://ocw.example",
      version: "0.3.2",
      sha256: stub.manifest.sha256,
      nodePath: SCRATCH_NODE_PATH,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(runtime()).filter((n) => n.startsWith("install.json.tmp"))).toEqual([]);
  });

  it("leaves a current install.json alone", async () => {
    await switched();
    const file = join(runtime(), "install.json");
    const before = readFileSync(file);
    await reconcileSelfUpdate({
      ocwHome: home.ocwHome,
      running: { version: "0.3.2", sha256: stub.manifest.sha256 },
      now: () => NOW,
    });
    expect(readFileSync(file)).toEqual(before);
  });

  it("puts no host path in any frame (PD-25)", async () => {
    await switched();
    for (const running of [
      { version: "0.3.2", sha256: stub.manifest.sha256 },
      { version: "0.3.1", sha256: home.oldSha256 },
    ]) {
      const boot = await reconcileSelfUpdate({ ocwHome: home.ocwHome, running, now: () => NOW });
      for (const f of boot?.frames ?? []) {
        for (const v of Object.values(f)) {
          if (typeof v === "string") expect(v).not.toMatch(HOST_PATH_TOKEN_RE);
        }
      }
    }
    expect(await readSelfUpdateMarker(home.ocwHome)).toEqual(marker());
  });
});

describe("pruneRuntimeVersions and clearStaging (07.17.1, PD-12, E16)", () => {
  it("removes only 12-hex versions outside keep, then clearStaging removes the staging directories", async () => {
    await switched();
    const versions = join(runtime(), "versions");
    for (const name of ["aaaaaaaaaaaa", "bbbbbbbbbbbb", "notes", ".staging-x"]) {
      mkdirSync(join(versions, name), { recursive: true });
      writeFileSync(join(versions, name, "f"), "x");
    }
    const removed = await pruneRuntimeVersions({
      ocwHome: home.ocwHome,
      keep: [prepared.sha12, home.oldSha12],
    });
    expect(removed.sort()).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    expect(readdirSync(versions).sort()).toEqual(
      [".staging-x", "notes", prepared.sha12, home.oldSha12].sort(),
    );
    expect(await clearStaging(home.ocwHome)).toBe(1);
    expect(readdirSync(versions).sort()).toEqual(["notes", prepared.sha12, home.oldSha12].sort());
  });

  it("never removes the directory current points to, even when keep forgets it", async () => {
    await switched();
    const removed = await pruneRuntimeVersions({ ocwHome: home.ocwHome, keep: [home.oldSha12] });
    expect(removed).toEqual([]);
    expect(existsSync(join(runtime(), "versions", prepared.sha12, "ocw-runtime.mjs"))).toBe(true);
  });

  it("never removes the directory of the running bundle", async () => {
    await switched();
    const argv1 = join(runtime(), "versions", home.oldSha12, "ocw-runtime.mjs");
    const removed = await pruneRuntimeVersions({ ocwHome: home.ocwHome, keep: [], argv1 });
    expect(removed).toEqual([]);
    expect(existsSync(argv1)).toBe(true);
  });

  it("answers empty when there is no versions directory", async () => {
    const empty = await scratchOcwHome({ installed: null });
    try {
      expect(await pruneRuntimeVersions({ ocwHome: join(empty.ocwHome, "none"), keep: [] })).toEqual([]);
      expect(await clearStaging(join(empty.ocwHome, "none"))).toBe(0);
    } finally {
      empty.cleanup();
    }
  });
});
