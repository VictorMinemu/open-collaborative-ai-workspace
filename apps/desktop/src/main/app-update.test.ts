import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppUpdateController,
  type AppUpdateDeps,
  type AppUpdateView,
  appImageNameNotice,
  appUpdateMenuModel,
  type DaemonKind,
  onboardingUpdateView,
  UPDATE_SENTENCES,
  type UpdateFallbackReason,
  type UpdaterLike,
  updateErrorSentence,
} from "./app-update";

const RELEASE_URL = "https://github.com/VictorMinemu/open-collaborative-ai-workspace/releases/tag/v0.5.1";
const DOWNLOADED = "/Users/someone/Library/Caches/@ocwdesktop-updater/pending/OCW-v0.5.1-macos-arm64.zip";

/** electron-updater's surface, as the controller uses it. */
class FakeUpdater extends EventEmitter {
  available: string | null = "0.5.1";
  checkError: Error | null = null;
  downloadError: Error | null = null;
  /** Emit `update-downloaded` from `downloadUpdate` (as a cached or quick download does). */
  emitOnDownload = true;
  checkForUpdates = vi.fn(async () => {
    if (this.checkError) {
      this.emit("error", this.checkError);
      throw this.checkError;
    }
    if (!this.available) return { isUpdateAvailable: false, updateInfo: { version: "0.5.0" } };
    return { isUpdateAvailable: true, updateInfo: { version: this.available } };
  });
  downloadUpdate = vi.fn(async () => {
    if (this.downloadError) {
      this.emit("error", this.downloadError);
      throw this.downloadError;
    }
    this.emit("download-progress", { percent: 42.7 });
    if (this.emitOnDownload)
      this.emit("update-downloaded", { version: this.available, downloadedFile: DOWNLOADED });
    return [DOWNLOADED];
  });
  quitAndInstall = vi.fn();
}

