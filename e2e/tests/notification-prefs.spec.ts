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

const userMenu = (page: Page) => page.getByTestId("user-menu").filter({ visible: true }).first();

test("Settings › Notifications, pause from the user menu, all new messages, and the tab title count", async ({
  browser,
}, info) => {
  test.setTimeout(180_000);
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

  // The browser has not decided yet: permission starts at "default".
  const { context, page } = await openRecorded(browser, who, project, `/chat/${random.id}`);
  await page.evaluate(() => localStorage.setItem("e2e-notification-permission", "default"));
  await page.goto("/settings/notifications");
  const settings = page.getByTestId("notification-settings");
  await expect(settings).toBeVisible();
  await expect(page.getByTestId("notification-permission")).toContainText("Not enabled yet");
  // Nothing asked for permission on load, here or in the chat before.
  expect(await page.evaluate(() => window.__permissionRequests)).toBe(0);
  await bothThemes(page, `settings-notifications-${size}`);

  // ---- "Enable notifications" asks once, on the click
  await page.getByTestId("enable-notifications").click();
  await expect(page.getByTestId("notification-permission")).toContainText("Allowed");
  expect(await page.evaluate(() => window.__permissionRequests)).toBe(1);
  await expect(page.getByTestId("enable-notifications")).toHaveCount(0);

  // ---- Web notifications off: a mention reaches the inbox but pops nothing
  const web = page.getByTestId("web-enabled");
  await expect(web).toHaveAttribute("aria-checked", "true");
  await web.click();
  await expect(web).toHaveAttribute("aria-checked", "false");
  await expect
    .poll(
      async () =>
        ((await (await api.get("/api/v1/notification-prefs")).json()) as { webEnabled: boolean }).webEnabled,
    )
    .toBe(false);
  const off = await postAs(admin, design.id, `@${handle} while web notifications are off`);
  await notificationOf(api, off.id);
  await page.waitForTimeout(1_500);
  expect(await notes(page)).toEqual([]);

  // ---- back on: the next mention pops (on a settings page too: the notifier runs app-wide)
  await web.click();
  await expect(web).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(
      async () =>
        ((await (await api.get("/api/v1/notification-prefs")).json()) as { webEnabled: boolean }).webEnabled,
    )
    .toBe(true);
  const on = await postAs(admin, design.id, `@${handle} and now they are on`);
  const onNote = await notificationOf(api, on.id);
  await expect
    .poll(async () => (await notes(page)).map((n) => n.tag), { timeout: 5_000 })
    .toEqual([onNote.id]);

  // ---- "Pause notifications" › 1 hour from the user menu: paused, and pop-ups stop
  await page.goto(`/chat/${random.id}`);
  await expect(page.getByTestId("channel-view")).toHaveAttribute("data-channel-id", random.id);
  await userMenu(page).click();
  await page.getByTestId("pause-notifications").click();
  await expect(page.getByTestId("pause-1h")).toBeVisible();
  await page.getByTestId("pause-1h").hover();
  await shot(page, `user-menu-pause-${size}`);
  await page.getByTestId("pause-1h").click();
  await expect(page.getByTestId("dnd-indicator").filter({ visible: true })).toHaveCount(1);
  // Picking an item closes the whole menu tree; reopen only once it is gone.
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await userMenu(page).click();
  await expect(page.getByTestId("notifications-paused")).toContainText("Notifications paused until");
  await page.keyboard.press("Escape");
  await expect(page.locator('[role="menu"]')).toHaveCount(0);
  await page.evaluate(() => {
    window.__notes = [];
  });
  const quiet = await postAs(admin, design.id, `@${handle} during the pause`);
  await notificationOf(api, quiet.id);
  await page.waitForTimeout(1_500);
  expect(await notes(page)).toEqual([]);
  await userMenu(page).click();
  await expect(page.getByTestId("resume-notifications")).toBeVisible({ timeout: 3_000 });
  await page.getByTestId("resume-notifications").click();
  await expect(page.getByTestId("dnd-indicator")).toHaveCount(0);

  // ---- #random on "All new messages": a plain message there pops while the member reads #design
  const menu = await openNotifyMenu(page);
  await menu.getByTestId("notify-level-all").click();
  await expect
    .poll(async () => {
      const res = await api.get("/api/v1/channels");
      const row = (
        (await res.json()) as { channels: Array<{ id: string; notifyLevel: string }> }
      ).channels.find((c) => c.id === random.id);
      return row?.notifyLevel;
    })
    .toBe("all");
  await page.goto(`/chat/${design.id}`);
  await expect(page.getByTestId("channel-view")).toHaveAttribute("data-channel-id", design.id);
  await page.evaluate(() => {
    window.__notes = [];
  });
  const plain = await postAs(admin, random.id, "Standup moves to 10:15 tomorrow");
  await expect
    .poll(async () => await notes(page), { timeout: 5_000 })
    .toEqual([
      { title: `${ADMIN.name} in #${random.name}`, body: "Standup moves to 10:15 tomorrow", tag: plain.id },
    ]);

  // ---- the tab title counts unread mentions: (2), then nothing once they are read
  expect((await api.post("/api/v1/notifications/read", { data: { all: true } })).ok()).toBe(true);
  await expect(page).not.toHaveTitle(/^\(\d+\+?\) /);
  await postAs(admin, random.id, `@${handle} first question`);
  await postAs(admin, random.id, `@${handle} second question`);
  await expect(page).toHaveTitle(/^\(2\) /, { timeout: 5_000 });
  await page.goto(`/chat/${random.id}`);
  await expect(page.getByTestId("channel-view")).toHaveAttribute("data-channel-id", random.id);
  await expect(page).not.toHaveTitle(/^\(\d+\+?\) /, { timeout: 5_000 });

  await context.close();
  await resetPrefs(api);
  await api.dispose();
  await admin.dispose();
});
