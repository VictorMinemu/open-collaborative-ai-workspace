import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Personal bots (03.1-01, SC1): a Developer creates a personal bot in one click, its private chat appears under
 * Bots in the sidebar, and the bot answers a plain message (no @mention) as one flat reply. The fake cell
 * (e2e/support/fake-cell-plugin.ts) stands in for OpenClaw; nobody else, the admin included, can read the chat.
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

test.describe.configure({ mode: "serial" });

test("personal bot: one click → private chat under Bots → answers without @mention; invisible to others", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const tag = mobile ? "390" : "1440";
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");

  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  // Re-runnable: remove Sam's personal bots left by an earlier project or run. Only Sam sees them in
  // GET /agents (03.1-02); deleting them as their owner.
  const samApi = await apiAs(SAM);
  const listed = (await (await samApi.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
  };
  for (const a of listed.agents.filter((x) => x.scope === "personal" && x.ownerUserId === samId)) {
    expect((await samApi.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  await samApi.dispose();

  const plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });
  await plugin.start();
  try {
    const { context, page } = await openAs(browser, SAM, project);

    // ---- Direct messages offers one-click personal bot creation
    if (mobile) await page.getByTestId("mobile-nav-trigger").click();
    const create = page.getByTestId("create-personal-bot");
    await expect(create).toBeVisible();
    await expect(page.getByTestId("dm-section")).toContainText("Direct messages");
    await shot(page, `personal-bot-sidebar-empty-${tag}`);
    await create.click();

    // ---- one click → the private chat opens
    await expect(page).toHaveURL(/\/chat\/dm\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    const dmId = page.url().match(/\/chat\/dm\/([0-9a-f-]{36})/)?.[1] ?? "";
    await expect(page.getByTestId("dm-view")).toBeVisible();
    await expect(page.getByTestId("dm-title")).toHaveText("Sam's assistant");
    await expect(page.getByTestId("dm-privacy")).toHaveText("Personal bot · only you can see this chat");

    // ---- a plain message (no @) gets one flat reply from the bot
    const box = page.getByTestId("composer");
    await box.click();
    await box.fill("hello there");
    await box.press("Enter");
    const reply = page
      .locator('[data-testid="message"][data-author-kind="agent"]')
      .filter({ hasText: "Asked by Sam Lee" });
    await expect(reply.first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("thread-summary")).toHaveCount(0);
    const delivered = plugin.events.filter(
      (e) =>
        e.type === "agent.mention.v1" &&
        (e.data as { conversation?: { id?: string } }).conversation?.id === dmId,
    );
    expect(delivered).toHaveLength(1);
    await bothThemes(page, `personal-bot-dm-${tag}`);

    // ---- the chat is listed under Bots
    if (mobile) await page.getByTestId("mobile-nav-trigger").click();
    const link = page.getByTestId("dm-link").filter({ hasText: "Sam's assistant" });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("create-personal-bot")).toHaveCount(0);
    await bothThemes(page, `personal-bot-sidebar-${tag}`);
    if (mobile) await page.keyboard.press("Escape");
    await context.close();

    // ---- nobody else sees it, the admin included
    const read = await admin.get(`/api/v1/conversations/${dmId}/messages`);
    expect(read.status()).toBe(404);
    const adminDms = (await (await admin.get("/api/v1/dms")).json()) as { dms: Array<{ id: string }> };
    expect(adminDms.dms.some((d) => d.id === dmId)).toBe(false);

    const asAdmin = await openAs(browser, ADMIN, project);
    if (mobile) await asAdmin.page.getByTestId("mobile-nav-trigger").click();
    await expect(asAdmin.page.getByTestId("dm-section")).toBeVisible();
    await expect(asAdmin.page.getByTestId("dm-link").filter({ hasText: "Sam's assistant" })).toHaveCount(0);
    await asAdmin.page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    await expect(asAdmin.page.getByTestId("dm-missing")).toBeVisible();
    await asAdmin.context.close();
  } finally {
    await plugin.stop();
    await admin.dispose();
  }
});
