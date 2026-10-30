import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { APIRequestContext } from "@playwright/test";

/**
 * A Work Zone server set up the way an owner does it (07.12-09, PD-02, PD-19): the workspace's own install script
 * (`curl -fsSL <api>/api/v1/runtime/install.sh | sh`) installs the bundle the API serves into a scratch HOME, then the
 * INSTALLED `ocw-runtime setup --yes --service none` pairs it by device code (the spec approves the printed link in
 * Settings › Devices) and registers a scratch repository, and `start()` runs the installed daemon. No checkout source,
 * no desktop app.
 *
 * PD-19, nothing here reaches the developer's machine:
 *   - every child gets an explicit env (never this process's: no inherited `OCW_*`, never the real HOME) with a scratch
 *     `HOME` (`OCW_HOME` = `<HOME>/.ocw`), `OCW_RUNTIME_FAKE=1` and `OCW_RUNTIME_UPDATES=off`;
 *   - `PATH` is a scratch bin (a `node` link to this node and an `npm` that runs `fake-npm.mjs`), the scratch
 *     `~/.local/bin`, `/usr/bin` and `/bin`: no real npm, no real Claude Code or Codex, no developer bin directory;
 *   - `--service none`: no service manager is touched.
 * This file imports nothing from Playwright at runtime, so its unit test runs under vitest.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..");
/** The fake `npm` (`e2e/support/fake-npm.mjs`). */
export const FAKE_NPM = join(import.meta.dirname, "fake-npm.mjs");
/** The workspace's Claude Agent SDK the fake npm links beside the installed bundle. */
export const WORKSPACE_SDK = join(
  REPO_ROOT,
  "apps",
  "local-runtime",
  "node_modules",
  "@anthropic-ai",
  "claude-agent-sdk",
);
/** macOS caps a Unix socket path at 104 bytes; the daemon's control socket is `<OCW_HOME>/runtime.sock`. */
const MAX_SOCKET_PATH = 100;

export interface PairingPrompt {
  /** `<web>/settings/devices?pair=XXXX-XXXX` (`verificationUriComplete`). */
  url: string;
  code: string;
}

/**
 * The approval link and its code in `ocw-runtime setup`'s output so far, or null until the link's whole line has
 * arrived (stdout comes in chunks: a line cut mid-code must not pass for a link).
 */
export function parsePairingPrompt(stdout: string): PairingPrompt | null {
  const m = /^[ \t]*(https?:\/\/\S+\/settings\/devices\?pair=([0-9A-Z]{4}-[0-9A-Z]{4}))\r?\n/m.exec(stdout);
  return m?.[1] && m[2] ? { url: m[1], code: m[2] } : null;
}

