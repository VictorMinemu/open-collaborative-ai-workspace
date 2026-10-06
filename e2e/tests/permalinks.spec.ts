import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { freshChannel, messageRow, openMessageActions, postAs } from "../support/chat";
import { ADMIN, shot } from "./env";

/**
 * CHAT-13 / CHAT-14 (04-03): "Copy link" on any message; opening the link loads history around it (even far older
 * than the first page), highlights it, and keeps the view detached from the live tail until "Jump to latest".
 */

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** Posts `count` numbered messages and returns them in order (index 0 = "#1"). */
async function seedHistory(api: APIRequestContext, conversationId: string, count: number, label: string) {
  const out: Array<{ id: string; seq: number }> = [];
  for (let n = 1; n <= count; n++) out.push(await postAs(api, conversationId, `${label} #${n}`));
  return out;
}

/** Scrolls a message list to the top until the row is rendered (older pages load on the way). */
async function scrollUpTo(page: Page, scrollTestId: string, messageId: string) {
  const scroller = page.getByTestId(scrollTestId);
  for (let i = 0; i < 15 && (await messageRow(page, messageId).count()) === 0; i++) {
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(400);
  }
  await expect(messageRow(page, messageId)).toBeAttached();
}

/** Picks "Copy link" on a message (toolbar menu on desktop, long-press sheet on mobile); returns the copied URL. */
async function copyLink(page: Page, messageId: string, project: string): Promise<string> {
  const actions = await openMessageActions(page, messageId, project);
  if (project === "mobile") {
    await actions.getByTestId("copy-link").click();
  } else {
    await actions.getByTestId("message-more").click();
    await page.getByTestId("message-menu").getByTestId("copy-link").click();
  }
  await expect(page.getByText("Link copied")).toBeVisible();
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe.configure({ mode: "serial" });

test("copy link → another member opens it: history around it, highlighted, detached until Jump to latest", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const size = project === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const sam = await apiAs(SAM);
  const channel = await freshChannel(admin, [sam], "perma");
  const history = await seedHistory(admin, channel.id, 120, "History");
  const third = history[2] as { id: string };

  // ---- Sam scrolls up through older pages to #3 and copies its link
  const s = await openAs(browser, SAM, project);
  await s.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
  await s.page.goto(`${BASE_URL}/chat/${channel.id}`);
  await expect(messageRow(s.page, (history[119] as { id: string }).id)).toBeVisible();
  await scrollUpTo(s.page, "channel-scroll", third.id);
  const link = await copyLink(s.page, third.id, project);
  expect(link.startsWith(new URL(BASE_URL).origin)).toBe(true);
  expect(link.endsWith(`?m=${third.id}`)).toBe(true);
  expect(link).not.toContain(channel.name);

  // ---- the admin opens the link in a new page: #3 in view and highlighted, detached from the tail
  const a = await openAs(browser, ADMIN, project);
  await a.page.goto(link);
  const target = messageRow(a.page, third.id);
  await expect(target).toBeVisible();
  await expect(target).toHaveAttribute("data-highlighted", "true");
  await expect(target).toBeInViewport();
  await expect(target).toContainText("History #3");
  const pill = a.page.getByTestId("jump-to-latest");
  await expect(pill).toBeVisible();
  await expect(a.page.getByTestId("channel-scroll")).toHaveAttribute("data-detached", "true");
  // The tail (#120) is not rendered while detached.
  await expect(messageRow(a.page, (history[119] as { id: string }).id)).toHaveCount(0);
  await bothThemes(a.page, `permalink-highlight-${size}`);

  // ---- a live message from Sam does not move the admin's scroll; the pill counts it
  const scroller = a.page.getByTestId("channel-scroll");
  const before = await scroller.evaluate((el) => el.scrollTop);
  const live = await postAs(sam, channel.id, "Live while you read the archive");
  await expect(a.page.getByTestId("jump-to-latest-count")).toHaveText("1 new", { timeout: 5_000 });
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(before);
  await expect(target).toBeInViewport();
  await expect(messageRow(a.page, live.id)).toHaveCount(0);

  // ---- Jump to latest: back on the live tail with Sam's message at the bottom; `m` leaves the URL
  await pill.click();
  await expect(messageRow(a.page, live.id)).toBeInViewport({ timeout: 5_000 });
  await expect(pill).toHaveCount(0);
  await expect(a.page).not.toHaveURL(/[?&]m=/);
  await expect(scroller).not.toHaveAttribute("data-detached", "true");
  await bothThemes(a.page, `permalink-jump-latest-${size}`);

  // ---- live again: the next message from Sam follows at the bottom
  const next = await postAs(sam, channel.id, "And now you're live again");
  await expect(messageRow(a.page, next.id)).toBeInViewport({ timeout: 5_000 });

  await a.context.close();
  await s.context.close();
  await admin.dispose();
  await sam.dispose();
});
