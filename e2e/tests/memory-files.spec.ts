import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { freshPersonalBot } from "../support/bot-tools";
import { ALEX } from "../support/chat";
import {
  ACME,
  denyFolder,
  ensureMemoryReader,
  MEMORY_DEPARTMENT,
  MEMORY_OTHER_TEAM,
  MEMORY_READER,
  MEMORY_TEAM,
  type MemorySeed,
  memoryScopes,
  pruneVentasToSeed,
  seedMemory,
} from "../support/memory";
import { ADMIN, shot } from "./env";

/**
 * The memory viewer (Phase 07.2, 07.2-10, MEM-02, UI-SPEC): Nina, a Ventas member, opens Memory from the navigation,
 * expands her team's folder in the tree and reads a file rendered as Markdown; on a phone the tree is one full-screen list whose scopes
 * expand in place, and a file opens on its own screen with "Back to files". Then links, hostile content, the shared
 * not-found state, search with its scope selector, keyboard and ARIA, axe, and the review screenshots
 * (`review-memory-*-<1440|390>[-dark].png` when OCW_E2E_SCREENSHOT_DIR is set). No provider is called.
 */

test.describe.configure({ mode: "serial" });

let admin: APIRequestContext;
let seed: MemorySeed;
let readerId: string;
let denyRule: string | null = null;
const open: BrowserContext[] = [];

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  seed = await seedMemory(admin);
  // The keyboard case walks Ventas › clients row by row and snapshots the tree exactly.
  await pruneVentasToSeed(admin, seed);
  // Her own persona, not Sam: other specs leave Sam private scopes in the shared database (WINDOWS 162), and the
  // viewer cases assert her exact scope list and tree.
  readerId = await ensureMemoryReader(admin, seed);
});

test.afterAll(async () => {
  for (const c of open.splice(0)) await c.close();
  if (denyRule) await admin?.delete(`/api/v1/permission-rules/${denyRule}`);
  await admin?.dispose();
});

async function signIn(browser: Parameters<typeof openAs>[0], project: string, who: Actor = MEMORY_READER) {
  const s = await openAs(browser, who, project);
  open.push(s.context);
  return s.page;
}

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

/** The viewer's outline never skips a level: file name h1, then the file's own headings from h2 (WINDOWS 154). */
const NO_HEADING_SKIPS = { failOn: ["heading-order"] } as const;

type ListedScope = Awaited<ReturnType<typeof memoryScopes>>[number];

/**
 * The reader's scopes from the API, checked (WINDOWS 162). Exact where the fixture decides: the units are Comercial
 * then Ventas, the organization comes last, and there is no private scope at all (hers or anyone's) and never Compras.
 * The only other scopes allowed are bot notebooks, listed before the units: a team bot that another spec creates in
 * Ventas (agent-memory's Ledger) shares its notebook with every Ventas member, whatever ran before.
 */
async function readerScopes(): Promise<ListedScope[]> {
  const reader = await apiAs(MEMORY_READER);
  const listed = await memoryScopes(reader);
  await reader.dispose();
  const kinds = listed.map((s) => s.kind);
  const notebooks = kinds.filter((k) => k === "agent").length;
  expect(kinds, "notebooks first, then the units, then the organization").toEqual([
    ...Array<string>(notebooks).fill("agent"),
    "unit",
    "unit",
    "org",
  ]);
  expect(listed.slice(notebooks).map((s) => s.label)).toEqual([
    MEMORY_DEPARTMENT,
    MEMORY_TEAM,
    "Organization",
  ]);
  expect(listed.map((s) => s.label)).not.toContain(MEMORY_OTHER_TEAM);
  return listed;
}

const accessibleName = (s: ListedScope) =>
  s.kind === "agent"
    ? `${s.label}, bot memory`
    : s.kind === "org"
      ? `${s.label}, memory for everyone`
      : `${s.label}, ${s.label === MEMORY_DEPARTMENT ? "department" : "team"} memory`;

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

/** Visible controls without an accessible name (aria-label, labelledby, text or title); ai-chat-visual precedent. */
async function unnamedControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const nameOf = (el: Element) => {
      const label = el.getAttribute("aria-label")?.trim();
      if (label) return label;
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const text = by
          .split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
        if (text) return text;
      }
      const text = (el as HTMLElement).innerText?.trim() || el.textContent?.trim();
      if (text) return text;
      if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return "label";
      return el.getAttribute("title")?.trim() ?? "";
    };
    const selector =
      'button, [role="button"], a[href], [role="menuitem"], [role="option"], [role="treeitem"], input, [role="combobox"]';
    return [...document.querySelectorAll(selector)]
      .filter((el) => !el.closest('[aria-hidden="true"], [inert]') && visible(el) && !nameOf(el))
      .map((el) => el.outerHTML.slice(0, 200));
  });
}

