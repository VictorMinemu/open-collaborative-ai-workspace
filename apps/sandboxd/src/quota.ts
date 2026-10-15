import type { SandboxdTarget } from "@ocw/contracts";
import { SandboxdFailure, type Sandboxes } from "./sandboxes";
import { OCW_FILES } from "./spec";

/**
 * The soft disk quota of each bot's workspace (07.8-09, D-01, D-11 F-9, Pitfall 6, T-07.8-09-03). Docker named
 * volumes have no size limit, so sandboxd measures: `du -sb` through `ocw-files du` as 10001, before every write or
 * upload, after a delete and on every sweep. Over the quota the bot's sandbox stops with reason `disk_full` and
 * `ensure` refuses until a measurement is back under it (people delete through the files helper). A write that would
 * not fit is refused before any byte reaches the workspace. A hard quota (XFS `pquota`) is host hardening, documented
 * for the phase gate.
 */

export interface Quota {
  /** Measures the workspace, records it, and marks or clears `disk_full`; never counts as the bot's activity. */
  measure(target: SandboxdTarget): Promise<number>;
  /** `disk_full` (409) when the workspace is over quota or `incoming` bytes would not fit; else the measured size. */
  assertRoom(target: SandboxdTarget, incoming: number): Promise<number>;
  /** Records the size after a write without measuring again (the next measurement corrects it). */
  afterWrite(target: SandboxdTarget, estimatedBytes: number): void;
  /** Re-measures after a change (a delete); a failure here never fails the operation that changed the files. */
  afterChange(target: SandboxdTarget): Promise<void>;
}

export interface QuotaDeps {
  sandboxes: Pick<
    Sandboxes,
    "workspace" | "run" | "limitsFor" | "recordDisk" | "isDiskFull" | "markDiskFull" | "clearDiskFull"
  >;
}

const MEASURE_TIMEOUT_MS = 120_000;

export function createQuota(deps: QuotaDeps): Quota {
  const { sandboxes } = deps;

  async function measure(target: SandboxdTarget): Promise<number> {
    const handle = await sandboxes.workspace(target, { touch: false });
    const res = await sandboxes.run(handle, [OCW_FILES, "du"], { timeoutMs: MEASURE_TIMEOUT_MS });
    const bytes = Number.parseInt(res.stdout.toString("utf8").trim(), 10);
    if (res.exitCode !== 0 || !Number.isFinite(bytes) || bytes < 0) {
      throw new SandboxdFailure("docker_unavailable", 500, "the workspace could not be measured");
    }
    sandboxes.recordDisk(target, bytes);
    const { diskQuotaBytes } = sandboxes.limitsFor(target.orgId);
    if (bytes > diskQuotaBytes) {
      if (!sandboxes.isDiskFull(target)) await sandboxes.markDiskFull(target);
    } else if (sandboxes.isDiskFull(target)) {
      await sandboxes.clearDiskFull(target);
    }
    return bytes;
  }

  return {
    measure,

    async assertRoom(target, incoming) {
      const used = await measure(target);
      const { diskQuotaBytes } = sandboxes.limitsFor(target.orgId);
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
