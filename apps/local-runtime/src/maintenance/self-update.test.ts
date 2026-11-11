// Phase 07.17.1 (ADR-0040, D-03, D-07, D-08, PD-06, PD-07, PD-08, PD-19): the daemon builds the served runtime beside
// the running one and switches to it. Every case runs on a scratch OCW_HOME (`scratchOcwHome`), against a loopback stub
// of the workspace's runtime routes (`startDistStub`) and the fake npm (`fakeNpm`, never the real one or its
// registry); nothing here touches the OS user's home or any non-loopback host.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rename, symlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { CLAUDE_AGENT_SDK_PACKAGE, RUNTIME_ROUTES, runtimeExternalFiles } from "@ocw/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeInstallInfo } from "../install-info.js";
import {
  fetchServedManifest,
  isLoopbackHost,
  NPM_CI_ARGS,
  type PrepareVersionOptions,
  prepareVersion,
  readSelfUpdateMarker,
  removeSelfUpdateMarker,
  SELF_UPDATE_FAILURE_SENTENCES,
  SelfUpdateError,
  type SelfUpdateFailure,
  type SelfUpdateMarker,
  selfUpdateMarkerPath,
  serverRuntimeUrl,
  switchToVersion,
  writeSelfUpdateMarker,
} from "./self-update.js";
import {
  type DistStub,
  fakeNpm,
  HOST_PATH_TOKEN_RE,
  layOutVersion,
  SCRATCH_NODE_PATH,
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

async function failureOf(p: Promise<unknown>, failure: SelfUpdateFailure): Promise<SelfUpdateError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SelfUpdateError);
  const e = err as SelfUpdateError;
  expect(e.failure).toBe(failure);
  expect(e.message).toBe(SELF_UPDATE_FAILURE_SENTENCES[failure]);
  // E23 / PD-25: what may leave the device never names a host path.
  expect(e.message).not.toMatch(HOST_PATH_TOKEN_RE);
  if (e.detail !== null) expect(e.detail).not.toMatch(HOST_PATH_TOKEN_RE);
  return e;
}

/** D-07: a failure before the switch leaves the server running what it ran. */
function expectUntouched(installJson: Buffer): void {
  expect(readlinkSync(join(runtime(), "current"))).toBe(`versions/${home.oldSha12}`);
  expect(installJsonBytes().equals(installJson)).toBe(true);
  expect(readdirSync(join(runtime(), "versions")).filter((n) => n.startsWith(".staging-"))).toEqual([]);
  expect(existsSync(join(runtime(), "versions", stub.manifest.sha256.slice(0, 12)))).toBe(false);
}

