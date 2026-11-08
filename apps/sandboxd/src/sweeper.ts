import type { Quota } from "./quota";
import { type Clock, SandboxdFailure, type Sandboxes } from "./sandboxes";

/**
 * The broker's periodic pass (07.8-09, D-01, D-09, F-9): every interval (60 s by default) it measures each running
 * sandbox's workspace (the soft quota stops one that is over), stops a sandbox idle past its organization's
 * `idleStopMs` with reason `idle` (its volume stays), reports CPU and disk as `usage`, and reaps `files` helpers idle
 * for 60 s. One bot's failure never stops the pass for the others; nothing here logs a path or content.
 *
 * Without a pushed policy for the organization (sandboxd restarted and the API has not pushed yet) a running sandbox is
 * measured and sampled but never stopped: there is no default idle time or quota to judge it by, and nothing new can run
 * in it meanwhile (exec answers `policy_missing`).
 */

export const SWEEP_INTERVAL_MS = 60_000;
/** A `files` helper nobody used for this long is removed (its volume stays). */
export const FILES_HELPER_IDLE_MS = 60_000;

export interface SweeperDeps {
  sandboxes: Pick<
    Sandboxes,
    | "listRunning"
    | "isDiskFull"
    | "idleMs"
    | "hasRunningProcess"
    | "limitsFor"
    | "stopWith"
    | "sampleUsage"
    | "reapFilesHelpers"
  >;
  quota: Pick<Quota, "measure">;
  clock?: Clock;
  intervalMs?: number;
  filesHelperIdleMs?: number;
  /** Ids-only warnings (a failed measurement, say). */
  onError?: (what: string, err: unknown) => void;
}

export interface Sweeper {
  start(): void;
  stop(): void;
  /** One pass; tests drive it directly with their clock. */
  tick(): Promise<void>;
}

export function createSweeper(deps: SweeperDeps): Sweeper {
  const { sandboxes, quota } = deps;
  const clock = deps.clock ?? { now: () => Date.now() };
  const intervalMs = deps.intervalMs ?? SWEEP_INTERVAL_MS;
  const helperIdleMs = deps.filesHelperIdleMs ?? FILES_HELPER_IDLE_MS;
  const onError = deps.onError ?? (() => {});
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  async function tick(): Promise<void> {
    let shells: Awaited<ReturnType<Sandboxes["listRunning"]>> = [];
    try {
      shells = await sandboxes.listRunning();
    } catch (err) {
      onError("list", err);
    }
    for (const { target } of shells) {
      // A kill switch that landed after the listing: the shell is gone or going, and measuring it now would start a
      // `files` helper for it (CI p164: one per killed bot, still running after the kill). The kill sampled its usage.
      if (sandboxes.limitsFor(target.orgId)?.killed) continue;
      try {
        // The soft quota first: over it, the sandbox stops with reason disk_full (and one usage sample).
        await quota.measure(target);
        if (sandboxes.isDiskFull(target)) continue;
        const idleStopMs = sandboxes.limitsFor(target.orgId)?.idleStopMs;
        if (
          idleStopMs !== undefined &&
          sandboxes.idleMs(target, clock.now()) >= idleStopMs &&
          !sandboxes.hasRunningProcess(target)
        ) {
          await sandboxes.stopWith(target, "idle");
          continue;
        }
        await sandboxes.sampleUsage(target);
      } catch (err) {
        // Purged between the listing and its measurement: nothing left to measure, nothing to warn about.
        if (err instanceof SandboxdFailure && err.code === "not_found") continue;
        onError("sandbox", err);
      }
    }
    try {
      await sandboxes.reapFilesHelpers(clock.now(), helperIdleMs);
    } catch (err) {
      onError("reap", err);
    }
  }

  return {
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        // One pass at a time: a slow Docker never stacks passes.
        if (running) return;
        running = tick().finally(() => {
          running = null;
        });
      }, intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
