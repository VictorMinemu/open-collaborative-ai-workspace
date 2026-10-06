import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { type Actor, apiAs, ensureMember, openAs } from "../support/actors";
import { freshChannel, messageRow, postAs } from "../support/chat";
import { ADMIN, shot } from "./env";

/**
 * CHAT-08 (04-09): notifications. A mention lands in the member's Mentions view live (the sidebar badge counts it),
 * opening it jumps to the message and marks it read. Each Playwright project uses its own colleague so the counts
 * of one project never leak into the other (both share one stack).
 */

const RECIPIENT: Record<string, Actor> = {
  desktop: { name: "Nadia Desk", email: "nadia@ocw.test", password: "nadia-e2e-password-123" },
  mobile: { name: "Milo Phone", email: "milo@ocw.test", password: "milo-e2e-password-123" },
};
const handleOf = (a: Actor) => a.email.split("@")[0] as string;

async function bothThemes(page: Page, name: string) {
  await shot(page, name);
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, `${name}-dark`);
  await page.emulateMedia({ colorScheme: "light" });
}

/** The views: rows on desktop, the segmented row inside the navigation drawer on phones. */
async function openViews(page: Page, mobile: boolean): Promise<Locator> {
  if (mobile) await page.getByTestId("mobile-nav-trigger").click();
  const views = page.getByTestId(mobile ? "views-segmented" : "views-list").filter({ visible: true });
  await expect(views).toBeVisible();
  return views;
}

async function readAll(api: APIRequestContext) {
  expect((await api.post("/api/v1/notifications/read", { data: { all: true } })).ok()).toBe(true);
}

test.describe.configure({ mode: "serial" });

test("a mention reaches the Mentions view live; opening it jumps to the message and reads it", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const size = mobile ? "390" : "1440";
  const who = RECIPIENT[project] ?? (RECIPIENT.desktop as Actor);
  const handle = handleOf(who);

  const admin = await apiAs(ADMIN);
  await ensureMember(admin, who, "developer");
  const api = await apiAs(who);
  await readAll(api);
  const channel = await freshChannel(admin, [], "launch");

  const me = await openAs(browser, who, project);
  const { page } = me;
  let views = await openViews(page, mobile);
  const mentionsLink = views.getByTestId("view-mentions");
  await expect(mentionsLink).toBeVisible();
  await expect(mentionsLink.getByTestId("view-count")).toHaveCount(0);
  await expect(views.locator("a")).toHaveText([/All/, /Mentions/, /Threads/, /AI Chats/, /Saved/]);
  if (mobile) await page.keyboard.press("Escape");

  // ---- the admin mentions the member in a channel they have not joined: the badge counts it within 5 s
  const msg = await postAs(
    admin,
    channel.id,
    `Can you review the launch plan, @${handle}? It is due **Friday**.`,
  );
  views = await openViews(page, mobile);
  await expect(views.getByTestId("view-mentions").getByTestId("view-count")).toHaveText("1", {
    timeout: 5_000,
  });

  // A thread reply that mentions them too (a second, richer row for the review captures).
  const root = await postAs(admin, channel.id, "Release checklist");
  await postAs(admin, channel.id, `@${handle} can you own the changelog?`, { threadRootId: root.id });
  await expect(views.getByTestId("view-mentions").getByTestId("view-count")).toHaveText("2", {
    timeout: 5_000,
  });

  // ---- the Mentions view lists them, newest first: actor, kind, conversation, snippet with a mention chip
  await views.getByTestId("view-mentions").click();
  await expect(page).toHaveURL(/\/chat\/mentions$/);
  const inbox = page.getByTestId("inbox");
  await expect(inbox).toBeVisible();
  const item = inbox.locator(`[data-testid="inbox-item"][data-message-id="${msg.id}"]`);
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute("data-unread", "true");
  await expect(item.getByTestId("inbox-actor")).toHaveText(ADMIN.name);
  await expect(item).toContainText("mentioned you");
  await expect(item.getByTestId("inbox-conversation")).toHaveText(channel.name);
  await expect(item.getByTestId("inbox-snippet")).toContainText("Can you review the launch plan");
  await expect(item.getByTestId("inbox-snippet").getByTestId("mention")).toHaveText(`@${handle}`);
  await expect(inbox.getByTestId("inbox-item").first()).toContainText("changelog");
  await bothThemes(page, `inbox-${size}`);

  // ---- opening it lands on the message, highlighted, and reads it
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/chat/${channel.id}\\?m=${msg.id}`));
  const target = messageRow(page, msg.id);
  await expect(target).toBeVisible();
  await expect(target).toHaveAttribute("data-highlighted", "true");
  views = await openViews(page, mobile);
  await expect(views.getByTestId("view-mentions").getByTestId("view-count")).toHaveText("1");

  // ---- "Mark all read" clears the rest
  await views.getByTestId("view-mentions").click();
  await page.getByTestId("inbox-mark-all").click();
  await expect(page.getByTestId("inbox-item").first()).not.toHaveAttribute("data-unread", "true");
  views = await openViews(page, mobile);
  await expect(views.getByTestId("view-mentions").getByTestId("view-count")).toHaveCount(0);

  await me.context.close();
  await api.dispose();
  await admin.dispose();
});
