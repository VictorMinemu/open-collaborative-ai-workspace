import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeDistManifest } from "@ocw/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertScriptSafeUrl, renderInstallScript } from "./install-script";

/**
 * Phase 07.12-06 (HSR-01, D-01, D-10, PD-04, PD-05): the installer the API serves at `/api/v1/runtime/install.sh`.
 * The rendering cases check what is embedded and how; the behaviour cases below run the rendered script with `sh`
 * in a scratch HOME against a loopback stub, with a fake npm (PD-19: never the real HOME, npm or network).
 */

const SHA = "a".repeat(64);

function manifestFor(bundle: Buffer | string, version = "0.1.0"): RuntimeDistManifest {
  const bytes = Buffer.from(bundle);
  return {
    version,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    file: "ocw-runtime.mjs",
    minNode: 24,
    external: [
      { name: "@anthropic-ai/claude-agent-sdk", version: "0.3.282" },
      { name: "@anthropic-ai/sdk", version: "0.128.0" },
      { name: "@modelcontextprotocol/sdk", version: "1.30.1" },
      { name: "zod", version: "4.6.5" },
    ],
    bundled: [{ name: "ws", version: "8.21.3", license: "MIT" }],
    source: { repository: "https://github.com/VictorMinemu/open-collaborative-ai-workspace", commit: null },
    builtAt: "2026-10-29T08:00:00.000Z",
  };
}

const MANIFEST: RuntimeDistManifest = { ...manifestFor("x"), sha256: SHA };

describe("assertScriptSafeUrl (07.12-06, PD-05)", () => {
  it.each([
    "javascript:x",
    "https://u:p@h",
    "https://h/?q",
    "https://h/#f",
    "https://h/$(id)",
    "https://h/'x",
    "ftp://h.example",
    "https://h example",
    "https://h/`id`",
    "https://h/\nx",
    "",
  ])("refuses %j", (url) => {
    expect(() => assertScriptSafeUrl(url)).toThrow();
  });

  it.each([
    ["https://ocw.example.com", "https://ocw.example.com"],
    ["http://127.0.0.1:4290", "http://127.0.0.1:4290"],
    ["https://h.example/ocw", "https://h.example/ocw"],
    ["https://ocw.example.com/", "https://ocw.example.com"],
  ])("accepts %j (no trailing slash)", (url, expected) => {
    expect(assertScriptSafeUrl(url)).toBe(expected);
  });
});