/** Both themes of one screen: layout invariants, axe on the viewer, then the capture. Back to light afterwards. */
async function review(page: Page, screen: string, w: string, opts: { axe?: boolean } = {}) {
  const viewport = page.viewportSize();
  if (viewport && w === "1440") await page.mouse.move(viewport.width - 4, Math.round(viewport.height / 2));
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await noSidewaysScroll(page, `${screen} ${theme}`);
    expect.soft(await unnamedControls(page), `${screen} (${theme}): unnamed controls`).toEqual([]);
    if (opts.axe !== false) await expectNoSeriousA11y(page, '[data-testid="memory-shell"]', NO_HEADING_SKIPS);
    await shot(page, `review-memory-${screen}-${w}${theme === "dark" ? "-dark" : ""}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

const focusedName = (page: Page) =>
  page.evaluate(
    () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent,
  );

/** 1440: the tree column next to the reading pane. */
async function browseDesktop(page: Page) {
  await page.getByTestId("nav-memory").click();
  await expect(page).toHaveURL(/\/memory$/);

  // The scopes the API lists for her, in the same order as the tree: her department, her team, then the organization
  // (after any Ventas bot notebook). No other team, and no private scope.
  const listed = await readerScopes();
  const scopes = tree(page).locator('[data-kind="scope"]');
  await expect(scopes).toHaveCount(listed.length);
  expect(await scopes.evaluateAll((els) => els.map((e) => e.getAttribute("data-scope-id")))).toEqual(
    listed.map((s) => s.id),
  );
  await expect(row(page, `${MEMORY_DEPARTMENT}, department memory`)).toBeVisible();
  await expect(row(page, `${MEMORY_TEAM}, team memory`)).toBeVisible();
  await expect(row(page, "Organization, memory for everyone")).toBeVisible();
  await expect(tree(page).getByText(MEMORY_OTHER_TEAM)).toHaveCount(0);

  // Desktop /memory opens the first scope's MEMORY.md.
  await expect(page.getByTestId("memory-file")).toHaveAttribute("data-path", "MEMORY.md");
  await expect(row(page, "MEMORY.md", listed[0]?.id)).toHaveAttribute("aria-current", "page");

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
  const listed = await readerScopes();
  const scopes = tree(page).locator('[data-kind="scope"]');
  await expect(scopes).toHaveCount(listed.length);
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

test("a Ventas member opens Memory, expands her team's folder and reads a file", async ({
  browser,
}, info) => {
  const mobile = info.project.name === "mobile";
  const page = await signIn(browser, info.project.name);
  if (mobile) await browsePhone(page);
  else await browseDesktop(page);
});

test("links open inside the viewer, hostile HTML stays text, missing and unreadable files share one not-found state", async ({
  browser,
}, info) => {
  const w = widthOf(info.project.name);
  const page = await signIn(browser, info.project.name);
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });

  // A relative .md link opens the other file in place (client navigation, same tab); the rest keeps its rules.
  await page.goto(`${BASE_URL}/memory/${seed.orgScopeId}/policies/expenses.md`);
  const file = page.getByTestId("memory-file");
  await expect(file).toHaveAttribute("data-path", "policies/expenses.md");
  await page.evaluate(() => {
    (window as unknown as { __memoryNoReload: boolean }).__memoryNoReload = true;
  });
  await expect(file.getByRole("link", { name: "workspace memory" })).toHaveAttribute(
    "href",
    `/memory/${seed.orgScopeId}/MEMORY.md`,
  );
  await expect(file.getByRole("link", { name: "outside page" })).toHaveAttribute("target", "_blank");
  await expect(file.getByRole("link", { name: "text file" })).toHaveCount(0);
  await expect(file.getByText("text file")).toBeVisible();
  await file.getByRole("link", { name: "vacation policy" }).click();
  await expect(page).toHaveURL(`${BASE_URL}/memory/${seed.orgScopeId}/policies/vacations.md`);
  await expect(page.getByTestId("memory-file")).toHaveAttribute("data-path", "policies/vacations.md");
  expect(
    await page.evaluate(() => (window as unknown as { __memoryNoReload?: boolean }).__memoryNoReload),
    "client navigation",
  ).toBe(true);

  // Script and image tags in a file are text: no element, no dialog.
  await page.goto(`${BASE_URL}/memory/${seed.orgScopeId}/notes/hostile.md`);
  await expect(page.getByTestId("memory-file")).toHaveAttribute("data-path", "notes/hostile.md");
  await expect(page.getByTestId("memory-file").getByText("<script>alert(1)</script>")).toBeVisible();
  await expect(page.getByTestId("memory-file").locator("script, img, iframe")).toHaveCount(0);
  await expect(page.getByTestId("memory-file").getByText("Plain text after the tags.")).toBeVisible();

  // A deny rule on hr/ for her: the folder disappears and its URL is the same not-found as a missing file.
  denyRule = await denyFolder(admin, seed, readerId);
  await page.goto(`${BASE_URL}/memory/${seed.ventasScopeId}`);
  await expect(row(page, `${MEMORY_TEAM}, team memory`)).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "clients, folder", seed.ventasScopeId)).toBeVisible();
  await expect(row(page, "hr, folder", seed.ventasScopeId)).toHaveCount(0);

  const title = "This file doesn't exist or you can't open it";
  for (const path of ["hr/salaries.md", "clients/nope.md", "notes.txt"]) {
    await page.goto(`${BASE_URL}/memory/${seed.ventasScopeId}/${path}`);
    const notFound = page.getByTestId("memory-file-notfound");
    await expect(notFound, path).toBeVisible();
    await expect(notFound.getByRole("heading", { name: title })).toBeVisible();
    await expect(notFound.getByRole("link", { name: `Back to ${MEMORY_TEAM}` })).toBeVisible();
    await expect(page.getByText("Compensation")).toHaveCount(0);
  }
  // A scope id that is not an id at all (a typo, a crafted link) is the same state, never an error.
  await page.goto(`${BASE_URL}/memory/not-a-scope/clients/acme.md`);
  await expect(page.getByTestId("memory-file-notfound").getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to memory" })).toBeVisible();
  await page.goto(`${BASE_URL}/memory/${seed.ventasScopeId}/hr/salaries.md`);
  await expect(page.getByTestId("memory-file-notfound")).toBeVisible();
  if (w === "1440") await review(page, "notfound", w);
  else await expectNoSeriousA11y(page, '[data-testid="memory-shell"]', NO_HEADING_SKIPS);
  expect(dialogs, "no script ran").toEqual([]);
});

test("search: results grouped by scope with marks, a scope selector, Enter opens, Escape returns to the tree", async ({
  browser,
}, info) => {
  const w = widthOf(info.project.name);
  const mobile = w === "390";
  const page = await signIn(browser, info.project.name);
  await page.goto(`${BASE_URL}/memory`);
  await expect(tree(page)).toBeVisible();

  const field = page.getByRole("searchbox", { name: "Search memory" });
  await field.fill("vacaciones");
  const results = page.getByRole("list", { name: "Search results" });
  await expect(results).toBeVisible();
  await expect(tree(page)).toHaveCount(0);
  await expect(results.getByRole("list", { name: MEMORY_TEAM })).toBeVisible();
  await expect(results.getByRole("list", { name: "Organization" })).toBeVisible();
  await expect(results.getByRole("list", { name: MEMORY_OTHER_TEAM })).toHaveCount(0);
  const hits = page.getByTestId("memory-search-hit");
  await expect(hits).toHaveCount(2);
  await expect(page.getByTestId("memory-search-hit").locator("mark").first()).toBeVisible();
  await expect(page.getByTestId("memory-search-count")).toHaveText("2 results");
  await review(page, "search", w);

  // The selector lists All memory and the scopes the API listed; Ventas narrows the results.
  await page.getByRole("combobox", { name: "Search in" }).click();
  const options = page.getByRole("option");
  await expect(options).toHaveText(["All memory", ...(await readerScopes()).map((s) => s.label)]);
  await page.getByRole("option", { name: MEMORY_TEAM }).click();
  await expect(hits).toHaveCount(1);
  await expect(hits.first()).toHaveAttribute("data-path", "team/vacaciones.md");
  await expect(page.getByTestId("memory-search-count")).toHaveText("1 result");

  await field.fill("zzqqxx");
  await expect(page.getByText("No results for “zzqqxx”.")).toBeVisible();
  await page.getByRole("button", { name: "Search all memory" }).click();
  await expect(page.getByRole("combobox", { name: "Search in" })).toHaveText(/All memory/);
  await expect(page.getByRole("button", { name: "Search all memory" })).toHaveCount(0);

  // Enter on a result opens it and focuses its heading; the query stays.
  await field.fill("vacaciones");
  await expect(hits).toHaveCount(2);
  await page.getByTestId("memory-search-hit").filter({ hasText: "vacations.md" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${BASE_URL}/memory/${seed.orgScopeId}/policies/vacations.md`);
  await expect(page.getByRole("heading", { level: 1, name: "vacations.md" })).toBeFocused();
  if (mobile) {
    await page.getByRole("button", { name: "Back to files" }).tap();
  }
  await expect(field).toHaveValue("vacaciones");
  await expect(hits).toHaveCount(2);
  if (!mobile) {
    await expect(hits.filter({ hasText: "vacations.md" })).toHaveAttribute("aria-current", "page");
  }

  // Escape clears the query and returns focus to the tree.
  await field.focus();
  await page.keyboard.press("Escape");
  await expect(field).toHaveValue("");
  await expect(tree(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("treeitem");

  // Alex is not in Ventas: no Ventas scope, option or hit.
  const alex = await signIn(browser, info.project.name, ALEX);
  await alex.goto(`${BASE_URL}/memory`);
  await expect(tree(alex)).toBeVisible();
  await expect(tree(alex).getByRole("treeitem", { name: `${MEMORY_TEAM}, team memory` })).toHaveCount(0);
  await alex.getByRole("searchbox", { name: "Search memory" }).fill("vacaciones");
  const alexResults = alex.getByRole("list", { name: "Search results" });
  await expect(alexResults.getByRole("list", { name: MEMORY_OTHER_TEAM })).toBeVisible();
  await expect(alexResults.getByRole("list", { name: MEMORY_TEAM })).toHaveCount(0);
  await expect(alex.getByTestId("memory-search-hit").filter({ hasText: "team/" })).toHaveCount(0);
  await alex.getByRole("combobox", { name: "Search in" }).click();
  await expect(alex.getByRole("option", { name: MEMORY_TEAM, exact: true })).toHaveCount(0);
  await alex.keyboard.press("Escape");
});

/** 1440: keyboard, ARIA tree snapshot, axe, and the viewer and loading screenshots. */
async function keyboardDesktop(page: Page) {
  // Comercial's MEMORY.md is open (a deep link expands its scope), so the flow starts there whatever notebooks come
  // before it in the tree.
  const listed = await readerScopes();
  await page.goto(`${BASE_URL}/memory/${seed.departmentScopeId}/MEMORY.md`);
  await expect(page.getByTestId("memory-file")).toHaveAttribute("data-path", "MEMORY.md");
  // The file pane and the tree load apart: the open file's row exists only once its scope's file list arrives, and
  // until then the tree's one tab stop is its first row (with other specs' bot notebooks listed first, that list can
  // arrive after the file pane: WINDOWS #251). Tab is pressed only once the row is rendered and holds the tab stop.
  const openRow = row(page, "MEMORY.md", seed.departmentScopeId);
  await expect(openRow).toHaveAttribute("aria-current", "page");
  await expect(openRow).toHaveAttribute("tabindex", "0");

  // Tab from the search field lands on the open file's row (one tab stop).
  await page.getByRole("searchbox", { name: "Search memory" }).focus();
  await page.keyboard.press("Tab");
  await expect.poll(() => focusedName(page)).toBe("MEMORY.md");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => focusedName(page)).toBe(`${MEMORY_TEAM}, team memory`);
  await page.keyboard.press("ArrowRight");
  await expect(row(page, `${MEMORY_TEAM}, team memory`)).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => focusedName(page)).toBe("clients, folder");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => focusedName(page)).toBe("acme.md");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${BASE_URL}/memory/${seed.ventasScopeId}/clients/acme.md`);
  await expect(page.getByRole("heading", { level: 1, name: "acme.md" })).toBeFocused();
  await expect(row(page, "acme.md", seed.ventasScopeId)).toHaveAttribute("aria-current", "page");

  // Home / End, typeahead and * on the tree.
  await row(page, "acme.md", seed.ventasScopeId).focus();
  await page.keyboard.press("Home");
  // The first scope's row (a scope with no files adds ", no files yet" to its name).
  await expect
    .poll(async () => (await focusedName(page))?.startsWith(accessibleName(listed[0] as ListedScope)))
    .toBe(true);
  await page.keyboard.press("End");
  await expect.poll(() => focusedName(page)).toBe("Organization, memory for everyone");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Home");
  await page.keyboard.type("po");
  await expect.poll(() => focusedName(page)).toBe("policies, folder");
  await page.keyboard.press("*");
  await expect(row(page, "notes, folder", seed.orgScopeId)).toHaveAttribute("aria-expanded", "true");
  await expect(row(page, "policies, folder", seed.orgScopeId)).toHaveAttribute("aria-expanded", "true");
  // → on a file does nothing.
  await row(page, "acme.md", seed.ventasScopeId).focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => focusedName(page)).toBe("acme.md");

  await expect(tree(page)).toMatchAriaSnapshot(`
    - tree "Memory files":
      - treeitem "Comercial, department memory" [expanded]
      - treeitem "MEMORY.md"
      - treeitem "Ventas, team memory" [expanded]
      - treeitem "MEMORY.md"
      - treeitem "clients, folder" [expanded]
      - treeitem "globex, folder"
      - treeitem "acme.md" [selected]
      - treeitem "team, folder"
      - treeitem "Organization, memory for everyone" [expanded]
      - treeitem "MEMORY.md"
      - treeitem "notes, folder" [expanded]
      - treeitem "hostile.md"
      - treeitem "policies, folder" [expanded]
      - treeitem "expenses.md"
      - treeitem "vacations.md"
  `);
  const items = await tree(page)
    .getByRole("treeitem")
    .evaluateAll((els) =>
      els.map((e) => ({ name: e.getAttribute("aria-label"), level: Number(e.getAttribute("aria-level")) })),
    );
  const first = items.findIndex((i) => i.name === `${MEMORY_DEPARTMENT}, department memory`);
  // Anything before Comercial is a collapsed bot notebook (readerScopes); from Comercial on, the exact outline.
  const notebooks = listed.filter((s) => s.kind === "agent");
  expect(items.slice(0, first).map((i) => i.level)).toEqual(notebooks.map(() => 1));
  items.slice(0, first).forEach((i, n) => {
    expect(i.name?.startsWith(accessibleName(notebooks[n] as ListedScope)), `${i.name}`).toBe(true);
  });
  expect(items.slice(first).map((i) => i.level)).toEqual([1, 2, 1, 2, 2, 3, 3, 2, 1, 2, 2, 3, 2, 3, 3]);

  // The viewer review: Ventas › clients open, acme.md selected and rendered.
  await page.goto(`${BASE_URL}/memory/${seed.ventasScopeId}/clients/acme.md`);
  await expect(page.getByTestId("memory-file")).toHaveAttribute("data-path", "clients/acme.md");
  await expect(row(page, "acme.md", seed.ventasScopeId)).toBeVisible();
  await review(page, "viewer", "1440");

  // Loading: the tree and the file pane as skeletons while the API is held.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/api/v1/memory/**", async (route) => {
    await held;
    await route.continue().catch(() => undefined);
  });
  await page.goto(`${BASE_URL}/memory`);
  await expect(page.getByTestId("memory-tree-loading")).toBeVisible();
  await expect(page.getByTestId("memory-file-loading")).toBeVisible();
  await review(page, "loading", "1440", { axe: false });
  release();
  await page.unroute("**/api/v1/memory/**");
}

/** 390: rows ≥ 44 px, named back control, the breadcrumb fits, axe, and the phone screenshots. */
async function polishPhone(page: Page) {
  await page.goto(`${BASE_URL}/memory`);
  await expect(tree(page)).toBeVisible();
  await expect(tree(page).locator('[data-kind="scope"]').first()).toHaveAttribute("aria-expanded", "false");
  await review(page, "scopes", "390");

  await row(page, `${MEMORY_TEAM}, team memory`).tap();
  await row(page, "clients, folder", seed.ventasScopeId).tap();
  await expect(row(page, "acme.md", seed.ventasScopeId)).toBeVisible();
  for (const box of await tree(page)
    .getByRole("treeitem")
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height))) {
    expect(box, "phone rows are at least 44 px").toBeGreaterThanOrEqual(44);
  }
  await review(page, "tree", "390");

  await row(page, "acme.md", seed.ventasScopeId).tap();
  // The loading screen has its own back control: measure the loaded file screen's.
  await expect(page.getByTestId("memory-file")).toHaveAttribute("data-path", "clients/acme.md");
  const back = page.getByRole("button", { name: "Back to files" });
  await expect(back).toBeVisible();
  expect((await back.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
  const fits = await crumbs.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(fits, "breadcrumb truncates instead of overflowing").toBe(true);
  await review(page, "file", "390");

  await back.tap();
  await page.getByRole("searchbox", { name: "Search memory" }).fill("vacaciones");
  await expect(page.getByTestId("memory-search-hit")).toHaveCount(2);
  await page.getByRole("searchbox", { name: "Search memory" }).blur();
  await review(page, "search", "390");
}

test("keyboard and ARIA on desktop, touch targets on phones, axe and the review screenshots", async ({
  browser,
}, info) => {
  const mobile = info.project.name === "mobile";
  const page = await signIn(browser, info.project.name);
  if (mobile) await polishPhone(page);
  else await keyboardDesktop(page);
});

test("Settings › Modules lists Memory next to Work Zone, AI chats and Bots", async ({ browser }, info) => {
  const w = widthOf(info.project.name);
  const page = (await openAs(browser, ADMIN, info.project.name)).page;
  open.push(page.context());
  await page.goto(`${BASE_URL}/settings/modules`);
  await expect(page.getByText("Memory", { exact: true }).first()).toBeVisible();
  // The card's own sentence names every module, Memory included (WINDOWS 155).
  await expect(page.getByTestId("module-access").first()).toContainText(
    "Turn Work Zone, AI chats, Bots, Memory, Sandbox and Browser on or off for the whole organization",
  );
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await shot(page, `review-memory-modules-${w}${theme === "dark" ? "-dark" : ""}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
});

