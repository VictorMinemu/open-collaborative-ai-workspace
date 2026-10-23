import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { MODULE_CATALOG } from "../../packages/contracts/src/module-access.ts";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { freshTeamBot } from "../support/bot-tools";
import { clearSessions, openContextOf, signInThroughBot, take } from "../support/browser-signin";
import { cellToken } from "../support/cell-token";
import { ALEX, freshChannel, postAs } from "../support/chat";
import { FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { enableBotSandbox, enableSandboxOrg, resume } from "../support/sandbox";
import { ADMIN, API_URL } from "./env";

/**
 * The bot page's Browser tab (07.8-27; BRW-02, D-06, UI-SPEC § 3.6, C-03), against the real API, the fake cell (driven
 * by hand) and the fake sandboxd. Scout has a page open for Sam in #ops (Live, Open live view opens the live view on
 * it), a page Alex is signing in to there (a private row without a button), and Sam's own sign-in in his DM. Recent
 * activity names hosts and conversations only, newest first, 20 at a time with Show more. A bot that never browsed
 * shows the whole-tab empty state; one with nothing open shows "Nothing open right now." With Browser off for Sam the
 * tab is absent and `?tab=browser` shows Memory. axe in light and dark, 44 px targets and the screenshots at both widths.
 */

test.describe.configure({ mode: "serial" });

const BOT = "Scout";
const QUIET = "Quiet";
const PANEL = "panel.fake.test";
const STATUS = "status.fake.test";
const INVOICES = "invoices.fake.test";

let admin: APIRequestContext;
let samApi: APIRequestContext;
let alexApi: APIRequestContext;
let samId: string;
let cell: FakeCellPlugin;
const open: BrowserContext[] = [];

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  samId = await ensureMember(admin, SAM, "developer");
  await ensureMember(admin, ALEX, "developer");
  samApi = await apiAs(SAM);
  alexApi = await apiAs(ALEX);
  await enableSandboxOrg(admin);
  await resume(admin);
  cell = new FakeCellPlugin({ apiUrl: API_URL, token: cellToken(), autoAck: true, autoReply: false });
  await cell.start();
});

test.afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

test.afterAll(async () => {
  for (const c of open.splice(0)) await c.close();
  await cell?.stop();
  await samApi?.dispose();
  await alexApi?.dispose();
  await admin?.dispose();
});

async function signIn(browser: Parameters<typeof openAs>[0], who: Actor, project: string): Promise<Page> {
  const s = await openAs(browser, who, project);
  open.push(s.context);
  return s.page;
}

async function mentionOf(messageId: string): Promise<MentionPayload> {
  const ev = await cell.waitFor(
    (e) => e.type === "agent.mention.v1" && (e.data as unknown as MentionPayload).message?.id === messageId,
    30_000,
  );
  return ev.data as unknown as MentionPayload;
}

async function browserBot(name: string): Promise<string> {
  const id = await freshTeamBot(admin, name);
  await enableBotSandbox(admin, id, { sandbox: true, browser: true });
  return id;
}

async function dmWith(api: APIRequestContext, botId: string): Promise<string> {
  const dm = await api.post(`/api/v1/agents/${botId}/dm`);
  expect(dm.ok(), "a DM with the bot").toBe(true);
  return ((await dm.json()) as { dmId: string }).dmId;
}

/** `who` asks the bot in `conversationId`; the bot opens each host in turn (closing the last); returns the mention. */
async function botOpens(
  api: APIRequestContext,
  conversationId: string,
  botId: string,
  hosts: string[],
  opts: { closeLast?: boolean; mention?: boolean } = {},
): Promise<MentionPayload> {
  const asked = await postAs(
    api,
    conversationId,
    opts.mention ? `@${BOT} open ${hosts.join(", ")}` : `Open ${hosts.join(", ")}`,
    opts.mention ? { mentions: [{ kind: "agent", id: botId }] } : {},
  );
  const m = await mentionOf(asked.id);
  await cell.browser(m, "ocw_browser_close", {});
  for (const [i, host] of hosts.entries()) {
    if (i > 0) await cell.browser(m, "ocw_browser_close", {});
    expect(await cell.browser(m, "ocw_browser_open", { url: `https://${host}/app?secret=1` })).toMatch(
      new RegExp(`^opened ${host.replace(/\./gu, "\\.")}`, "u"),
    );
  }
  if (opts.closeLast) await cell.browser(m, "ocw_browser_close", {});
  await cell.reply(m, `Opened ${hosts.length} page(s).`);
  return m;
}