describe("renderInstallScript (07.12-06, PD-04)", () => {
  const script = renderInstallScript({ serverUrl: "https://ocw.example.com/", manifest: MANIFEST });
  const lines = script.split("\n");

  it("is a POSIX sh script whose body runs only from main(), called on the last line", () => {
    expect(lines[0]).toBe("#!/bin/sh");
    expect(script).toContain("set -eu");
    expect(script).toContain("umask 077");
    expect(script).toMatch(/^main\(\) \{$/m);
    expect(script.trimEnd().split("\n").at(-1)).toBe('main "$@"');
  });

  it("embeds the server URL single-quoted, the version, the sha256 and the pins as name@version words", () => {
    expect(script).toContain("'https://ocw.example.com'");
    expect(script).toContain("'0.1.0'");
    expect(script).toContain(`'${SHA}'`);
    expect(script).toContain(`'${SHA.slice(0, 12)}'`);
    expect(script).toContain(
      "'@anthropic-ai/claude-agent-sdk@0.3.282' '@anthropic-ai/sdk@0.128.0' '@modelcontextprotocol/sdk@1.30.1' 'zod@4.6.5'",
    );
    expect(script).toContain("--no-audit --no-fund --omit=optional --ignore-scripts");
  });

  it("refuses an unsafe URL and a manifest that does not parse", () => {
    expect(() => renderInstallScript({ serverUrl: "https://h/$(id)", manifest: MANIFEST })).toThrow();
    expect(() =>
      renderInstallScript({
        serverUrl: "https://ocw.example.com",
        manifest: { ...MANIFEST, version: "1.0.0'; id; '" },
      }),
    ).toThrow();
  });

  it("never elevates and never evaluates text (outside comments)", () => {
    const code = lines.filter((l) => !/^\s*#/.test(l)).join("\n");
    expect(code).not.toMatch(/\bsudo\b/);
    expect(code).not.toMatch(/\beval\b/);
    expect(code).not.toMatch(/\|\s*(ba|da|z)?sh\b/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Behaviour: the rendered script run by `/bin/sh` (dash on Linux) in a scratch HOME. PATH holds only a case's own
// bin directory (a `node` link to this process's node and a fake `npm` that records its arguments and lays out a
// stub SDK) and a tools directory linking the few system commands the script uses, so no developer `~/.local/bin`,
// real npm or other node is ever reachable. The only server is a loopback stub serving the bundle.
// ---------------------------------------------------------------------------------------------------------------

const SDK = "@anthropic-ai/claude-agent-sdk";
const SYSTEM_TOOLS = ["uname", "id", "mktemp", "curl", "mkdir", "rm", "mv", "readlink", "cat", "ln", "chmod"];

const bundleFor = (version: string) =>
  `import "${SDK}";\nif (process.argv[2] === "version") console.log(${JSON.stringify(version)});\n` +
  `if (process.argv[2] === "home") console.log(process.env.OCW_HOME ?? "<unset>");\n`;

let root: string;
let tools: string;
let server: Server;
let stubUrl: string;
const stub = { bundle: bundleFor("0.1.0"), hits: 0 };
let caseSeq = 0;

interface Case {
  dir: string;
  home: string;
  bin: string;
  npmArgs: string;
  path: string;
}

/** A fresh scratch HOME and bin dir. `node`: a link to the real node, a fake that reports `22.12.0`, or none. */
async function newCase(opts: { node?: "real" | "old"; npm?: boolean } = {}): Promise<Case> {
  const dir = join(root, `case-${++caseSeq}`);
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  const npmArgs = join(dir, "npm-args.txt");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  if ((opts.node ?? "real") === "real") {
    await symlink(process.execPath, join(bin, "node"));
  } else {
    await writeFile(join(bin, "node"), "#!/bin/sh\necho 22.12.0\n");
    await chmod(join(bin, "node"), 0o755);
  }
  if (opts.npm ?? true) {
    const sdkDir = `"$prefix/node_modules/${SDK}"`;
    await writeFile(
      join(bin, "npm"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > '${npmArgs}'`,
        "prefix=",
        'while [ $# -gt 0 ]; do if [ "$1" = --prefix ]; then prefix=$2; fi; shift; done',
        `mkdir -p ${sdkDir}`,
        `printf '{"name":"${SDK}","version":"0.3.282","main":"index.js"}\\n' > ${sdkDir}/package.json`,
        `printf 'module.exports = {};\\n' > ${sdkDir}/index.js`,
        "",
      ].join("\n"),
    );
    await chmod(join(bin, "npm"), 0o755);
  }
  return { dir, home, bin, npmArgs, path: `${bin}:${tools}` };
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `sh <file>` with an explicit environment: HOME, PATH, LANG and the case's variables only. */
function sh(file: string, c: Case, env: Record<string, string> = {}, args: string[] = []): Promise<Run> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("/bin/sh", [file, ...args], {
      env: { HOME: c.home, PATH: c.path, LANG: "C", ...env },
      cwd: c.dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function install(c: Case, script: string, env: Record<string, string> = {}): Promise<Run> {
  const file = join(c.dir, "install.sh");
  await writeFile(file, script);
  return sh(file, c, env);
}

const ocwRuntime = (c: Case) => join(c.home, ".ocw", "runtime");
const shimPath = (c: Case) => join(c.home, ".local", "bin", "ocw-runtime");

/** Every path under `dir` (symlinks not followed) whose mode lets the group or others write. */
async function groupOrWorldWritable(dir: string): Promise<string[]> {
  const out: string[] = [];
  const st = await lstat(dir);
  if (!st.isSymbolicLink() && (st.mode & 0o022) !== 0) out.push(dir);
  if (st.isDirectory()) {
    for (const name of await readdir(dir)) out.push(...(await groupOrWorldWritable(join(dir, name))));
  }
  return out;
}

function expectNothingWritten(c: Case) {
  expect(existsSync(join(c.home, ".ocw"))).toBe(false);
  expect(existsSync(join(c.home, ".local"))).toBe(false);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ocw-install-sh-"));
  tools = join(root, "tools");
  await mkdir(tools);
  for (const tool of SYSTEM_TOOLS) {
    const found = ["/usr/bin", "/bin"].map((d) => join(d, tool)).find((p) => existsSync(p));
    if (!found) throw new Error(`the install.sh tests need ${tool} in /usr/bin or /bin`);
    await symlink(found, join(tools, tool));
  }
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/v1/runtime/bundle") {
      stub.hits++;
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
      res.end(stub.bundle);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  stubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((ok) => server?.close(ok));
  if (root) await rm(root, { recursive: true, force: true });
});

describe("install.sh run with sh in a scratch HOME (07.12-06, D-01, D-10, PD-04, PD-19)", {
  timeout: 60_000,
}, () => {
  it("installs the verified bundle with the SDK beside it, current, install.json and a 0755 launcher", async () => {
    stub.bundle = bundleFor("0.1.0");
    const manifest = manifestFor(stub.bundle, "0.1.0");
    const sha12 = manifest.sha256.slice(0, 12);
    const c = await newCase();
    const res = await install(c, renderInstallScript({ serverUrl: stubUrl, manifest }));
    expect(res.code, res.stderr).toBe(0);

    const versionDir = join(ocwRuntime(c), "versions", sha12);
    expect(existsSync(join(versionDir, "ocw-runtime.mjs"))).toBe(true);
    expect(await readlink(join(ocwRuntime(c), "current"))).toBe(`versions/${sha12}`);

    // Exactly the fields apps/local-runtime's RuntimeInstallInfo reads (checked by shape, no cross-app import).
    const info = JSON.parse(await readFile(join(ocwRuntime(c), "install.json"), "utf8")) as Record<
      string,
      string
    >;
    expect(Object.keys(info).sort()).toEqual(["installedAt", "nodePath", "serverUrl", "sha256", "version"]);
    expect(info.serverUrl).toBe(stubUrl);
    expect(info.version).toBe("0.1.0");
    expect(info.sha256).toBe(manifest.sha256);
    expect(new Date(info.installedAt ?? "").toISOString()).toBe(info.installedAt);
    expect(info.nodePath).toBe(join(c.bin, "node"));

    const shim = await stat(shimPath(c));
    expect(shim.mode & 0o777).toBe(0o755);
    const ran = await sh(shimPath(c), c, {}, ["version"]);
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout.trim()).toBe("0.1.0");

    const npmArgs = (await readFile(c.npmArgs, "utf8")).trimEnd().split("\n");
    expect(npmArgs).toEqual([
      "install",
      "--prefix",
      versionDir,
      "--no-audit",
      "--no-fund",
      "--omit=optional",
      "--ignore-scripts",
      ...manifest.external.map((p) => `${p.name}@${p.version}`),
    ]);
    expect(await groupOrWorldWritable(join(c.home, ".ocw"))).toEqual([]);
    expect(res.stdout).toContain("Next: ocw-runtime setup");
    expect(res.stdout).toContain("is not on your PATH");
    expect(res.stdout).not.toContain("service restart");
  });

  it("a bundle whose bytes differ from the embedded sha256 is refused and nothing is installed", async () => {
    stub.bundle = bundleFor("0.1.0");
    const c = await newCase();
    const res = await install(
      c,
      renderInstallScript({ serverUrl: stubUrl, manifest: manifestFor(bundleFor("9.9.9"), "0.1.0") }),
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("checksum mismatch");
    expect(existsSync(join(ocwRuntime(c), "versions"))).toBe(false);
    expect(existsSync(join(ocwRuntime(c), "current"))).toBe(false);
    expect(existsSync(shimPath(c))).toBe(false);
  });

  it("Node below 24 is refused, naming Node 24 and where to get it; nothing is written", async () => {
    const c = await newCase({ node: "old" });
    const hits = stub.hits;
    const res = await install(
      c,
      renderInstallScript({ serverUrl: stubUrl, manifest: manifestFor(stub.bundle) }),
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("Node 24 or later is required (found 22.12.0)");
    expect(res.stderr).toContain("https://nodejs.org");
    expect(stub.hits).toBe(hits);
    expectNothingWritten(c);
  });

  it("a missing npm is refused by name; nothing is written", async () => {
    const c = await newCase({ npm: false });
    const res = await install(
      c,
      renderInstallScript({ serverUrl: stubUrl, manifest: manifestFor(stub.bundle) }),
    );
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("npm is required");
    expectNothingWritten(c);
  });

  it("plain http to a non-loopback host is refused unless OCW_INSTALL_ALLOW_HTTP=1", async () => {
    stub.bundle = bundleFor("0.1.0");
    const script = renderInstallScript({
      serverUrl: "http://ocw.lan:4000",
      manifest: manifestFor(stub.bundle),
    });

    const refused = await newCase();
    const res = await install(refused, script);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("plain http to a non-loopback host");
    expectNothingWritten(refused);

    // The rule applies to OCW_SERVER_URL too. With the flag the script goes on to the download: 0.0.0.0:1 never
    // leaves this machine and refuses the connection at once.
    const viaEnv = await newCase();
    const env = { OCW_SERVER_URL: "http://0.0.0.0:1" };
    expect((await install(viaEnv, script, env)).stderr).toContain("plain http to a non-loopback host");
    const allowed = await install(viaEnv, script, { ...env, OCW_INSTALL_ALLOW_HTTP: "1" });
    expect(allowed.code).not.toBe(0);
    expect(allowed.stderr).not.toContain("plain http");
    expect(allowed.stderr).toContain(
      "could not download the runtime from http://0.0.0.0:1/api/v1/runtime/bundle",
    );
    expectNothingWritten(viaEnv);

    // OCW_SERVER_URL reaches the stub (a container reaching the API by another name) and is what install.json keeps.
    const ok = await newCase();
    const done = await install(ok, script, { OCW_SERVER_URL: stubUrl, OCW_INSTALL_ALLOW_HTTP: "1" });
    expect(done.code, done.stderr).toBe(0);
    const info = JSON.parse(await readFile(join(ocwRuntime(ok), "install.json"), "utf8"));
    expect(info.serverUrl).toBe(stubUrl);
  });

  it("an OCW_HOME given at install is kept by the launcher (ME-02); the default adds nothing", async () => {
    stub.bundle = bundleFor("0.1.0");
    const script = renderInstallScript({ serverUrl: stubUrl, manifest: manifestFor(stub.bundle) });

    const custom = await newCase();
    const home = join(custom.dir, "srv o'cw $x");
    const res = await install(custom, script, { OCW_HOME: home });
    expect(res.code, res.stderr).toBe(0);
    expect(existsSync(join(home, "runtime", "install.json"))).toBe(true);
    // Every later command (setup, service install, doctor) sees the install's home without OCW_HOME exported...
    const ran = await sh(shimPath(custom), custom, {}, ["home"]);
    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout.trim()).toBe(home);
    // ...and an explicit OCW_HOME still wins.
    const other = await sh(shimPath(custom), custom, { OCW_HOME: "/elsewhere" }, ["home"]);
    expect(other.stdout.trim()).toBe("/elsewhere");

    const plain = await newCase();
    expect((await install(plain, script)).code).toBe(0);
    expect(await readFile(shimPath(plain), "utf8")).not.toContain("OCW_HOME");
    expect((await sh(shimPath(plain), plain, {}, ["home"])).stdout.trim()).toBe("<unset>");
  });

  it("a truncated download runs nothing", async () => {
    const script = renderInstallScript({ serverUrl: stubUrl, manifest: manifestFor(stub.bundle) });
    const lines = script.split("\n");
    const half = lines.slice(0, Math.floor(lines.length / 2)).join("\n");
    expect(half).toMatch(/^main\(\) \{$/m);
    expect(half).not.toContain('main "$@"');
    const c = await newCase();
    const hits = stub.hits;
    await install(c, `${half}\n`);
    expect(stub.hits).toBe(hits);
    expectNothingWritten(c);
  });

  it("re-runs upgrade: the previous version is kept, older ones removed, and the restart hint is shown", async () => {
    const c = await newCase();
    const shas: string[] = [];
    const runs: Run[] = [];
    for (const version of ["0.1.0", "0.1.1", "0.1.2"]) {
      stub.bundle = bundleFor(version);
      const manifest = manifestFor(stub.bundle, version);
      shas.push(manifest.sha256.slice(0, 12));
      const res = await install(c, renderInstallScript({ serverUrl: stubUrl, manifest }));
      expect(res.code, res.stderr).toBe(0);
      runs.push(res);
    }
    expect(runs[0]?.stdout).not.toContain("ocw-runtime service restart");
    expect(runs[1]?.stdout).toContain(
      "If the service runs, restart it when no session runs: ocw-runtime service restart",
    );
    expect((await readdir(join(ocwRuntime(c), "versions"))).sort()).toEqual([shas[1], shas[2]].sort());
    expect(await readlink(join(ocwRuntime(c), "current"))).toBe(`versions/${shas[2]}`);
    const ran = await sh(shimPath(c), c, {}, ["version"]);
    expect(ran.stdout.trim()).toBe("0.1.2");

    // The same version again reuses its directory (no npm run) and removes nothing.
    await rm(c.npmArgs);
    const again = await install(
      c,
      renderInstallScript({ serverUrl: stubUrl, manifest: manifestFor(stub.bundle, "0.1.2") }),
    );
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("reusing it");
    expect(existsSync(c.npmArgs)).toBe(false);
    expect((await readdir(join(ocwRuntime(c), "versions"))).sort()).toEqual([shas[1], shas[2]].sort());
  });
});
