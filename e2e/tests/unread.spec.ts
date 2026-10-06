import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { type Actor, apiAs, ensureMember, openAs } from "../support/actors";
import { freshChannel, messageRow, openMessageActions, postAs } from "../support/chat";
import { ADMIN, shot } from "./env";

/**
 * CHAT-09 (04-10, D-07): unread and mention badges counted over messages, live, and read state synced across a
 * member's tabs and devices. Each Playwright project uses its own member so the counts of one project never leak
 * into the other (both share one stack).
 */

const MEMBER: Record<string, Actor> = {
  desktop: { name: "Una Desk", email: "una@ocw.test", password: "una-e2e-password-123" },
  mobile: { name: "Ugo Phone", email: "ugo@ocw.test", password: "ugo-e2e-password-123" },
};
const handleOf = (a: Actor) => a.email.split("@")[0] as string;

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
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
const badgeOf = (row: Locator) => row.getByTestId("unread-badge");

async function readEverything(api: APIRequestContext) {
  expect((await api.post("/api/v1/notifications/read", { data: { all: true } })).ok()).toBe(true);
}

test.describe.configure({ mode: "serial" });

test("live unread and mention badges; opening a conversation clears them on the member's other tab", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const size = mobile ? "390" : "1440";
  const who = MEMBER[project] ?? (MEMBER.desktop as Actor);

  const admin = await apiAs(ADMIN);
  await ensureMember(admin, who, "developer");
  const api = await apiAs(who);
  await readEverything(api);
  const random = await freshChannel(admin, [api], "random");
  const design = await freshChannel(admin, [api], "design");

  // Two tabs of the same member (one browser context = one device), both on their landing channel.
  const a = await openAs(browser, who, project);
  const tabA = a.page;
  const tabB = await a.context.newPage();
  await tabB.goto(tabA.url());
  await expect(tabB.getByTestId("channel-view")).toBeVisible();

  // ---- nothing unread yet
  let list = await openSidebar(tabA, mobile);
  await expect(channelLink(list, random.name)).toBeVisible();
  await expect(badgeOf(channelLink(list, random.name))).toHaveCount(0);
  await closeSidebar(tabA, mobile);

  // ---- three messages in #random and a mention in #design reach tab A live
  for (const body of ["Lunch at 1?", "Pizza or sushi?", "Booking at 12:45"])
    await postAs(admin, random.id, body);
  await postAs(admin, design.id, `@${handleOf(who)} can you check the new icons?`);
  list = await openSidebar(tabA, mobile);
  const randomBadge = badgeOf(channelLink(list, random.name));
  const designBadge = badgeOf(channelLink(list, design.name));
  await expect(randomBadge).toHaveAttribute("data-count", "3", { timeout: 5_000 });
  await expect(randomBadge).toHaveAttribute("data-style", "count");
  await expect(designBadge).toHaveAttribute("data-count", "1", { timeout: 5_000 });
  await expect(designBadge).toHaveAttribute("data-style", "mention");
  await expect(channelLink(list, random.name)).toHaveAttribute("data-unread", "true");
  await bothThemes(tabA, `sidebar-badges-${size}`);

  // ---- tab B shows the same, then tab A opens #random and tab B's badge goes away without a reload
  let listB = await openSidebar(tabB, mobile);
  await expect(badgeOf(channelLink(listB, random.name))).toHaveAttribute("data-count", "3", {
    timeout: 5_000,
  });
  await closeSidebar(tabB, mobile);

  await channelLink(list, random.name).click();
  await expect(tabA).toHaveURL(new RegExp(`/chat/${random.id}`));
  await expect(tabA.getByTestId("channel-view")).toBeVisible();
  await expect(tabA.getByTestId("message").filter({ hasText: "Booking at 12:45" })).toBeVisible();

  listB = await openSidebar(tabB, mobile);
  await expect(badgeOf(channelLink(listB, random.name))).toHaveCount(0, { timeout: 5_000 });
  await expect(channelLink(listB, random.name)).not.toHaveAttribute("data-unread", "true");
  // #design is still unread with its mention.
  await expect(badgeOf(channelLink(listB, design.name))).toHaveAttribute("data-style", "mention");
  await closeSidebar(tabB, mobile);

  // ---- opening #design reads its mention too: the Mentions inbox count drops (04-09 open item)
  await tabA.goto(`/chat/${design.id}`);
  await expect(tabA.getByTestId("channel-view")).toBeVisible();
  listB = await openSidebar(tabB, mobile);
  await expect(badgeOf(channelLink(listB, design.name))).toHaveCount(0, { timeout: 5_000 });
  await expect
    .poll(
      async () => {
        const res = await api.get("/api/v1/notifications?filter=mentions");
        return ((await res.json()) as { unreadCount: number }).unreadCount;
      },
      { timeout: 5_000 },
    )
    .toBe(0);

  await a.context.close();
  await api.dispose();
  await admin.dispose();
});

