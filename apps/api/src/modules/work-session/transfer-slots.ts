import { Transform } from "node:stream";
import { BOT_FILE_LIMITS } from "@ocw/contracts";

/**
 * The transfer routes' stream slots (07.17.1.1 PD-05, review WR-01, IN-11): one set per app, never per process. At most
 * `perApp` streams at once, and at most `perOrganization` of them for one organization, so one tenant (or one member
 * who paired devices) can never take every slot. `take` answers a release (idempotent), or null when either is full:
 * the route then answers 503 `busy` before the row is claimed, and the device retries.
 */
export function createTransferSlots(
  limits: { perApp: number; perOrganization: number } = {
    perApp: BOT_FILE_LIMITS.concurrentTransfersPerProcess,
    perOrganization: BOT_FILE_LIMITS.concurrentTransfersPerOrganization,
  },
) {
  let active = 0;
  const byOrganization = new Map<string, number>();
  return {
    take(organizationId: string): (() => void) | null {
      const mine = byOrganization.get(organizationId) ?? 0;
      if (active >= limits.perApp || mine >= limits.perOrganization) return null;
      active += 1;
      byOrganization.set(organizationId, mine + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
        const left = (byOrganization.get(organizationId) ?? 1) - 1;
        if (left <= 0) byOrganization.delete(organizationId);
        else byOrganization.set(organizationId, left);
      };
    },
  };
}

export type TransferSlots = ReturnType<typeof createTransferSlots>;

/**
 * Review WR-01: a transfer stream's own deadline. `meter` passes the bytes through and counts each chunk as progress;
 * `onExpire` runs once, at `deadlineMs` (the transfer's `expires_at`, whatever the progress) or after `idleMs` without
 * a chunk (a device that stopped reading or sending). The route then destroys the request, which frees its slot and
 * fails the row. `clear` when the stream ended on its own.
 */
export function guardTransferStream(p: { deadlineMs: number; idleMs: number; onExpire: () => void }): {
  meter: Transform;
  clear(): void;
} {
  let done = false;
  let idle: NodeJS.Timeout | undefined;
  const stop = () => {
    done = true;
    clearTimeout(overall);
    clearTimeout(idle);
  };
  const expire = () => {
    if (done) return;
    stop();
    p.onExpire();
  };
  const overall = setTimeout(expire, Math.max(0, p.deadlineMs));
  const touch = () => {
    if (done) return;
    clearTimeout(idle);
    idle = setTimeout(expire, p.idleMs);
  };
  touch();
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      touch();
      callback(null, chunk);
    },
  });
  return { meter, clear: stop };
}