class FakeMacUpdater extends FakeUpdater {
  prepareDownloaded = vi.fn(async (_info: { version: string; downloadedFile: string }) => undefined);
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface Harness {
  controller: AppUpdateController;
  updater: FakeUpdater;
  hold: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  onChange: ReturnType<typeof vi.fn>;
  daemon: { kind: DaemonKind };
  idle: { seconds: number };
}

function harness(over: Partial<AppUpdateDeps> & { updater?: FakeUpdater | null } = {}): Harness {
  const updater = over.updater === undefined ? new FakeUpdater() : over.updater;
  const daemon = { kind: "ours" as DaemonKind };
  const idle = { seconds: 0 };
  const hold = vi.fn(
    async (_drain: boolean): Promise<unknown> => ({ held: true, state: "held", running: 0 }),
  );
  const release = vi.fn(async () => ({ released: true }));
  const quit = vi.fn();
  const notify = vi.fn();
  const onChange = vi.fn();
  const controller = new AppUpdateController({
    updater: updater as unknown as UpdaterLike | null,
    fallback: null,
    installAllowed: true,
    currentVersion: "0.5.0",
    hold,
    release,
    daemon: () => daemon.kind,
    quit,
    idleSeconds: () => idle.seconds,
    notify,
    onChange,
    ...over,
  } as AppUpdateDeps);
  return {
    controller,
    updater: (updater ?? new FakeUpdater()) as FakeUpdater,
    hold: (over.hold as typeof hold) ?? hold,
    release: (over.release as typeof release) ?? release,
    quit,
    notify,
    onChange,
    daemon,
    idle,
  };
}

const labels = (c: AppUpdateController) => appUpdateMenuModel(c.view()).map((i) => i.label);

let h: Harness;
afterEach(() => {
  h?.controller.stop();
  vi.useRealTimers();
});

describe("click to restart (07.13.1 D-07, Pitfall 3)", () => {
  beforeEach(() => {
    h = harness();
    h.controller.start();
  });

  it("checks, downloads, offers the restart, holds, quits once, and installs only from the quit event", async () => {
    await h.controller.check("click");
    await flush();
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(h.controller.view().phase).toBe("ready");
    expect(labels(h.controller)).toContain("Restart to update to v0.5.1");

    await h.controller.restart();
    await flush();
    expect(h.hold).toHaveBeenCalledTimes(1);
    expect(h.hold).toHaveBeenCalledWith(true);
    expect(h.quit).toHaveBeenCalledTimes(1);
    expect(h.hold.mock.invocationCallOrder[0]).toBeLessThan(h.quit.mock.invocationCallOrder[0] as number);
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();

    h.controller.onQuit();
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(h.updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    h.controller.onQuit();
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it.each(["paused", "external", "stopped"] as const)(
    "with the daemon %s it quits without asking for a hold",
    async (kind) => {
      await h.controller.check("click");
      await flush();
      h.daemon.kind = kind;
      await h.controller.restart();
      await flush();
      expect(h.hold).not.toHaveBeenCalled();
      expect(h.quit).toHaveBeenCalledTimes(1);
      h.controller.onQuit();
      expect(h.updater.quitAndInstall).toHaveBeenCalledWith(true, true);
    },
  );

  it("never quits when the hold is not held", async () => {
    h.hold.mockResolvedValue({ held: false, state: "draining", running: 1 });
    await h.controller.check("click");
    await flush();
    await h.controller.restart();
    await flush();
    expect(h.quit).not.toHaveBeenCalled();
    h.controller.onQuit();
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("a hold answer it cannot read is treated as an unreachable runtime", async () => {
    h.hold.mockResolvedValue({ held: "yes", path: "/Users/someone" });
    await h.controller.check("click");
    await flush();
    await h.controller.restart();
    await flush();
    expect(h.quit).not.toHaveBeenCalled();
    expect(h.controller.view().phase).toBe("ready");
    expect(h.controller.view().notice).toBe(UPDATE_SENTENCES.runtimeUnreachable);
  });

  it("nothing installs on quit before an update is ready", () => {
    h.controller.onQuit();
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe("install allowed only outside the test feed", () => {
  it("with installAllowed false, onQuit never calls the installer", async () => {
    h = harness({ installAllowed: false });
    h.controller.start();
    await h.controller.check("click");
    await flush();
    await h.controller.restart();
    await flush();
    expect(h.quit).toHaveBeenCalledTimes(1);
    h.controller.onQuit();
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe("the macOS prepare step (D-05)", () => {
  it("offers the restart only after prepareDownloaded resolved, with the downloaded file and version", async () => {
    const mac = new FakeMacUpdater();
    let finish: () => void = () => undefined;
    mac.prepareDownloaded.mockImplementation(
      () => new Promise<undefined>((r) => (finish = () => r(undefined))),
    );
    h = harness({ updater: mac });
    h.controller.start();
    await h.controller.check("click");
    await flush();
    expect(mac.prepareDownloaded).toHaveBeenCalledWith({ version: "0.5.1", downloadedFile: DOWNLOADED });
    expect(h.controller.view().phase).not.toBe("ready");
    finish();
    await flush();
    expect(h.controller.view().phase).toBe("ready");
  });

  it("a prepare failure falls back to the release page with a fixed sentence", async () => {
    const mac = new FakeMacUpdater();
    mac.prepareDownloaded.mockRejectedValue(new Error(`codesign failed for ${DOWNLOADED}`));
    h = harness({ updater: mac });
    h.controller.start();
    await h.controller.check("click");
    await flush();
    const view = h.controller.view();
    expect(view.phase).toBe("fallback");
    expect(view.url).toBe(RELEASE_URL);
    expect(view.notice).toBe(UPDATE_SENTENCES.macPrepareFailed);
    expect(UPDATE_SENTENCES.macPrepareFailed).toMatch(/could not be prepared/);
    const menu = appUpdateMenuModel(view);
    expect(menu).toContainEqual({
      label: "Update available (v0.5.1)",
      enabled: true,
      action: "openRelease",
      url: RELEASE_URL,
    });
    expect(JSON.stringify(menu)).not.toContain("codesign");
    expect(JSON.stringify(onboardingUpdateView(view))).not.toContain("Users");
    await h.controller.restart();
    expect(h.quit).not.toHaveBeenCalled();
    h.controller.onQuit();
    expect(mac.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe("errors become fixed sentences", () => {
  it("a failed click check leaves the check-failed sentence and never the error text", async () => {
    h = harness();
    h.updater.checkError = Object.assign(new Error("getaddrinfo ENOTFOUND github.com /Users/someone"), {
      code: "ENOTFOUND",
    });
    h.controller.start();
    await expect(h.controller.check("click")).resolves.toBeUndefined();
    await flush();
    expect(h.controller.view().notice).toBe(UPDATE_SENTENCES.checkFailed);
    expect(JSON.stringify(appUpdateMenuModel(h.controller.view()))).not.toContain("ENOTFOUND");
  });
});

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const status = (level: "automatic" | "notify" | "off" | null, appUpdate: unknown = null) =>
  ({ reported: true, level, appUpdate }) as Parameters<AppUpdateController["onDaemonStatus"]>[0];

describe("levels and the schedule (D-08)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("no automatic check before the first reported status, then one every checkEveryMs", async () => {
    h = harness();
    h.updater.available = null;
    h.controller.start();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled();
    h.controller.onDaemonStatus(status("notify"));
    await flush();
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    h.controller.onDaemonStatus(status("notify"));
    await vi.advanceTimersByTimeAsync(DAY - 1_000);
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(DAY);
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(3);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("without any status the first check runs after firstCheckFallbackMs, at notify", async () => {
    h = harness();
    h.controller.start();
    await vi.advanceTimersByTimeAsync(MIN - 1);
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    h.controller.onQuit();
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("off never checks by itself, and a click still checks and downloads", async () => {
    h = harness();
    h.controller.start();
    h.controller.onDaemonStatus(status("off"));
    await vi.advanceTimersByTimeAsync(3 * DAY);
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled();
    await h.controller.check("click");
    await flush();
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(h.controller.view().phase).toBe("ready");
  });

  it.each(["automatic", "notify"] as const)("%s downloads after an automatic check", async (level) => {
    h = harness();
    h.controller.start();
    h.controller.onDaemonStatus(status(level));
    await flush();
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(h.controller.view().phase).toBe("ready");
  });

  it("an unknown level counts as notify", async () => {
    h = harness();
    h.controller.start();
    h.controller.onDaemonStatus(status(null));
    await flush();
    expect(h.updater.downloadUpdate).toHaveBeenCalledTimes(1);
    h.controller.onQuit();
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("level changes cancel or reschedule the checks and never drop a ready update", async () => {
    h = harness();
    h.updater.available = null;
    h.controller.start();
    h.controller.onDaemonStatus(status("notify"));
    await flush();
    h.controller.onDaemonStatus(status("off"));
    await vi.advanceTimersByTimeAsync(2 * DAY);
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(1);
    h.controller.onDaemonStatus(status("automatic"));
    await flush();
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(2);
    h.updater.available = "0.5.1";
    await vi.advanceTimersByTimeAsync(DAY);
    expect(h.controller.view().phase).toBe("ready");
    h.controller.onDaemonStatus(status("off"));
    expect(h.controller.view().phase).toBe("ready");
  });

  it("an automatic failure returns to idle silently; a click failure leaves a sentence until the next check", async () => {
    h = harness();
    h.updater.checkError = Object.assign(new Error("sha512 checksum mismatch, expected a, got b"), {
      code: "ERR_CHECKSUM_MISMATCH",
    });
    h.controller.start();
    h.controller.onDaemonStatus(status("notify"));
    await flush();
    expect(h.controller.view()).toMatchObject({ phase: "idle", notice: null });
    await h.controller.check("click");
    expect(h.controller.view()).toMatchObject({ phase: "idle", notice: UPDATE_SENTENCES.checksumMismatch });
    expect(appUpdateMenuModel(h.controller.view())[0]).toEqual({
      label: UPDATE_SENTENCES.checksumMismatch,
      enabled: false,
    });
    h.updater.checkError = null;
    h.updater.available = null;
    await h.controller.check("click");
    expect(h.controller.view().notice).toBeNull();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]?.[0]).toBe(UPDATE_SENTENCES.upToDate);
  });

  it("a download failure after a click becomes a sentence", async () => {
    h = harness();
    h.updater.downloadError = Object.assign(new Error("Cannot find latest-mac.yml"), {
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
    });
    h.controller.start();
    await h.controller.check("click");
    await flush();
    expect(h.controller.view()).toMatchObject({ phase: "idle", notice: UPDATE_SENTENCES.noUpdateFile });
  });
});

describe("install on quit by level (D-08)", () => {
  it.each([
    ["automatic", [true, false]],
    ["notify", null],
    ["off", null],
  ] as const)("at %s a normal quit with a ready update installs %j", async (level, args) => {
    h = harness();
    h.controller.start();
    h.controller.onDaemonStatus(status(level));
    await h.controller.check("click");
    await flush();
    expect(h.controller.view().phase).toBe("ready");
    h.controller.onQuit();
    if (args) expect(h.updater.quitAndInstall).toHaveBeenCalledWith(...args);
    else expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe("the unattended restart (automatic only, D-08)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  async function readyAt(level: "automatic" | "notify") {
    h = harness();
    h.controller.start();
    h.controller.onDaemonStatus(status(level));
    await flush();
    expect(h.controller.view().phase).toBe("ready");
  }

  it("asks hold(false) only after 30 min of system idle, then quits and installs silently", async () => {
    await readyAt("automatic");
    h.idle.seconds = 1799;
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(h.hold).not.toHaveBeenCalled();
    h.idle.seconds = 1800;
    await vi.advanceTimersByTimeAsync(MIN);
    expect(h.hold).toHaveBeenCalledTimes(1);
    expect(h.hold).toHaveBeenCalledWith(false);
    expect(h.quit).toHaveBeenCalledTimes(1);
    h.controller.onQuit();
    expect(h.updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("a not-held answer changes nothing and retries a minute later, never with drain", async () => {
    await readyAt("automatic");
    h.hold.mockResolvedValue({ held: false, state: "idle", running: 1 });
    h.idle.seconds = 4000;
    await vi.advanceTimersByTimeAsync(MIN);
    expect(h.hold).toHaveBeenCalledTimes(1);
    expect(h.controller.view().phase).toBe("ready");
    expect(labels(h.controller)).toEqual(["Restart to update to v0.5.1"]);
    await vi.advanceTimersByTimeAsync(MIN);
    expect(h.hold).toHaveBeenCalledTimes(2);
    expect(h.hold.mock.calls.every((c) => c[0] === false)).toBe(true);
    expect(h.quit).not.toHaveBeenCalled();
  });

  it("never at notify, even when the person is away", async () => {
    await readyAt("notify");
    h.idle.seconds = 7200;
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(h.hold).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
  });
});

describe("waiting for the daemon (D-07, D-09)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    h = harness();
    h.controller.start();
    await h.controller.check("click");
    await flush();
    h.hold.mockResolvedValue({ held: false, state: "draining", running: 2 });
  });

  it("shows the running sessions, follows the status, and quits once the daemon says held", async () => {
    await h.controller.restart();
    expect(labels(h.controller)).toEqual(["Waiting for 2 sessions to finish…", "Cancel the restart"]);
    expect(appUpdateMenuModel(h.controller.view())[1]).toEqual({
      label: "Cancel the restart",
      enabled: true,
      action: "cancelWait",
    });
    h.controller.onDaemonStatus(status("notify", { state: "draining", running: 1 }));
    expect(labels(h.controller)[0]).toBe("Waiting for 1 session to finish…");
    expect(h.quit).not.toHaveBeenCalled();
    h.controller.onDaemonStatus(status("notify", { state: "held", running: 0 }));
    await flush();
    expect(h.quit).toHaveBeenCalledTimes(1);
    h.controller.onQuit();
    expect(h.updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it("a timed-out drain goes back to Restart to update with the fixed sentence", async () => {
    await h.controller.restart();
    await vi.advanceTimersByTimeAsync(11_000);
    h.controller.onDaemonStatus(status("notify", { state: "idle", running: 2, lastEnd: "timed_out" }));
    expect(h.controller.view().phase).toBe("ready");
    expect(labels(h.controller)).toEqual([UPDATE_SENTENCES.holdTimedOut, "Restart to update to v0.5.1"]);
    expect(h.quit).not.toHaveBeenCalled();
  });

  it("gives up after 31 minutes by itself and releases the gates", async () => {
    await h.controller.restart();
    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.controller.view()).toMatchObject({ phase: "ready", notice: UPDATE_SENTENCES.holdTimedOut });
    expect(h.quit).not.toHaveBeenCalled();
  });

  it("Cancel the restart releases once and goes back to ready", async () => {
    await h.controller.restart();
    h.controller.cancelWait();
    await flush();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(labels(h.controller)).toEqual(["Restart to update to v0.5.1"]);
    h.controller.onDaemonStatus(status("notify", { state: "held", running: 0 }));
    await flush();
    expect(h.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("a runtime update blocks: says so and asks again at most every 10 s while the daemon is idle", async () => {
    h.hold.mockResolvedValue({ held: false, state: "idle", running: 0, blocked: "runtime_update" });
    await h.controller.restart();
    expect(labels(h.controller)).toEqual(["Waiting for a runtime update to finish…", "Cancel the restart"]);
    await vi.advanceTimersByTimeAsync(1_000);
    h.controller.onDaemonStatus(status("notify", { state: "idle", running: 0 }));
    await flush();
    expect(h.hold).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_000);
    h.hold.mockResolvedValue({ held: true, state: "held", running: 0 });
    h.controller.onDaemonStatus(status("notify", { state: "idle", running: 0 }));
    await flush();
    expect(h.hold).toHaveBeenCalledTimes(2);
    expect(h.hold.mock.calls.every((c) => c[0] === true)).toBe(true);
    expect(h.quit).toHaveBeenCalledTimes(1);
  });

  it("a hold that throws goes back to ready with the runtime-unreachable sentence and reopens the gates", async () => {
    h.hold.mockRejectedValue(new Error("connect ENOENT /Users/someone/.ocw/runtime.sock"));
    await h.controller.restart();
    expect(h.controller.view()).toMatchObject({
      phase: "ready",
      notice: UPDATE_SENTENCES.runtimeUnreachable,
    });
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(appUpdateMenuModel(h.controller.view()))).not.toContain("ENOENT");
  });

  it("an action that throws returns to its previous phase and never escapes", async () => {
    h.hold.mockResolvedValue({ held: true, state: "held", running: 0 });
    await expect(
      h.controller.holdThen(async () => {
        throw new Error("mover failed");
      }),
    ).resolves.toBeUndefined();
    expect(h.controller.view().phase).toBe("ready");
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});

describe("the fallback notice (no platform updater)", () => {
  it("shows a checked release page only", () => {
    h = harness({ updater: null, fallback: "deb" });
    h.controller.start();
    h.controller.setFallbackNotice({ version: "0.5.1", url: "https://example.com/evil" });
    expect(h.controller.view().phase).toBe("idle");
    h.controller.setFallbackNotice({ version: "0.5.1", url: RELEASE_URL });
    expect(h.controller.view()).toMatchObject({ phase: "fallback", version: "0.5.1", url: RELEASE_URL });
    expect(labels(h.controller)[0]).toBe(
      "Update available (v0.5.1): download the .deb, or use the AppImage, which updates itself",
    );
    h.controller.setFallbackNotice(null);
    expect(h.controller.view().phase).toBe("idle");
  });
});

const v = (over: Partial<AppUpdateView>): AppUpdateView => ({
  phase: "idle",
  fallback: null,
  notice: null,
  ...over,
});

describe("the menu and onboarding views (D-06, D-09)", () => {
  it("gives exactly the fixed labels per phase", () => {
    expect(appUpdateMenuModel(v({}))).toEqual([
      { label: "Check for updates…", enabled: true, action: "check" },
    ]);
    expect(appUpdateMenuModel(v({ phase: "checking" }))).toEqual([
      { label: "Checking for updates…", enabled: false },
    ]);
    expect(appUpdateMenuModel(v({ phase: "downloading", version: "0.5.1", percent: 42 }))).toEqual([
      { label: "Downloading v0.5.1… 42%", enabled: false },
    ]);
    expect(appUpdateMenuModel(v({ phase: "ready", version: "0.5.1" }))).toEqual([
      { label: "Restart to update to v0.5.1", enabled: true, action: "restart" },
    ]);
    const waiting = (running: number, waitingFor: "sessions" | "runtime_update") =>
      appUpdateMenuModel(v({ phase: "waiting", version: "0.5.1", running, waitingFor }))[0]?.label;
    expect(waiting(1, "sessions")).toBe("Waiting for 1 session to finish…");
    expect(waiting(3, "sessions")).toBe("Waiting for 3 sessions to finish…");
    expect(waiting(0, "runtime_update")).toBe("Waiting for a runtime update to finish…");
    expect(appUpdateMenuModel(v({ phase: "fallback", version: "0.5.1", url: RELEASE_URL }))[0]).toEqual({
      label: "Update available (v0.5.1)",
      enabled: true,
      action: "openRelease",
      url: RELEASE_URL,
    });
    expect(
      appUpdateMenuModel(v({ phase: "fallback", version: "0.5.1", url: RELEASE_URL, fallback: "deb" }))[0]
        ?.label,
    ).toBe("Update available (v0.5.1): download the .deb, or use the AppImage, which updates itself");
  });

  it("offers Move OCW to Applications only from the disk image or a translocated path", () => {
    const move = {
      label: "Move OCW to Applications to get automatic updates",
      enabled: true,
      action: "moveToApplications",
    };
    const reasons: UpdateFallbackReason[] = [
      "dmg",
      "translocated",
      "unwritable",
      "not_bundle",
      "deb",
      "unsupported",
    ];
    for (const fallback of reasons) {
      for (const view of [
        v({ fallback }),
        v({ phase: "fallback", version: "0.5.1", url: RELEASE_URL, fallback }),
      ]) {
        const has = appUpdateMenuModel(view).some((i) => i.action === "moveToApplications");
        expect(has).toBe(fallback === "dmg" || fallback === "translocated");
        if (has) expect(appUpdateMenuModel(view)).toContainEqual(move);
      }
    }
  });

  it("maps the same phases for the onboarding window", () => {
    expect(onboardingUpdateView(v({}))).toBeUndefined();
    expect(onboardingUpdateView(v({ phase: "checking" }))).toEqual({
      kind: "progress",
      label: "Checking for updates…",
    });
    expect(onboardingUpdateView(v({ phase: "downloading", version: "0.5.1", percent: 42 }))).toEqual({
      kind: "progress",
      label: "Downloading v0.5.1… 42%",
    });
    expect(onboardingUpdateView(v({ phase: "ready", version: "0.5.1" }))).toEqual({
      kind: "ready",
      label: "Restart to update to v0.5.1",
    });
    expect(
      onboardingUpdateView(v({ phase: "waiting", version: "0.5.1", running: 2, waitingFor: "sessions" })),
    ).toEqual({ kind: "waiting", label: "Waiting for 2 sessions to finish…" });
    // Restarting is a sentence only, like the tray: a "Cancel the restart" now would quit without installing.
    expect(onboardingUpdateView(v({ phase: "restarting", version: "0.5.1" }))).toEqual({
      kind: "progress",
      label: "Restarting to update to v0.5.1…",
    });
    expect(onboardingUpdateView(v({ phase: "fallback", version: "0.5.1", url: RELEASE_URL }))).toEqual({
      kind: "link",
      label: "Update available (v0.5.1)",
      url: RELEASE_URL,
    });
    expect(onboardingUpdateView(v({ fallback: "dmg" }))).toEqual({
      kind: "move",
      label: "Move OCW to Applications to get automatic updates",
    });
    expect(
      onboardingUpdateView(
        v({ phase: "fallback", version: "0.5.1", url: RELEASE_URL, fallback: "translocated" }),
      ),
    ).toEqual({
      kind: "move",
      label: "Move OCW to Applications to get automatic updates",
      link: { label: "Update available (v0.5.1)", url: RELEASE_URL },
    });
    expect(onboardingUpdateView(v({ notice: UPDATE_SENTENCES.checkFailed }))).toEqual({
      kind: "error",
      label: UPDATE_SENTENCES.checkFailed,
    });
  });

  it("never carries a slash outside the release URL", () => {
    const views: AppUpdateView[] = [
      v({}),
      v({ phase: "checking" }),
      v({ phase: "downloading", version: "0.5.1", percent: 42 }),
      v({ phase: "ready", version: "0.5.1", notice: UPDATE_SENTENCES.holdTimedOut }),
      v({ phase: "waiting", version: "0.5.1", running: 2, waitingFor: "sessions" }),
      v({ phase: "waiting", version: "0.5.1", running: 0, waitingFor: "runtime_update" }),
      v({ phase: "restarting", version: "0.5.1" }),
      v({ phase: "fallback", version: "0.5.1", url: RELEASE_URL, fallback: "deb" }),
      v({ phase: "fallback", version: "0.5.1", url: RELEASE_URL, fallback: "dmg" }),
      ...Object.values(UPDATE_SENTENCES).map((notice) => v({ notice })),
    ];
    for (const view of views) {
      for (const out of [appUpdateMenuModel(view), onboardingUpdateView(view)]) {
        expect(JSON.stringify(out ?? null).replaceAll(RELEASE_URL, "")).not.toContain("/");
      }
    }
  });
});

describe("updateErrorSentence and appImageNameNotice", () => {
  it("maps codes and the checksum wording only", () => {
    const coded = (code: string, message = "x /Users/someone") => Object.assign(new Error(message), { code });
    expect(updateErrorSentence(coded("ERR_CHECKSUM_MISMATCH"))).toBe(UPDATE_SENTENCES.checksumMismatch);
    expect(updateErrorSentence(new Error("sha512 checksum mismatch after full download of OCW.zip"))).toBe(
      UPDATE_SENTENCES.checksumMismatch,
    );
    expect(updateErrorSentence(coded("ERR_UPDATER_CHANNEL_FILE_NOT_FOUND"))).toBe(
      UPDATE_SENTENCES.noUpdateFile,
    );
    expect(updateErrorSentence(coded("ERR_UPDATER_LATEST_VERSION_NOT_FOUND"))).toBe(
      UPDATE_SENTENCES.noUpdateFile,
    );
    for (const other of [
      coded("ERR_UPDATER_INVALID_VERSION"),
      new Error("boom"),
      "text",
      null,
      undefined,
      42,
    ]) {
      expect(updateErrorSentence(other)).toBe(UPDATE_SENTENCES.checkFailed);
    }
  });

  it("names the old and the new AppImage once each, and only plain file names", () => {
    const old = "OCW-v0.5.0-linux-x86_64.AppImage";
    const next = "OCW-v0.5.1-linux-x86_64.AppImage";
    const notice = appImageNameNotice(old, next);
    expect(notice).not.toBeNull();
    expect(notice?.split(old).length).toBe(2);
    expect(notice?.split(next).length).toBe(2);
    expect(appImageNameNotice(next, next)).toBeNull();
    expect(appImageNameNotice(null, next)).toBeNull();
    expect(appImageNameNotice(`/home/someone/${old}`, next)).toBeNull();
    expect(appImageNameNotice(old, `apps\\${next}`)).toBeNull();
  });
});