const npmReport = () => join(runtime(), "versions", "fake-npm-report.json");

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("prepareVersion failures (07.17.1, D-07, E1–E10, E23)", () => {
  it("one extra byte in the bundle → checksum (E1)", async () => {
    const before = installJsonBytes();
    const opts = await options();
    stub.set("extra_byte");
    await failureOf(prepareVersion(opts), "checksum");
    expectUntouched(before);
  });

  it("a bundle streaming past manifest.bytes → checksum, and the download stops at the cap (E2)", async () => {
    const before = installJsonBytes();
    const opts = await options();
    stub.set("oversize");
    await failureOf(prepareVersion(opts), "checksum");
    await waitFor(() => stub.bundleClosedEarly);
    expect(stub.bundleClosedEarly).toBe(true);
    expectUntouched(before);
  });

  it("a redirect from /version → unreachable; the redirect target is never requested (E3)", async () => {
    stub.set("redirect");
    await failureOf(fetchServedManifest({ serverUrl: stub.url, env }), "unreachable");
    expect(stub.requests).toEqual([RUNTIME_ROUTES.version]);
    expect(stub.redirectRequests).toEqual([]);
  });

  it("a 503 → unreachable; a manifest with a bad field or no JSON → bad_manifest", async () => {
    stub.set("unavailable");
    await failureOf(fetchServedManifest({ serverUrl: stub.url, env }), "unreachable");
    stub.set("ok");
    const badSha = JSON.stringify({ ...stub.manifest, sha256: "x".repeat(64) });
    const f: typeof fetch = async () => new Response(badSha, { status: 200 });
    await failureOf(fetchServedManifest({ serverUrl: stub.url, env, fetch: f }), "bad_manifest");
    const notJson: typeof fetch = async () => new Response("<html>", { status: 200 });
    await failureOf(fetchServedManifest({ serverUrl: stub.url, env, fetch: notJson }), "bad_manifest");
  });

  it("review WR-04: a manifest a later release extended (unknown keys) still parses and prepares; the extra keys are dropped", async () => {
    const later = JSON.stringify({
      ...stub.manifest,
      signature: "sig",
      installCommand: "run-me",
      source: { ...stub.manifest.source, tag: "v0.3.2" },
    });
    const f: typeof fetch = async () => new Response(later, { status: 200 });
    const manifest = await fetchServedManifest({ serverUrl: stub.url, env, fetch: f });
    expect(manifest).toEqual(stub.manifest);
    expect(manifest).not.toHaveProperty("installCommand");
    const opts = await options();
    const prepared = await prepareVersion({ ...opts, manifest });
    expect(prepared.sha12).toBe(stub.manifest.sha256.slice(0, 12));
  });

  it("a server that never answers → unreachable at the timeout", async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    await failureOf(
      fetchServedManifest({ serverUrl: stub.url, env, fetch: hang, timeoutMs: 50 }),
      "unreachable",
    );
  });

  it("the http rule is install.sh's: https, loopback or OCW_INSTALL_ALLOW_HTTP=1 (E4)", () => {
    const route = RUNTIME_ROUTES.version;
    expect(serverRuntimeUrl("https://ocw.example", route, {}).href).toBe(`https://ocw.example${route}`);
    expect(serverRuntimeUrl("https://ocw.example/", route, {}).href).toBe(`https://ocw.example${route}`);
    expect(serverRuntimeUrl("http://localhost:1", route, {}).href).toBe(`http://localhost:1${route}`);
    expect(serverRuntimeUrl("http://127.0.0.1:1", route, {}).href).toBe(`http://127.0.0.1:1${route}`);
    expect(serverRuntimeUrl("http://ocw.example", route, { OCW_INSTALL_ALLOW_HTTP: "1" }).href).toBe(
      `http://ocw.example${route}`,
    );
    for (const bad of [
      "http://ocw.example",
      "http://127.0.0.1.nip.io",
      "http://127.1..1",
      "ftp://ocw.example",
      "ocw.example",
    ]) {
      expect(() => serverRuntimeUrl(bad, route, {}), bad).toThrow(SELF_UPDATE_FAILURE_SENTENCES.insecure_url);
    }
    expect(() => serverRuntimeUrl("http://ocw.example", route, { OCW_INSTALL_ALLOW_HTTP: "true" })).toThrow(
      SelfUpdateError,
    );
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.1.")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.nip.io")).toBe(false);
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
  });

  it("refuses plain http to a non-loopback server before any request (E4)", async () => {
    const f: typeof fetch = async () => {
      throw new Error("must not be called");
    };
    await failureOf(fetchServedManifest({ serverUrl: "http://ocw.example", env, fetch: f }), "insecure_url");
  });

  it("a lockfile whose hash is not the manifest's → bad_lockfile, npm never ran (E5)", async () => {
    const before = installJsonBytes();
    const opts = await options();
    stub.set("wrong_lock");
    await failureOf(prepareVersion(opts), "bad_lockfile");
    expect(existsSync(npmReport())).toBe(false);
    expectUntouched(before);
  });

  it("a lockfile with the right hash but other pins → bad_lockfile, npm never ran (E5)", async () => {
    const before = installJsonBytes();
    const manifest = { ...stub.manifest, external: [{ name: CLAUDE_AGENT_SDK_PACKAGE, version: "9.9.9" }] };
    await failureOf(prepareVersion(await options({ manifest })), "bad_lockfile");
    expect(existsSync(npmReport())).toBe(false);
    expectUntouched(before);
  });

  it("npm exiting non-zero → npm_failed; its output reaches only the scrubbed detail", async () => {
    const before = installJsonBytes();
    writeFileSync(join(runtime(), "versions", "fake-update.json"), JSON.stringify({ exitCode: 1 }));
    const err = await failureOf(prepareVersion(await options()), "npm_failed");
    expect(err.detail).toContain("npm error code EACCES");
    expectUntouched(before);
  });

  it("no npm beside node and none on PATH → npm_missing", async () => {
    const before = installJsonBytes();
    const bin = join(home.ocwHome, "..", "node-only-bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    const empty = join(home.ocwHome, "..", "empty-path");
    mkdirSync(empty);
    const opts = await options({ npmPath: null, execPath: join(bin, "node"), env: { ...env, PATH: empty } });
    await failureOf(prepareVersion(opts), "npm_missing");
    expectUntouched(before);
  });

  it("an npm outside the OS temp directory is refused in tests (PD-19)", async () => {
    const before = installJsonBytes();
    await failureOf(prepareVersion(await options({ npmPath: "/usr/bin/env" })), "outside_scratch_home");
    expect(stub.requests).toEqual([RUNTIME_ROUTES.version]);
    expectUntouched(before);
  });

  it("a bundle that reports another version → wrong_version, not kept (E7)", async () => {
    const before = installJsonBytes();
    stub.serve("0.3.2", `import "${CLAUDE_AGENT_SDK_PACKAGE}";\nconsole.log("0.3.9");\n`);
    await failureOf(prepareVersion(await options()), "wrong_version");
    expectUntouched(before);
  });

  it("a bundle that throws on start → preflight_failed", async () => {
    const before = installJsonBytes();
    stub.serve("0.3.2", `import "${CLAUDE_AGENT_SDK_PACKAGE}";\nthrow new Error("boom at /opt/x/y");\n`);
    const err = await failureOf(prepareVersion(await options()), "preflight_failed");
    expect(err.detail).toContain("boom");
    expectUntouched(before);
  });

  it("a manifest needing a newer Node → node_too_old before any bundle request (E8)", async () => {
    const before = installJsonBytes();
    const opts = await options();
    await failureOf(prepareVersion({ ...opts, manifest: { ...opts.manifest, minNode: 99 } }), "node_too_old");
    expect(stub.requests).toEqual([RUNTIME_ROUTES.version]);
    expectUntouched(before);
  });

  it("too little free space → disk_full before any bundle request (E9)", async () => {
    const before = installJsonBytes();
    const opts = await options({ freeBytes: async () => 1024 * 1024 });
    await failureOf(prepareVersion(opts), "disk_full");
    expect(stub.requests).toEqual([RUNTIME_ROUTES.version]);
    expectUntouched(before);
  });

  it("an unknown free space (statfs failing) does not block", async () => {
    const prepared = await prepareVersion(
      await options({
        freeBytes: async () => {
          throw new Error("statfs not supported");
        },
      }),
    );
    expect(prepared.reused).toBe(false);
  });

  it("an OCW_HOME inside the OS user's home is refused before any request or write (PD-19)", async () => {
    const inside = join(userInfo().homedir, `.ocw-self-update-test-${RUN_ID}`);
    const opts = await options({ manifest: stub.manifest, ocwHome: inside });
    await failureOf(prepareVersion(opts), "outside_scratch_home");
    expect(stub.requests).toEqual([]);
    expect(existsSync(inside)).toBe(false);
  });

  it("a complete versions/<sha12> with the right hash is reused: no bundle request, no npm (E10)", async () => {
    const before = installJsonBytes();
    const new12 = stub.manifest.sha256.slice(0, 12);
    layOutVersion(join(runtime(), "versions", new12), stub.bundle);
    const prepared = await prepareVersion(await options());
    expect(prepared).toEqual({ manifest: stub.manifest, sha12: new12, reused: true });
    expect(stub.requests).toEqual([RUNTIME_ROUTES.version]);
    expect(existsSync(npmReport())).toBe(false);
    expect(readlinkSync(join(runtime(), "current"))).toBe(`versions/${home.oldSha12}`);
    expect(installJsonBytes().equals(before)).toBe(true);
  });

  it("an incomplete versions/<sha12> (no SDK) is rebuilt", async () => {
    const new12 = stub.manifest.sha256.slice(0, 12);
    mkdirSync(join(runtime(), "versions", new12), { recursive: true });
    writeFileSync(join(runtime(), "versions", new12, "ocw-runtime.mjs"), stub.bundle);
    const prepared = await prepareVersion(await options());
    expect(prepared.reused).toBe(false);
    expect(
      existsSync(
        join(runtime(), "versions", new12, "node_modules", CLAUDE_AGENT_SDK_PACKAGE, "package.json"),
      ),
    ).toBe(true);
  });
});

