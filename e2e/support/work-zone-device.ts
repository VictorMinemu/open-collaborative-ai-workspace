import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIRequestContext, expect } from "@playwright/test";
import { API_URL } from "../tests/env";

/**
 * A REAL local-runtime daemon (apps/local-runtime) in fake-runtime mode (OCW_RUNTIME_FAKE=1: no model, no
 * login), paired through the API as the signed-in owner of `adminApi`, with one scratch git repo registered.
 * Used by the Work Zone controls specs (Phase 03.2); `stop()` kills the daemon, revokes the device and removes
 * the temp dirs.
 * Runtime CLI updates (07.11, PD-19): every device runs with `OCW_RUNTIME_UPDATES=off` unless the spec's `env`
 * overrides it; only the runtime-updates specs do, together with a scratch `HOME` and `PATH`
 * (`e2e/support/runtime-updates.ts`), so no spec's daemon ever touches a real CLI.
 * 07.16-21: `extraProjects` registers more scratch repositories on the same device (their ids in `extraProjectIds`),
 * and `startIsolatedServer` runs the daemon as a headless service (`OCW_RUNTIME_HOST=service`) and turns the
 * isolated-server mark on with the device's own CLI (`ocw-runtime isolated-server on`, D-19).
 */

const RUNTIME_BIN = join(import.meta.dirname, "..", "..", "apps", "local-runtime", "bin", "ocw-runtime");

/** The `README.md` every scratch repository is created with (07.17.1.1-14: a bot downloads it byte for byte). */
export const scratchReadme = (projectName: string) =>
  `# ${projectName}\n\nScratch repository for an end-to-end test.\n`;

export interface FakeDeviceHandle {
  deviceId: string;
  projectId: string;
  projectName: string;
  /** The ids of `opts.extraProjects` by name (07.16-21: a bot profile lists two projects of one device). */
  extraProjectIds: Record<string, string>;
  /** The device's scratch `OCW_HOME` (control socket, config, token). */
  ocwHome: string;
  /**
   * Runs `ocw-runtime <args>` with the device's env (its `OCW_HOME`) and resolves with stdout; rejects on a non-zero
   * exit. Asynchronous on purpose: a stub the spec serves from its own process (a fake registry) must keep answering
   * while the CLI waits for the daemon.
   */
  runtimeCli(args: string[]): Promise<string>;
  /**
   * Stop the daemon gracefully (SIGTERM) WITHOUT revoking the device: its runtimes report every session as ended
   * ("completed"), so the sessions stay listed (a revoked host hides them). `stop()` still cleans up afterwards.
   */
  shutdown(): Promise<void>;
  /** Start the daemon again after `shutdown()` and wait until the device is online (07.5-12: offline → back). */
  restart(): Promise<void>;
  /** Remove the scratch project on the device (`ocw-runtime remove-project`) and wait until the API stops listing it. */
  removeProject(): Promise<void>;
  stop(): Promise<void>;
}

