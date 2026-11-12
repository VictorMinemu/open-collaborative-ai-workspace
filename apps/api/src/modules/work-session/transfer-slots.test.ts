// 07.17.1.1 review WR-01: the transfer routes' stream slots, per app and per organization.

import { BOT_FILE_LIMITS } from "@ocw/contracts";
import { describe, expect, it, vi } from "vitest";
import { createTransferSlots, guardTransferStream } from "./transfer-slots";

describe("createTransferSlots (review WR-01)", () => {
  it("one organization never takes more than its share; the others still get the rest", () => {
    const slots = createTransferSlots({ perApp: 4, perOrganization: 2 });
    const a1 = slots.take("org-a");
    const a2 = slots.take("org-a");
    expect(a1).not.toBeNull();
    expect(a2).not.toBeNull();
    expect(slots.take("org-a")).toBeNull();
    const b1 = slots.take("org-b");
    const b2 = slots.take("org-b");
    expect(b1).not.toBeNull();
    expect(b2).not.toBeNull();
    // The app is full: a third organization waits too.
    expect(slots.take("org-c")).toBeNull();
    a1!();
    expect(slots.take("org-c")).not.toBeNull();
    expect(slots.take("org-a")).toBeNull();
  });

  it("a release is counted once, however often it is called", () => {
    const slots = createTransferSlots({ perApp: 2, perOrganization: 2 });
    const release = slots.take("org-a")!;
    release();
    release();
    expect(slots.take("org-a")).not.toBeNull();
    expect(slots.take("org-a")).not.toBeNull();
    expect(slots.take("org-a")).toBeNull();
  });

  it("defaults to the contract's numbers", () => {
    const slots = createTransferSlots();
    const taken = [];
    for (let i = 0; i < BOT_FILE_LIMITS.concurrentTransfersPerOrganization; i++) taken.push(slots.take("o"));
    expect(taken.every((t) => t !== null)).toBe(true);
    expect(slots.take("o")).toBeNull();
    expect(BOT_FILE_LIMITS.concurrentTransfersPerOrganization).toBeLessThan(
      BOT_FILE_LIMITS.concurrentTransfersPerProcess,
    );
  });
});

describe("guardTransferStream (review WR-01)", () => {
  it("expires once at the deadline even while bytes keep moving", async () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const guard = guardTransferStream({ deadlineMs: 1000, idleMs: 400, onExpire });
      // Progress every 300 ms keeps the idle timer quiet; the overall deadline still falls at 1 000 ms.
      for (let i = 0; i < 3; i++) {
        vi.advanceTimersByTime(300);
        guard.meter.write(Buffer.from("x"));
        guard.meter.read();
      }
      expect(onExpire).toHaveBeenCalledTimes(0);
      vi.advanceTimersByTime(150);
      expect(onExpire).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(5000);
      expect(onExpire).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires when no byte moved for idleMs; clear() stops both timers", () => {
    vi.useFakeTimers();
    try {
      const idle = vi.fn();
      guardTransferStream({ deadlineMs: 10_000, idleMs: 400, onExpire: idle });
      vi.advanceTimersByTime(401);
      expect(idle).toHaveBeenCalledTimes(1);

      const cleared = vi.fn();
      const guard = guardTransferStream({ deadlineMs: 500, idleMs: 400, onExpire: cleared });
      guard.clear();
      vi.advanceTimersByTime(10_000);
      expect(cleared).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a deadline already past expires at once", () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      guardTransferStream({ deadlineMs: -5, idleMs: 400, onExpire });
      vi.advanceTimersByTime(0);
      expect(onExpire).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
