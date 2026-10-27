import { describe, expect, it } from "vitest";
import { leftSidebar, moveFocus, nextAfterRemoval, toggleKey } from "./use-sidebar-keys";

/**
 * The sidebar's arrow keys (07.10-04, UI-SPEC § Keyboard): ↑/↓ step through the row-level targets in DOM order, Home
 * and End jump to the ends, ArrowUp on the first returns to the search field; ←/→ collapse and expand a section on its
 * toggle; a removed focused row hands focus to the next row of its section, else to the section's toggle.
 */

describe("moveFocus", () => {
  it("steps down and up, and stops at the ends", () => {
    expect(moveFocus(5, 1, "ArrowDown")).toBe(2);
    expect(moveFocus(5, 4, "ArrowDown")).toBe(4);
    expect(moveFocus(5, 2, "ArrowUp")).toBe(1);
  });

  it("ArrowUp on the first row goes back to the search field (-1)", () => {
    expect(moveFocus(5, 0, "ArrowUp")).toBe(-1);
  });

  it("Home and End jump to the first and last row", () => {
    expect(moveFocus(5, 3, "Home")).toBe(0);
    expect(moveFocus(5, 1, "End")).toBe(4);
  });

  it("ignores every other key and an empty list", () => {
    expect(moveFocus(5, 1, "Tab")).toBeNull();
    expect(moveFocus(5, 1, "Enter")).toBeNull();
    expect(moveFocus(0, 0, "ArrowDown")).toBeNull();
  });
});

describe("toggleKey", () => {
  it("collapses an expanded section with ArrowLeft and expands a collapsed one with ArrowRight", () => {
    expect(toggleKey("ArrowLeft", true)).toBe(true);
    expect(toggleKey("ArrowRight", false)).toBe(true);
  });

  it("does nothing when the section is already in that state, or for another key", () => {
    expect(toggleKey("ArrowLeft", false)).toBe(false);
    expect(toggleKey("ArrowRight", true)).toBe(false);
    expect(toggleKey("Enter", true)).toBe(false);
  });
});

describe("nextAfterRemoval", () => {
  it("is the row that took the removed row's place in its section", () => {
    expect(nextAfterRemoval({ sectionRows: 3, index: 1, hasToggle: true })).toEqual({
      kind: "row",
      index: 1,
    });
  });

  it("is the section's toggle when the removed row was the last one", () => {
    expect(nextAfterRemoval({ sectionRows: 1, index: 1, hasToggle: true })).toEqual({ kind: "toggle" });
    expect(nextAfterRemoval({ sectionRows: 0, index: 0, hasToggle: true })).toEqual({ kind: "toggle" });
  });

  it("falls back to the same place in the whole sidebar when the section itself is gone", () => {
    expect(nextAfterRemoval({ sectionRows: 0, index: 0, hasToggle: false })).toEqual({ kind: "global" });
  });
});

describe("leftSidebar (07.10-07, LO-03)", () => {
  it("is true when focus went outside the sidebar while the row is still there: never pull focus back later", () => {
    expect(leftSidebar({ rowConnected: true, focusInside: false })).toBe(true);
  });

  it("is false while focus stays in the sidebar, or when the row itself left (focus survival then applies)", () => {
    expect(leftSidebar({ rowConnected: true, focusInside: true })).toBe(false);
    expect(leftSidebar({ rowConnected: false, focusInside: false })).toBe(false);
  });
});
