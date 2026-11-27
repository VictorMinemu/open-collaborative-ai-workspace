// Review WR-02: the AppImage updater starts the new AppImage from inside the old app's quit event, while the old
// process still holds the single-instance lock. That instance retries the lock for a bounded time instead of quitting
// at once; any other second start quits at once, as before. The updater's marker never reaches the daemon.
import { describe, expect, it, vi } from "vitest";
import { acquireSingleInstanceLock, UPDATER_LOCK_ATTEMPTS, UPDATER_LOCK_DELAY_MS } from "./single-instance";

const noSleep = vi.fn(async (_ms: number) => undefined);

describe("acquireSingleInstanceLock (review WR-02)", () => {
  it("takes the lock at once when it is free, and removes the updater's marker from the environment", async () => {
    const env: NodeJS.ProcessEnv = { APPIMAGE_SILENT_INSTALL: "true", HOME: "/home/someone" };
    const request = vi.fn(() => true);
    expect(await acquireSingleInstanceLock({ request, env, sleep: noSleep })).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(env).toEqual({ HOME: "/home/someone" });
  });

  it("a second start the person made quits at once (no retry)", async () => {
    const request = vi.fn(() => false);
    const sleep = vi.fn(async (_ms: number) => undefined);
    expect(await acquireSingleInstanceLock({ request, env: {}, sleep })).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("the instance the updater started retries until the old one let go", async () => {
    const answers = [false, false, false, true];
    const request = vi.fn(() => answers.shift() ?? false);
    const sleep = vi.fn(async (_ms: number) => undefined);
    const env: NodeJS.ProcessEnv = { APPIMAGE_SILENT_INSTALL: "true" };
    expect(await acquireSingleInstanceLock({ request, env, sleep })).toBe(true);
    expect(request).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(UPDATER_LOCK_DELAY_MS);
    expect(env.APPIMAGE_SILENT_INSTALL).toBeUndefined();
  });

  it("gives up after a bounded number of attempts", async () => {
    const request = vi.fn(() => false);
    const sleep = vi.fn(async (_ms: number) => undefined);
    expect(
      await acquireSingleInstanceLock({ request, env: { APPIMAGE_SILENT_INSTALL: "true" }, sleep }),
    ).toBe(false);
    expect(request).toHaveBeenCalledTimes(UPDATER_LOCK_ATTEMPTS + 1);
    expect(UPDATER_LOCK_ATTEMPTS * UPDATER_LOCK_DELAY_MS).toBeLessThanOrEqual(15_000);
  });

  it("only the exact marker value counts", async () => {
    const request = vi.fn(() => false);
    expect(
      await acquireSingleInstanceLock({ request, env: { APPIMAGE_SILENT_INSTALL: "1" }, sleep: noSleep }),
    ).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
