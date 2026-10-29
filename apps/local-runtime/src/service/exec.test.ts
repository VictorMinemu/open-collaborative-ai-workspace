import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultServiceExec, isGuardedServiceCommand, MAX_SERVICE_OUTPUT_BYTES } from "./exec.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the service exec guard (07.12, PD-19)", () => {
  it.each(["systemctl", "loginctl", "launchctl", "journalctl"])("refuses %s under Vitest", async (tool) => {
    vi.stubEnv("OCW_SERVICE_PROOF", "");
    await expect(defaultServiceExec(tool, ["--user", "daemon-reload"])).rejects.toThrow(
      /refused under tests/,
    );
  });

  it("matches the basename, so an absolute path is caught too", async () => {
    vi.stubEnv("OCW_SERVICE_PROOF", "");
    await expect(defaultServiceExec("/usr/bin/systemctl", ["--user", "status"])).rejects.toThrow(
      /refused under tests/,
    );
    await expect(defaultServiceExec("/bin/launchctl", ["print", "gui/501"])).rejects.toThrow(
      /refused under tests/,
    );
    expect(isGuardedServiceCommand("/usr/bin/journalctl")).toBe(true);
    expect(isGuardedServiceCommand("getent")).toBe(false);
    expect(isGuardedServiceCommand("id")).toBe(false);
  });

  it("refuses in follow (inherit) mode as well", async () => {
    vi.stubEnv("OCW_SERVICE_PROOF", "");
    await expect(defaultServiceExec("journalctl", ["--user", "-f"], { inherit: true })).rejects.toThrow(
      /refused under tests/,
    );
  });

  it("lets `id` and other tools through, without a shell", async () => {
    const r = await defaultServiceExec("id", ["-u"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+$/);
    // No shell: the argument is passed verbatim, never interpreted.
    const echo = await defaultServiceExec("echo", ["$HOME;", "`id`"]);
    expect(echo.stdout).toBe("$HOME; `id`\n");
  });

  it("reports a missing binary as code null, not a throw", async () => {
    const r = await defaultServiceExec("ocw-no-such-binary-xyz", []);
    expect(r.code).toBeNull();
  });

  it("caps captured output at 64 KB", async () => {
    const r = await defaultServiceExec("head", ["-c", String(200 * 1024), "/dev/zero"]);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeLessThanOrEqual(MAX_SERVICE_OUTPUT_BYTES);
    expect(MAX_SERVICE_OUTPUT_BYTES).toBe(64 * 1024);
  });
});
