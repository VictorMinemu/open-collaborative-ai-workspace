import { crc32, deflateSync } from "node:zlib";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { cellToken } from "../support/bot-tools";
import { messageRow, openMessageActions } from "../support/chat";
import { FakeCellPlugin } from "../support/fake-cell-plugin";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Phase 4 gate (04-13): a whole chat day for two members on one fresh isolated stack (own Garage), crossing every
 * Phase 4 slice. The admin opens a department channel and a group DM with Sam and a team bot; mentions Sam; Sam
 * follows the notification, answers in the thread with a pasted screenshot; the admin opens it in the lightbox,
 * reacts and pins; Sam asks the bot in the group, searches accent-less Spanish, jumps back, marks the channel
 * unread (his second tab shows the badge again) and sees the admin's edit live. Captures `chat-day-<step>-<size>`.
 */

type Unit = { id: string; name: string; parentId: string | null };

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** A lowercase, letters-only token unique to this run (full-text search splits digits off words). */
const uniqueWord = () =>
  `zq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.replace(/[0-9]/g, (d) =>
    String.fromCharCode(97 + Number(d)),
  );

/** Get-or-create a department (both projects share one stack). */
async function ensureDepartment(admin: APIRequestContext, name: string): Promise<string> {
  const { units } = (await (await admin.get("/api/v1/units")).json()) as { units: Unit[] };
  const found = units.find((u) => u.name === name && u.parentId === null);
  if (found) return found.id;
  const res = await admin.post("/api/v1/units", { data: { kind: "department", name, parentId: null } });
  expect(res.ok(), `create department ${name}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

/** A team bot on the never-metered mock model, recreated so earlier runs leave nothing behind. */
async function freshTeamBot(admin: APIRequestContext, name: string) {
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  for (const a of listed.agents.filter((x) => x.name === name)) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await admin.post("/api/v1/agents", {
    data: {
      name,
      description: "Summarizes the group when asked.",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), "create team bot").toBe(true);
  return (await res.json()) as { id: string; username: string };
}

/** An RGB PNG "screenshot": a soft gradient with a white card (no image library needed). */
function screenshotPng(width = 720, height = 450): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const card = x > width * 0.18 && x < width * 0.82 && y > height * 0.22 && y < height * 0.78;
      const bar = card && y > height * 0.3 && y < height * 0.35 && x < width * 0.6;
      const t = (x / width + y / height) / 2;
      const px: [number, number, number] = bar
        ? [16, 185, 129]
        : card
          ? [250, 250, 252]
          : [Math.round(16 + 200 * t * 0.6), Math.round(185 + 70 * t * 0.6), Math.round(129 + 126 * t * 0.3)];
      raw[row + 1 + x * 3] = px[0];
      raw[row + 2 + x * 3] = px[1];
      raw[row + 3 + x * 3] = px[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Pastes a file into a composer the way the browser does (a ClipboardEvent carrying it). */
async function pasteFile(target: Locator, file: { name: string; type: string; bytes: Buffer }) {
  await target.click();
  await target.evaluate(
    (el, f) => {
      const dataTransfer = new DataTransfer();
      const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dataTransfer.items.add(new File([bytes], f.name, { type: f.type }));
      el.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: dataTransfer, bubbles: true, cancelable: true }),
      );
    },
    { name: file.name, type: file.type, b64: file.bytes.toString("base64") },
  );
}

async function expectLoaded(img: Locator) {
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 })
    .toBeGreaterThan(0);
}

/** The views: rows on desktop, the segmented row inside the navigation drawer on phones. */
async function openViews(page: Page, mobile: boolean): Promise<Locator> {
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  const views = page.getByTestId(mobile ? "views-segmented" : "views-list").filter({ visible: true });
  await expect(views).toBeVisible();
  return views;
}

/** The channel list: in place on desktop, inside the navigation drawer on phones. */
async function openSidebar(page: Page, mobile: boolean): Promise<Locator> {
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  const list = page.getByTestId("channel-list").filter({ visible: true }).first();
  await expect(list).toBeVisible();
  return list;
}

async function closeSidebar(page: Page, mobile: boolean) {
  if (mobile) await page.keyboard.press("Escape");
}