// ---------------------------------------------------------------- 07.2-12: edit, history, diffs, file actions

/**
 * Editing (Phase 07.2, 07.2-12, MEM-02, D-03): a Ventas lead edits a team file as Markdown source in CodeMirror,
 * saves with the version they started from, and sees the new version and its diff in History. Then conflicts,
 * secrets, file and folder actions, restore, the dirty guard, live owner updates, phone tabs, read-only and the
 * review screenshots. People used only here: Lucía (Ventas lead) and Paula (a member with a private bot memory), so
 * the viewer persona's tree, asserted exactly above, never changes.
 */

const LEAD: Actor = { name: "Lucía Vega", email: "lucia@ocw.test", password: "lucia-e2e-password-123" };
const PAULA: Actor = { name: "Paula Ortiz", email: "paula@ocw.test", password: "paula-e2e-password-123" };

async function ensureUnitRole(unitId: string, userId: string, role: "member" | "lead") {
  const res = await admin.get(`/api/v1/units/${unitId}/members`);
  const { members } = (await res.json()) as { members: Array<{ userId: string; role: string }> };
  const found = members.find((m) => m.userId === userId);
  if (found?.role === role) return;
  if (found) {
    const patch = await admin.patch(`/api/v1/units/${unitId}/members/${userId}`, { data: { role } });
    expect(patch.ok(), `make ${userId} ${role} of ${unitId}: ${patch.status()}`).toBe(true);
    return;
  }
  const add = await admin.post(`/api/v1/units/${unitId}/members`, { data: { userId, role } });
  expect(add.ok(), `add ${userId} to ${unitId} as ${role}: ${add.status()}`).toBe(true);
}

