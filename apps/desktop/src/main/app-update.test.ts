import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AppUpdateController,
  type AppUpdateDeps,
  appUpdateMenuModel,
  type DaemonKind,
  onboardingUpdateView,
  UPDATE_SENTENCES,
  type UpdaterLike,
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
