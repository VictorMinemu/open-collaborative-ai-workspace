import type { WorkProjectParent } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { creatableUnits } from "./use-creatable-units";

/**
 * Where the section "+" shows and which unit it preselects (07.10-05, D-07, UI-SPEC § 2, R3, R6): only from the
 * parents `GET /work-projects/parents` returned (the resolver decided them); the browser decides nothing else.
 */

const ENG = "01a11635-d6e7-7c87-9f17-0000000000e1";
const WEB = "01a11635-d6e7-7c87-9f17-0000000000e2";
const API = "01a11635-d6e7-7c87-9f17-0000000000e3";
const OPS = "01a11635-d6e7-7c87-9f17-0000000000f1";
const BILLING = "01a11635-d6e7-7c87-9f17-0000000000f2";
const SALES = "01a11635-d6e7-7c87-9f17-0000000000f9";

const parent = (
  id: string,
  name: string,
  topId: string,
  kind: WorkProjectParent["kind"] = "team",
): WorkProjectParent => ({ id, name, kind, trail: [], topId });

describe("creatableUnits", () => {
  it("offers nothing without parents (still loading, or the viewer may create nowhere)", () => {
    for (const parents of [undefined, []]) {
      const c = creatableUnits(parents);
      expect(c.canCreateIn(ENG)).toBe(false);
      expect(c.defaultParentFor(ENG)).toBeUndefined();
    }
  });

  it("a lead of a team may create in the team's department, preselecting the team", () => {
    const c = creatableUnits([parent(WEB, "Web", ENG)]);
    expect(c.canCreateIn(ENG)).toBe(true);
    expect(c.defaultParentFor(ENG)).toBe(WEB);
    expect(c.canCreateIn(OPS)).toBe(false);
    expect(c.defaultParentFor(OPS)).toBeUndefined();
  });

  it("the department itself wins when the viewer may create there", () => {
    const c = creatableUnits([
      parent(ENG, "Engineering", ENG, "department"),
      parent(API, "API", ENG),
      parent(WEB, "Web", ENG),
    ]);
    expect(c.defaultParentFor(ENG)).toBe(ENG);
  });

  it("otherwise the first unit inside it, in the API's order", () => {
    const c = creatableUnits([
      parent(API, "API", ENG),
      parent(BILLING, "Billing", OPS),
      parent(WEB, "Web", ENG),
    ]);
    expect(c.defaultParentFor(ENG)).toBe(API);
    expect(c.defaultParentFor(OPS)).toBe(BILLING);
    expect(c.canCreateIn(SALES)).toBe(false);
  });
});
