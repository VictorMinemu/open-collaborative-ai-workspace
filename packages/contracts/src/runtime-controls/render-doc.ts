import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RUNTIME_CONTROL_INVENTORY, type RuntimeControlArea, type RuntimeControlRow } from "./index";

/**
 * Renders the runtime controls inventory (WZC-06, P-09) as the generated part of
 * `docs/workzone/runtime-controls-inventory.md`. Internal helper: not exported from `index.ts`, so the web bundle
 * never pulls `node:fs`. `inventory-doc.test.ts` fails when the document and the code disagree; regenerate with
 *
 *     pnpm exec tsx packages/contracts/src/runtime-controls/render-doc.ts --write
 */

export const INVENTORY_START = "<!-- inventory:start -->";
export const INVENTORY_END = "<!-- inventory:end -->";
export const INVENTORY_DOC_URL = new URL(
  "../../../../docs/workzone/runtime-controls-inventory.md",
  import.meta.url,
);

const AREA_TITLES: Record<RuntimeControlArea, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "workzone-ui": "Work Zone UI",
};

/** One table cell: pipes escaped, line breaks flattened. */
function cell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** A markdown table per area (Claude Code, Codex, Work Zone UI): Control | Status | Reason | Evidence, rows in order. */
export function renderInventoryTable(rows: readonly RuntimeControlRow[]): string {
  const areas = [...new Set(rows.map((r) => r.area))].sort(
    (a, b) => Object.keys(AREA_TITLES).indexOf(a) - Object.keys(AREA_TITLES).indexOf(b),
  );
  const sections = areas.map((area) => {
    const lines = [
      `### ${AREA_TITLES[area]}`,
      "",
      "| Control | Status | Reason | Evidence |",
      "| --- | --- | --- | --- |",
      ...rows
        .filter((r) => r.area === area)
        .map((r) => `| ${cell(r.control)} | ${r.status} | ${cell(r.reason)} | ${cell(r.evidence)} |`),
    ];
    return lines.join("\n");
  });
  return sections.join("\n\n");
}

/** The generated text between the markers of a document (without the blank lines around it). */
export function tableInDoc(doc: string): string {
  const start = doc.indexOf(INVENTORY_START);
  const end = doc.indexOf(INVENTORY_END);
  if (start < 0 || end < start) throw new Error("inventory markers missing in the document");
  return doc.slice(start + INVENTORY_START.length, end).trim();
}

/** The document with the generated text replaced. */
export function withTable(doc: string, table: string): string {
  const start = doc.indexOf(INVENTORY_START);
  const end = doc.indexOf(INVENTORY_END);
  if (start < 0 || end < start) throw new Error("inventory markers missing in the document");
  return `${doc.slice(0, start + INVENTORY_START.length)}\n\n${table}\n\n${doc.slice(end)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--write")) {
  const doc = readFileSync(INVENTORY_DOC_URL, "utf8");
  writeFileSync(INVENTORY_DOC_URL, withTable(doc, renderInventoryTable(RUNTIME_CONTROL_INVENTORY)));
  console.log(
    `Wrote ${RUNTIME_CONTROL_INVENTORY.length} rows to docs/workzone/runtime-controls-inventory.md`,
  );
}
