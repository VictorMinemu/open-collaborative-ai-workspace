import type { PresenceFrame } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { aggregatePresence, applyPresenceFrame, type PresenceSnapshot } from "./presence";

const T = "conv:0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";
const U1 = "0190d5e2-7c3a-7cc2-9d2e-000000000001";
const U2 = "0190d5e2-7c3a-7cc2-9d2e-000000000002";
const C1 = "0190d5e2-7c3a-7cc2-9d2e-0000000000c1";
const C2 = "0190d5e2-7c3a-7cc2-9d2e-0000000000c2";
const C3 = "0190d5e2-7c3a-7cc2-9d2e-0000000000c3";

const frame = (full: boolean, entries: PresenceFrame["entries"], topic = T): PresenceFrame => ({
  op: "presence",
  topic,
  full,
  entries,
});
const empty = (): PresenceSnapshot => ({ topics: {} });

describe("applyPresenceFrame", () => {
  it("a full frame replaces the topic (offline entries dropped)", () => {
    let s = applyPresenceFrame(empty(), frame(true, [{ conn: C1, userId: U1, state: "online" }]));
    s = applyPresenceFrame(
      s,
      frame(true, [
        { conn: C2, userId: U2, state: "away" },
        { conn: C3, userId: U2, state: "offline" },
      ]),
    );
    expect(s.topics[T]).toEqual({ [C2]: { userId: U2, state: "away" } });
  });

  it("a delta upserts one connection and an offline delta removes it", () => {
    let s = applyPresenceFrame(empty(), frame(true, [{ conn: C1, userId: U1, state: "online" }]));
    s = applyPresenceFrame(s, frame(false, [{ conn: C2, userId: U2, state: "online" }]));
    expect(Object.keys(s.topics[T] ?? {})).toEqual([C1, C2]);
    s = applyPresenceFrame(s, frame(false, [{ conn: C2, userId: U2, state: "away" }]));
    expect(s.topics[T]?.[C2]).toEqual({ userId: U2, state: "away" });
    s = applyPresenceFrame(s, frame(false, [{ conn: C1, userId: U1, state: "offline" }]));
    expect(s.topics[T]).toEqual({ [C2]: { userId: U2, state: "away" } });
  });

  it("returns the same object when nothing changed", () => {
    const s = applyPresenceFrame(empty(), frame(true, [{ conn: C1, userId: U1, state: "online" }]));
    expect(applyPresenceFrame(s, frame(false, [{ conn: C1, userId: U1, state: "online" }]))).toBe(s);
    expect(applyPresenceFrame(s, frame(false, [{ conn: C2, userId: U2, state: "offline" }]))).toBe(s);
    expect(applyPresenceFrame(s, frame(true, [{ conn: C1, userId: U1, state: "online" }]))).toBe(s);
  });

  it("leaves other topics untouched", () => {
    const other = "ws:0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e60";
    let s = applyPresenceFrame(empty(), frame(true, [{ conn: C1, userId: U1, state: "online" }], other));
    const before = s.topics[other];
    s = applyPresenceFrame(s, frame(true, [{ conn: C2, userId: U2, state: "online" }]));
    expect(s.topics[other]).toBe(before);
  });
});

describe("aggregatePresence", () => {
  it("folds connections per user (online beats away) and sorts online first", () => {
    expect(aggregatePresence(undefined)).toEqual([]);
    expect(
      aggregatePresence({
        [C1]: { userId: U1, state: "away" },
        [C2]: { userId: U2, state: "away" },
        [C3]: { userId: U2, state: "online" },
      }),
    ).toEqual([
      { userId: U2, state: "online" },
      { userId: U1, state: "away" },
    ]);
  });
});