async function openTab(page: Page, botId: string) {
  await page.goto(`${BASE_URL}/bots/${botId}?tab=browser`);
  await expect(page.getByTestId("agent-tab-browser")).toHaveAttribute("aria-selected", "true", {
    timeout: 15_000,
  });
  const tab = page.getByTestId("browser-tab");
  await expect(tab).toBeVisible();
  await expect(tab.getByTestId("browser-tab-loading")).toHaveCount(0, { timeout: 15_000 });
  return tab;
}

/** axe (light and dark), named controls, no sideways scroll; 44 px targets below 1024. */
async function invariants(page: Page, label: string, selector: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    expect.soft(await unnamedControls(page), `${label} (${theme}): unnamed controls`).toEqual([]);
    await expectNoSidewaysScroll(page, `${label} (${theme})`);
    await expectNoSeriousA11y(page, selector);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await expectTouchTargets(page, selector);
}

test("Sam sees Scout's open pages and recent activity, opens the live view, and a private row has no button", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const mobile = project === "mobile";
  const botId = await browserBot(BOT);
  const ops = await freshChannel(admin, [samApi, alexApi], "ops");
  const added = await admin.post(`/api/v1/channels/${ops.id}/members`, {
    data: { kind: "agent", id: botId },
  });
  expect(added.ok(), `add ${BOT} to #${ops.name}`).toBe(true);
  const samDm = await dmWith(samApi, botId);

  // 21 older pages in #ops (Show more), then Sam's sign-in in his DM, then the two pages still open in #ops.
  const older = Array.from({ length: 21 }, (_, i) => `site-${i + 1}.fake.test`);
  await botOpens(samApi, ops.id, botId, older.slice(0, 11), { closeLast: true, mention: true });
  await botOpens(samApi, ops.id, botId, older.slice(11), { closeLast: true, mention: true });
  const page = await signIn(browser, SAM, project);
  await clearSessions(samApi);
  await signInThroughBot({ cell, mentionOf, member: samApi, page, botId, dmId: samDm }, INVOICES, {
    tag: `tab ${widthOf(project)}`,
  });
  await botOpens(samApi, ops.id, botId, [PANEL], { mention: true });
  const panelId = await openContextOf(samApi, botId, PANEL, `/chat/${ops.id}`);
  await botOpens(alexApi, ops.id, botId, [STATUS], { mention: true });
  const statusId = await openContextOf(alexApi, botId, STATUS, `/chat/${ops.id}`);
  // Alex takes control of his page to sign in: for Sam it is private, with no button and no frames.
  const alexPage = await signIn(browser, ALEX, "desktop");
  await take(alexPage, statusId);

  const tab = await openTab(page, botId);
  // Tabs: Memory · Capabilities · (Sandbox, absent: Sam does not configure Scout) · Browser, last.
  await expect(page.getByRole("tablist").getByRole("tab")).toHaveText(["Memory", "Capabilities", "Browser"]);
  await expect(tab.getByRole("heading", { name: "Open now" })).toBeVisible();
  await expect(tab).toContainText(`Pages ${BOT} has open that you can watch.`);

  const live = tab.getByTestId(`browser-open-row-${panelId}`);
  await expect(live).toHaveAttribute("data-state", "live");
  await expect(live.getByTestId("browser-open-host-host")).toHaveText(PANEL);
  await expect(live.getByTestId("browser-open-state")).toHaveText("Live");
  await expect(live.getByTestId("browser-open-meta")).toHaveText(
    new RegExp(`^# ${ops.name} · open since \\d{2}:\\d{2}$`, "u"),
  );
  const privateRow = tab.getByTestId(`browser-open-row-${statusId}`);
  await expect(privateRow).toHaveAttribute("data-state", "private");
  await expect(privateRow.getByTestId("browser-open-state")).toHaveText("Private sign-in in progress");
  await expect(privateRow.getByTestId("browser-open-live")).toHaveCount(0);

  // Recent activity: hosts and conversations only, newest first; the page's path and query never appear.
  await expect(tab.getByRole("heading", { name: "Recent activity" })).toBeVisible();
  const rows = tab.getByTestId("browser-activity-row");
  await expect(rows).toHaveCount(20);
  await expect(rows.first()).toContainText(`Opened ${STATUS} · # ${ops.name}`);
  await expect(rows.nth(1)).toContainText(`Opened ${PANEL} · # ${ops.name}`);
  await expect(
    tab.getByTestId("browser-activity").getByText(`You signed in to ${INVOICES} · DM with you`),
  ).toBeVisible();
  await expect(rows.first().locator("time")).toHaveText(/^\d{2}:\d{2}$/u);
  expect(await tab.textContent()).not.toContain("secret=1");
  expect(await tab.textContent()).not.toContain("/app");
  await expect(tab.getByTestId("browser-isolation")).toContainText(
    "Runs in its own container, separate from the sandbox.",
  );

  if (mobile) {
    // At 390 the row stacks and its button takes the full width.
    const button = live.getByTestId("browser-open-live");
    const [b, r] = await Promise.all([button.boundingBox(), live.boundingBox()]);
    expect(b && r && b.width > r.width - 48).toBe(true);
  }
  await invariants(page, `browser tab ${widthOf(project)}`, '[data-testid="browser-tab"]');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await captureReview(page, `bot-browser-${widthOf(project)}`);

  // Show more loads the older events: 21 older pages, the sign-in's page and its sign-in, the two open pages = 25.
  await tab.getByTestId("browser-activity-more").click();
  await expect(rows).toHaveCount(25);
  await expect(tab.getByTestId("browser-activity-more")).toHaveCount(0);
  await expect(rows.last()).toContainText(`Opened ${older[0]} · # ${ops.name}`);

  // Open live view: the live view on that page (the small window on desktop; on phones the dock once 07.8-26 lands).
  await live.getByTestId("browser-open-live").click();
  const view = page.getByTestId("live-view");
  await expect(view).toBeVisible();
  await expect(view).toHaveAttribute("data-context", panelId);
});

