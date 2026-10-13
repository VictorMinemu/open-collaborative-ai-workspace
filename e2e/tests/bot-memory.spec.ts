import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Bot memory (03.1-07; SC5, BOT-04, D-10). Sam asks his personal bot to remember something; the simulated cell
 * runs `ocw_memory_save` through the real `POST /agent-channel/v1/memories`; Sam sees the note under "What <bot>
 * remembers about you" in the DM header, the next turn carries it (`[memory: 1]`), and deleting it removes it
 * from the next turn (`[memory: 0]`). Clear all asks for confirmation.
 */

function cellToken(): string {
  if (process.env.OCW_CELL_TOKEN) return process.env.OCW_CELL_TOKEN;
  const file = join(import.meta.dirname, "..", "..", ".env");
  const line = existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .find((l) => l.startsWith("OCW_CELL_TOKEN="))
    : undefined;
  return line?.slice("OCW_CELL_TOKEN=".length).trim() ?? "";
}

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** Every capability allowed: what an organization without a policy row gets. */
async function resetPolicy(admin: APIRequestContext) {
  const allow = { orgWide: true, personal: true };
  const res = await admin.put("/api/v1/bot-policy", {
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

/** Sam's only personal bot, fresh, and its private chat. */
async function freshPersonalBot(samId: string): Promise<{ id: string; name: string; dmId: string }> {
  const sam = await apiAs(SAM);
  const listed = (await (await sam.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
  };
  for (const a of listed.agents.filter((x) => x.scope === "personal" && x.ownerUserId === samId)) {
    expect((await sam.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await sam.post("/api/v1/agents/personal", {
    data: { modelProvider: "mock", modelId: "mock-1" },
  });
  expect(res.ok(), "create Sam's personal bot").toBe(true);
  const body = (await res.json()) as { agent: { id: string; name: string }; dmId: string };
  await sam.dispose();
  return { id: body.agent.id, name: body.agent.name, dmId: body.dmId };
}

/** Sends `text` in the open DM and waits for the bot's reply containing `expectText`. */
async function ask(page: Page, text: string, expectText: string) {
  const box = page.getByTestId("composer");
  await box.click();
  await box.fill(text);
  await box.press("Enter");
  const reply = page
    .locator('[data-testid="message"][data-author-kind="agent"]')
    .filter({ hasText: expectText });
  await expect(reply.last()).toBeVisible({ timeout: 15_000 });
  return reply.last();
}

async function openMemory(page: Page, botName: string) {
  await page.getByTestId("bot-memory").click();
  const panel = page.getByTestId("memory-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("heading", { name: `What ${botName} remembers about you` })).toBeVisible();
  return panel;
}

/** Visible controls without an accessible name (memory-files / ai-chat-visual precedent; 07.2-14). */
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
      'button, [role="button"], a[href], [role="menuitem"], [role="option"], input, [role="combobox"]';
    return [...document.querySelectorAll(selector)]
      .filter((el) => !el.closest('[aria-hidden="true"], [inert]') && visible(el) && !nameOf(el))
      .map((el) => el.outerHTML.slice(0, 200));
  });
}

/** 07.2-14: at 390 the footer's buttons are 44 px tall and nothing in it overlaps (it may wrap to two rows). */
async function footerFits(panel: ReturnType<Page["getByTestId"]>) {
  const footer = panel.getByTestId("memory-footer");
  const boxes = await Promise.all(
    ["memory-count", "memory-open-in-memory", "memory-clear-all"].map((id) =>
      footer.getByTestId(id).boundingBox(),
    ),
  );
  for (const id of ["memory-open-in-memory", "memory-clear-all"]) {
    expect((await footer.getByTestId(id).boundingBox())?.height ?? 0, `${id} height`).toBeGreaterThanOrEqual(
      44,
    );
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      expect(a && b, "footer items laid out").toBeTruthy();
      if (!a || !b) continue;
      const apart =
        a.x + a.width <= b.x + 0.5 ||
        b.x + b.width <= a.x + 0.5 ||
        a.y + a.height <= b.y + 0.5 ||
        b.y + b.height <= a.y + 0.5;
      expect(apart, `footer items ${i} and ${j} do not overlap`).toBe(true);
    }
  }
}

test.describe.configure({ mode: "serial" });

test("Sam's bot remembers what he asks, he sees it in the chat, and deleting it removes it from the next turn", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const tag = project === "mobile" ? "390" : "1440";
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");

  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  await resetPolicy(admin);
  const bot = await freshPersonalBot(samId);

  const plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });
  await plugin.start();
  try {
    const sam = await openAs(browser, SAM, project);
    await sam.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();

    // ---- nothing yet: the panel says how to start
    let panel = await openMemory(sam.page, bot.name);
    await expect(panel.getByTestId("memory-empty")).toHaveText(
      `Nothing yet. Ask ${bot.name} to remember something.`,
    );
    await expect(panel).toContainText("Only you can see this. Admins can't.");
    await sam.page.keyboard.press("Escape");
    await expect(panel).toBeHidden();

    // ---- Sam asks; the cell saves through the gated tool
    await ask(
      sam.page,
      'Remember this [[call ocw_memory_save {"text":"My favourite colour is teal"}]]',
      "Tool ocw_memory_save: saved",
    );

    // ---- the panel lists it (the reply refreshed it)
    panel = await openMemory(sam.page, bot.name);
    const items = panel.getByTestId("memory-item");
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText("My favourite colour is teal");
    await bothThemes(sam.page, `bot-memory-${tag}`);

    // ---- 07.2-14: the panel says where the notes live and opens the private MEMORY.md in the viewer
    await expect(panel.getByTestId("memory-file-note")).toHaveText(
      `Kept in your private memory file with ${bot.name}.`,
    );
    const openInMemory = panel.getByRole("button", { name: "Open in Memory" });
    await expect(openInMemory).toBeVisible();
    if (tag === "390") await footerFits(panel);
    expect(await unnamedControls(sam.page), "DM memory panel: unnamed controls").toEqual([]);
    const { expectNoSeriousA11y } = await import("../support/a11y");
    for (const theme of ["dark", "light"] as const) {
      await sam.page.emulateMedia({ colorScheme: theme });
      await expectNoSeriousA11y(sam.page, '[data-testid="memory-panel"]');
    }
    await bothThemes(sam.page, `review-dm-memory-panel-${tag}`);
    await openInMemory.click();
    await expect(sam.page).toHaveURL(/\/memory\/[0-9a-f-]{36}\/MEMORY\.md$/);
    const privateScopeId = new URL(sam.page.url()).pathname.split("/")[2] ?? "";
    const privateFile = sam.page.getByTestId("memory-file");
    await expect(
      privateFile.getByRole("listitem").filter({ hasText: "My favourite colour is teal" }),
    ).toBeVisible();
    const samApi = await apiAs(SAM);
    const stored = await samApi.get(`/api/v1/memory/scopes/${privateScopeId}/file?path=MEMORY.md`);
    expect(((await stored.json()) as { content: string }).content).toContain("- My favourite colour is teal");
    await samApi.dispose();
    await sam.page.goto(`${BASE_URL}/chat/dm/${bot.dmId}`);
    await expect(sam.page.getByTestId("dm-view")).toBeVisible();
    await sam.page.keyboard.press("Escape");

    // ---- the next turn carries the note
    await ask(sam.page, "What do you know about me?", "[memory: 1]");

    // ---- delete it: the list empties and the next turn has none
    panel = await openMemory(sam.page, bot.name);
    await panel.getByTestId("memory-item").first().getByTestId("memory-delete").click();
    await expect(panel.getByTestId("memory-item")).toHaveCount(0);
    await expect(panel.getByTestId("memory-empty")).toBeVisible();
    await sam.page.keyboard.press("Escape");
    await ask(sam.page, "And now?", "[memory: 0]");

    // ---- two more notes, then Clear all asks first
    await ask(
      sam.page,
      'Note [[call ocw_memory_save {"text":"Lives in Madrid"}]] [[call ocw_memory_save {"text":"Has a cat named Miso"}]]',
      "Tool ocw_memory_save: saved",
    );
    panel = await openMemory(sam.page, bot.name);
    await expect(panel.getByTestId("memory-item")).toHaveCount(2);
    await panel.getByTestId("memory-clear-all").click();
    const confirm = sam.page.getByTestId("memory-clear-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("2 notes");
    await bothThemes(sam.page, `bot-memory-clear-${tag}`);
    await confirm.getByTestId("memory-clear-confirm-action").click();
    await expect(confirm).toBeHidden();
    await expect(panel.getByTestId("memory-item")).toHaveCount(0);
    await expect(panel.getByTestId("memory-empty")).toBeVisible();

    // ---- 07.2-14: the empty panel still leads to the (existing) private file
    await expect(panel.getByRole("button", { name: "Open in Memory" })).toBeVisible();
    await sam.page.keyboard.press("Escape");
    await expect(panel).toBeHidden();

    // ---- 07.2-14: with the private MEMORY.md open in a second tab, the bot saves a note: it shows without a reload
    // and the new version is announced politely
    const viewer = await sam.context.newPage();
    await viewer.goto(`${BASE_URL}/memory/${privateScopeId}/MEMORY.md`);
    const liveFile = viewer.getByTestId("memory-file");
    await expect(liveFile).toBeVisible();
    await expect(liveFile).not.toContainText("Prefers morning meetings");
    await ask(
      sam.page,
      'Note [[call ocw_memory_save {"text":"Prefers morning meetings"}]]',
      "Tool ocw_memory_save: saved",
    );
    await expect(liveFile.getByRole("listitem").filter({ hasText: "Prefers morning meetings" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(liveFile.locator('[aria-live="polite"]')).toHaveText(/^Updated to version \d+ by /);
    await viewer.close();

    // ---- an admin cannot read Sam's notes (404, like any other part of his personal bot)
    expect((await admin.get(`/api/v1/agents/${bot.id}/memories`)).status()).toBe(404);
    await sam.context.close();
  } finally {
    await plugin.stop();
    await admin.dispose();
  }
});
