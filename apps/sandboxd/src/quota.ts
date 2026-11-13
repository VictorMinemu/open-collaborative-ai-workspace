import type { SandboxdTarget } from "@ocw/contracts";
import { SandboxdFailure, type Sandboxes } from "./sandboxes";
import { EXTRACT_SCRATCH, OCW_FILES } from "./spec";

/**
 * The soft disk quota of each bot's workspace (07.8-09, D-01, D-11 F-9, Pitfall 6, T-07.8-09-03). Docker named
 * volumes have no size limit, so sandboxd measures: `du -sb` through `ocw-files du` as 10001, before every write or
 * upload, after a delete and on every sweep. Over the quota the bot's sandbox stops with reason `disk_full` and
 * `ensure` refuses until a measurement is back under it (people delete through the files helper). A write that would
 * not fit is refused before any byte reaches the workspace. A hard quota (XFS `pquota`) is host hardening, documented
 * for the phase gate.
 *
 * The quota is the organization's pushed policy; there is no default. Without one (sandboxd restarted and the API has not
 * pushed yet) a measurement is recorded but decides nothing, and a write is refused with `policy_missing` (409).
 */

export interface Quota {
  /** Measures the workspace, records it, and marks or clears `disk_full`; never counts as the bot's activity. */
  measure(target: SandboxdTarget): Promise<number>;
  /**
   * `policy_missing` (409) without a pushed policy; `disk_full` (409) when the workspace is over quota or `incoming`
   * bytes would not fit; else the measured size.
   */
  assertRoom(target: SandboxdTarget, incoming: number): Promise<number>;
  /** Records the size after a write without measuring again (the next measurement corrects it). */
  afterWrite(target: SandboxdTarget, estimatedBytes: number): void;
  /** Re-measures after a change (a delete); a failure here never fails the operation that changed the files. */
  afterChange(target: SandboxdTarget): Promise<void>;
}

export interface QuotaDeps {
  sandboxes: Pick<
    Sandboxes,
    | "workspace"
    | "run"
    | "limitsFor"
    | "requirePolicy"
    | "recordDisk"
    | "isDiskFull"
    | "markDiskFull"
    | "clearDiskFull"
  >;
}

const MEASURE_TIMEOUT_MS = 120_000;

export function createQuota(deps: QuotaDeps): Quota {
  const { sandboxes } = deps;

  /**
   * Removes ocw-extract's scratch folder (07.17.1.1.1 review WR-06), only once the shell is stopped (`disk_full`), so no
   * run can be using it: a run SIGKILLed mid-extraction leaves it, and it alone may keep the workspace over its quota.
   * True when something was removed; never fails the measurement.
   */
  async function clearScratch(target: SandboxdTarget): Promise<boolean> {
    try {
      const handle = await sandboxes.workspace(target, { touch: false });
      const res = await sandboxes.run(handle, [OCW_FILES, "rm", EXTRACT_SCRATCH, "1"], {
        timeoutMs: MEASURE_TIMEOUT_MS,
      });
      return res.exitCode === 0;
    } catch {
      return false;
    }
  }

  async function measure(target: SandboxdTarget, again = true): Promise<number> {
    const handle = await sandboxes.workspace(target, { touch: false });
    const res = await sandboxes.run(handle, [OCW_FILES, "du"], { timeoutMs: MEASURE_TIMEOUT_MS });
    const bytes = Number.parseInt(res.stdout.toString("utf8").trim(), 10);
    if (res.exitCode !== 0 || !Number.isFinite(bytes) || bytes < 0) {
      throw new SandboxdFailure("docker_unavailable", 500, "the workspace could not be measured");
    }
    sandboxes.recordDisk(target, bytes);
    // No policy, no quota: nothing is marked or cleared until the API pushes the organization's policy.
    const diskQuotaBytes = sandboxes.limitsFor(target.orgId)?.diskQuotaBytes;
    if (diskQuotaBytes === undefined) return bytes;
    if (bytes > diskQuotaBytes) {
      if (!sandboxes.isDiskFull(target)) await sandboxes.markDiskFull(target);
      // The shell is stopped now: what a killed ocw-extract left goes, and one more measurement may clear disk_full.
      if (again && (await clearScratch(target))) return measure(target, false);
    } else if (sandboxes.isDiskFull(target)) {
      await sandboxes.clearDiskFull(target);
    }
    return bytes;
  }

  return {
    measure: (target) => measure(target),

    async assertRoom(target, incoming) {
      sandboxes.requirePolicy(target.orgId);
      const used = await measure(target);
      const { diskQuotaBytes } = sandboxes.requirePolicy(target.orgId);
      if (used > diskQuotaBytes) {
        throw new SandboxdFailure("disk_full", 409, "the workspace is over its quota");
      }
      if (used + incoming > diskQuotaBytes) {
        throw new SandboxdFailure("disk_full", 409, "the content does not fit in the workspace quota");
      }
      return used;
    },

    afterWrite(target, estimatedBytes) {
      sandboxes.recordDisk(target, estimatedBytes);
    },

    async afterChange(target) {
      try {
        await measure(target);
      } catch {
        // The change itself succeeded; the next sweep measures again.
      }
    },
  };
}
