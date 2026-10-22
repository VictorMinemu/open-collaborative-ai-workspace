import { describe, expect, it } from "vitest";
import { FrameSlot } from "./live-view";

/**
 * Drop-on-slow (P-08, T-07.8-16-06): a viewer's one-frame slot. A write in flight blocks the next one; meanwhile only
 * the newest frame waits, so a slow socket never queues more than the frame being written plus one, and it catches up
 * with the latest frame, never with a backlog.
 */

function sink() {
  const written: number[] = [];
  const pending: Array<() => void> = [];
  return {
    written,
    pending,
    s: {
      bufferedAmount: 0,
      open: () => true,
      write(frame: Uint8Array, done: () => void) {
        written.push(frame[0] as number);
        pending.push(done);
      },
    },
  };
}

const frame = (n: number) => new Uint8Array([n]);

describe("FrameSlot (drop-on-slow)", () => {
  it("a fast socket receives every frame in order", () => {
    const k = sink();
    const slot = new FrameSlot(k.s);
    for (let i = 1; i <= 5; i++) {
      slot.offer(frame(i));
      k.pending.shift()?.();
    }
    expect(k.written).toEqual([1, 2, 3, 4, 5]);
    expect(slot.dropped).toBe(0);
  });

  it("a stalled socket keeps one waiting frame, the latest; it is written once the stall ends", () => {
    const k = sink();
    const slot = new FrameSlot(k.s);
    slot.offer(frame(1));
    for (let i = 2; i <= 40; i++) slot.offer(frame(i));
    expect(k.written).toEqual([1]);
    expect(slot.dropped).toBe(38);
    k.pending.shift()?.();
    expect(k.written).toEqual([1, 40]);
    k.pending.shift()?.();
    expect(k.written).toEqual([1, 40]);
    expect(slot.sent).toBe(2);
  });

  it("the privacy gate is asked when the frame is handed to the socket: a frame that waited while the page turned private is dropped (proof pipeline 55)", () => {
    const k = sink();
    let allowed = true;
    const slot = new FrameSlot({ ...k.s, allowed: () => allowed });
    slot.offer(frame(1));
    // Frame 2 waits behind the slow write of frame 1; the page turns private before its turn.
    slot.offer(frame(2));
    allowed = false;
    k.pending.shift()?.();
    expect(k.written).toEqual([1]);
    expect(slot.dropped).toBe(1);
    // Nothing is kept for later either: once the gate opens again, only a new frame is written.
    allowed = true;
    k.pending.shift()?.();
    expect(k.written).toEqual([1]);
    slot.offer(frame(3));
    expect(k.written).toEqual([1, 3]);
  });

  it("a closed socket is never written; clear() drops the waiting frame (the privacy filter turned it off)", () => {
    const k = sink();
    let open = true;
    const slot = new FrameSlot({ ...k.s, open: () => open });
    slot.offer(frame(1));
    slot.offer(frame(2));
    slot.clear();
    k.pending.shift()?.();
    expect(k.written).toEqual([1]);
    open = false;
    slot.offer(frame(3));
    expect(k.written).toEqual([1]);
  });
});
