// Phase 07.17.1 (ADR-0040, PD-19): test-only helpers for the runtime self-update. Never imported by production code.
//
// A scratch `OCW_HOME` laid out exactly as `install.sh` leaves it (`runtime/versions/<sha12>/`, a relative `current`
// link, a 0600 `install.json`), a loopback stub of the workspace's three runtime routes, a fake `npm` (a copy of
// `fake-cli/fake-cli.mjs` whose `ci` role lays out a stub SDK) and a tiny bundle. Nothing here reaches the network, the
// real npm registry, a service manager or the OS user's real home: the scratch home lives under the OS temp directory
// and is refused when that is inside the user's home.

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_AGENT_SDK_PACKAGE,
  RUNTIME_BUNDLE_FILE,
  RUNTIME_EXTERNAL_LOCK_FILE,
  RUNTIME_EXTERNAL_LOCK_ROOT,
  RUNTIME_ROUTES,
  type RuntimeDistManifest,
  runtimeExternalFiles,
} from "@ocw/contracts";

/** The SDK version the stub pins (any exact version works: the fake npm installs whatever the lock names). */
export const STUB_SDK_VERSION = "0.3.282";

/** A host path token as PD-25 forbids it in anything sent off the device (messages, frames, markers). */
export const HOST_PATH_TOKEN_RE = /\/(home|tmp|opt|usr|var|Users|private)\//;

const FAKE_CLI = fileURLToPath(new URL("./fake-cli/fake-cli.mjs", import.meta.url));

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** A tiny ESM bundle: imports the SDK beside it (so it fails without `node_modules`) and prints `version`. */
export function testBundle(version: string): string {
  return (
    `import "${CLAUDE_AGENT_SDK_PACKAGE}";\n` +
    `if (process.argv[2] === "version") console.log(${JSON.stringify(version)});\n`
  );
}

/** The external lockfile the stub serves: lockfile v3 rooted at the manifest's pins, like the real build's. */
export function testLock(sdkVersion = STUB_SDK_VERSION): string {
  return `${JSON.stringify(
    {
      name: RUNTIME_EXTERNAL_LOCK_ROOT,
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: RUNTIME_EXTERNAL_LOCK_ROOT, dependencies: { [CLAUDE_AGENT_SDK_PACKAGE]: sdkVersion } },
        [`node_modules/${CLAUDE_AGENT_SDK_PACKAGE}`]: {
          version: sdkVersion,
          resolved: `https://registry.npmjs.org/${CLAUDE_AGENT_SDK_PACKAGE}/-/claude-agent-sdk-${sdkVersion}.tgz`,
          integrity: `sha512-${"A".repeat(86)}==`,
        },
      },
    },
    null,
    2,
  )}\n`;
}

/** A manifest `RuntimeDistManifest.parse` accepts for `bundle` and `lock`. */
export function testManifest(version: string, bundle: string, lock: string): RuntimeDistManifest {
  return {
    version,
    sha256: sha256(bundle),
    bytes: Buffer.byteLength(bundle),
    file: RUNTIME_BUNDLE_FILE,
    minNode: 24,
    external: [{ name: CLAUDE_AGENT_SDK_PACKAGE, version: STUB_SDK_VERSION }],
    externalLockSha256: sha256(lock),
    bundled: [],
    source: { repository: "https://github.com/example/ocw", commit: null },
    builtAt: "2026-11-11T10:00:00.000Z",
  };
}

export type DistStubMode = "ok" | "extra_byte" | "oversize" | "wrong_lock" | "redirect" | "unavailable";

export interface DistStub {
  /** `http://127.0.0.1:<port>`: the device's `config.serverUrl` in tests. */
  url: string;
  /** The manifest served now. */
  readonly manifest: RuntimeDistManifest;
  /** The bundle text served now. */
  readonly bundle: string;
  /** The lockfile text served now. */
  readonly lock: string;
  /** Every request path the stub received, in order. */
  requests: string[];
  /** Every request path the redirect target (another loopback port) received: must stay empty. */
  redirectRequests: string[];
  /** Whether a bundle response was closed by the client before the stub finished writing it. */
  readonly bundleClosedEarly: boolean;
  set(mode: DistStubMode): void;
  serve(version: string, bundle?: string): void;
  close(): Promise<void>;
}

