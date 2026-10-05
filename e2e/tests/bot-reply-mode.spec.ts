import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, createChannel, ensureMember, openAs, SAM } from "../support/actors";
import { FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Reply mode "every message" (03.1-08, BOT-04, D-12): a team bot set to answer every message follows a channel
 * on its own. A plain human message, with no @mention, gets the bot's reply in that message's thread. The fake
 * cell (e2e/support/fake-cell-plugin.ts) stands in for OpenClaw and replies to whatever the API delivers.
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

/** A fresh team bot on the never-metered mock model (bots left by earlier runs are deleted first). */
async function freshTeamBot(admin: APIRequestContext, name: string): Promise<string> {
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  for (const a of listed.agents.filter((x) => x.name === name)) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await admin.post("/api/v1/agents", {
    data: {
      name,
      description: "Follows the deploys channel and answers every update.",
      instructions: "Acknowledge deploy updates briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), "create team bot").toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function send(page: Page, text: string) {
  const box = page.getByTestId("composer");
  await box.click();
  await box.fill(text);
  await box.press("Enter");
}

async function openThreadOf(page: Page, mobile: boolean, text: string) {
  const msg = page.getByTestId("message").filter({ hasText: text }).first();
  if (mobile) {
    await msg.getByTestId("thread-summary").click();
  } else {
    await msg.hover();
    await msg.getByTestId("reply-in-thread").click();
  }
  await expect(page.getByTestId("thread-panel")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("reply mode: a team bot answers an unmentioned message in that message's thread", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const tag = mobile ? "390" : "1440";
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");

  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const name = mobile ? "Herald" : "Scribe";
  const botId = await freshTeamBot(admin, name);
  // Set through the API: this spec does not depend on the capabilities UI.
  const patched = await admin.patch(`/api/v1/agents/${botId}/capabilities`, { data: { replyMode: "all" } });
  expect(patched.ok(), "reply mode all").toBe(true);
  const channelId = await createChannel(admin, `deploys-${project}-${Date.now().toString(36)}`);
  const added = await admin.post(`/api/v1/channels/${channelId}/members`, {
    data: { kind: "agent", id: botId },
  });
  expect(added.ok(), "add the bot to the channel").toBe(true);
  const samApi = await apiAs(SAM);
  expect((await samApi.post(`/api/v1/channels/${channelId}/join`)).ok()).toBe(true);

  const plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });
  await plugin.start();
  try {
    const { context, page } = await openAs(browser, SAM, project);
    await page.goto(`${BASE_URL}/chat/${channelId}`);
    await expect(page.getByTestId("composer")).toBeVisible();

    await send(page, "deploy done");
    const root = page.getByTestId("message").filter({ hasText: "deploy done" }).first();
    await expect(root).toBeVisible();
    // The bot answered without being mentioned, inside the message's thread (not at channel level).
    await expect(root.getByTestId("thread-summary")).toContainText("1 reply", { timeout: 10_000 });
    await expect(
      page.locator('[data-testid="message"][data-author-kind="agent"]').filter({ hasText: "Asked by" }),
    ).toHaveCount(0);

    const rootId = await root.getAttribute("data-message-id");
    const delivered = plugin.events
      .filter((e) => e.type === "agent.mention.v1")
      .map((e) => e.data as unknown as MentionPayload)
      .filter((m) => m.conversation.id === channelId);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.agent.id).toBe(botId);
    expect(delivered[0]?.thread.rootMessageId).toBe(rootId);

    await openThreadOf(page, mobile, "deploy done");
    const reply = page
      .getByTestId("thread-panel")
      .locator('[data-testid="message"][data-author-kind="agent"]')
      .filter({ hasText: "Asked by Sam Lee" });
    await expect(reply).toHaveCount(1);
    await expect(reply).toContainText(name);
    await bothThemes(page, `reply-mode-thread-${tag}`);
    await context.close();
  } finally {
    await plugin.stop();
    await samApi.dispose();
    await admin.dispose();
  }
});