/** Lucía leads Ventas (memory.write on its memory through LEAD_PERMISSIONS). */
async function ensureLead(): Promise<string> {
  const id = await ensureMember(admin, LEAD, "lead");
  await ensureUnitRole(seed.ventasUnitId, id, "lead");
  return id;
}

interface FileDto {
  id: string;
  version: number;
  content: string;
}

async function readFile(api: APIRequestContext, scopeId: string, path: string): Promise<FileDto | null> {
  const res = await api.get(`/api/v1/memory/scopes/${scopeId}/file?path=${encodeURIComponent(path)}`);
  if (res.status() === 404) return null;
  expect(res.ok(), `read ${path}: ${res.status()}`).toBe(true);
  return (await res.json()) as FileDto;
}

/** Deletes `path` when it exists and creates it again as the admin: a new file at version 1 ("Created"). */
async function freshFile(scopeId: string, path: string, content: string): Promise<FileDto> {
  const old = await readFile(admin, scopeId, path);
  if (old) {
    const del = await admin.delete(`/api/v1/memory/files/${old.id}?expectedVersion=${old.version}`);
    expect(del.ok(), `delete ${path}: ${del.status()}`).toBe(true);
  }
  const res = await admin.post(`/api/v1/memory/scopes/${scopeId}/files`, { data: { path, content } });
  expect(res.ok(), `create ${path}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as FileDto;
}

const editorOf = (page: Page, path: string) =>
  page.getByRole("textbox", { name: `Markdown source of ${path}` });

/**
 * Puts the caret at the end of the document (after its trailing newline, through a DOM selection CodeMirror picks up,
 * the same on desktop and touch) and types a new last line.
 */
async function appendLine(page: Page, path: string, text: string, opts: { paste?: boolean } = {}) {
  const editor = editorOf(page, path);
  await expect(editor).toBeVisible();
  await editor.click();
  await editor.evaluate((el) => {
    const lines = el.querySelectorAll(".cm-line");
    const last = lines[lines.length - 1];
    if (!last) return;
    const range = document.createRange();
    range.selectNodeContents(last);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  });
  // CodeMirror reads the DOM selection asynchronously: wait until its active line is the last one.
  await expect
    .poll(() =>
      editor.evaluate((el) => {
        const lines = el.querySelectorAll(".cm-line");
        return lines[lines.length - 1]?.classList.contains("cm-activeLine") ?? false;
      }),
    )
    .toBe(true);
  if (opts.paste) await page.keyboard.insertText(text);
  else await page.keyboard.type(text);
}

/** Every script body the page loads from now on (for the "reading never loads the editor" check). */
function recordScripts(page: Page): () => Promise<string[]> {
  const bodies: Promise<string>[] = [];
  page.on("response", (r) => {
    if (r.request().resourceType() === "script") bodies.push(r.text().catch(() => ""));
  });
  return () => Promise.all(bodies);
}
/** A literal only the CodeMirror view bundle carries (its scroller element's class). */
const EDITOR_MARK = "cm-scroller";

const ADDED = "- Ana Ruiz — finance";

test("a Ventas lead edits a team file as Markdown, saves, and sees the new version and its diff in History", async ({
  browser,
}, info) => {
  const mobile = info.project.name === "mobile";
  await ensureLead();
  const acme = await freshFile(seed.ventasScopeId, "clients/acme.md", ACME);
  expect(acme.version).toBe(1);
  const page = await signIn(browser, info.project.name, LEAD);
  const scripts = recordScripts(page);
  const href = `${BASE_URL}/memory/${seed.ventasScopeId}/clients/acme.md`;
  await page.goto(href);
  const file = page.getByTestId("memory-file");
  await expect(file).toHaveAttribute("data-path", "clients/acme.md");
  await expect(file.getByText("Industrial pumps, 3 plants.", { exact: false })).toBeVisible();
  await expect(page.getByTestId("memory-file-meta")).not.toContainText("Read only");

  // Reading never loads the editor bundle.
  expect(
    (await scripts()).some((b) => b.includes(EDITOR_MARK)),
    "no editor chunk while reading",
  ).toBe(false);

  const tabs = page.getByRole("tablist", { name: "File view" });
  await tabs.getByRole("tab", { name: "Edit" }).click();
  await expect(page).toHaveURL(`${href}?tab=edit`);
  await expect(editorOf(page, "clients/acme.md")).toBeVisible();
  expect(
    (await scripts()).some((b) => b.includes(EDITOR_MARK)),
    "the editor chunk loads on Edit",
  ).toBe(true);
  await expect(page.getByTestId("memory-file-meta")).toContainText("Editing version 1");
  const save = page.getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeDisabled();
  await appendLine(page, "clients/acme.md", ADDED);
  await expect(page.getByRole("status").filter({ hasText: "Unsaved changes" })).toBeVisible();
  await expect(save).toBeEnabled();
  await page.keyboard.press("Control+s");

  await expect(page.getByText("Saved version 2")).toBeVisible();
  await expect(page).toHaveURL(href);
  await expect(editorOf(page, "clients/acme.md")).toHaveCount(0);
  await expect(file.getByText("Ana Ruiz — finance")).toBeVisible();
  await expect(page.getByTestId("memory-file-version")).toHaveText("Version 2");
  await expect(page.getByTestId("memory-file-editor")).toHaveText(LEAD.name);
  const stored = await readFile(admin, seed.ventasScopeId, "clients/acme.md");
  expect(stored?.version).toBe(2);
  expect(stored?.content).toContain(ADDED);

  if (mobile) {
    // Phone: View · Edit · History tabs (underline, 44 px); History lists, a row opens a unified diff.
    for (const t of await tabs.getByRole("tab").all()) {
      expect((await t.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    await expect(tabs.getByRole("tab")).toHaveText(["View", "Edit", "History"]);
    await tabs.getByRole("tab", { name: "History" }).click();
    await expect(page).toHaveURL(`${href}?tab=history`);
  } else {
    // 1440: the History toggle opens the 360 px column.
    const toggle = page.getByRole("button", { name: "History", exact: true });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(`${href}?tab=history`);
    const column = page.getByTestId("memory-history-column");
    await expect(column).toBeVisible();
    expect(Math.round((await column.boundingBox())?.width ?? 0)).toBe(360);
  }

  const revisions = page.getByTestId("memory-revision");
  await expect(revisions).toHaveCount(2);
  await expect(revisions.nth(0)).toHaveAttribute("data-version", "2");
  await expect(revisions.nth(0)).toContainText("Edited");
  await expect(revisions.nth(0)).toContainText("+1");
  await expect(revisions.nth(0)).toContainText("−0");
  await expect(revisions.nth(0)).toContainText(LEAD.name);
  await expect(revisions.nth(1)).toHaveAttribute("data-version", "1");
  await expect(revisions.nth(1)).toContainText("Created");

  await revisions.nth(0).click();
  await expect(page).toHaveURL(`${href}?tab=history&v=2`);
  // 1440 keeps the list in its column with the row pressed; phone tabs open the revision in place of the list.
  if (mobile) await expect(page.getByRole("button", { name: "All versions" })).toBeVisible();
  else await expect(revisions.nth(0)).toHaveAttribute("aria-pressed", "true");
  const diff = page.getByRole("region", { name: "Changes from version 1 to version 2" });
  await expect(diff).toBeVisible();
  await expect(diff).toHaveAttribute("data-layout", mobile ? "unified" : "split");
  const inserted = diff.locator(".cm-merge-b .cm-changedLine").filter({ hasText: "Ana Ruiz — finance" });
  await expect(inserted).toBeVisible();
  const bar = await inserted.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(bar, "a 3 px change bar").toContain("3px");
  const added = page.getByTestId("memory-diff-added");
  await expect(added).toHaveText("+1");
  await expect(added).toHaveClass(/text-emerald-700/);
  await noSidewaysScroll(page, "history diff");
});

test("at 1100 px the file has View · Edit · History tabs and no history column", async ({
  browser,
}, info) => {
  const page = await signIn(browser, info.project.name, LEAD);
  if (info.project.name !== "mobile") await page.setViewportSize({ width: 1100, height: 900 });
  const href = `${BASE_URL}/memory/${seed.ventasScopeId}/clients/acme.md`;
  await page.goto(href);
  await expect(page.getByTestId("memory-file")).toHaveAttribute("data-path", "clients/acme.md");
  const tabs = page.getByRole("tablist", { name: "File view" });
  await expect(tabs.getByRole("tab")).toHaveText(["View", "Edit", "History"]);
  await expect(page.locator('[data-slot="tabs"][data-variant="underline"]').first()).toBeVisible();
  await expect(page.getByTestId("memory-history-column")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "History", exact: true })).toHaveCount(0);
  await tabs.getByRole("tab", { name: "History" }).click();
  const revisions = page.getByTestId("memory-revision");
  await expect(revisions.first()).toBeVisible();
  await revisions.first().click();
  const diff = page.getByRole("region", { name: /^Changes from version \d+ to version \d+$/ });
  await expect(diff).toHaveAttribute("data-layout", "unified");
  await expect(diff.locator(".cm-changedLine").first()).toBeVisible();
  await page.getByRole("button", { name: "All versions" }).click();
  await expect(revisions.first()).toBeVisible();
  await noSidewaysScroll(page, "1100 history");
});

test("Sam can't edit the team file but edits a private MEMORY.md the same way (Paula with her bot)", async ({
  browser,
}, info) => {
  // Sam is a member of Ventas without write: Read only, no Edit tab.
  const sam = await signIn(browser, info.project.name, SAM);
  await sam.goto(`${BASE_URL}/memory/${seed.ventasScopeId}/clients/acme.md`);
  await expect(sam.getByTestId("memory-file")).toHaveAttribute("data-path", "clients/acme.md");
  await expect(sam.getByTestId("memory-file-meta")).toContainText("Read only");
  await expect(sam.getByRole("tab", { name: "Edit" })).toHaveCount(0);
  await expect(sam.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

  // Paula, a Ventas member too, opens her private memory with her bot and edits its MEMORY.md.
  const paulaId = await ensureMember(admin, PAULA, "developer");
  await ensureUnitRole(seed.ventasUnitId, paulaId, "member");
  const bot = await freshPersonalBot(PAULA, paulaId);
  const paulaApi = await apiAs(PAULA);
  const opened = await paulaApi.post("/api/v1/memory/scopes", {
    data: { kind: "personal", agentId: bot.id },
  });
  expect(opened.ok(), `open private scope: ${opened.status()}`).toBe(true);
  const scope = (await opened.json()) as { id: string };
  await paulaApi.dispose();

  const page = await signIn(browser, info.project.name, PAULA);
  const href = `${BASE_URL}/memory/${scope.id}/MEMORY.md`;
  await page.goto(href);
  await expect(page.getByTestId("memory-file")).toHaveAttribute("data-path", "MEMORY.md");
  await page.getByRole("tablist", { name: "File view" }).getByRole("tab", { name: "Edit" }).click();
  await appendLine(page, "MEMORY.md", "- Prefers short answers");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/^Saved version \d+$/)).toBeVisible();
  await expect(page.getByTestId("memory-file").getByText("Prefers short answers")).toBeVisible();
});

// ---------------------------------------------------------------- 07.2-12 Task 3

const ACME_HREF = () => `${BASE_URL}/memory/${seed.ventasScopeId}/clients/acme.md`;
/** An Anthropic-style key, assembled so no scanner flags this file. */
const PASTED_KEY = ["sk", "ant", "api03", "Zq7Lm2Np9Rt4Vx8Bc1Df6Gh3Jk5"].join("-");
const ROOT_NOTE = "MEMORY.md is the scope's main file. You can edit it, not rename or delete it.";

async function putAs(api: APIRequestContext, fileId: string, content: string, expectedVersion: number) {
  const res = await api.put(`/api/v1/memory/files/${fileId}`, { data: { content, expectedVersion } });
  expect(res.ok(), `PUT ${fileId}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as FileDto;
}

async function openEdit(page: Page, href: string, path: string) {
  await page.goto(`${href}?tab=edit`);
  await expect(editorOf(page, path)).toBeVisible();
}

const saveButton = (page: Page) => page.getByRole("button", { name: "Save", exact: true });

test("a concurrent save opens the conflict view: Keep mine saves over it, Use theirs discards the draft", async ({
  browser,
}, info) => {
  const w = widthOf(info.project.name);
  const mobile = w === "390";
  await ensureLead();
  const acme = await freshFile(seed.ventasScopeId, "clients/acme.md", ACME);
  const page = await signIn(browser, info.project.name, LEAD);

  await openEdit(page, ACME_HREF(), "clients/acme.md");
  await appendLine(page, "clients/acme.md", "- Lead's note");
  // The admin saves first, from another session.
  await putAs(admin, acme.id, `${ACME}- Admin's note\n`, 1);
  await saveButton(page).click();

  const conflict = page.getByTestId("memory-conflict");
  await expect(conflict.getByRole("alert")).toHaveText(
    `${ADMIN.name} saved version 2 while you were editing.`,
  );
  await expect(page.getByRole("heading", { name: "Choose what to keep" })).toBeFocused();
  const diff = page.getByRole("region", { name: "Changes from version 2 to your changes" });
  await expect(diff).toBeVisible();
  await expect(diff).toHaveAttribute("data-layout", mobile ? "unified" : "split");
  const keep = page.getByRole("button", { name: "Keep mine" });
  const theirs = page.getByRole("button", { name: "Use theirs" });
  await expect(conflict.getByText("Saves your text as version 3. Version 2 stays in History.")).toBeVisible();
  await expect(conflict.getByText("Discards your changes and shows version 2.")).toBeVisible();
  if (mobile) {
    // Stacked full width, 44 px each.
    const pane = (await conflict.boundingBox())?.width ?? 0;
    for (const b of [keep, theirs]) {
      const box = await b.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(pane - 33);
    }
  }
  await review(page, "conflict", w);

  await keep.click();
  await expect(page.getByText("Saved version 3")).toBeVisible();
  await expect(page).toHaveURL(ACME_HREF());
  const kept = await readFile(admin, seed.ventasScopeId, "clients/acme.md");
  expect(kept?.version).toBe(3);
  expect(kept?.content).toContain("- Lead's note");
  expect(kept?.content).not.toContain("- Admin's note");

  // Second round: the draft loses to the saved version.
  await openEdit(page, ACME_HREF(), "clients/acme.md");
  await appendLine(page, "clients/acme.md", "- Discarded idea");
  await putAs(admin, acme.id, `${ACME}- Admin again\n`, 3);
  await saveButton(page).click();
  await expect(page.getByTestId("memory-conflict")).toBeVisible();
  await page.getByRole("button", { name: "Use theirs" }).click();
  await expect(page).toHaveURL(ACME_HREF());
  const file = page.getByTestId("memory-file");
  await expect(file.getByText("Admin again")).toBeVisible();
  await expect(file.getByText("Discarded idea")).toHaveCount(0);
  await expect(page.getByTestId("memory-file-version")).toHaveText("Version 4");
  expect((await readFile(admin, seed.ventasScopeId, "clients/acme.md"))?.version).toBe(4);
});

test("a pasted secret is refused with its line and a masked sample; nothing is saved", async ({
  browser,
}, info) => {
  const w = widthOf(info.project.name);
  await ensureLead();
  await freshFile(seed.ventasScopeId, "clients/acme.md", ACME);
  const page = await signIn(browser, info.project.name, LEAD);
  await openEdit(page, ACME_HREF(), "clients/acme.md");
  await appendLine(page, "clients/acme.md", `API token ${PASTED_KEY}`, { paste: true });
  await saveButton(page).click();

  const line = ACME.split("\n").length;
  const notice = page.getByTestId("memory-secret-notice");
  await expect(notice).toHaveAttribute("role", "alert");
  await expect(notice).toContainText(`This looks like a secret on line ${line}.`);
  await expect(notice).toContainText("sk-a••••");
  await expect(notice).toContainText("Secrets can't be stored in memory. Remove it and save again.");
  expect(await notice.textContent()).not.toContain(PASTED_KEY);
  const marked = page.locator(".cm-secretLine");
  await expect(marked).toHaveCount(1);
  await expect(marked).toContainText("API token");
  await expect(editorOf(page, "clients/acme.md")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Unsaved changes" })).toBeVisible();
  expect((await readFile(admin, seed.ventasScopeId, "clients/acme.md"))?.version).toBe(1);
  await review(page, "secret", w);
  await page.getByRole("button", { name: `Go to line ${line}` }).click();
  await expect(editorOf(page, "clients/acme.md")).toBeFocused();
});

test("history shows a revision's diff and restores an older version as a new one", async ({
  browser,
}, info) => {
  const w = widthOf(info.project.name);
  const mobile = w === "390";
  await ensureLead();
  const acme = await freshFile(seed.ventasScopeId, "clients/acme.md", ACME);
  await putAs(
    admin,
    acme.id,
    ACME.replace("- Luis Romero — maintenance\n", "- Luis Romero — plant manager\n- Ana Ruiz — finance\n"),
    1,
  );
  const page = await signIn(browser, info.project.name, LEAD);
  await page.goto(`${ACME_HREF()}?tab=history&v=2`);
  const diff = page.getByRole("region", { name: "Changes from version 1 to version 2" });
  await expect(diff).toBeVisible();
  await expect(diff.locator(".cm-changedLine").first()).toBeVisible();
  await expect(page.getByTestId("memory-diff-added")).toHaveText("+2");
  await expect(page.getByTestId("memory-diff-removed")).toHaveText("−1");
  await expect(page.getByTestId("memory-diff-removed")).toHaveClass(/text-red-700/);
  // Collapsed unchanged stretch, deleted text struck through in the unified view.
  await expect(diff.locator(".cm-collapsedLines").first()).toContainText("unchanged lines");
  if (mobile) {
    await expect(diff.locator(".cm-deletedLine del").first()).toHaveCSS(
      "text-decoration-line",
      "line-through",
    );
  }
  // The newest version has nothing to restore.
  await expect(page.getByRole("button", { name: /^Restore/ })).toHaveCount(0);
  await review(page, "history", w);

  await page.goto(`${ACME_HREF()}?tab=history&v=1`);
  await expect(page.getByRole("region", { name: "Changes from empty to version 1" })).toBeVisible();
  await page.getByRole("button", { name: mobile ? "Restore" : "Restore version 1" }).click();
  const dialog = page.getByRole("dialog", { name: "Restore version 1?" });
  await expect(dialog).toContainText(
    "Its content becomes version 3. Nothing is lost: version 2 stays in history.",
  );
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByRole("button", { name: "Restore version 1" }).click();
  await expect(page.getByText("Restored version 1 as version 3")).toBeVisible();
  await expect(page.getByTestId("memory-revision-view")).toHaveCount(0);
  await expect(page.getByTestId("memory-file-version")).toHaveText("Version 3");
  const restored = await readFile(admin, seed.ventasScopeId, "clients/acme.md");
  expect(restored?.content).toBe(ACME);
  if (mobile)
    await page.getByRole("tablist", { name: "File view" }).getByRole("tab", { name: "History" }).click();
  const top = page.getByTestId("memory-revision").first();
  await expect(top).toHaveAttribute("data-version", "3");
  await expect(top).toContainText("Restored");
});

test("leaving Edit with unsaved changes asks first: tree, back and tabs; the draft survives Keep editing", async ({
  browser,
}, info) => {
  const w = widthOf(info.project.name);
  const mobile = w === "390";
  await ensureLead();
  await freshFile(seed.ventasScopeId, "clients/acme.md", ACME);
  const page = await signIn(browser, info.project.name, LEAD);
  await page.goto(ACME_HREF());
  await page.getByRole("tablist", { name: "File view" }).getByRole("tab", { name: "Edit" }).click();
  await appendLine(page, "clients/acme.md", "- Draft line");
  await expect(page.getByRole("status").filter({ hasText: "Unsaved changes" })).toBeVisible();
  // The editor fits the width; nothing scrolls sideways (review checks it too).
  const box = await editorOf(page, "clients/acme.md").boundingBox();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(Number(w) + 1);
  await review(page, "edit", w);

  const discard = page.getByRole("dialog", { name: "Discard unsaved changes?" });
  // An in-app way out: the tree (desktop) or Back to files (phone).
  if (mobile) await page.getByRole("button", { name: "Back to files" }).click();
  else await row(page, "MEMORY.md", seed.ventasScopeId).click();
  await expect(discard).toBeVisible();
  await expect(discard).toContainText("Your changes to acme.md haven't been saved.");
  await expect(discard.getByRole("button", { name: "Keep editing" })).toBeFocused();
  await discard.getByRole("button", { name: "Keep editing" }).click();
  await expect(discard).toHaveCount(0);
  await expect(page).toHaveURL(`${ACME_HREF()}?tab=edit`);
  await expect(editorOf(page, "clients/acme.md")).toContainText("Draft line");

  // Browser Back leaves Edit without asking first: the guard asks now, Keep editing brings the draft back.
  await page.goBack();
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(`${ACME_HREF()}?tab=edit`);
  await expect(editorOf(page, "clients/acme.md")).toContainText("Draft line");

  // A tab change asks too; Discard changes leaves.
  if (mobile)
    await page.getByRole("tablist", { name: "File view" }).getByRole("tab", { name: "View" }).click();
  else await page.getByRole("button", { name: "Cancel" }).click();
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Discard changes" }).click();
  await expect(page).toHaveURL(ACME_HREF());
  await expect(page.getByTestId("memory-file").getByText("Draft line")).toHaveCount(0);
  expect((await readFile(admin, seed.ventasScopeId, "clients/acme.md"))?.version).toBe(1);

  // Closing the tab with unsaved changes asks the browser's own question.
  await page.getByRole("tablist", { name: "File view" }).getByRole("tab", { name: "Edit" }).click();
  await appendLine(page, "clients/acme.md", "- Unsaved again");
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.type());
    void d.accept();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => dialogs).toContain("beforeunload");
});