const MIB = 1024 * 1024;

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/** Writes `body` in 64 KiB chunks with a pause between them, so a client that stops reading is seen to close early. */
async function slowWrite(res: ServerResponse, body: Buffer, onClosedEarly: () => void): Promise<void> {
  let closed = false;
  res.once("close", () => {
    if (!res.writableFinished) {
      closed = true;
      onClosedEarly();
    }
  });
  for (let at = 0; at < body.byteLength && !closed; at += 64 * 1024) {
    const ok = res.write(body.subarray(at, at + 64 * 1024));
    if (!ok) await new Promise<void>((r) => res.once("drain", () => r()).once("close", () => r()));
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!closed) res.end();
}

/**
 * The workspace's runtime routes on `127.0.0.1` (`node:http` only): `version` (the manifest), `bundle` and
 * `externalLock`, in the mode set by `set()`.
 */
export async function startDistStub(opts: { version?: string; bundle?: string } = {}): Promise<DistStub> {
  let mode: DistStubMode = "ok";
  let bundle = opts.bundle ?? testBundle(opts.version ?? "0.3.2");
  const lock = testLock();
  let manifest = testManifest(opts.version ?? "0.3.2", bundle, lock);
  let bundleClosedEarly = false;
  const requests: string[] = [];
  const redirectRequests: string[] = [];

  const target = createServer((req: IncomingMessage, res: ServerResponse) => {
    redirectRequests.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(manifest));
  });
  const targetUrl = await listen(target);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? "";
    requests.push(path);
    if (mode === "unavailable") {
      res.writeHead(503, { "content-type": "application/json" }).end('{"code":"runtime_unavailable"}');
      return;
    }
    if (path === RUNTIME_ROUTES.version) {
      if (mode === "redirect") {
        res.writeHead(302, { location: `${targetUrl}${RUNTIME_ROUTES.version}` }).end();
        return;
      }
      res
        .writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" })
        .end(JSON.stringify(manifest));
      return;
    }
    if (path === RUNTIME_ROUTES.bundle) {
      const base = Buffer.from(bundle);
      if (mode === "oversize") {
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        void slowWrite(res, Buffer.concat([base, Buffer.alloc(MIB, 0x20)]), () => {
          bundleClosedEarly = true;
        });
        return;
      }
      const body = mode === "extra_byte" ? Buffer.concat([base, Buffer.from(" ")]) : base;
      res
        .writeHead(200, {
          "content-type": "text/javascript; charset=utf-8",
          "content-length": String(body.byteLength),
          "x-content-sha256": manifest.sha256,
        })
        .end(body);
      return;
    }
    if (path === RUNTIME_ROUTES.externalLock) {
      // A changed byte: still a valid lockfile, but its hash is not the manifest's.
      const body = mode === "wrong_lock" ? `${lock} ` : lock;
      res
        .writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "x-content-sha256": manifest.externalLockSha256,
        })
        .end(body);
      return;
    }
    res.writeHead(404).end();
  });
  const url = await listen(server);

  return {
    url,
    get manifest() {
      return manifest;
    },
    get bundle() {
      return bundle;
    },
    get lock() {
      return lock;
    },
    requests,
    redirectRequests,
    get bundleClosedEarly() {
      return bundleClosedEarly;
    },
    set(next) {
      mode = next;
    },
    serve(version, nextBundle) {
      bundle = nextBundle ?? testBundle(version);
      manifest = testManifest(version, bundle, lock);
    },
    close: async () => {
      for (const s of [server, target]) {
        s.closeAllConnections();
        await new Promise<void>((r) => s.close(() => r()));
      }
    },
  };
}

