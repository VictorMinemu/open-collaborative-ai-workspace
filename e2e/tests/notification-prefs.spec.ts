import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { type Actor, apiAs, ensureMember, openAs } from "../support/actors";
import { freshChannel, postAs } from "../support/chat";
import { ADMIN, shot } from "./env";

/**
 * CHAT-10 (04-11, D-02): notification preferences and OS notifications while the app runs. `window.Notification` is
 * replaced by a recorder (init script), so the spec sees exactly which pop-ups the app asked the OS for, with their
 * tag and click handler. Each Playwright project uses its own member so one project never sees the other's.
 */

const MEMBER: Record<string, Actor> = {
  desktop: { name: "Pia Desk", email: "pia@ocw.test", password: "pia-e2e-password-123" },
  mobile: { name: "Pol Phone", email: "pol@ocw.test", password: "pol-e2e-password-123" },
};
const handleOf = (a: Actor) => a.email.split("@")[0] as string;

interface Recorded {
  title: string;
  body: string;
  tag: string;
}

declare global {
  interface Window {
    __notes: Array<Recorded & { onclick: (() => void) | null }>;
    __permissionRequests: number;
    __badge: number[];
  }
}

/**
 * The recorder: permission comes from localStorage (`e2e-notification-permission`, default "granted") so a test can
 * start at "default"; `requestPermission` is counted and grants.
 */
function installRecorder() {
  const KEY = "e2e-notification-permission";
  window.__notes = [];
  window.__permissionRequests = 0;
  class RecordingNotification {
    static get permission(): NotificationPermission {
      return (localStorage.getItem(KEY) as NotificationPermission | null) ?? "granted";
    }
    static async requestPermission(): Promise<NotificationPermission> {
      window.__permissionRequests += 1;
      localStorage.setItem(KEY, "granted");
      return "granted";
    }
    title: string;
    body: string;
    tag: string;
    onclick: (() => void) | null = null;
    constructor(title: string, opts?: NotificationOptions) {
      this.title = title;
      this.body = opts?.body ?? "";
      this.tag = opts?.tag ?? "";
      window.__notes.push(this);
    }
    close() {}
  }
  Object.defineProperty(window, "Notification", {
    value: RecordingNotification,
    configurable: true,
    writable: true,
  });
}

const notes = (page: Page): Promise<Recorded[]> =>
  page.evaluate(() => window.__notes.map(({ title, body, tag }) => ({ title, body, tag })));

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

/** A signed-in member's browser with the recorder installed on every page, opened on `path`. */
async function openRecorded(
  browser: import("@playwright/test").Browser,
  who: Actor,
  project: string,
  path: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const s = await openAs(browser, who, project);
  await s.context.grantPermissions(["notifications"]);
  await s.context.addInitScript(installRecorder);
  await s.page.goto(path);
  await expect(s.page.getByTestId("app-shell")).toBeVisible();
  return s;
}

async function resetPrefs(api: APIRequestContext) {
  const res = await api.put("/api/v1/notification-prefs", {
    data: { dndUntil: null, desktopEnabled: true, webEnabled: true, defaultLevel: "mentions" },
  });
  expect(res.ok(), "reset prefs").toBe(true);
}