test("empty states: the whole tab before any page, then 'Nothing open right now.'; Browser off removes the tab", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const botId = await browserBot(QUIET);
  const page = await signIn(browser, SAM, project);
  let tab = await openTab(page, botId);
  await expect(tab.getByRole("heading", { name: "No browser activity yet" })).toBeVisible();
  await expect(tab).toContainText(`When ${QUIET} opens a page, it shows up here and you can watch it live.`);

  const dm = await dmWith(samApi, botId);
  await botOpens(samApi, dm, botId, [PANEL], { closeLast: true });
  tab = await openTab(page, botId);
  await expect(tab.getByTestId("browser-open-empty")).toHaveText("Nothing open right now.");
  await expect(tab.getByTestId("browser-activity-row")).toHaveCount(1);
  await expect(tab.getByTestId("browser-activity-row").first()).toContainText(
    `Opened ${PANEL} · DM with you`,
  );
  await expect(tab.getByTestId("browser-activity-more")).toHaveCount(0);
  await invariants(page, `browser tab empty ${widthOf(project)}`, '[data-testid="browser-tab"]');

  if (project === "mobile") return;
  const rules: string[] = [];
  try {
    for (const permission of MODULE_CATALOG.browser.patterns) {
      const res = await admin.post("/api/v1/permission-rules", {
        data: { scopeUnitId: null, subjectKind: "user", subjectId: samId, permission, effect: "deny" },
      });
      expect(res.ok(), `deny ${permission} for Sam: ${res.status()}`).toBe(true);
      rules.push(((await res.json()) as { id: string }).id);
    }
    await page.goto(`${BASE_URL}/bots/${botId}?tab=browser`);
    await expect(page.getByRole("tablist").getByRole("tab", { name: "Memory" })).toHaveAttribute(
      "aria-selected",
      "true",
      { timeout: 15_000 },
    );
    await expect(page.getByTestId("agent-tab-browser")).toHaveCount(0);
    await expect(page.getByTestId("browser-tab")).toHaveCount(0);
  } finally {
    for (const ruleId of rules) await admin.delete(`/api/v1/permission-rules/${ruleId}`);
  }
});
