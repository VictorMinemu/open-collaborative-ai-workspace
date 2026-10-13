import { describe, expect, it } from "vitest";
import { actionHash } from "./hash";

/**
 * The action hash (MEM-06, D-05): a fixed-order tuple per kind, a domain tag and a version, so a hash pinned today
 * stays valid after any refactor and two kinds never collide on the same tuple.
 */
describe("actionHash", () => {
  it("matches the pinned vector (domain tag, version 1, kind, tuple)", () => {
    expect(actionHash("memory.write", ["p", 1, null, true])).toBe(
      "226e21dd6081a8fee510dddd45223843a2d0c5003959fdbbd4923904bfc63b94",
    );
  });

  it("is 64 lowercase hex characters", () => {
    expect(actionHash("tool.call", [])).toMatch(/^[0-9a-f]{64}$/);
  });

  it("depends on the order of the tuple", () => {
    expect(actionHash("memory.write", ["a", "b"])).not.toBe(actionHash("memory.write", ["b", "a"]));
  });

  it("tells a string from a number and null from the string 'null'", () => {
    expect(actionHash("memory.write", ["1"])).not.toBe(actionHash("memory.write", [1]));
    expect(actionHash("memory.write", [null])).not.toBe(actionHash("memory.write", ["null"]));
    expect(actionHash("memory.write", [true])).not.toBe(actionHash("memory.write", ["true"]));
  });

  it("binds the kind: the same tuple under another kind differs", () => {
    expect(actionHash("memory.write", ["x"])).not.toBe(actionHash("tool.call", ["x"]));
  });

  it("keeps tuple boundaries: ['ab'] differs from ['a', 'b']", () => {
    expect(actionHash("memory.write", ["ab"])).not.toBe(actionHash("memory.write", ["a", "b"]));
  });

  it.each([
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("throws on %s", (_label, n) => {
    expect(() => actionHash("memory.write", [n])).toThrow(/integer/);
  });

  it("throws on undefined (a missing field must never hash like null)", () => {
    expect(() => actionHash("memory.write", [undefined as unknown as null])).toThrow(/undefined/);
  });

  it("throws on a non-atom (objects would need a canonical form)", () => {
    expect(() => actionHash("memory.write", [{} as unknown as null])).toThrow(/atom/);
  });
});