export async function startFakeDevice(
  adminApi: APIRequestContext,
  opts: { name: string; projectName: string; extraProjects?: string[]; env?: Record<string, string> },
): Promise<FakeDeviceHandle> {
  const enrollment = await adminApi.post("/api/v1/devices/enrollments", { data: {} });
  expect(enrollment.ok(), "create a pairing code").toBe(true);
  const { code } = (await enrollment.json()) as { code: string };

  const home = mkdtempSync(join(tmpdir(), "ocw-e2e-home-"));
  const repoParent = mkdtempSync(join(tmpdir(), "ocw-e2e-repo-"));
  const scratchRepo = (name: string) => {
    const dir = join(repoParent, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "README.md"), scratchReadme(name));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("-c", "user.email=e2e@ocw.test", "-c", "user.name=E2E", "commit", "-qm", "init");
    return dir;
  };
  const repo = scratchRepo(opts.projectName);
  const extraRepos = (opts.extraProjects ?? []).map((name) => ({ name, dir: scratchRepo(name) }));

  const env = {
    ...process.env,
    OCW_HOME: home,
    OCW_RUNTIME_FAKE: "1",
    OCW_RUNTIME_FAKE_DELAY_MS: "120",
    // 07.11 (PD-19): runtime CLI updates off unless the spec overrides it (before `...opts.env`).
    OCW_RUNTIME_UPDATES: "off",
    ...opts.env,
  };
  let daemon: ChildProcess | null = null;
  const found: { deviceId?: string; projectId?: string; extra: Record<string, string> } = { extra: {} };
  const cleanup = async () => {
    daemon?.kill("SIGTERM");
    daemon = null;
    if (found.deviceId) await adminApi.delete(`/api/v1/devices/${found.deviceId}`).catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  };

  try {
    execFileSync(
      process.execPath,
      [RUNTIME_BIN, "enroll", "--server", API_URL, "--code", code, "--name", opts.name],
      { env, stdio: "pipe" },
    );
    const added = execFileSync(process.execPath, [RUNTIME_BIN, "add-project", repo], { env, stdio: "pipe" });
    const localId = (() => {
      try {
        return (JSON.parse(added.toString("utf8")) as { localId?: string }).localId ?? null;
      } catch {
        return null;
      }
    })();
    for (const extra of extraRepos) {
      execFileSync(process.execPath, [RUNTIME_BIN, "add-project", extra.dir], { env, stdio: "pipe" });
    }
    daemon = spawn(process.execPath, [RUNTIME_BIN, "run"], { env, stdio: "ignore" });

    await expect
      .poll(
        async () => {
          const devices = (await (await adminApi.get("/api/v1/devices")).json()) as {
            devices: Array<{ id: string; name: string; status: string }>;
          };
          const d = devices.devices.find((x) => x.name === opts.name && x.status === "online");
          if (!d) return false;
          found.deviceId = d.id;
          const projects = (await (await adminApi.get("/api/v1/projects")).json()) as {
            projects: Array<{ id: string; deviceId: string; name: string; available: boolean }>;
          };
          const idOf = (name: string) =>
            projects.projects.find((p) => p.deviceId === d.id && p.name === name && p.available)?.id;
          found.projectId = idOf(opts.projectName);
          for (const extra of extraRepos) {
            const id = idOf(extra.name);
            if (id) found.extra[extra.name] = id;
          }
          return found.projectId !== undefined && Object.keys(found.extra).length === extraRepos.length;
        },
        { timeout: 30_000, message: `${opts.name} comes online with ${opts.projectName}` },
      )
      .toBe(true);

    if (!found.deviceId || !found.projectId) throw new Error(`${opts.name} did not register its project`);
    const shutdown = async () => {
      const proc = daemon;
      daemon = null;
      if (!proc || proc.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
      });
    };
    const deviceId = found.deviceId;
    const projectId = found.projectId;
    const statusOf = async () => {
      const devices = (await (await adminApi.get("/api/v1/devices")).json()) as {
        devices: Array<{ id: string; status: string }>;
      };
      return devices.devices.find((d) => d.id === deviceId)?.status ?? "missing";
    };
    const restart = async () => {
      if (daemon && daemon.exitCode === null) return;
      daemon = spawn(process.execPath, [RUNTIME_BIN, "run"], { env, stdio: "ignore" });
      await expect
        .poll(statusOf, { timeout: 30_000, message: `${opts.name} comes back online` })
        .toBe("online");
    };
    const removeProject = async () => {
      if (!localId) throw new Error("the scratch project's local id is unknown");
      execFileSync(process.execPath, [RUNTIME_BIN, "remove-project", localId], { env, stdio: "pipe" });
      await expect
        .poll(
          async () => {
            const projects = (await (await adminApi.get("/api/v1/projects")).json()) as {
              projects: Array<{ id: string; available: boolean }>;
            };
            return projects.projects.find((p) => p.id === projectId)?.available ?? false;
          },
          { timeout: 30_000, message: `${opts.projectName} is removed` },
        )
        .toBe(false);
    };
    const runtimeCli = (args: string[]) =>
      new Promise<string>((resolve, reject) => {
        execFile(process.execPath, [RUNTIME_BIN, ...args], { env }, (err, stdout, stderr) => {
          if (err) reject(new Error(`ocw-runtime ${args.join(" ")}: ${err.message} ${stderr}`.trim()));
          else resolve(stdout);
        });
      });
    return {
      deviceId,
      projectId,
      projectName: opts.projectName,
      extraProjectIds: { ...found.extra },
      ocwHome: home,
      runtimeCli,
      shutdown,
      restart,
      removeProject,
      stop: cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/**
 * A fake device that runs as a headless service (`OCW_RUNTIME_HOST=service`) with the isolated-server mark turned on
 * locally (`ocw-runtime isolated-server on`, which the running daemon reloads and reports), as an admin's build server
 * would be (07.16 D-19, PD-18). Resolves once `GET /devices` lists it as a service host with the mark.
 */
export async function startIsolatedServer(
  adminApi: APIRequestContext,
  opts: { name: string; projectName: string; extraProjects?: string[]; env?: Record<string, string> },
): Promise<FakeDeviceHandle> {
  const device = await startFakeDevice(adminApi, {
    ...opts,
    env: { ...opts.env, OCW_RUNTIME_HOST: "service" },
  });
  try {
    await device.runtimeCli(["isolated-server", "on"]);
    await expect
      .poll(
        async () => {
          const { devices } = (await (await adminApi.get("/api/v1/devices")).json()) as {
            devices: Array<{ id: string; hostKind?: string | null; isolatedServer?: boolean }>;
          };
          const d = devices.find((x) => x.id === device.deviceId);
          return d ? { hostKind: d.hostKind ?? null, isolatedServer: d.isolatedServer === true } : null;
        },
        { timeout: 30_000, message: `${opts.name} reports a service host with the isolated-server mark` },
      )
      .toEqual({ hostKind: "service", isolatedServer: true });
  } catch (err) {
    await device.stop();
    throw err;
  }
  return device;
}
