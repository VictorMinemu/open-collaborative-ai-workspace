import { describe, expect, it } from "vitest";
import { focusInDialog } from "./composer";

/** An element stub whose `closest` answers for the given ancestor selectors only. */
const inside = (...ancestors: string[]) => ({
  closest: (selectors: string) =>
    selectors
      .split(",")
      .map((s) => s.trim())
      .some((s) => ancestors.includes(s))
      ? ({} as Element)
      : null,
});

describe("the composer never takes the keyboard from an open dialog (07.1-14)", () => {
  it("focus inside a dialog, an alert dialog or an aria-modal element is a dialog's", () => {
    expect(focusInDialog(inside('[role="dialog"]'))).toBe(true);
    expect(focusInDialog(inside('[role="alertdialog"]'))).toBe(true);
    expect(focusInDialog(inside('[aria-modal="true"]'))).toBe(true);
  });

  it("focus on the page, or nowhere, lets the composer take it", () => {
    expect(focusInDialog(inside())).toBe(false);
    expect(focusInDialog(null)).toBe(false);
    expect(focusInDialog(undefined)).toBe(false);
  });
});
