// The single-instance lock (review WR-02). electron-updater's AppImage updater starts the new AppImage from inside
// the old app's `quit` event, with `APPIMAGE_SILENT_INSTALL=true`, while the old process still holds the lock; the new
// instance would get `false` and quit, and the restart the person asked for would never come back. That instance
// alone retries for a bounded time; a second start the person made still quits at once. The marker is removed from
// this process's environment on read, so it never reaches the daemon. No Electron imports (unit-tested).

/** How many times the updater-started instance asks again, and how long it waits in between (10 s in all). */
export const UPDATER_LOCK_ATTEMPTS = 50;
export const UPDATER_LOCK_DELAY_MS = 200;

const MARKER = "APPIMAGE_SILENT_INSTALL";

export async function acquireSingleInstanceLock(deps: {
  /** `app.requestSingleInstanceLock()`. */
  request: () => boolean;
  /** This process's environment (`process.env`); the updater's marker is deleted from it. */
  env: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const startedByUpdater = deps.env[MARKER] === "true";
  delete deps.env[MARKER];
  if (deps.request()) return true;
  if (!startedByUpdater) return false;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; i < UPDATER_LOCK_ATTEMPTS; i++) {
    await sleep(UPDATER_LOCK_DELAY_MS);
    if (deps.request()) return true;
  }
  return false;
}