test("file and folder actions: new folder, new file, rename or move with live validation, delete; MEMORY.md stays", async ({
  browser,
}, info) => {
  const w = widthOf(info.project.name);
  const mobile = w === "390";
  await ensureLead();
  for (const p of ["meetings/INDEX.md", "meetings/2026-10-08.md", "meetings/kickoff.md"]) {
    const f = await readFile(admin, seed.ventasScopeId, p);
    if (f) await admin.delete(`/api/v1/memory/files/${f.id}?expectedVersion=${f.version}`);
  }
  const page = await signIn(browser, info.project.name, LEAD);
  const base = `${BASE_URL}/memory/${seed.ventasScopeId}`;
  await page.goto(`${base}/MEMORY.md`);
  await expect(page.getByTestId("memory-file")).toHaveAttribute("data-path", "MEMORY.md");

  // MEMORY.md: Rename and Delete are disabled with the reason.
  await page.getByRole("button", { name: "File actions" }).click();
  const menu = page.getByRole("menu");
  for (const name of [/Rename or move/, /Delete/]) {
    await expect(menu.getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true");
  }
  if (!mobile) {
    await menu.getByRole("menuitem", { name: /Rename or move/ }).hover();
    await expect(page.getByText(ROOT_NOTE, { exact: true })).toBeVisible();
  }
  await page.keyboard.press("Escape");

  if (mobile) {
    // Phone: the file's ⋯ menu renames and deletes (bottom-sheet dialogs); creating happens from the tree's ⋯.
    await freshFile(seed.ventasScopeId, "meetings/2026-10-08.md", "# 2026-10-08\n");
    await page.goto(`${base}/meetings/2026-10-08.md`);
    await page.getByRole("button", { name: "File actions" }).click();
    await page.getByRole("menuitem", { name: /Rename or move/ }).click();
    const dialog = page.getByRole("dialog", { name: "Rename or move" });
    const field = dialog.getByLabel("Path");
    await expect(field).toBeFocused();
    await field.fill("meetings/kickoff.md");
    await dialog.getByRole("button", { name: "Rename" }).click();
    await expect(page.getByText("Renamed to kickoff.md")).toBeVisible();
    await expect(page).toHaveURL(`${base}/meetings/kickoff.md`);
    await page.getByRole("button", { name: "File actions" }).click();
    await page.getByRole("menuitem", { name: /Delete/ }).click();
    const del = page.getByRole("dialog", { name: "Delete meetings/kickoff.md?" });
    await expect(del.getByRole("button", { name: "Cancel" })).toBeFocused();
    await del.getByRole("button", { name: "Delete file" }).click();
    await expect(page.getByText("Deleted kickoff.md")).toBeVisible();
    await expect(page).toHaveURL(`${base}/MEMORY.md`);

    // The tree screen: the focused row's ⋯ (44 px) creates files and folders in that place.
    await page.goto(`${BASE_URL}/memory`);
    await row(page, `${MEMORY_TEAM}, team memory`).tap();
    const more = page.getByRole("button", { name: `Actions for ${MEMORY_TEAM}` });
    await expect(more).toBeVisible();
    expect((await more.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await more.tap();
    await expect(page.getByRole("menuitem", { name: "New file…" })).toBeVisible();
    await page.getByRole("menuitem", { name: "New folder…" }).tap();
    const folderSheet = page.getByRole("dialog", { name: "New folder" });
    await expect(folderSheet.getByLabel("Folder")).toHaveValue("");
    await folderSheet.getByRole("button", { name: "Cancel" }).tap();
    await noSidewaysScroll(page, "tree 390 with row menu");
    return;
  }

  // New folder (column header): meetings/INDEX.md is created and opened, the folder shows in the tree.
  await page.getByRole("button", { name: "New folder" }).click();
  const folderDialog = page.getByRole("dialog", { name: "New folder" });
  await folderDialog.getByLabel("Folder").fill("meetings");
  await expect(folderDialog).toContainText("Creates meetings/INDEX.md so the folder isn't empty.");
  await folderDialog.getByRole("button", { name: "Create folder" }).click();
  await expect(page).toHaveURL(`${base}/meetings/INDEX.md`);
  await expect(row(page, "meetings, folder", seed.ventasScopeId)).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("memory-file").getByRole("heading", { name: "meetings" })).toBeVisible();

  // New file in the open file's folder: opens in Edit with its heading.
  await page.getByRole("button", { name: "New file" }).click();
  const fileDialog = page.getByRole("dialog", { name: "New file" });
  const pathField = fileDialog.getByLabel("Path");
  await expect(pathField).toHaveValue("meetings/");
  await pathField.press("End");
  await pathField.pressSequentially("2026-10-08.md");
  await fileDialog.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(`${base}/meetings/2026-10-08.md?tab=edit`);
  await expect(editorOf(page, "meetings/2026-10-08.md")).toContainText("# 2026-10-08");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(`${base}/meetings/2026-10-08.md`);

  // Rename or move from the tree row's ⋯ menu, with live validation.
  const fileRow = row(page, "2026-10-08.md", seed.ventasScopeId);
  await fileRow.hover();
  await page.getByRole("button", { name: "Actions for 2026-10-08.md" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await shot(page, "review-memory-actions-menu-1440");
  await page.getByRole("menuitem", { name: /Rename or move/ }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename or move" });
  const renameField = renameDialog.getByLabel("Path");
  await expect(renameField).toHaveValue("meetings/2026-10-08.md");
  await expect
    .poll(() =>
      renameField.evaluate((el: HTMLInputElement) =>
        el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0),
      ),
    )
    .toBe("2026-10-08");
  await renameField.fill("../x.md");
  await expect(renameDialog.getByRole("alert")).toHaveText('"." and ".." aren\'t allowed.');
  await review(page, "actions", "1440", { axe: false });
  await expectNoSeriousA11y(page, '[role="dialog"]');
  // From 1024 the close X keeps its 32 px desktop look (it grows to 44 only on touch widths, WINDOWS 161).
  const closeBox = await renameDialog.getByRole("button", { name: "Close", exact: true }).boundingBox();
  expect(Math.round(closeBox?.width ?? 0), "desktop dialog close stays 32 px").toBe(32);
  await renameField.fill("clients/acme.md");
  await expect(renameDialog.getByRole("alert")).toHaveText("A file with this name already exists.");
  await renameField.fill("archive/kickoff.md");
  await expect(renameDialog.getByRole("button", { name: "Move" })).toBeVisible();
  await renameField.fill("meetings/kickoff.md");
  await renameDialog.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByText("Renamed to kickoff.md")).toBeVisible();
  await expect(page).toHaveURL(`${base}/meetings/kickoff.md`);
  await expect(row(page, "kickoff.md", seed.ventasScopeId)).toBeVisible();
  await expect(row(page, "2026-10-08.md", seed.ventasScopeId)).toHaveCount(0);

  // Keyboard: F2 renames the focused row, Delete deletes it (with confirmation).
  await row(page, "kickoff.md", seed.ventasScopeId).focus();
  await page.keyboard.press("F2");
  await expect(page.getByRole("dialog", { name: "Rename or move" })).toBeVisible();
  await page.keyboard.press("Escape");
  await row(page, "kickoff.md", seed.ventasScopeId).focus();
  await page.keyboard.press("Delete");
  const del = page.getByRole("dialog", { name: "Delete meetings/kickoff.md?" });
  await expect(del).toContainText(
    `Everyone with access to ${MEMORY_TEAM} memory loses this file, bots included.`,
  );
  await expect(del.getByRole("button", { name: "Cancel" })).toBeFocused();
  await del.getByRole("button", { name: "Delete file" }).click();
  await expect(page.getByText("Deleted kickoff.md")).toBeVisible();
  await expect(page).toHaveURL(`${base}/meetings/INDEX.md`);
  await expect(row(page, "kickoff.md", seed.ventasScopeId)).toHaveCount(0);

  // Clean up: the folder disappears with its last file.
  const index = await readFile(admin, seed.ventasScopeId, "meetings/INDEX.md");
  if (index) await admin.delete(`/api/v1/memory/files/${index.id}?expectedVersion=${index.version}`);
});

test("the owner sees their private memory change live, and a newer-version notice while editing", async ({
  browser,
}, info) => {
  const paulaId = await ensureMember(admin, PAULA, "developer");
  const bot = await freshPersonalBot(PAULA, paulaId);
  const paulaApi = await apiAs(PAULA);
  const opened = await paulaApi.post("/api/v1/memory/scopes", {
    data: { kind: "personal", agentId: bot.id },
  });
  expect(opened.ok()).toBe(true);
  const scope = (await opened.json()) as { id: string };
  const root = await readFile(paulaApi, scope.id, "MEMORY.md");
  expect(root).toBeTruthy();

  const page = await signIn(browser, info.project.name, PAULA);
  const href = `${BASE_URL}/memory/${scope.id}/MEMORY.md`;
  await page.goto(href);
  await expect(page.getByTestId("memory-file")).toHaveAttribute("data-path", "MEMORY.md");
  await expect(page.getByTestId("memory-file-version")).toHaveText(`Version ${root?.version}`);

  // Another session of Paula saves the file: the view updates without a reload.
  const v2 = await putAs(paulaApi, root?.id ?? "", "# Memory\n\n- Likes tables\n", root?.version ?? 1);
  await expect(page.getByTestId("memory-file").getByText("Likes tables")).toBeVisible();
  await expect(page.getByTestId("memory-file-version")).toHaveText(`Version ${v2.version}`);
  await expect(page.getByText(`Updated to version ${v2.version} by ${PAULA.name}`)).toBeAttached();

  // While editing, a newer version shows a notice; saving then opens the conflict view.
  await page.getByRole("tablist", { name: "File view" }).getByRole("tab", { name: "Edit" }).click();
  await appendLine(page, "MEMORY.md", "- Mine");
  const v3 = await putAs(
    paulaApi,
    root?.id ?? "",
    "# Memory\n\n- Likes tables\n- Answers in Spanish\n",
    v2.version,
  );
  await expect(
    page.getByText(
      `Version ${v3.version} was saved while you were editing. You'll choose what to keep when you save.`,
    ),
  ).toBeVisible();
  await saveButton(page).click();
  await expect(page.getByTestId("memory-conflict")).toBeVisible();
  await paulaApi.dispose();
});

test("read only: a member sees the Read only badge and no Edit on a team file", async ({ browser }, info) => {
  const w = widthOf(info.project.name);
  const page = await signIn(browser, info.project.name);
  await page.goto(ACME_HREF());
  await expect(page.getByTestId("memory-file")).toHaveAttribute("data-path", "clients/acme.md");
  await expect(page.getByTestId("memory-file-meta")).toContainText("Read only");
  await expect(page.getByRole("tab", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New file" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Actions for / })).toHaveCount(0);
  if (w === "1440") await review(page, "readonly", w);
  else await expectNoSeriousA11y(page, '[data-testid="memory-shell"]', NO_HEADING_SKIPS);

  // Three hours later the meta row reads the UI-SPEC's short age, "3h ago" (WINDOWS 155); the full date stays for
  // screen readers.
  await page.clock.setFixedTime(Date.now() + 3 * 3_600_000 + 5 * 60_000);
  await page.reload();
  const meta = page.getByTestId("memory-file-meta");
  await expect(meta).toContainText("3h ago");
  await expect(meta).not.toContainText("hours ago");
  await review(page, "age", w);
});
