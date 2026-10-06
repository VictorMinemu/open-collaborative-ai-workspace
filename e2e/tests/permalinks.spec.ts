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

test("thread reply link: the channel opens around its root with the thread panel open and the reply highlighted", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const size = project === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const sam = await apiAs(SAM);
  const channel = await freshChannel(admin, [sam], "thread-link");
  const history = await seedHistory(admin, channel.id, 70, "Topic");
  const root = history[4] as { id: string };
  const replies: Array<{ id: string }> = [];
  for (const body of ["First thought", "The reply worth linking", "Last word"]) {
    replies.push(await postAs(sam, channel.id, body, { threadRootId: root.id }));
  }
  const linked = replies[1] as { id: string };

  // ---- the admin opens the old thread and copies the link of a reply from the panel
  const a = await openAs(browser, ADMIN, project);
  await a.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
  await a.page.goto(`${BASE_URL}/chat/${channel.id}?thread=${root.id}`);
  const panel = a.page.getByTestId("thread-panel");
  await expect(messageRow(panel, linked.id)).toBeVisible();
  const link = await copyLink(a.page, linked.id, project);
  expect(link.endsWith(`/chat/${channel.id}?thread=${root.id}&m=${linked.id}`)).toBe(true);
  await a.context.close();

  // ---- Sam opens it: detached around the root (older than the first page), panel open, reply highlighted
  const s = await openAs(browser, SAM, project);
  await s.page.goto(link);
  const sPanel = s.page.getByTestId("thread-panel");
  await expect(sPanel).toBeVisible();
  const reply = messageRow(sPanel, linked.id);
  await expect(reply).toBeVisible();
  await expect(reply).toHaveAttribute("data-highlighted", "true");
  await expect(reply).toBeInViewport();
  await expect(messageRow(s.page.getByTestId("channel-scroll"), root.id)).toBeAttached();
  await expect(s.page.getByTestId("channel-scroll")).toHaveAttribute("data-detached", "true");
  await bothThemes(s.page, `permalink-thread-${size}`);

  await s.context.close();
  await admin.dispose();
  await sam.dispose();
});

test("bot DM link: the DM opens around the message, highlighted", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const size = project === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const botName = project === "mobile" ? "Archivist Mobile" : "Archivist";
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  for (const old of listed.agents.filter((x) => x.name === botName)) {
    expect((await admin.delete(`/api/v1/agents/${old.id}`)).ok()).toBe(true);
  }
  const created = await admin.post("/api/v1/agents", {
    data: {
      name: botName,
      description: "Keeps notes.",
      instructions: "Keep notes.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(created.ok(), "create team bot").toBe(true);
  const botId = ((await created.json()) as { id: string }).id;
  const sam = await apiAs(SAM);
  const opened = await sam.post(`/api/v1/agents/${botId}/dm`);
  expect(opened.ok(), "open DM").toBe(true);
  const dmId = ((await opened.json()) as { dmId: string }).dmId;
  expect(dmId, "dm id").toBeTruthy();
  const notes = await seedHistory(sam, dmId as string, 70, "Note");
  const second = notes[1] as { id: string };

  const s = await openAs(browser, SAM, project);
  await s.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE_URL });
  await s.page.goto(`${BASE_URL}/chat/dm/${dmId}`);
  await expect(messageRow(s.page, (notes[69] as { id: string }).id)).toBeVisible();
  await scrollUpTo(s.page, "dm-scroll", second.id);
  const link = await copyLink(s.page, second.id, project);
  expect(link.endsWith(`/chat/dm/${dmId}?m=${second.id}`)).toBe(true);

  const fresh = await s.context.newPage();
  await fresh.goto(link);
  const target = messageRow(fresh, second.id);
  await expect(target).toBeVisible();
  await expect(target).toHaveAttribute("data-highlighted", "true");
  await expect(fresh.getByTestId("dm-scroll")).toHaveAttribute("data-detached", "true");
  await expect(fresh.getByTestId("jump-to-latest")).toBeVisible();
  await bothThemes(fresh, `permalink-dm-${size}`);

  await s.context.close();
  await admin.dispose();
  await sam.dispose();
});

test("deleted and unavailable targets degrade without leaking anything", async ({ browser }, info) => {
  test.setTimeout(180_000);
  const project = info.project.name;
  const size = project === "mobile" ? "390" : "1440";
  const admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  const sam = await apiAs(SAM);
  const channel = await freshChannel(admin, [sam], "gone");
  const history = await seedHistory(admin, channel.id, 60, "Log");
  const doomed = history[9] as { id: string };
  expect((await admin.delete(`/api/v1/messages/${doomed.id}`)).ok()).toBe(true);
  const secretName = `board-${Date.now().toString(36)}`;
  const privateRes = await admin.post("/api/v1/channels", {
    data: { name: secretName, visibility: "private" },
  });
  expect(privateRes.ok()).toBe(true);
  const privateId = ((await privateRes.json()) as { id: string }).id;
  const secret = await postAs(admin, privateId, "Q4 salary review");

  const s = await openAs(browser, SAM, project);

  // ---- a deleted message without replies: the conversation opens near it with a toast, no highlight
  await s.page.goto(`${BASE_URL}/chat/${channel.id}?m=${doomed.id}`);
  await expect(s.page.getByText("This message was deleted")).toBeVisible();
  await expect(messageRow(s.page, (history[10] as { id: string }).id)).toBeInViewport();
  await expect(s.page.locator('[data-highlighted="true"]')).toHaveCount(0);
  await expect(messageRow(s.page, doomed.id)).toHaveCount(0);

  // ---- a message in a private channel Sam is not in: the same view as a missing one, no name
  await s.page.goto(`${BASE_URL}/chat/${privateId}?m=${secret.id}`);
  const unavailable = s.page.getByTestId("message-unavailable");
  await expect(unavailable).toBeVisible();
  await expect(unavailable).toContainText("This message isn't available");
  await expect(s.page.getByText(secretName)).toHaveCount(0);
  await expect(s.page.getByText("salary")).toHaveCount(0);
  await shot(s.page, `permalink-unavailable-${size}`);

  // ---- a missing message in a channel Sam can read: identical view
  await s.page.goto(`${BASE_URL}/chat/${channel.id}?m=00000000-0000-4000-8000-000000000000`);
  await expect(s.page.getByTestId("message-unavailable")).toContainText("This message isn't available");

  await s.context.close();
  await admin.dispose();
  await sam.dispose();
});