test("mark unread from a message holds the conversation unread here and on the other tab until read", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const size = mobile ? "390" : "1440";
  const who = MEMBER[project] ?? (MEMBER.desktop as Actor);

  const admin = await apiAs(ADMIN);
  await ensureMember(admin, who, "developer");
  const api = await apiAs(who);
  const random = await freshChannel(admin, [api], "random");
  const msgs: Array<{ id: string; seq: number }> = [];
  for (const body of ["Agenda for Friday", "Item two: budget", "Item three: hiring", "Item four: offsite"]) {
    msgs.push(await postAs(admin, random.id, body));
  }
  const second = msgs[1] as { id: string; seq: number };

  const a = await openAs(browser, who, project);
  const tabA = a.page;
  const landing = tabA.url();
  const tabB = await a.context.newPage();
  await tabB.goto(landing);
  await expect(tabB.getByTestId("channel-view")).toBeVisible();

  // ---- tab A reads #random, then marks it unread from message 2
  await tabA.goto(`/chat/${random.id}`);
  await expect(messageRow(tabA, second.id)).toBeVisible();
  let listB = await openSidebar(tabB, mobile);
  await expect(badgeOf(channelLink(listB, random.name))).toHaveCount(0, { timeout: 5_000 });
  await closeSidebar(tabB, mobile);

  const actions = await openMessageActions(tabA, second.id, project);
  await actions
    .getByTestId(mobile ? "mark-unread" : "message-more")
    .first()
    .click();
  if (!mobile) await tabA.getByTestId("mark-unread").click();

  // The divider sits right above message 2; staying here does not read it again.
  const divider = tabA.getByTestId("new-messages-divider");
  await expect(divider).toBeVisible();
  const next = divider.locator("xpath=following-sibling::*[1]");
  await expect(next).toHaveAttribute("data-message-id", second.id);
  // A calm capture: no hover toolbar, no focused trigger.
  await tabA.mouse.move(1, 1);
  await tabA.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await bothThemes(tabA, `mark-unread-${size}`);
  await tabA.waitForTimeout(1_500);

  // ---- tab B shows the badge again (3 unread: messages 2, 3 and 4)
  listB = await openSidebar(tabB, mobile);
  await expect(badgeOf(channelLink(listB, random.name))).toHaveAttribute("data-count", "3", {
    timeout: 5_000,
  });
  await closeSidebar(tabB, mobile);

  // ---- leaving and coming back (in the app, then a reload) keeps it unread
  let listA = await openSidebar(tabA, mobile);
  await channelLink(listA, "general").click();
  await expect(tabA).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
  await expect(tabA).not.toHaveURL(new RegExp(random.id));
  listA = await openSidebar(tabA, mobile);
  await expect(badgeOf(channelLink(listA, random.name))).toHaveAttribute("data-count", "3");
  await channelLink(listA, random.name).click();
  await expect(messageRow(tabA, second.id)).toBeVisible();
  await tabA.reload();
  await expect(messageRow(tabA, second.id)).toBeVisible();
  await expect(tabA.getByTestId("new-messages-divider")).toBeVisible();
  await tabA.waitForTimeout(1_500);
  listB = await openSidebar(tabB, mobile);
  await expect(badgeOf(channelLink(listB, random.name))).toHaveAttribute("data-count", "3");
  await closeSidebar(tabB, mobile);

  // ---- "Mark as read" in the header menu reads it everywhere
  await tabA.getByTestId("conversation-notify-menu").click();
  await tabA.getByTestId("mark-read").click();
  listB = await openSidebar(tabB, mobile);
  await expect(badgeOf(channelLink(listB, random.name))).toHaveCount(0, { timeout: 5_000 });
  await closeSidebar(tabB, mobile);

  // ---- "Mark as unread" from the header marks the latest message unread; reaching the bottom reads it again
  await tabA.getByTestId("conversation-notify-menu").click();
  await tabA.getByTestId("mark-unread-latest").click();
  listB = await openSidebar(tabB, mobile);
  await expect(badgeOf(channelLink(listB, random.name))).toHaveAttribute("data-count", "1", {
    timeout: 5_000,
  });
  await closeSidebar(tabB, mobile);
  if (!mobile) {
    await tabA.getByTestId("channel-scroll").hover();
    await tabA.mouse.wheel(0, 400);
    listB = await openSidebar(tabB, mobile);
    await expect(badgeOf(channelLink(listB, random.name))).toHaveCount(0, { timeout: 5_000 });
  }

  await a.context.close();
  await api.dispose();
  await admin.dispose();
});
