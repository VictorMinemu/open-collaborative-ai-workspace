import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, type BrowserContext, expect, test } from "@playwright/test";
import { apiAs, BASE_URL, openAs } from "../support/actors";
import { freshTeamBot } from "../support/bot-tools";
import { putMemoryFile } from "../support/memory";
import { ADMIN } from "./env";

/**
 * The bot page's Sandbox tab (07.8-15; SBX-05, D-04, D-12, UI-SPEC Surface 3, R4, R11).
 *
 * The memory tree backstop (R4): the 07.2 tree rows moved into a shared `TreeRowView`. With
 * `OCW_E2E_TREE_BASELINE=<dir>`, the agent page's memory tree of a fixed bot is captured at this width in light and
 * dark; the first run writes the PNGs (on the commit before the extraction), every later run must produce the same
 * bytes. Without the variable the test still checks the tree renders.
 */

test.describe.configure({ mode: "serial" });

const TREELINE = "Treeline";

let admin: APIRequestContext;
const open: BrowserContext[] = [];

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
});

test.afterAll(async () => {
  for (const c of open.splice(0)) await c.close();
  await admin?.dispose();
});

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

test("the memory tree renders the same pixels after its rows moved to TreeRowView (R4 backstop)", async ({
  browser,
}, info) => {
  const id = await freshTeamBot(admin, TREELINE);
  const scope = await admin.post("/api/v1/memory/scopes", { data: { kind: "agent", agentId: id } });
  expect(scope.ok(), "ensure Treeline's notebook").toBe(true);
  const scopeId = ((await scope.json()) as { id: string }).id;
  await putMemoryFile(admin, scopeId, "MEMORY.md", "# Treeline\n\nKeeps the row backstop steady.\n");
  await putMemoryFile(admin, scopeId, "suppliers/pumps.md", "# Pumps\n");
  await putMemoryFile(admin, scopeId, "suppliers/deep/valves.md", "# Valves\n");
  await putMemoryFile(admin, scopeId, "zeta.md", "# Zeta\n");

  const s = await openAs(browser, ADMIN, info.project.name);
  open.push(s.context);
  const page = s.page;
  await page.goto(`${BASE_URL}/bots/${id}`);
  const tree = page.getByRole("tree", { name: `${TREELINE} memory files` });
  await expect(tree.getByRole("treeitem", { name: "MEMORY.md", exact: true })).toBeVisible();
  await tree.getByRole("treeitem", { name: "suppliers, folder", exact: true }).click();
  await tree.getByRole("treeitem", { name: "deep, folder", exact: true }).click();
  await expect(tree.getByRole("treeitem", { name: "valves.md", exact: true })).toBeVisible();
  // A keyboard-focused row (the focus ring) next to the selected one.
  await tree.getByRole("treeitem", { name: "zeta.md", exact: true }).focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  const viewport = page.viewportSize();
  if (viewport) await page.mouse.move(viewport.width - 4, viewport.height - 4);

  const dir = process.env.OCW_E2E_TREE_BASELINE;
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(300);
    const png = await tree.screenshot({ animations: "disabled", caret: "hide" });
    if (!dir) continue;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `memory-tree-${widthOf(info.project.name)}-${theme}.png`);
    if (!existsSync(file)) {
      writeFileSync(file, png);
      continue;
    }
    expect(png.equals(readFileSync(file)), `${file}: identical pixels`).toBe(true);
  }
  await page.emulateMedia({ colorScheme: "light" });
});
