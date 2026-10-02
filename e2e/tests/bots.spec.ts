import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Bots: Settings › Models (fake key) → one-click bot from a preset → provisioning → ready when the (fake)
 * OpenClaw cell acks over the Agent Channel API → add to channel. When chat is deployed, also mention → reply.
 * The fake plugin (e2e/support/fake-cell-plugin.ts) stands in for apps/openclaw-channel; no model is called.
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

async function login(page: Page, next: string) {
  await page.goto(next);
  await expect(page.getByTestId("login-form")).toBeVisible();
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page
    .getByTestId("login-form")
    .getByRole("button", { name: /sign in|log in/i })
    .click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

test("models → one-click bot → ready via the cell → add to channel", async ({ page }, info) => {
  const tag = info.project.name === "mobile" ? "390" : "1440";
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");
  const plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });

  try {
    // ---- Settings › Models: connect Anthropic with a fake key (never called: bots below use the mock model)
    await login(page, "/settings/models");
    const anthropic = page.getByTestId("provider-anthropic");
    await expect(anthropic).toBeVisible();
    if (await page.getByTestId("connect-anthropic").isVisible()) {
      await shot(page, `bots-models-empty-${tag}`);
      await page.getByTestId("connect-anthropic").click();
      await expect(page.getByTestId("connect-provider-dialog")).toBeVisible();
      await page.getByTestId("provider-api-key").fill("sk-ant-e2e-fake-key-not-real-0000");
      await shot(page, `bots-models-connect-${tag}`);
      await page.getByTestId("save-provider").click();
    }
    await expect(anthropic.getByText("Connected")).toBeVisible();
    await expect(anthropic.getByText("Claude Sonnet 5.5")).toBeVisible();
    await expect(page.getByText("sk-ant-e2e-fake-key-not-real-0000")).toHaveCount(0);
    await shot(page, `bots-models-${tag}`);

    // ---- One-click bot from a preset, on the never-metered mock model
    const name = tag === "390" ? "Atlas" : "Nova";
    // Re-runnable: remove bots left by a previous run of this spec.
    const existing = (await (await page.request.get(`${API_URL}/api/v1/agents`)).json()) as {
      agents: Array<{ id: string; name: string }>;
    };
    for (const a of existing.agents.filter((x) => x.name === name)) {
      await page.request.delete(`${API_URL}/api/v1/agents/${a.id}`);
    }
    await page.goto("/bots");
    await expect(page.getByRole("heading", { name: "Bots", exact: true })).toBeVisible();
    await page.getByTestId("new-bot").click();
    const sheet = page.getByTestId("new-bot-sheet");
    await expect(sheet.getByTestId("bot-presets")).toBeVisible();
    await shot(page, `bots-new-presets-${tag}`);
    await sheet.getByTestId("preset-product-manager").click();
    await sheet.getByTestId("bot-name").fill(name);
    await expect(sheet.getByTestId("bot-username")).toHaveValue(name.toLowerCase());
    await sheet.getByTestId("bot-model").click();
    await page.getByRole("option", { name: /Mock model/ }).click();
    await shot(page, `bots-new-form-${tag}`);
    await sheet.getByTestId("create-bot").click();
    await expect(sheet).toBeHidden();

    const card = page.getByTestId("bot-card").filter({ hasText: name }).first();
    await expect(card).toBeVisible();
    const username = (await card.getAttribute("data-username")) ?? "";
    expect(username.startsWith(name.toLowerCase())).toBe(true);
    // Before any cell is connected it stays provisioning (unless an old cell is still connected).
    await expect(card.getByTestId("bot-status")).toHaveAttribute("data-status", /provisioning|ready/);
    await shot(page, `bots-gallery-provisioning-${tag}`);

    // ---- The OpenClaw cell (fake plugin) syncs config and acks → the chip flips live, no reload
    await plugin.start();
    await expect(card.getByTestId("bot-status")).toHaveAttribute("data-status", "ready", { timeout: 15_000 });
    await shot(page, `bots-gallery-${tag}`);

    // ---- Detail sheet
    await card.getByRole("button", { name }).click();
    await expect(page.getByTestId("bot-detail-sheet")).toBeVisible();
    await shot(page, `bots-detail-${tag}`);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("bot-detail-sheet")).toBeHidden();

    // ---- Add to channel (chat owns channels; tolerated when chat is not deployed)
    await card.getByTestId("add-to-channel").click();
    const dialog = page.getByTestId("add-to-channel-dialog");
    await expect(dialog).toBeVisible();
    await shot(page, `bots-add-to-channel-${tag}`);
    const hasChat = (await page.request.get(`${API_URL}/api/v1/channels`)).status() === 200;
    if (hasChat && (await dialog.getByTestId("channel-option").count()) > 0) {
      await dialog.getByTestId("channel-option").first().click();
      await dialog.getByTestId("confirm-add-to-channel").click();
      await expect(dialog).toBeHidden();
    } else {
      await page.keyboard.press("Escape");
    }

    // ---- Bots runtime: connected
    await page.goto("/settings/bots-runtime");
    await expect(page.getByTestId("cell-status")).toHaveAttribute("data-connected", "true");
    await shot(page, `bots-runtime-${tag}`);

    // ---- Dark mode review shots
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/bots");
    await expect(card.getByTestId("bot-status")).toHaveAttribute("data-status", "ready");
    await shot(page, `bots-gallery-dark-${tag}`);
    await page.goto("/settings/models");
    await expect(page.getByTestId("provider-anthropic").getByText("Connected")).toBeVisible();
    await shot(page, `bots-models-dark-${tag}`);
    await page.emulateMedia({ colorScheme: "light" });

    // ---- Mention → reply (only once chat is merged: B1's REST surface)
    if (hasChat) {
      const agents = (await (await page.request.get(`${API_URL}/api/v1/agents`)).json()) as {
        agents: Array<{ id: string; username: string }>;
      };
      const agent = agents.agents.find((a) => a.username === username);
      expect(agent).toBeTruthy();
      const channelName = `bots-e2e-${tag}-${Date.now().toString(36)}`;
      const created = await page.request.post(`${API_URL}/api/v1/channels`, { data: { name: channelName } });
      expect(created.ok()).toBe(true);
      const channel = (await created.json()) as { id: string };
      expect(
        (
          await page.request.post(`${API_URL}/api/v1/channels/${channel.id}/members`, {
            data: { kind: "agent", id: agent!.id },
          })
        ).ok(),
      ).toBe(true);
      const posted = await page.request.post(`${API_URL}/api/v1/conversations/${channel.id}/messages`, {
        data: {
          body: `@${username} what should we build first?`,
          mentions: [{ kind: "agent", id: agent!.id }],
        },
      });
      expect(posted.ok()).toBe(true);
      await plugin.waitUntil(() => plugin.replies.length > 0, 15_000);
      expect(plugin.replies[0]!.mention.message.author.displayName).toBe(ADMIN.name);

      // The reply is in the thread, attributed to the bot, with the structured identity it received.
      await page.goto(`/chat/${channel.id}`);
      await page.getByTestId("thread-summary").first().click();
      const thread = page.getByTestId("thread-panel");
      await expect(thread.getByText(`Asked by ${ADMIN.name}`)).toBeVisible();
      await shot(page, `bots-reply-thread-${tag}`);
    }
  } finally {
    await plugin.stop();
  }
});
