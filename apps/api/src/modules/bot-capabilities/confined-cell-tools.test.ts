import { BROWSER_TOOL_NAMES, isDangerousToolName, SANDBOX_TOOL_NAMES } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { confinedCellTools } from "./turn-policy";

/** 07.8-08 (WINDOWS #240): the confined tools a bot's cell entry allows follow its own switches and sandboxd. */
describe("confinedCellTools", () => {
  it("lists the sandbox tools for the Sandbox switch and the browser tools for the Browser switch", () => {
    expect(confinedCellTools({ sandbox: true, browser: false }, true)).toEqual([...SANDBOX_TOOL_NAMES]);
    expect(confinedCellTools({ sandbox: false, browser: true }, true)).toEqual([...BROWSER_TOOL_NAMES]);
    expect(confinedCellTools({ sandbox: true, browser: true }, true)).toHaveLength(15);
    expect(confinedCellTools({ sandbox: false, browser: false }, true)).toEqual([]);
  });

  it("lists nothing while sandboxd is not configured, whatever the switches say", () => {
    expect(confinedCellTools({ sandbox: true, browser: true }, false)).toEqual([]);
  });

  it("never lists a name the cell refuses (the reconciler's alsoAllow filter keeps all of them)", () => {
    for (const name of confinedCellTools({ sandbox: true, browser: true }, true)) {
      expect(isDangerousToolName(name), name).toBe(false);
    }
  });
});
