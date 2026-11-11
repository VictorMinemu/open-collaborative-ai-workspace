// 07.17.1 (D-05, PD-08; review WR-07): the self-update's exit hand-over for `ocw-runtime run`, in a module with no side
// effects on import. `cli.ts` owns one `ShutdownGuard` per `run` and shares it between the signal handler and this hook,
// so only the first of them exits. Never calls a service manager: the exit code alone asks systemd / launchd for the
// restart (75, `SELF_UPDATE_EXIT_CODE`).

/** How long the self-update hand-over waits for the daemon to stop before it exits anyway. */
export const HAND_OVER_TIMEOUT_MS = 10_000;

/** `run`'s one stopping guard, shared by the signal handler and the self-update hand-over. */
export interface ShutdownGuard {
  stopping: boolean;
}

export function createShutdownGuard(): ShutdownGuard {
  return { stopping: false };
}

/**
 * The self-update's exit hook (`DaemonOptions.exitForUpdate`). It marks the guard first (a SIGTERM during the hand-over
 * then does not exit 0), stops the daemon, then exits with `code` (75: systemd's `Restart=on-failure` and launchd's
 * `KeepAlive` start the new build). A stop that fails or hangs past the timeout still exits with `code`. A second call,
 * or a call after a signal began stopping, does nothing.
 */
export function selfUpdateExit(deps: {
  guard: ShutdownGuard;
  stop: () => Promise<void>;
  exit: (code: number) => void;
  timeoutMs?: number;
}): (code: number) => Promise<void> {
  return async (code) => {
    if (deps.guard.stopping) return;
    deps.guard.stopping = true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deps.timeoutMs ?? HAND_OVER_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([deps.stop(), timeout]);
    } catch {
      // The exit below is the hand-over; a failed stop must not keep the old build running.
    } finally {
      if (timer) clearTimeout(timer);
    }
    deps.exit(code);
  };
}
