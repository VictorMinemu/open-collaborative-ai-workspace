import { type ChildProcess, execFileSync, spawn } from "node:child_process";
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
 */

const RUNTIME_BIN = join(import.meta.dirname, "..", "..", "apps", "local-runtime", "bin", "ocw-runtime");

export interface FakeDeviceHandle {
  deviceId: string;
  projectId: string;
  projectName: string;
  stop(): Promise<void>;
}

export async function startFakeDevice(
  adminApi: APIRequestContext,
  opts: { name: string; projectName: string; env?: Record<string, string> },
): Promise<FakeDeviceHandle> {
  const enrollment = await adminApi.post("/api/v1/devices/enrollments", { data: {} });
  expect(enrollment.ok(), "create a pairing code").toBe(true);
  const { code } = (await enrollment.json()) as { code: string };

  const home = mkdtempSync(join(tmpdir(), "ocw-e2e-home-"));
  const repoParent = mkdtempSync(join(tmpdir(), "ocw-e2e-repo-"));
  const repo = join(repoParent, opts.projectName);
  mkdirSync(repo);
  writeFileSync(
    join(repo, "README.md"),
    `# ${opts.projectName}\n\nScratch repository for an end-to-end test.\n`,
  );
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=e2e@ocw.test", "-c", "user.name=E2E", "commit", "-qm", "init");

  const env = {
    ...process.env,
    OCW_HOME: home,
    OCW_RUNTIME_FAKE: "1",
    OCW_RUNTIME_FAKE_DELAY_MS: "120",
    ...opts.env,
  };
  let daemon: ChildProcess | null = null;
  const found: { deviceId?: string; projectId?: string } = {};
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
    execFileSync(process.execPath, [RUNTIME_BIN, "add-project", repo], { env, stdio: "pipe" });
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
          found.projectId = projects.projects.find(
            (p) => p.deviceId === d.id && p.name === opts.projectName && p.available,
          )?.id;
          return found.projectId !== undefined;
        },
        { timeout: 30_000, message: `${opts.name} comes online with ${opts.projectName}` },
      )
      .toBe(true);

    if (!found.deviceId || !found.projectId) throw new Error(`${opts.name} did not register its project`);
    return {
      deviceId: found.deviceId,
      projectId: found.projectId,
      projectName: opts.projectName,
      stop: cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
