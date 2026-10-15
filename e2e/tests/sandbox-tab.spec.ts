import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { freshTeamBot } from "../support/bot-tools";
import { putMemoryFile } from "../support/memory";
import {
  enableBotSandbox,
  enableSandboxOrg,
  fakeSandboxd,
  organizationOf,
  resume,
  type SandboxTarget,
} from "../support/sandbox";
import { ADMIN } from "./env";

/**
 * The bot page's Sandbox tab (07.8-15; SBX-05, D-04, D-12, UI-SPEC Surface 3, R4, R11). A person who configures a bot
 * sees its sandbox: the status card, the lazy file tree and a plain-text preview, against the real API and the fake
 * sandboxd (`scripts/e2e-isolated.sh` mounts it at `/__sandboxd`; the spec seeds files and events through its controls).
 * Someone who may not configure the bot sees no Sandbox tab, and `?tab=sandbox` shows Memory.
 *
 * The memory tree backstop (R4): the 07.2 tree rows moved into a shared `TreeRowView`. With
 * `OCW_E2E_TREE_BASELINE=<dir>`, the agent page's memory tree of a fixed bot is captured at this width in light and
 * dark; the first run writes the PNGs (on the commit before the extraction), every later run must produce the same
 * bytes. Without the variable the test still checks the tree renders.
 */

test.describe.configure({ mode: "serial" });

const SCOUT = "Scout";
const TREELINE = "Treeline";
const Q3 = "month,revenue\njul,1200\naug,1450\nsep,1610\n";
const SUMMARY = "# Q3 summary\n\nRevenue grew every month.\n";
const NOTES = "Ask finance for the September close.\n";
const FETCH = "import csv\nprint('fetch')\n";

let admin: APIRequestContext;
let orgId: string;
const open: BrowserContext[] = [];

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  orgId = await organizationOf(admin);
  await enableSandboxOrg(admin);
  // A kill left by another spec would hide the running state.
  await resume(admin);
});

test.afterAll(async () => {
  for (const c of open.splice(0)) await c.close();
  await admin?.dispose();
});

async function signIn(browser: Parameters<typeof openAs>[0], project: string, who: Actor = ADMIN) {
  const s = await openAs(browser, who, project);
  open.push(s.context);
  return s.page;
}

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

/** A team bot "Scout" with its Sandbox switch on and a running sandbox holding a few files. */
async function scoutWithFiles(): Promise<{ id: string; target: SandboxTarget }> {
  const id = await freshTeamBot(admin, SCOUT);
  await enableBotSandbox(admin, id, { sandbox: true });
  const target = { orgId, agentId: id };
  const fake = fakeSandboxd();
  await fake.seedFile(target, "reports/q3.csv", Q3);
  await fake.seedFile(target, "reports/summary.md", SUMMARY);
  await fake.seedFile(target, "scripts/fetch.py", FETCH);
  await fake.seedFile(target, "notes.txt", NOTES);
  // Disk and CPU as sandboxd reports them (the API mirrors usage events).
  await fake.emit({ type: "usage", target, cpuMs: 12 * 60_000, diskBytes: 1_503_238_554 });
  return { id, target };
}

const tabs = (page: Page) => page.getByRole("tablist");

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

  const page = await signIn(browser, info.project.name);
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

test("a configurer opens the Sandbox tab and previews a file the bot wrote; others never see the tab", async ({
  browser,
}, info) => {
  const scout = await scoutWithFiles();
  const page = await signIn(browser, info.project.name);
  await page.goto(`${BASE_URL}/bots/${scout.id}?tab=sandbox`);

  const tab = page.getByTestId("agent-tab-sandbox");
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const status = page.getByTestId("sandbox-status");
  await expect(status).toHaveAttribute("data-status", "running", { timeout: 15_000 });
  await expect(page.getByTestId("sandbox-isolation")).toHaveText("Hardened container · weaker isolation");
  await expect(page.getByTestId("sandbox-disk")).toContainText("1.4 GB of 2 GB");
  await expect(page.getByTestId("sandbox-cpu")).toContainText("12 min");

  const tree = page.getByRole("tree", { name: `Files in ${SCOUT}'s sandbox` });
  await expect(tree).toBeVisible();
  await page.getByTestId("sandbox-row-reports").click();
  const q3 = page.getByTestId("sandbox-row-reports/q3.csv");
  await expect(q3).toBeVisible();
  await expect(q3).toContainText(`${Q3.length} B`);
  await q3.click();
  const preview = page.getByTestId("sandbox-preview");
  await expect(preview).toBeVisible();
  await expect(preview.locator("pre")).toContainText("month,revenue");

  // Sam reads the bot but may not configure it: no Sandbox tab, and the deep link shows Memory.
  const sam = await signIn(browser, info.project.name, SAM);
  await sam.goto(`${BASE_URL}/bots/${scout.id}?tab=sandbox`);
  await expect(sam.getByTestId("agent-page")).toBeVisible();
  await expect(tabs(sam).getByRole("tab", { name: "Memory" })).toHaveAttribute("aria-selected", "true");
  await expect(sam.getByTestId("agent-tab-sandbox")).toHaveCount(0);
});
