import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Daily usage limits (03.1-05, SC5, BOT-07): once a bot reaches its daily limit it answers with a clear notice,
 * posted as the bot, instead of a reply, and the cell never receives the message (so no model is called). The
 * fake cell (e2e/support/fake-cell-plugin.ts) stands in for OpenClaw and counts what it receives.
 */

const NOTICE =
  "I've reached my daily limit of 2 replies, so I can't answer right now. I'll be back after 00:00 UTC.";

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

test("daily limit: two replies, then the bot posts the limit notice and the cell gets nothing", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  const project = info.project.name;
  const tag = project === "mobile" ? "390" : "1440";
  const token = cellToken();
  test.skip(!token, "OCW_CELL_TOKEN is not configured");

  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  const samApi = await apiAs(SAM);
  // Re-runnable: a fresh personal bot (and so a fresh counter) for every project and run.
  const listed = (await (await samApi.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
  };
  for (const a of listed.agents.filter((x) => x.scope === "personal" && x.ownerUserId === samId)) {
    expect((await samApi.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const created = (await (await samApi.post("/api/v1/agents/personal", { data: {} })).json()) as {
    agent: { id: string };
    dmId: string;
  };
  const botId = created.agent.id;
  const dmId = created.dmId;
  const patched = await samApi.patch(`/api/v1/agents/${botId}/capabilities`, { data: { dailyLimit: 2 } });
  expect(patched.ok()).toBe(true);

  const plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });
  await plugin.start();
  try {
    const { context, page } = await openAs(browser, SAM, project);
    await page.goto(`${BASE_URL}/chat/dm/${dmId}`);
    await expect(page.getByTestId("dm-view")).toBeVisible();

    const botMessages = page.locator('[data-testid="message"][data-author-kind="agent"]');
    const delivered = () =>
      plugin.events.filter(
        (e) =>
          e.type === "agent.mention.v1" &&
          (e.data as { conversation?: { id?: string } }).conversation?.id === dmId,
      );
    const send = async (text: string) => {
      const box = page.getByTestId("composer");
      await box.click();
      await box.fill(text);
      await box.press("Enter");
    };

    // ---- two messages within the limit: two real replies from the (fake) cell
    await send("first question");
    await expect(botMessages).toHaveCount(1, { timeout: 10_000 });
    await send("second question");
    await expect(botMessages).toHaveCount(2, { timeout: 10_000 });
    await expect(botMessages.filter({ hasText: "Asked by Sam Lee" })).toHaveCount(2);
    expect(delivered()).toHaveLength(2);

    // ---- the third: the bot itself posts the notice; the cell receives nothing
    await send("third question");
    const notice = botMessages.filter({ hasText: NOTICE });
    await expect(notice).toHaveCount(1, { timeout: 10_000 });
    await expect(botMessages).toHaveCount(3);
    // DMs are flat: the notice is a normal bot message, not a thread reply or an error toast.
    await expect(page.getByTestId("thread-summary")).toHaveCount(0);
    // Give a (wrongly) delivered event time to arrive before asserting it never did.
    await page.waitForTimeout(1_000);
    expect(delivered()).toHaveLength(2);

    // ---- the owner sees today's usage against the limit
    const view = (await (await samApi.get(`/api/v1/agents/${botId}/capabilities`)).json()) as {
      usage: { today: number; limit: number };
    };
    expect(view.usage).toMatchObject({ today: 2, limit: 2 });

    await bothThemes(page, `bot-limit-notice-${tag}`);
    await context.close();
  } finally {
    await plugin.stop();
    await samApi.dispose();
    await admin.dispose();
  }
});
