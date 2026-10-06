import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PINNED_RUNTIME_VERSIONS, RUNTIME_CONTROL_INVENTORY, RuntimeControlStatus } from "./index";
import {
  INVENTORY_DOC_URL,
  INVENTORY_END,
  INVENTORY_START,
  renderInventoryTable,
  tableInDoc,
} from "./render-doc";

/**
 * The documented inventory can never drift from the code inventory (WZC-06, P-09): the table between the markers in
 * `docs/workzone/runtime-controls-inventory.md` is exactly `renderInventoryTable(RUNTIME_CONTROL_INVENTORY)`.
 * Regenerate it with `pnpm exec tsx packages/contracts/src/runtime-controls/render-doc.ts --write`.
 */

const doc = readFileSync(INVENTORY_DOC_URL, "utf8");

describe("runtime controls inventory document (WZC-06)", () => {
  it("has exactly one generated table between the markers", () => {
    expect(doc.split(INVENTORY_START).length - 1).toBe(1);
    expect(doc.split(INVENTORY_END).length - 1).toBe(1);
    expect(doc.indexOf(INVENTORY_START)).toBeLessThan(doc.indexOf(INVENTORY_END));
  });

  it("the table equals renderInventoryTable(RUNTIME_CONTROL_INVENTORY)", () => {
    expect(tableInDoc(doc)).toBe(renderInventoryTable(RUNTIME_CONTROL_INVENTORY));
  });

  it("names the pinned runtime versions", () => {
    expect(doc).toContain(PINNED_RUNTIME_VERSIONS["claude-code"].cli);
    expect(doc).toContain(PINNED_RUNTIME_VERSIONS["claude-code"].sdk);
    expect(doc).toContain(PINNED_RUNTIME_VERSIONS.codex.cli);
  });

  it("every row has a valid status and a reason", () => {
    for (const r of RUNTIME_CONTROL_INVENTORY) {
      expect(RuntimeControlStatus.options, r.control).toContain(r.status);
      expect(r.reason.trim(), r.control).not.toBe("");
    }
  });

  it("renders one table per area with every row, in inventory order, pipes escaped", () => {
    const table = renderInventoryTable(RUNTIME_CONTROL_INVENTORY);
    for (const heading of ["### Claude Code", "### Codex", "### Work Zone UI"])
      expect(table).toContain(heading);
    const bodyRows = table
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| Control |") && !l.startsWith("| --- "));
    expect(bodyRows).toHaveLength(RUNTIME_CONTROL_INVENTORY.length);
    const rendered = renderInventoryTable([
      { ...RUNTIME_CONTROL_INVENTORY[0]!, control: "a | b", reason: "x|y" },
    ]);
    expect(rendered).toContain("a \\| b");
    expect(rendered).toContain("x\\|y");
  });
});
