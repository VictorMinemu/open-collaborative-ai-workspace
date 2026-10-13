import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, openAs, SAM } from "../support/actors";
import { ask, cellToken, freshPersonalBot } from "../support/bot-tools";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { type MemorySeed, putMemoryFile, seedMemory } from "../support/memory";
import { ADMIN, API_URL, shot } from "./env";

/**
 * The agent page (Phase 07.2, 07.2-14, MEM-03, MEM-07, UI-SPEC "Agent page", R8, R9): Sam opens his bot's page from
 * the Bots gallery ("Open page"), sees its notebook rendered read-only in place and his private memory with it in the
 * tree, then its capabilities read-only. On a phone the page is the tree only and a file opens the viewer. An admin
 * sees a team bot's notebook and nobody's private memory, and a personal bot's page is not found for anyone but its
 * owner. Review screenshots `review-agent-page-{memory,capabilities}-<1440|390>[-dark].png` when
 * OCW_E2E_SCREENSHOT_DIR is set. The simulated cell answers; no provider is called.
 */

test.describe.configure({ mode: "serial" });

const SCOUT = "Scout";
const LEDGER = "Ledger";
const NOTEBOOK = `# Scout notebook

Researches pump suppliers for the Ventas team and keeps short notes.

## Working rules

- Compare at least three suppliers before recommending one.
- Note lead times in weeks.
`;
const SUPPLIERS = "# Pump suppliers\n\n- Hidrobomba — 4 weeks lead time\n- AquaFlow — 6 weeks lead time\n";
const LEDGER_NOTEBOOK = "# Ledger notebook\n\nTracks the Ventas pipeline. Quarter goal: 12 renewals.\n";
const SAM_PRIVATE_LEDGER = "# Memory\n\n- Sam prefers weekly pipeline summaries\n";

let admin: APIRequestContext;
let seed: MemorySeed;
const open: BrowserContext[] = [];

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  seed = await seedMemory(admin);
  await resetPolicy(admin);
});

test.afterAll(async () => {
  for (const c of open.splice(0)) await c.close();
  await admin?.dispose();
});

/** Every capability allowed: what an organization without a policy row gets (bot-memory precedent). */
async function resetPolicy(api: APIRequestContext) {
  const allow = { orgWide: true, personal: true };
  const res = await api.put("/api/v1/bot-policy", {
    data: {
      capabilities: { internet: allow, memory: allow, dateTime: allow, replyModeAll: allow },
      searchProvider: "duckduckgo",
      maxPersonalBotsPerUser: 3,
      personalDailyLimitMax: 100,
      personalAllowedModels: [],
    },
  });
  expect(res.ok(), "reset bot policy").toBe(true);
}

async function signIn(browser: Parameters<typeof openAs>[0], project: string, who: Actor = SAM) {
  const s = await openAs(browser, who, project);
  open.push(s.context);
  return s.page;
}

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

