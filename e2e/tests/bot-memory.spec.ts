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

    // ---- an admin cannot read Sam's notes (404, like any other part of his personal bot)
    expect((await admin.get(`/api/v1/agents/${bot.id}/memories`)).status()).toBe(404);
    await sam.context.close();
  } finally {
    await plugin.stop();
    await admin.dispose();
  }
});