export interface HeadlessDevice {
  deviceId: string;
  projectId: string;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface HeadlessServer {
  /** The scratch root holding everything below (removed by `stop()`). */
  root: string;
  /** The scratch `HOME`. */
  home: string;
  /** `<HOME>/.ocw`. */
  ocwHome: string;
  /** `<HOME>/.local/bin/ocw-runtime`, the launcher install.sh wrote. */
  shim: string;
  /** The scratch git repository setup registered (`<HOME>/src/<projectName>`). */
  repo: string;
  /** What install.sh printed (stdout and stderr). */
  installOutput: string;
  /** The approval link setup printed. */
  pairingUrl: Promise<string>;
  /** Setup's exit code. */
  setupDone: Promise<number>;
  /** Setup's stdout and stderr so far. */
  setupOutput(): string;
  /** Each fake npm call's arguments. */
  npmCalls(): string[][];
  /** Starts the installed `ocw-runtime run` and waits until the device is online with its project available. */
  start(): Promise<HeadlessDevice>;
  /** Runs the installed `ocw-runtime <args>` with the device's env; resolves on any exit code. */
  cli(args: string[]): Promise<CliResult>;
  /** SIGTERM the daemon (and a setup still waiting), revoke the device, remove the scratch directories. */
  stop(): Promise<void>;
}

/** Single-quotes a value for `sh`. */
const shq = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

async function poll<T>(
  what: string,
  probe: () => Promise<T | null>,
  { timeoutMs = 30_000, intervalMs = 500 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Installs the runtime from `apiUrl`'s install script into a scratch HOME (rejects when the script fails), then starts
 * `ocw-runtime setup --yes --server <apiUrl> --name <name> --project <repo> --service none`, which waits for the
 * owner's approval of `pairingUrl`. `adminApi` (the owner, signed in) finds the device and revokes it in `stop()`.
 */
export async function startHeadlessServer(
  adminApi: APIRequestContext,
  opts: { name: string; projectName: string; apiUrl?: string },
): Promise<HeadlessServer> {
  const apiUrl = opts.apiUrl ?? process.env.OCW_E2E_API_URL ?? "http://localhost:4000";
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ocw-hs-")));
  const home = join(root, "home");
  const ocwHome = join(home, ".ocw");
  const localBin = join(home, ".local", "bin");
  const shim = join(localBin, "ocw-runtime");
  const bin = join(root, "bin");
  const repo = join(home, "src", opts.projectName);
  if (join(ocwHome, "runtime.sock").length > MAX_SOCKET_PATH) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(
      `the scratch OCW_HOME ${ocwHome} is too long for a Unix socket; set TMPDIR to a shorter path`,
    );
  }

  let setup: ChildProcess | null = null;
  let daemon: ChildProcess | null = null;
  let deviceId: string | null = null;
  const stop = async () => {
    const children = [setup, daemon].filter((c): c is ChildProcess => c !== null);
    setup = null;
    daemon = null;
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(children.map((c) => waitForExit(c, 12_000)));
    if (deviceId) await adminApi.delete(`/api/v1/devices/${deviceId}`).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  };

  try {
    // ---- the scratch machine: a bin with node and the fake npm, a HOME, a git repository inside it
    mkdirSync(bin, { recursive: true });
    mkdirSync(repo, { recursive: true });
    symlinkSync(process.execPath, join(bin, "node"));
    writeFileSync(
      join(bin, "npm"),
      `#!/bin/sh\n# fake npm (07.12-09, PD-19)\nexec ${shq(process.execPath)} ${shq(FAKE_NPM)} "$@"\n`,
    );
    chmodSync(join(bin, "npm"), 0o755);
    writeFileSync(
      join(repo, "README.md"),
      `# ${opts.projectName}\n\nScratch repository for an end-to-end test.\n`,
    );
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, stdio: "ignore", env: { PATH: "/usr/bin:/bin", HOME: home } });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("-c", "user.email=e2e@ocw.test", "-c", "user.name=E2E", "commit", "-qm", "init");

    const env: NodeJS.ProcessEnv = {
      HOME: home,
      OCW_HOME: ocwHome,
      PATH: [bin, localBin, "/usr/bin", "/bin"].join(":"),
      TMPDIR: root,
      OCW_RUNTIME_FAKE: "1",
      OCW_RUNTIME_FAKE_DELAY_MS: "120",
      OCW_RUNTIME_UPDATES: "off",
    };

    // ---- curl … | sh, exactly the command Settings › Devices shows
    const installOutput = await new Promise<string>((resolve, reject) => {
      execFile(
        "/bin/sh",
        ["-c", `curl -fsSL ${shq(`${apiUrl}/api/v1/runtime/install.sh`)} | sh`],
        { env, cwd: home, timeout: 120_000 },
        (err, stdout, stderr) => {
          const text = `${stdout}${stderr}`;
          if (err) reject(new Error(`install.sh failed (${err.message}):\n${text}`));
          else resolve(text);
        },
      );
    });
    if (!existsSync(shim)) throw new Error(`install.sh wrote no ${shim}:\n${installOutput}`);

    // ---- setup, waiting for the owner's approval
    let setupText = "";
    let resolveUrl: (url: string) => void = () => undefined;
    let rejectUrl: (err: Error) => void = () => undefined;
    const pairingUrl = new Promise<string>((resolve, reject) => {
      resolveUrl = resolve;
      rejectUrl = reject;
    });
    const child = spawn(
      shim,
      ["setup", "--yes", "--server", apiUrl, "--name", opts.name, "--project", repo, "--service", "none"],
      { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] },
    );
    setup = child;
    const onData = (chunk: Buffer) => {
      setupText += chunk.toString("utf8");
      const prompt = parsePairingPrompt(setupText);
      if (prompt) resolveUrl(prompt.url);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk: Buffer) => {
      setupText += chunk.toString("utf8");
    });
    const setupDone = new Promise<number>((resolve) => {
      child.once("exit", (code, signal) => {
        if (setup === child) setup = null;
        rejectUrl(
          new Error(`setup exited (${code ?? signal}) before printing a pairing link:\n${setupText}`),
        );
        resolve(code ?? 128);
      });
    });
    // A rejection nobody awaits (setup failing after the link) must not crash the run.
    pairingUrl.catch(() => undefined);

    const listProjects = async () =>
      (await (await adminApi.get("/api/v1/projects")).json()) as {
        projects: Array<{ id: string; deviceId: string; name: string; available: boolean }>;
      };

    const start = async (): Promise<HeadlessDevice> => {
      const code = await setupDone;
      if (code !== 0) throw new Error(`setup exited ${code}:\n${setupText}`);
      const record = JSON.parse(readFileSync(join(ocwHome, "runtime.json"), "utf8")) as { deviceId?: string };
      if (!record.deviceId) throw new Error("runtime.json names no deviceId after setup");
      deviceId = record.deviceId;
      const log = createWriteStream(join(root, "daemon.log"));
      const proc = spawn(shim, ["run"], { env, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout?.pipe(log);
      proc.stderr?.pipe(log);
      daemon = proc;
      const id = deviceId;
      try {
        return await poll(`${opts.name} comes online with ${opts.projectName}`, async () => {
          if (proc.exitCode !== null) throw new Error(`the daemon exited ${proc.exitCode}`);
          const devices = (await (await adminApi.get("/api/v1/devices")).json()) as {
            devices: Array<{ id: string; status: string }>;
          };
          if (devices.devices.find((d) => d.id === id)?.status !== "online") return null;
          const project = (await listProjects()).projects.find(
            (p) => p.deviceId === id && p.name === opts.projectName && p.available,
          );
          return project ? { deviceId: id, projectId: project.id } : null;
        });
      } catch (err) {
        const tail = existsSync(join(root, "daemon.log"))
          ? readFileSync(join(root, "daemon.log"), "utf8").split("\n").slice(-30).join("\n")
          : "";
        throw new Error(`${(err as Error).message}\ndaemon log (last lines):\n${tail}`);
      }
    };

    const cli = (args: string[]) =>
      new Promise<CliResult>((resolve) => {
        execFile(shim, args, { env, cwd: home, timeout: 60_000 }, (err, stdout, stderr) => {
          const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
          resolve({ code, stdout, stderr });
        });
      });

    const npmCalls = () => {
      const file = join(ocwHome, "runtime", "versions", "fake-npm.log");
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
    };

    return {
      root,
      home,
      ocwHome,
      shim,
      repo,
      installOutput,
      pairingUrl,
      setupDone,
      setupOutput: () => setupText,
      npmCalls,
      start,
      cli,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