/** Opens (creating on first use) a memory scope through the API, as the caller. */
async function ensureScope(api: APIRequestContext, kind: "personal" | "agent", agentId: string) {
  const res = await api.post("/api/v1/memory/scopes", { data: { kind, agentId } });
  expect(res.ok(), `ensure ${kind} scope: ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** Sam's personal bot "Scout", recreated, with a filled notebook; returns its ids. */
async function freshScout(samId: string) {
  const bot = await freshPersonalBot(SAM, samId);
  const sam = await apiAs(SAM);
  const patched = await sam.patch(`/api/v1/agents/${bot.id}`, {
    data: { name: SCOUT, avatarUrl: "🔎", description: "Researches suppliers and keeps notes" },
  });
  expect(patched.ok(), `rename Scout: ${await patched.text()}`).toBe(true);
  const notebookScopeId = await ensureScope(sam, "agent", bot.id);
  await putMemoryFile(sam, notebookScopeId, "MEMORY.md", NOTEBOOK);
  await putMemoryFile(sam, notebookScopeId, "suppliers/pumps.md", SUPPLIERS);
  await sam.dispose();
  return { ...bot, notebookScopeId };
}

/** A team bot "Ledger" in Ventas, recreated; the admin (its owner by default) fills its notebook. */
async function freshLedger() {
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  for (const a of listed.agents.filter((x) => x.name === LEDGER)) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await admin.post("/api/v1/agents", {
    data: {
      name: LEDGER,
      avatarUrl: "📒",
      description: "Keeps the Ventas pipeline in order.",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
      unitId: seed.ventasUnitId,
    },
  });
  expect(res.ok(), `create Ledger: ${await res.text()}`).toBe(true);
  const id = ((await res.json()) as { id: string }).id;
  const notebookScopeId = await ensureScope(admin, "agent", id);
  await putMemoryFile(admin, notebookScopeId, "MEMORY.md", LEDGER_NOTEBOOK);
  return { id, notebookScopeId };
}

async function noSidewaysScroll(page: Page, label: string) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect.soft(scrollWidth, `${label}: no sideways scroll`).toBeLessThanOrEqual(innerWidth);
}

/** Visible controls without an accessible name (memory-files / ai-chat-visual precedent). */
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
      'button, [role="button"], [role="tab"], [role="switch"], a[href], [role="menuitem"], [role="option"], [role="treeitem"], input, [role="combobox"]';
    return [...document.querySelectorAll(selector)]
      .filter((el) => !el.closest('[aria-hidden="true"], [inert]') && visible(el) && !nameOf(el))
      .map((el) => el.outerHTML.slice(0, 200));
  });
}

/** Both themes of one agent-page screen: layout invariants, axe, then the capture. Back to light afterwards. */
async function review(page: Page, screen: string, w: string) {
  const viewport = page.viewportSize();
  if (viewport && w === "1440") await page.mouse.move(viewport.width - 4, Math.round(viewport.height / 2));
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, { timeout: 10_000 });
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await noSidewaysScroll(page, `${screen} ${theme}`);
    expect.soft(await unnamedControls(page), `${screen} (${theme}): unnamed controls`).toEqual([]);
    await expectNoSeriousA11y(page, '[data-testid="agent-page"]');
    await shot(page, `review-agent-page-${screen}-${w}${theme === "dark" ? "-dark" : ""}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
}

const agentTree = (page: Page, bot: string) => page.getByRole("tree", { name: `${bot} memory files` });
const treeRow = (page: Page, bot: string, name: string, scopeId?: string) => {
  const rows = agentTree(page, bot).getByRole("treeitem", { name, exact: true });
  return scopeId ? rows.and(page.locator(`[data-scope-id="${scopeId}"]`)) : rows;
};

/** From the Bots gallery, the bot's card → "Open page" (found by its link: other specs keep bots with the same name). */
async function openFromGallery(page: Page, id: string) {
  await page.goto(`${BASE_URL}/bots`);
  const card = page.locator(`[data-testid="bot-card"]:has(a[href="/bots/${id}"])`);
  await expect(card).toHaveCount(1);
  // The card's new link keeps every card inside the column (no sideways scroll at 390).
  await noSidewaysScroll(page, "bots gallery");
  await card.scrollIntoViewIfNeeded();
  await shot(page, `review-bots-gallery-open-page-${page.viewportSize()?.width === 390 ? "390" : "1440"}`);
  await card.getByRole("link", { name: "Open page" }).click();
  await expect(page).toHaveURL(new RegExp(`/bots/${id}$`));
  await expect(page.getByTestId("agent-page")).toBeVisible();
}

test("Sam opens his bot's page: its notebook in place, his private memory in the tree, its capabilities read-only", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const w = widthOf(project);
  const token = cellToken();
  expect(token, "OCW_CELL_TOKEN must be configured for the simulated cell").toBeTruthy();

  const scout = await freshScout(seed.samId);
  const plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });
  await plugin.start();
  try {
    const page = await signIn(browser, project);

    // ---- Sam saves a note through the DM (ocw_memory_save → his private MEMORY.md)
    await page.goto(`${BASE_URL}/chat/dm/${scout.dmId}`);
    await expect(page.getByTestId("dm-view")).toBeVisible();
    await ask(
      page,
      'Remember this [[call ocw_memory_save {"text":"My favourite colour is teal"}]]',
      "Tool ocw_memory_save: saved",
    );
    const sam = await apiAs(SAM);
    const privateScopeId = await ensureScope(sam, "personal", scout.id);
    await sam.dispose();

    // ---- gallery card → "Open page" → the bot's home
    await openFromGallery(page, scout.id);
    const agentPage = page.getByTestId("agent-page");
    await expect(agentPage.getByRole("heading", { level: 1, name: SCOUT })).toBeVisible();
    await expect(agentPage.getByTestId("bot-personal-badge")).toBeVisible();
    await expect(agentPage.getByTestId("agent-owner")).toHaveText("Owned by you");
    await expect(agentPage).toContainText("Researches suppliers and keeps notes");
    const message = agentPage.getByTestId("bot-message");
    await expect(message).toBeVisible();
    await expect(page.getByRole("tab", { name: "Memory" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Capabilities" })).toBeVisible();

    // The tree holds this bot's scopes only: its notebook, then Sam's private memory with it.
    const scopes = agentTree(page, SCOUT).locator('[data-kind="scope"]');
    await expect(scopes).toHaveCount(2);
    await expect(scopes.nth(0)).toHaveAttribute("aria-label", `${SCOUT} notebook, bot memory`);
    await expect(scopes.nth(1)).toHaveAttribute("aria-label", `You and ${SCOUT}, private memory`);

    if (project !== "mobile") {
      // ---- desktop: the notebook's MEMORY.md renders read-only in the page's file pane
      const file = agentPage.getByTestId("memory-file");
      await expect(file).toHaveAttribute("data-path", "MEMORY.md");
      await expect(file.getByRole("heading", { name: "Scout notebook" })).toBeVisible();
      await expect(file).toContainText("Compare at least three suppliers");
      await expect(file.getByText("Read only", { exact: true })).toBeVisible();
      await expect(agentPage.getByRole("tab", { name: "Edit" })).toHaveCount(0);
      await expect(agentPage.getByRole("button", { name: "History" })).toHaveCount(0);
      await expect(agentPage.getByRole("button", { name: "File actions" })).toHaveCount(0);
      const openInMemory = agentPage.getByRole("link", { name: "Open in Memory" });
      await expect(openInMemory).toHaveAttribute("href", `/memory/${scout.notebookScopeId}/MEMORY.md`);
      await expect(treeRow(page, SCOUT, "suppliers, folder", scout.notebookScopeId)).toBeVisible();
      await noSidewaysScroll(page, "agent page 1440");
      await review(page, "memory", w);

      // ---- his private MEMORY.md renders in the same pane; the URL stays on the bot page
      await treeRow(page, SCOUT, `You and ${SCOUT}, private memory`).click();
      await treeRow(page, SCOUT, "MEMORY.md", privateScopeId).click();
      await expect(file).toContainText("My favourite colour is teal");
      await expect(file.getByTestId("memory-file-meta")).toContainText("Private");
      await expect(page).toHaveURL(new RegExp(`/bots/${scout.id}$`));
      await expect(openInMemory).toHaveAttribute("href", `/memory/${privateScopeId}/MEMORY.md`);

      // ---- "Open in Memory" opens the viewer on that file
      await openInMemory.click();
      await expect(page).toHaveURL(new RegExp(`/memory/${privateScopeId}/MEMORY\\.md$`));
      await expect(page.getByTestId("memory-shell").getByTestId("memory-file")).toContainText(
        "My favourite colour is teal",
      );
      await page.goBack();
      await expect(agentPage).toBeVisible();
    } else {
      // ---- phone: header, a full-width 44 px Message button, tabs and the tree; no file pane
      const box = await message.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(390 - 32 - 1);
      for (const tab of ["Memory", "Capabilities"]) {
        expect(
          (await page.getByRole("tab", { name: tab }).boundingBox())?.height ?? 0,
        ).toBeGreaterThanOrEqual(44);
      }
      await expect(agentPage.getByTestId("memory-file")).toHaveCount(0);
      await expect(treeRow(page, SCOUT, "MEMORY.md", scout.notebookScopeId)).toBeVisible();
      await noSidewaysScroll(page, "agent page 390");
      await review(page, "memory", w);

      // ---- tapping a file opens the viewer's file screen
      await treeRow(page, SCOUT, "MEMORY.md", scout.notebookScopeId).click();
      await expect(page).toHaveURL(new RegExp(`/memory/${scout.notebookScopeId}/MEMORY\\.md$`));
      await expect(page.getByTestId("memory-file")).toContainText("Compare at least three suppliers");
      await page.goBack();
      await expect(agentPage).toBeVisible();
    }

    // ---- Capabilities: read-only even though Sam owns the bot
    await page.getByRole("tab", { name: "Capabilities" }).click();
    await expect(page).toHaveURL(new RegExp(`/bots/${scout.id}\\?tab=capabilities$`));
    await expect(agentPage).toContainText("Read only. Bot settings change these.");
    const panel = agentPage.getByTestId("capabilities-panel");
    await expect(panel).toBeVisible();
    for (const name of ["internet", "memory", "dateTime"]) {
      await expect(panel.getByTestId(`capability-${name}`)).toBeDisabled();
    }
    await expect(panel.getByText("Internet", { exact: true })).toBeVisible();
    await expect(panel.getByText("Memory", { exact: true })).toBeVisible();
    await expect(panel.getByText("Date & time", { exact: true })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Tools and skills" })).toBeVisible();
    await expect(panel.getByTestId("capability-dailyLimit")).toBeDisabled();
    const enabledSwitches = panel.locator('[role="switch"]:not([disabled]):not([aria-disabled="true"])');
    await expect(enabledSwitches).toHaveCount(0);
    await review(page, "capabilities", w);
  } finally {
    await plugin.stop();
  }
});

test("An admin sees a team bot's notebook and nobody's private memory; a personal bot's page is not found", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const ledger = await freshLedger();

  // Sam keeps private memory with the team bot, and has a personal bot of his own.
  const sam = await apiAs(SAM);
  const samPrivateScopeId = await ensureScope(sam, "personal", ledger.id);
  await putMemoryFile(sam, samPrivateScopeId, "MEMORY.md", SAM_PRIVATE_LEDGER);
  const listed = (await (await sam.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
  };
  const samBot =
    listed.agents.find((a) => a.scope === "personal" && a.ownerUserId === seed.samId)?.id ??
    (await freshPersonalBot(SAM, seed.samId)).id;
  await sam.dispose();

  const page = await signIn(browser, project, ADMIN);
  await page.goto(`${BASE_URL}/bots/${ledger.id}`);
  const agentPage = page.getByTestId("agent-page");
  await expect(agentPage.getByRole("heading", { level: 1, name: LEDGER })).toBeVisible();
  await expect(agentPage.getByTestId("bot-scope")).toContainText("Ventas");
  const scopes = agentTree(page, LEDGER).locator('[data-kind="scope"]');
  await expect(scopes).toHaveCount(1);
  await expect(scopes.first()).toHaveAttribute("aria-label", `${LEDGER} notebook, bot memory`);
  await expect(agentTree(page, LEDGER).getByRole("treeitem", { name: /private memory/ })).toHaveCount(0);
  await expect(page.locator(`[data-scope-id="${samPrivateScopeId}"]`)).toHaveCount(0);
  if (project !== "mobile") {
    await expect(agentPage.getByTestId("memory-file")).toContainText("Quarter goal: 12 renewals.");
  } else {
    await expect(treeRow(page, LEDGER, "MEMORY.md", ledger.notebookScopeId)).toBeVisible();
  }
  await expect(agentPage).not.toContainText("Sam prefers weekly pipeline summaries");

  // The admin's Memory never lists Sam's private scope, and its direct URL is the shared not-found state (MEM-07).
  await page.goto(`${BASE_URL}/memory`);
  await expect(page.getByRole("tree", { name: "Memory files" })).toBeVisible();
  await expect(page.locator(`[data-scope-id="${samPrivateScopeId}"]`)).toHaveCount(0);
  await expect(page.getByRole("treeitem", { name: /private memory/ })).toHaveCount(0);
  await page.goto(`${BASE_URL}/memory/${samPrivateScopeId}/MEMORY.md`);
  await expect(page.getByTestId("memory-file-notfound")).toContainText(
    "This file doesn't exist or you can't open it",
  );
  await expect(page.getByText("Sam prefers weekly pipeline summaries")).toHaveCount(0);

  // A personal bot's page is not found for anyone but its owner, admins included (ADR-0010).
  await page.goto(`${BASE_URL}/bots/${samBot}`);
  const notFound = page.getByTestId("agent-page-notfound");
  await expect(notFound).toBeVisible();
  await expect(notFound).toContainText("This bot doesn't exist or you can't open it");
  await expect(notFound.getByRole("link", { name: "Back to Bots" })).toHaveAttribute("href", "/bots");
  await expect(page.getByTestId("agent-page")).toHaveCount(0);
});
