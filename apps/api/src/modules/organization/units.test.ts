import type { UnitKind } from "@ocw/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyMove, type UnitNode, validateParentKind } from "./units";

describe("validateParentKind", () => {
  // Literal truth table (D-07): rows = kind, columns = parent (null = top level).
  const TABLE: Record<UnitKind, Record<"top" | UnitKind, boolean>> = {
    department: { top: true, department: true, team: false, project: false },
    team: { top: false, department: true, team: true, project: false },
    project: { top: false, department: true, team: true, project: false },
  };

  for (const [kind, row] of Object.entries(TABLE) as Array<[UnitKind, Record<string, boolean>]>) {
    for (const [parent, expected] of Object.entries(row)) {
      it(`${kind} under ${parent} → ${expected}`, () => {
        expect(validateParentKind(kind, parent === "top" ? null : (parent as UnitKind))).toBe(expected);
      });
    }
  }

  it("projects are leaves: nothing may sit under a project", () => {
    for (const kind of ["department", "team", "project"] as const) {
      expect(validateParentKind(kind, "project")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- applyMove properties

const id = (i: number) => `u${i}`;

/** A random forest: unit i's parent is null or one of the units created before it. */
const forest = fc.integer({ min: 1, max: 12 }).chain((n) =>
  fc
    .tuple(
      ...Array.from({ length: n }, (_, i) =>
        fc.option(fc.integer({ min: 0, max: Math.max(0, i - 1) }), { nil: null }),
      ),
    )
    .map((parents) => {
      const units: UnitNode[] = [];
      parents.forEach((p, i) => {
        const parent = i === 0 || p === null ? null : units[p]!;
        units.push({ id: id(i), parentId: parent?.id ?? null, path: [...(parent?.path ?? []), id(i)] });
      });
      return units;
    }),
);

const scenario = forest.chain((units) =>
  fc.record({
    units: fc.constant(units),
    moves: fc.array(
      fc.tuple(
        fc.integer({ min: 0, max: units.length - 1 }),
        fc.option(fc.integer({ min: 0, max: units.length - 1 }), { nil: null }),
      ),
      { maxLength: 20 },
    ),
  }),
);

/** The invariants every stored tree must keep (Pitfall 6). */
function assertTree(units: readonly UnitNode[]) {
  const byId = new Map(units.map((u) => [u.id, u]));
  for (const u of units) {
    expect(u.path.at(-1)).toBe(u.id);
    const parentPath = u.parentId === null ? [] : byId.get(u.parentId)!.path;
    expect(u.path.slice(0, -1)).toEqual(parentPath);
    expect(u.path.slice(0, -1)).not.toContain(u.id);
    expect(new Set(u.path).size).toBe(u.path.length);
  }
  // Following parent links always terminates at the top level (no cycle).
  for (const u of units) {
    let cur: UnitNode | undefined = u;
    let steps = 0;
    while (cur && cur.parentId !== null) {
      cur = byId.get(cur.parentId);
      steps += 1;
      expect(steps).toBeLessThanOrEqual(units.length);
    }
  }
}

const isInSubtree = (units: readonly UnitNode[], unitId: string, candidateId: string) =>
  units.find((u) => u.id === candidateId)!.path.includes(unitId);

describe("applyMove", () => {
  it("keeps path invariants after every accepted move; moves into the own subtree are unit_cycle", () => {
    fc.assert(
      fc.property(scenario, ({ units, moves }) => {
        let tree: UnitNode[] = units;
        assertTree(tree);
        for (const [u, t] of moves) {
          const unitId = id(u);
          const targetId = t === null ? null : id(t);
          if (targetId !== null && isInSubtree(tree, unitId, targetId)) {
            expect(() => applyMove(tree, unitId, targetId)).toThrow("unit_cycle");
            continue;
          }
          tree = applyMove(tree, unitId, targetId);
          assertTree(tree);
          expect(tree.find((x) => x.id === unitId)!.parentId).toBe(targetId);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("only the moved subtree changes", () => {
    fc.assert(
      fc.property(scenario, ({ units, moves }) => {
        const [first] = moves;
        if (!first) return;
        const unitId = id(first[0]);
        const targetId = first[1] === null ? null : id(first[1]);
        if (targetId !== null && isInSubtree(units, unitId, targetId)) return;
        const after = applyMove(units, unitId, targetId);
        for (const before of units) {
          const now = after.find((x) => x.id === before.id)!;
          if (!before.path.includes(unitId)) expect(now).toEqual({ ...before, path: [...before.path] });
        }
      }),
      { numRuns: 300 },
    );
  });

  it("rejects a unit moved under itself or a descendant", () => {
    const a = { id: "a", parentId: null, path: ["a"] };
    const b = { id: "b", parentId: "a", path: ["a", "b"] };
    const c = { id: "c", parentId: "b", path: ["a", "b", "c"] };
    expect(() => applyMove([a, b, c], "a", "a")).toThrow("unit_cycle");
    expect(() => applyMove([a, b, c], "a", "c")).toThrow("unit_cycle");
    expect(applyMove([a, b, c], "c", null).find((u) => u.id === "c")).toEqual({
      id: "c",
      parentId: null,
      path: ["c"],
    });
  });
});