function marker(over: Partial<SelfUpdateMarker> = {}): SelfUpdateMarker {
  return {
    runId: RUN_ID,
    commandId: "0d6c1c38-2f7e-4a8b-9a51-6c0f1e2d3b4a",
    trigger: "manual",
    from: { version: "0.3.1", sha256: home.oldSha256 },
    to: { version: "0.3.2", sha256: stub.manifest.sha256 },
    startedAt: "2026-11-11T12:00:00.000Z",
    ...over,
  };
}

const markerFile = () => join(runtime(), "self-update.json");

describe("the self-update marker (07.17.1, PD-08, PD-12)", () => {
  it("round-trips through a 0600 file", async () => {
    const m = marker();
    await writeSelfUpdateMarker(home.ocwHome, m);
    expect(selfUpdateMarkerPath(home.ocwHome)).toBe(markerFile());
    expect(statSync(markerFile()).mode & 0o777).toBe(0o600);
    expect(await readSelfUpdateMarker(home.ocwHome)).toEqual(m);
    expect(readFileSync(markerFile(), "utf8")).not.toMatch(HOST_PATH_TOKEN_RE);
  });

  it("reads an extra key, a bad sha256 or no file as null; removing a missing marker resolves", async () => {
    writeFileSync(markerFile(), JSON.stringify({ ...marker(), path: "/home/x" }));
    expect(await readSelfUpdateMarker(home.ocwHome)).toBeNull();
    writeFileSync(markerFile(), JSON.stringify(marker({ to: { version: "0.3.2", sha256: "x" } })));
    expect(await readSelfUpdateMarker(home.ocwHome)).toBeNull();
    writeFileSync(markerFile(), "{");
    expect(await readSelfUpdateMarker(home.ocwHome)).toBeNull();
    await removeSelfUpdateMarker(home.ocwHome);
    expect(existsSync(markerFile())).toBe(false);
    expect(await readSelfUpdateMarker(home.ocwHome)).toBeNull();
    await expect(removeSelfUpdateMarker(home.ocwHome)).resolves.toBeUndefined();
  });

  it("refuses to write a marker that does not parse", async () => {
    await expect(writeSelfUpdateMarker(home.ocwHome, marker({ runId: "not-a-uuid" }))).rejects.toThrow();
    expect(existsSync(markerFile())).toBe(false);
  });
});