/** The member's notification for one message (its id is the pop-up's tag). */
async function notificationOf(api: APIRequestContext, messageId: string): Promise<{ id: string }> {
  let found: { id: string } | undefined;
  await expect
    .poll(
      async () => {
        const res = await api.get("/api/v1/notifications?filter=all&limit=50");
        const items = ((await res.json()) as { items: Array<{ id: string; messageId: string }> }).items;
        found = items.find((n) => n.messageId === messageId);
        return !!found;
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  return found as { id: string };
}

async function openNotifyMenu(page: Page): Promise<Locator> {
  await page.getByTestId("conversation-notify-menu").click();
  const menu = page.getByTestId("conversation-notify-content");
  await expect(menu).toBeVisible();
  return menu;
}

test.describe.configure({ mode: "serial" });

test("muting a conversation silences its pop-ups and badge, mentions still reach the inbox; unmuted, a mention pops a real notification", async ({
  browser,
}, info) => {
  test.setTimeout(150_000);
  const project = info.project.name;
  const mobile = project === "mobile";
  const size = mobile ? "390" : "1440";
  const who = MEMBER[project] ?? (MEMBER.desktop as Actor);
  const handle = handleOf(who);

  const admin = await apiAs(ADMIN);
  await ensureMember(admin, who, "developer");
  const api = await apiAs(who);
  await resetPrefs(api);
  expect((await api.post("/api/v1/notifications/read", { data: { all: true } })).ok()).toBe(true);
  const random = await freshChannel(admin, [api], "random");
  const design = await freshChannel(admin, [api], "design");

  const { context, page } = await openRecorded(browser, who, project, `/chat/${design.id}`);
  await expect(page.getByTestId("channel-view")).toHaveAttribute("data-channel-id", design.id);

  // ---- mute #design from its notify menu
  let menu = await openNotifyMenu(page);
  await expect(menu.getByTestId("notify-level")).toHaveAttribute("data-value", "default");
  await page.mouse.move(1, 1);
  await bothThemes(page, `notify-menu-${size}`);
  await menu.getByTestId("mute-conversation").click();
  await expect(page.getByTestId("conversation-notify-menu")).toHaveAttribute("data-muted", "true");

  // ---- back on #random: the muted row is dimmed and marked
  await page.goto(`/chat/${random.id}`);
  await expect(page.getByTestId("channel-view")).toHaveAttribute("data-channel-id", random.id);
  let list = await openSidebar(page, mobile);
  await expect(channelLink(list, design.name)).toHaveAttribute("data-muted", "true");
  await expect(channelLink(list, design.name).getByTestId("muted-icon")).toBeVisible();

  // A plain message there adds no badge.
  await postAs(admin, design.id, "New icons are up on the board");
  await page.waitForTimeout(1_000);
  await expect(channelLink(list, design.name).getByTestId("unread-badge")).toHaveCount(0);
  await bothThemes(page, `sidebar-muted-${size}`);
  await closeSidebar(page, mobile);

  // ---- a mention in muted #design: no OS notification, but the Mentions inbox has it
  const muted = await postAs(admin, design.id, `@${handle} can you check the icon sizes?`);
  await notificationOf(api, muted.id);
  await page.waitForTimeout(1_500);
  expect(await notes(page)).toEqual([]);
  await page.goto("/chat/mentions");
  await expect(page.locator(`[data-testid="inbox-item"][data-message-id="${muted.id}"]`)).toBeVisible();

  // ---- unmute from #design's menu, then a mention while on #random pops exactly one notification
  await page.goto(`/chat/${design.id}`);
  await expect(page.getByTestId("channel-view")).toHaveAttribute("data-channel-id", design.id);
  menu = await openNotifyMenu(page);
  await expect(menu.getByTestId("mute-conversation")).toHaveAttribute("data-muted", "true");
  await menu.getByTestId("mute-conversation").click();
  await expect(page.getByTestId("conversation-notify-menu")).not.toHaveAttribute("data-muted", "true");
  await page.goto(`/chat/${random.id}`);
  await expect(page.getByTestId("channel-view")).toHaveAttribute("data-channel-id", random.id);
  list = await openSidebar(page, mobile);
  await expect(channelLink(list, design.name)).not.toHaveAttribute("data-muted", "true");
  await closeSidebar(page, mobile);
  await page.evaluate(() => {
    window.__notes = [];
  });

  const loud = await postAs(admin, design.id, `@${handle} the sizes look right now`);
  const n = await notificationOf(api, loud.id);
  await expect.poll(async () => (await notes(page)).length, { timeout: 5_000 }).toBe(1);
  const [note] = await notes(page);
  expect(note).toEqual({
    title: `${ADMIN.name} in #${design.name}`,
    body: `@${handle} the sizes look right now`,
    tag: n.id,
  });
  await page.waitForTimeout(800);
  expect(await notes(page)).toHaveLength(1);

  // ---- clicking it opens the message
  await page.evaluate(() => window.__notes[0]?.onclick?.());
  await expect(page).toHaveURL(new RegExp(`/chat/${design.id}\\?m=${loud.id}`));

  await context.close();
  await api.dispose();
  await admin.dispose();
});