const channelLink = (scope: Page | Locator, name: string) =>
  scope.locator(`[data-testid="channel-link"][data-channel-name="${name}"]`).first();

async function openPalette(page: Page, mobile: boolean) {
  if (mobile) await page.getByTestId("open-search").click();
  else await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByTestId("search-palette");
  await expect(palette).toBeVisible();
  await expect(palette.getByTestId("search-input")).toBeFocused();
  return palette;
}

/** A calm capture: no hover toolbar, no focused trigger. */
async function settle(page: Page) {
  await page.mouse.move(1, 1);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

test.describe.configure({ mode: "serial" });

test("a chat day: group DM with a bot, mention and notification, thread reply with a file, reaction, pin, search and jump, mark unread, live edit", async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const size = mobile ? "390" : "1440";
  const step = (name: string) => `chat-day-${name}-${size}`;
  const token = cellToken();
  expect(token, "OCW_CELL_TOKEN (the bot's cell) is configured").not.toBe("");

  // ---- morning setup: a Product channel, Sam in Product and in the channel, a group DM with Sam and a team bot
  const admin = await apiAs(ADMIN);
  const samId = await ensureMember(admin, SAM, "developer");
  const sam = await apiAs(SAM);
  expect((await sam.post("/api/v1/notifications/read", { data: { all: true } })).ok()).toBe(true);
  const product = await ensureDepartment(admin, "Product");
  const joined = await admin.post(`/api/v1/units/${product}/members`, {
    data: { userId: samId, role: "member" },
  });
  expect(joined.ok() || joined.status() === 409, `Sam in Product: ${joined.status()}`).toBe(true);
  const word = uniqueWord();
  const channelName = `release-${word.slice(-6)}-${project}`;
  const created = await admin.post("/api/v1/channels", {
    data: { name: channelName, visibility: "public", unitId: product },
  });
  expect(created.ok(), `create #${channelName}`).toBe(true);
  const channelId = ((await created.json()) as { id: string }).id;
  expect((await sam.post(`/api/v1/channels/${channelId}/join`)).ok()).toBe(true);

  const bot = await freshTeamBot(admin, mobile ? "Daybook" : "Dayline");
  const group = await admin.post("/api/v1/dms", {
    data: {
      participants: [
        { kind: "user", id: samId },
        { kind: "agent", id: bot.id },
      ],
    },
  });
  expect(group.ok(), `group DM: ${group.status()}`).toBe(true);
  const groupId = ((await group.json()) as { id: string }).id;

  const plugin = new FakeCellPlugin({ apiUrl: API_URL, token, autoAck: true, autoReply: true });
  await plugin.start();
  const a = await openAs(browser, ADMIN, project);
  const s = await openAs(browser, SAM, project);
  const tabB = await s.context.newPage();
  try {
    await tabB.goto(s.page.url());
    await expect(tabB.getByTestId("channel-view")).toBeVisible();

    // ---- the admin mentions Sam in the channel from the composer
    await a.page.goto(`${BASE_URL}/chat/${channelId}`);
    const composer = a.page.getByTestId("composer");
    await expect(composer).toBeVisible();
    const rootText = `@sam can you check the migración report for ${word}?`;
    await composer.click();
    await composer.fill(rootText);
    await composer.press("Enter");
    const rootOnAdmin = a.page.getByTestId("message").filter({ hasText: word }).last();
    await expect(rootOnAdmin).toBeVisible({ timeout: 10_000 });
    await expect(rootOnAdmin.getByTestId("mention")).toHaveText("@sam");
    const rootId = (await rootOnAdmin.getAttribute("data-message-id")) ?? "";
    expect(rootId).not.toBe("");
    await settle(a.page);
    await shot(a.page, step("mention"));

    // ---- Sam's Mentions view counts it and the channel shows a mention badge on his other tab, live
    const views = await openViews(s.page, mobile);
    await expect(views.getByTestId("view-mentions").getByTestId("view-count")).toHaveText("1", {
      timeout: 5_000,
    });
    const listB = await openSidebar(tabB, mobile);
    const badgeB = channelLink(listB, channelName).getByTestId("unread-badge");
    await expect(badgeB).toHaveAttribute("data-style", "mention", { timeout: 5_000 });
    await closeSidebar(tabB, mobile);

    // ---- Sam opens the notification and lands on the message, highlighted
    await views.getByTestId("view-mentions").click();
    await expect(s.page).toHaveURL(/\/chat\/mentions$/);
    const item = s.page.locator(`[data-testid="inbox-item"][data-message-id="${rootId}"]`);
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute("data-unread", "true");
    await expect(item.getByTestId("inbox-actor")).toHaveText(ADMIN.name);
    await expect(item.getByTestId("inbox-conversation")).toHaveText(channelName);
    await settle(s.page);
    await bothThemes(s.page, step("notification"));
    await item.click();
    await expect(s.page).toHaveURL(new RegExp(`/chat/${channelId}\\?m=${rootId}`));
    const rootOnSam = messageRow(s.page, rootId);
    await expect(rootOnSam).toHaveAttribute("data-highlighted", "true");
    await settle(s.page);
    await shot(s.page, step("landed"));

    // ---- Sam replies in its thread with a pasted screenshot
    const actions = await openMessageActions(s.page, rootId, project);
    await actions.getByTestId("reply-in-thread").click();
    const samPanel = s.page.getByTestId("thread-panel");
    await expect(samPanel).toBeVisible();
    const image = screenshotPng();
    await pasteFile(samPanel.getByTestId("thread-composer"), {
      name: "migration-report.png",
      type: "image/png",
      bytes: image,
    });
    await expect(samPanel.locator('[data-testid="attachment-item"][data-status="ready"]')).toHaveCount(1, {
      timeout: 15_000,
    });
    await samPanel.getByTestId("thread-composer").fill("Checked: the numbers match, screenshot attached");
    await samPanel.getByTestId("thread-composer-send").click();
    const replyOnSam = samPanel.getByTestId("message").filter({ hasText: "the numbers match" }).last();
    await expect(replyOnSam).toBeVisible({ timeout: 10_000 });
    await expectLoaded(replyOnSam.getByTestId("attachment-image"));
    const replyId = (await replyOnSam.getAttribute("data-message-id")) ?? "";
    expect(replyId).not.toBe("");
    await settle(s.page);
    await bothThemes(s.page, step("thread-file"));

    // ---- the admin sees the reply count live, opens the thread and the image in the lightbox
    const summary = messageRow(a.page, rootId).getByTestId("thread-summary");
    await expect(summary).toContainText("1 reply", { timeout: 5_000 });
    await summary.click();
    const adminPanel = a.page.getByTestId("thread-panel");
    await expect(adminPanel).toBeVisible();
    const replyOnAdmin = adminPanel.locator(`[data-testid="message"][data-message-id="${replyId}"]`);
    await expectLoaded(replyOnAdmin.getByTestId("attachment-image"));
    await replyOnAdmin.getByTestId("attachment-tile").first().click();
    const lightbox = a.page.getByTestId("lightbox");
    await expect(lightbox).toBeVisible();
    await expectLoaded(lightbox.getByTestId("lightbox-image"));
    await shot(a.page, step("lightbox"));
    await a.page.keyboard.press("Escape");
    await expect(lightbox).toBeHidden();

    // ---- the admin reacts 👍 to Sam's reply and pins the root; Sam sees both live
    const replyActions = await openMessageActions(a.page, replyId, project);
    await replyActions.locator('[data-testid="quick-reaction"][data-emoji="👍"]').click();
    if (mobile) await expect(a.page.getByTestId("message-sheet")).toBeHidden();
    await a.page.goto(`${BASE_URL}/chat/${channelId}`);
    const rootActions = await openMessageActions(a.page, rootId, project);
    if (mobile) {
      await rootActions.getByTestId("pin-message").click();
      await expect(a.page.getByTestId("message-sheet")).toBeHidden();
    } else {
      await rootActions.getByTestId("message-more").click();
      await a.page.getByTestId("message-menu").getByTestId("pin-message").click();
    }
    await expect(messageRow(a.page, rootId).getByTestId("pinned-label")).toBeVisible();

    const thumbs = replyOnSam.locator('[data-testid="reaction-chip"][data-emoji="👍"]');
    await expect(thumbs).toContainText("1", { timeout: 5_000 });
    await expect(thumbs).toHaveAttribute("data-mine", "false");
    await expect(
      s.page.locator(`[data-message-id="${rootId}"] [data-testid="pinned-label"]`).first(),
    ).toBeAttached({ timeout: 5_000 });
    if (!mobile) await expect(s.page.getByTestId("pinned-count")).toHaveText("1", { timeout: 5_000 });
    await settle(s.page);
    await shot(s.page, step("reaction-pin"));

    // ---- in the group DM Sam asks the bot; the simulated reply lands at the top level
    await s.page.goto(`${BASE_URL}/chat/dm/${groupId}`);
    await expect(s.page.getByTestId("dm-view")).toHaveAttribute("data-dm-kind", "group");
    const dmBox = s.page.getByTestId("composer");
    await dmBox.click();
    await dmBox.fill(`@${bot.username} summarize`);
    await dmBox.press("Enter");
    const botReply = s.page
      .locator('[data-testid="message"][data-author-kind="agent"]')
      .filter({ hasText: "Asked by Sam Lee" });
    await expect(botReply.first()).toBeVisible({ timeout: 15_000 });
    await expect(s.page.getByTestId("thread-summary")).toHaveCount(0);
    await settle(s.page);
    await shot(s.page, step("group-bot"));

    // ---- Sam searches without the accent, opens the hit and lands on the root, highlighted
    const palette = await openPalette(s.page, mobile);
    await palette.getByTestId("search-input").pressSequentially(`migracion ${word}`, { delay: 30 });
    const hit = palette.locator(`[data-kind="message"][data-message-id="${rootId}"]`);
    await expect(hit).toBeVisible();
    await expect(hit.locator("mark").first()).toHaveText("migración");
    await expect(hit).toContainText(`#${channelName}`);
    await bothThemes(s.page, step("search"));
    if (mobile) await hit.click();
    else {
      await expect(hit).toHaveAttribute("aria-selected", "true");
      await s.page.keyboard.press("Enter");
    }
    await expect(palette).toBeHidden();
    await expect(s.page).toHaveURL(new RegExp(`/chat/${channelId}\\?m=${rootId}`));
    await expect(rootOnSam).toHaveAttribute("data-highlighted", "true");
    await expect(rootOnSam).toBeInViewport();

    // ---- Sam marks the channel unread from the root; his second tab shows the badge again
    let list = await openSidebar(tabB, mobile);
    await expect(channelLink(list, channelName).getByTestId("unread-badge")).toHaveCount(0, {
      timeout: 5_000,
    });
    await closeSidebar(tabB, mobile);
    const unreadActions = await openMessageActions(s.page, rootId, project);
    if (mobile) await unreadActions.getByTestId("mark-unread").first().click();
    else {
      await unreadActions.getByTestId("message-more").first().click();
      await s.page.getByTestId("mark-unread").click();
    }
    await expect(s.page.getByTestId("new-messages-divider")).toBeVisible();
    list = await openSidebar(tabB, mobile);
    await expect(channelLink(list, channelName).getByTestId("unread-badge")).toHaveAttribute(
      "data-count",
      /^[1-9]\d*$/,
      { timeout: 5_000 },
    );
    await shot(tabB, step("mark-unread"));
    await closeSidebar(tabB, mobile);

    // ---- the admin edits the root; Sam sees the new text and "(edited)" live
    const editActions = await openMessageActions(a.page, rootId, project);
    await editActions.getByTestId("edit-message").click();
    const input = messageRow(a.page, rootId).getByTestId("edit-input");
    await expect(input).toBeFocused();
    await input.fill(`@sam can you check the migración report for ${word} before 15:00?`);
    await messageRow(a.page, rootId).getByTestId("edit-save").click();
    await expect(messageRow(a.page, rootId).getByTestId("edit-input")).toHaveCount(0);
    await expect(rootOnSam).toContainText("before 15:00", { timeout: 5_000 });
    await expect(rootOnSam.getByTestId("edited-marker")).toBeVisible({ timeout: 5_000 });
    await settle(s.page);
    await shot(s.page, step("edited"));
  } finally {
    await a.context.close();
    await s.context.close();
    await plugin.stop();
    await admin.dispose();
    await sam.dispose();
  }
});