export interface ScratchHome {
  /** The scratch `OCW_HOME` (a real path under the OS temp directory, never under the user's home). */
  ocwHome: string;
  /** The installed build's directory name and sha256 ("" when nothing is installed). */
  oldSha12: string;
  oldSha256: string;
  /** The `nodePath` written into the scratch `install.json`. */
  nodePath: string;
  cleanup(): void;
}

/** The `nodePath` of a scratch install record: a fake absolute path, never run. */
export const SCRATCH_NODE_PATH = "/opt/ocw-test-node/bin/node";

function insideDir(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

/** Writes a complete version directory as `install.sh` leaves it: bundle, npm files and a stub SDK. */
export function layOutVersion(dir: string, bundle: string, lock = testLock()): void {
  mkdirSync(join(dir, "node_modules", CLAUDE_AGENT_SDK_PACKAGE), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, RUNTIME_BUNDLE_FILE), bundle, { mode: 0o600 });
  const files = runtimeExternalFiles(testManifest("0.0.0", bundle, lock), lock);
  writeFileSync(join(dir, "package.json"), files.packageJson, { mode: 0o600 });
  writeFileSync(join(dir, RUNTIME_EXTERNAL_LOCK_FILE), files.lock, { mode: 0o600 });
  const sdk = join(dir, "node_modules", CLAUDE_AGENT_SDK_PACKAGE);
  writeFileSync(
    join(sdk, "package.json"),
    `${JSON.stringify({ name: CLAUDE_AGENT_SDK_PACKAGE, version: STUB_SDK_VERSION, main: "index.js" })}\n`,
  );
  writeFileSync(join(sdk, "index.js"), "module.exports = {};\n");
}

/**
 * A scratch `OCW_HOME` with an installed runtime (default 0.3.1), or none with `installed: null`. Throws when the OS
 * temp directory is inside the user's home (PD-19: no test may write there).
 */
export async function scratchOcwHome(
  opts: { installed?: { version: string; bundle: string } | null } = {},
): Promise<ScratchHome> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ocw-self-update-")));
  const home = userInfo().homedir;
  let realHome = home;
  try {
    realHome = realpathSync(home);
  } catch {
    // no home on disk
  }
  if (insideDir(root, home) || insideDir(root, realHome)) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      "the OS temp directory is inside the user's home; refusing to build a scratch OCW_HOME there",
    );
  }
  const ocwHome = join(root, "ocw");
  const runtime = join(ocwHome, "runtime");
  mkdirSync(join(runtime, "versions"), { recursive: true, mode: 0o700 });
  const installed =
    opts.installed === undefined ? { version: "0.3.1", bundle: testBundle("0.3.1") } : opts.installed;
  let oldSha256 = "";
  let oldSha12 = "";
  if (installed) {
    oldSha256 = sha256(installed.bundle);
    oldSha12 = oldSha256.slice(0, 12);
    layOutVersion(join(runtime, "versions", oldSha12), installed.bundle);
    symlinkSync(`versions/${oldSha12}`, join(runtime, "current"));
    writeFileSync(
      join(runtime, "install.json"),
      `${JSON.stringify(
        {
          serverUrl: "https://ocw.example",
          version: installed.version,
          sha256: oldSha256,
          installedAt: "2026-11-01T10:00:00.000Z",
          nodePath: SCRATCH_NODE_PATH,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }
  return {
    ocwHome,
    oldSha12,
    oldSha256,
    nodePath: SCRATCH_NODE_PATH,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * A fake `npm` in `dir` (a copy of `fake-cli.mjs` named `npm`): `ci --prefix <p> …` lays out a stub SDK under `<p>`
 * and reports its argv, env names and first PATH entry in `<p>/../fake-npm-report.json`. Returns its path.
 */
export async function fakeNpm(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const npm = join(dir, "npm");
  copyFileSync(FAKE_CLI, npm);
  chmodSync(npm, 0o755);
  return npm;
}
