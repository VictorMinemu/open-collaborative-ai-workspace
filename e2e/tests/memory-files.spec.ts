import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, openAs, SAM } from "../support/actors";
import {
  MEMORY_DEPARTMENT,
  MEMORY_OTHER_TEAM,
  MEMORY_TEAM,
  type MemorySeed,
  memoryScopes,
  seedMemory,
} from "../support/memory";
import { ADMIN } from "./env";

/**
 * The memory viewer (Phase 07.2, 07.2-10, MEM-02, UI-SPEC): Sam opens Memory from the navigation, expands his team's
 * folder in the tree and reads a file rendered as Markdown; on a phone the tree is one full-screen list whose scopes
 * expand in place, and a file opens on its own screen with "Back to files".
 */

test.describe.configure({ mode: "serial" });

let admin: APIRequestContext;
let seed: MemorySeed;
const open: BrowserContext[] = [];

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  seed = await seedMemory(admin);
});

test.afterAll(async () => {
  for (const c of open.splice(0)) await c.close();
  await admin?.dispose();
});

async function signIn(browser: Parameters<typeof openAs>[0], project: string) {
  const s = await openAs(browser, SAM, project);
  open.push(s.context);
  return s.page;
}

const tree = (page: Page) => page.getByRole("tree", { name: "Memory files" });
const row = (page: Page, name: string | RegExp, scopeId?: string) => {
  const items = tree(page).getByRole("treeitem", { name, exact: typeof name === "string" });
  return scopeId ? items.and(page.locator(`[data-scope-id="${scopeId}"]`)) : items;
};

async function noSidewaysScroll(page: Page, label: string) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect.soft(scrollWidth, `${label}: no sideways scroll`).toBeLessThanOrEqual(innerWidth);
}

/** 1440: the tree column next to the reading pane. */
async function browseDesktop(page: Page) {
  await page.getByTestId("nav-memory").click();
  await expect(page).toHaveURL(/\/memory$/);

  // Only the scopes the API lists for Sam, in tree order: his department, his team, then the organization.
  const sam = await apiAs(SAM);
  const listed = await memoryScopes(sam);
  await sam.dispose();
  expect(listed.map((s) => s.label)).toEqual([MEMORY_DEPARTMENT, MEMORY_TEAM, "Organization"]);
  const scopes = tree(page).locator('[data-kind="scope"]');
  await expect(scopes).toHaveCount(3);
  await expect(row(page, `${MEMORY_DEPARTMENT}, department memory`)).toBeVisible();
  await expect(row(page, `${MEMORY_TEAM}, team memory`)).toBeVisible();
  await expect(row(page, "Organization, memory for everyone")).toBeVisible();
  await expect(tree(page).getByText(MEMORY_OTHER_TEAM)).toHaveCount(0);

  // Desktop /memory opens the first scope's MEMORY.md.
  await expect(page.getByTestId("memory-file")).toHaveAttribute("data-path", "MEMORY.md");

  await row(page, `${MEMORY_TEAM}, team memory`).click();
  await expect(row(page, `${MEMORY_TEAM}, team memory`)).toHaveAttribute("aria-expanded", "true");
  await row(page, "clients, folder", seed.ventasScopeId).click();
  await row(page, "acme.md", seed.ventasScopeId).click();

  await expect(page).toHaveURL(`${BASE_URL}/memory/${seed.ventasScopeId}/clients/acme.md`);
  const file = page.getByTestId("memory-file");
  await expect(file).toHaveAttribute("data-path", "clients/acme.md");
  await expect(file.getByText("Industrial pumps, 3 plants.", { exact: false })).toBeVisible();
  await expect(file.getByRole("listitem").filter({ hasText: "Marta Gil" })).toBeVisible();
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("listitem");
  await expect(crumbs).toHaveText([MEMORY_TEAM, "clients", "acme.md"]);
  await expect(page.getByRole("heading", { level: 1, name: "acme.md" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("memory-file-version")).toHaveText(/^Version \d+$/);
  await expect(page.getByTestId("memory-file-editor")).toHaveText(ADMIN.name);
  await expect(page.getByTestId("memory-file-meta")).toContainText("Read only");
  await expect(row(page, "acme.md", seed.ventasScopeId)).toHaveAttribute("aria-current", "page");
  await expect(row(page, "acme.md", seed.ventasScopeId)).toHaveAttribute("aria-selected", "true");
  await noSidewaysScroll(page, "viewer 1440");
}

/** 390: one full-screen tree whose scopes expand in place, then a full-screen file with "Back to files". */
async function browsePhone(page: Page) {
  await page.goto(`${BASE_URL}/memory`);
  await expect(tree(page)).toBeVisible();
  await expect(page.getByTestId("memory-file")).toHaveCount(0);
  await expect(page.getByText("All memory")).toHaveCount(0);

  // Every scope is a collapsed 56 px top-level node of the same tree.
  const scopes = tree(page).locator('[data-kind="scope"]');
  await expect(scopes).toHaveCount(3);
  for (const s of await scopes.all()) {
    await expect(s).toHaveAttribute("aria-expanded", "false");
    await expect(s).toHaveAttribute("aria-level", "1");
    expect((await s.boundingBox())?.height).toBe(56);
  }

  const ventas = row(page, `${MEMORY_TEAM}, team memory`);
  await ventas.tap();
  await expect(ventas).toHaveAttribute("aria-expanded", "true");
  await expect(page).toHaveURL(/\/memory$/);
  const clients = row(page, "clients, folder", seed.ventasScopeId);
  expect((await clients.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await clients.tap();
  await row(page, "acme.md", seed.ventasScopeId).tap();

  await expect(page).toHaveURL(`${BASE_URL}/memory/${seed.ventasScopeId}/clients/acme.md`);
  await expect(page.getByTestId("memory-file")).toBeVisible();
  await expect(tree(page)).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "acme.md" })).toBeFocused();
  await noSidewaysScroll(page, "file 390");

  await page.getByRole("button", { name: "Back to files" }).tap();
  await expect(tree(page)).toBeVisible();
  await expect(ventas).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "acme.md", seed.ventasScopeId)).toBeFocused();
  await noSidewaysScroll(page, "tree 390");

  // A scope link opens the tree with that scope expanded.
  await page.goto(`${BASE_URL}/memory/${seed.orgScopeId}`);
  await expect(row(page, "Organization, memory for everyone")).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "policies, folder", seed.orgScopeId)).toBeVisible();
  await expect(page.getByTestId("memory-file")).toHaveCount(0);
}

test("Sam opens Memory, expands his team's folder and reads a file", async ({ browser }, info) => {
  const mobile = info.project.name === "mobile";
  const page = await signIn(browser, info.project.name);
  if (mobile) await browsePhone(page);
  else await browseDesktop(page);
});