describe("switchToVersion (07.17.1, D-03, PD-08, E11)", () => {
  async function prepared() {
    return prepareVersion(await options());
  }

  /** The real fs calls, recorded by destination name. */
  function spyFs(order: string[], failOn?: string) {
    return {
      rename: async (from: string, to: string) => {
        order.push(`rename:${basename(to)}`);
        if (failOn && basename(to) === failOn)
          throw Object.assign(new Error(`EIO: rename ${to}`), { code: "EIO" });
        return rename(from, to);
      },
      symlink: async (target: string, path: string) => {
        order.push(`symlink:${target}`);
        return symlink(target, path);
      },
    };
  }

  it("writes the marker, swaps current atomically to the relative new version, then rewrites install.json", async () => {
    const p = await prepared();
    const order: string[] = [];
    await switchToVersion({
      ocwHome: home.ocwHome,
      prepared: p,
      marker: marker(),
      serverUrl: stub.url,
      now: () => new Date("2026-11-11T12:01:00.000Z"),
      fs: spyFs(order),
    });
    expect(order).toEqual([
      "rename:self-update.json",
      `symlink:versions/${p.sha12}`,
      "rename:current",
      "rename:install.json",
    ]);
    expect(readlinkSync(join(runtime(), "current"))).toBe(`versions/${p.sha12}`);
    expect(realpathSync(join(runtime(), "current", "ocw-runtime.mjs"))).toBe(
      join(realpathSync(runtime()), "versions", p.sha12, "ocw-runtime.mjs"),
    );
    // The previous version stays for a rollback (PD-08).
    expect(existsSync(join(runtime(), "versions", home.oldSha12, "ocw-runtime.mjs"))).toBe(true);
    expect(await readSelfUpdateMarker(home.ocwHome)).toEqual(marker());
    expect(readdirSync(runtime()).filter((n) => n.startsWith("current.tmp-"))).toEqual([]);

    const file = join(runtime(), "install.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const info = RuntimeInstallInfo.parse(JSON.parse(readFileSync(file, "utf8")));
    expect(info).toEqual({
      serverUrl: stub.url,
      version: "0.3.2",
      sha256: stub.manifest.sha256,
      installedAt: "2026-11-11T12:01:00.000Z",
      nodePath: SCRATCH_NODE_PATH,
    });
  });

  it("replaces a leftover current.tmp-<pid> that points elsewhere (E11)", async () => {
    const p = await prepared();
    symlinkSync("versions/elsewhere", join(runtime(), `current.tmp-${process.pid}`));
    await switchToVersion({ ocwHome: home.ocwHome, prepared: p, marker: marker(), serverUrl: stub.url });
    expect(readlinkSync(join(runtime(), "current"))).toBe(`versions/${p.sha12}`);
    expect(readdirSync(runtime()).filter((n) => n.startsWith("current.tmp-"))).toEqual([]);
  });

  it("with no previous install record, the new record names the node that runs the daemon", async () => {
    const p = await prepared();
    rmSync(join(runtime(), "install.json"));
    await switchToVersion({ ocwHome: home.ocwHome, prepared: p, marker: marker(), serverUrl: stub.url });
    const info = RuntimeInstallInfo.parse(JSON.parse(readFileSync(join(runtime(), "install.json"), "utf8")));
    expect(info.nodePath).toBe(process.execPath);
    expect(info.version).toBe("0.3.2");
  });

  it("a failed link rename → switch_failed; current still resolves to the old version, no marker left", async () => {
    const p = await prepared();
    const before = installJsonBytes();
    const err = await failureOf(
      switchToVersion({
        ocwHome: home.ocwHome,
        prepared: p,
        marker: marker(),
        serverUrl: stub.url,
        fs: spyFs([], "current"),
      }),
      "switch_failed",
    );
    expect(err.detail).not.toMatch(HOST_PATH_TOKEN_RE);
    expect(readlinkSync(join(runtime(), "current"))).toBe(`versions/${home.oldSha12}`);
    expect(realpathSync(join(runtime(), "current", "ocw-runtime.mjs"))).toBe(
      join(realpathSync(runtime()), "versions", home.oldSha12, "ocw-runtime.mjs"),
    );
    expect(installJsonBytes().equals(before)).toBe(true);
    expect(existsSync(markerFile())).toBe(false);
    expect(readdirSync(runtime()).filter((n) => n.startsWith("current.tmp-"))).toEqual([]);
  });

  it("a server URL that is not a URL → switch_failed before anything changes", async () => {
    const p = await prepared();
    const before = installJsonBytes();
    await failureOf(
      switchToVersion({ ocwHome: home.ocwHome, prepared: p, marker: marker(), serverUrl: "not a url" }),
      "switch_failed",
    );
    expect(readlinkSync(join(runtime(), "current"))).toBe(`versions/${home.oldSha12}`);
    expect(installJsonBytes().equals(before)).toBe(true);
    expect(existsSync(markerFile())).toBe(false);
  });

  it("a prepared version that is not on disk → switch_failed, current untouched", async () => {
    const p = await prepared();
    rmSync(join(runtime(), "versions", p.sha12), { recursive: true });
    await failureOf(
      switchToVersion({ ocwHome: home.ocwHome, prepared: p, marker: marker(), serverUrl: stub.url }),
      "switch_failed",
    );
    expect(readlinkSync(join(runtime(), "current"))).toBe(`versions/${home.oldSha12}`);
    expect(existsSync(markerFile())).toBe(false);
  });
});
