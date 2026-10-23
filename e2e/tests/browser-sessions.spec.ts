import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { MODULE_CATALOG } from "../../packages/contracts/src/module-access.ts";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { freshTeamBot } from "../support/bot-tools";
import { clearSessions, type SignInTurn, sessionsOf, signInThroughBot } from "../support/browser-signin";
import { cellToken } from "../support/cell-token";
import { postAs } from "../support/chat";
import { FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { enableBotSandbox, enableSandboxOrg, resume } from "../support/sandbox";
import { asSuperuser } from "../support/superuser";
import { ADMIN, API_URL } from "./env";

/**
 * Settings › Keychain › Browser sessions (07.8-27; BRW-04, D-08, R7, U-3, U-13, UI-SPEC § 4.5, C-03), against the real
 * API, the fake cell (driven by hand) and the fake sandboxd. Sam signs in to a site through Scout's browser (07.8-21's
 * real path: the sign-in request, his takeover, the hand back that seals it); the Keychain lists it with the site, the
 * bot and the dates, never a username or a cookie. Revoke asks first, says it does not sign him out at the site, and the
 * row goes once the server answered; Scout's next page on that host is not signed in. An expiring sign-in is amber, an
 * expired one offers Remove; an admin of the same organization sees none of Sam's; with Browser off for Sam the section
 * stays while he has sign-ins and goes once he has none. axe in light and dark, 44 px targets, and the screenshots.
 */

test.describe.configure({ mode: "serial" });

const BOT = "Scout";
const PANEL = "panel.fake.test";
const INVOICES = "invoices.fake.test";
const SHOP = "shop.fake.test";
const DAY_S = 86_400;

let admin: APIRequestContext;
let samApi: APIRequestContext;
let samId: string;
let botId: string;
let dmId: string;
let cell: FakeCellPlugin;
const open: BrowserContext[] = [];

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  samId = await ensureMember(admin, SAM, "developer");
  samApi = await apiAs(SAM);
  await enableSandboxOrg(admin);
  await resume(admin);
  cell = new FakeCellPlugin({ apiUrl: API_URL, token: cellToken(), autoAck: true, autoReply: false });
  await cell.start();
});

/**
 * A new Scout and Sam's DM with it, for each test: once a bot loaded a member's session in a conversation, every later
 * turn there keeps member data and asks before another site (07.8-28, WINDOWS #292), so each test starts in a DM
 * where no session was ever loaded. The previous Scout's deletion takes its sealed sessions with it (#287).
 */
async function freshScout(): Promise<void> {
  botId = await freshTeamBot(admin, BOT);
  await enableBotSandbox(admin, botId, { sandbox: true, browser: true });
  const dm = await samApi.post(`/api/v1/agents/${botId}/dm`);
  expect(dm.ok(), `Sam's DM with ${BOT}`).toBe(true);
  dmId = ((await dm.json()) as { dmId: string }).dmId;
}

test.afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

test.afterAll(async () => {
  for (const c of open.splice(0)) await c.close();
  await cell?.stop();
  await samApi?.dispose();
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

const turnFor = (page: Page): SignInTurn => ({ cell, mentionOf, member: samApi, page, botId, dmId });

async function openKeychain(page: Page) {
  await page.goto(`${BASE_URL}/settings/keychain`);
  const section = page.getByTestId("browser-sessions");
  await expect(section).toBeVisible({ timeout: 15_000 });
  await expect(section.getByTestId("browser-sessions-loading")).toHaveCount(0);
  return section;
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

/** Scout's next page on `host` in Sam's DM: "(signed in)" when his saved sign-in was loaded. */
async function scoutOpens(host: string, tag: string): Promise<string> {
  const asked = await postAs(samApi, dmId, `Check ${host} again ${tag}`);
  const m = await mentionOf(asked.id);
  await cell.browser(m, "ocw_browser_close", {});
  const opened = await cell.browser(m, "ocw_browser_open", { url: `https://${host}/` });
  await cell.browser(m, "ocw_browser_close", {});
  await cell.reply(m, `Checked ${host} (${tag}).`);
  return opened;
}

test("tracer: Sam revokes a saved sign-in from Settings › Keychain; Scout's next page there is not signed in", async ({
  browser,
}, info) => {
  const project = info.project.name;
  await freshScout();
  await clearSessions(samApi);
  const page = await signIn(browser, SAM, project);
  const sealed = await signInThroughBot(turnFor(page), PANEL, { tag: `tracer ${widthOf(project)}` });
  expect(await scoutOpens(PANEL, `before ${widthOf(project)}`)).toBe(`opened ${PANEL} (signed in)`);

  const section = await openKeychain(page);
  await expect(section.getByRole("heading", { name: "Browser sessions" })).toBeVisible();
  const row = section.getByTestId(`browser-session-row-${sealed.id}`);
  await expect(row).toContainText(PANEL);
  await expect(row.getByTestId("browser-session-bot")).toHaveText(`with ${BOT}`);
  await expect(row.getByTestId("browser-session-meta")).toHaveText(
    /^Signed in today · last used .+ · expires [A-Z][a-z]{2} \d{1,2}(, \d{4})?$/u,
  );
  // Nothing sealed reaches the page: no cookie name or value, no username.
  const html = await page.content();
  expect(html).not.toContain("fake_session");
  expect(html).not.toContain("fake-signed-in");

  await row.getByTestId("browser-session-revoke").click();
  const dialog = page.getByTestId("browser-session-revoke-dialog");
  await expect(dialog.getByRole("heading")).toHaveText(`Revoke your ${PANEL} sign-in?`);
  await expect(dialog).toContainText(
    `${BOT} can't use it any more. This doesn't sign you out at ${PANEL}: to end the session there, sign out on the site or change your password.`,
  );
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await invariants(
    page,
    `revoke dialog ${widthOf(project)}`,
    '[data-testid="browser-session-revoke-dialog"]',
  );
  await captureReview(page, `keychain-revoke-dialog-${widthOf(project)}`);

  // The row stays until the server has answered (no optimistic removal), then goes with a toast.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => {
    release = r;
  });
  await page.route(`**/api/v1/browser-sessions/${sealed.id}`, async (route) => {
    await held;
    await route.continue();
  });
  await dialog.getByTestId("browser-session-revoke-confirm").click();
  await expect(dialog.getByTestId("browser-session-revoke-confirm")).toBeDisabled();
  await expect(row).toBeVisible();
  release();
  await expect(page.getByText(`${PANEL} sign-in revoked`)).toBeVisible();
  await expect(row).toHaveCount(0);
  await expect(dialog).toHaveCount(0);
  await page.unroute(`**/api/v1/browser-sessions/${sealed.id}`);
  expect((await sessionsOf(samApi)).some((s) => s.id === sealed.id)).toBe(false);

  // Scout's next page on that host carries no sign-in.
  expect(await scoutOpens(PANEL, `after ${widthOf(project)}`)).toBe(`opened ${PANEL}`);
});

test("expiring in amber, expired with Remove, nobody else's rows (an admin included), the empty box and Browser off", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const mobile = project === "mobile";
  await freshScout();
  await clearSessions(samApi);
  const page = await signIn(browser, SAM, project);
  const t = turnFor(page);
  const now = Math.floor(Date.now() / 1000);
  const panel = await signInThroughBot(t, PANEL, { tag: `states ${widthOf(project)}` });
  const invoices = await signInThroughBot(t, INVOICES, {
    expiresAt: now + 2 * DAY_S,
    tag: `states ${widthOf(project)}`,
  });
  const shop = await signInThroughBot(t, SHOP, { tag: `states ${widthOf(project)}` });
  // Expired yesterday (time passing is the only way there; the 7-day purge would remove it a week later).
  await asSuperuser(
    "update app.browser_sessions set expires_at = now() - interval '1 day' where id = $1 and user_id = $2",
    [shop.id, samId],
  );

  const section = await openKeychain(page);
  const rows = section.getByTestId(/^browser-session-row-/u);
  await expect(rows).toHaveCount(3);
  await expect(section.getByTestId(`browser-session-row-${panel.id}`)).toHaveAttribute(
    "data-status",
    "active",
  );
  const expiring = section
    .getByTestId(`browser-session-row-${invoices.id}`)
    .getByTestId("browser-session-expiry");
  await expect(expiring).toHaveText("expires in 2 days");
  await expect(expiring).toHaveAttribute("data-soon", "true");
  await expect(expiring.locator("svg")).toHaveCount(1);
  const expiredRow = section.getByTestId(`browser-session-row-${shop.id}`);
  await expect(expiredRow).toHaveAttribute("data-status", "expired");
  await expect(expiredRow).toContainText("Expired");
  await expect(expiredRow.getByTestId("browser-session-meta")).toHaveText("Sign in again when a bot asks.");
  await expect(expiredRow.getByTestId("browser-session-revoke")).toHaveCount(0);
  await expect(section).toContainText(
    "Saved sign-ins are encrypted on the server and used only for your turns. Revoking one doesn't sign you out at the site.",
  );
  await invariants(page, `browser sessions ${widthOf(project)}`, '[data-testid="browser-sessions"]');
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.getElementById("browser-sessions")?.scrollIntoView({ block: "start" });
  });
  await captureReview(page, `keychain-browser-sessions-${widthOf(project)}`);

  // An admin of the same organization: none of Sam's rows, in the page or the API; his DELETE is a 404.
  const adminPage = await signIn(browser, ADMIN, project);
  const adminSection = await openKeychain(adminPage);
  for (const s of [panel, invoices, shop]) {
    await expect(adminSection.getByTestId(`browser-session-row-${s.id}`)).toHaveCount(0);
  }
  const adminIds = new Set((await sessionsOf(admin)).map((s) => s.id));
  expect([panel, invoices, shop].some((s) => adminIds.has(s.id))).toBe(false);
  expect((await admin.delete(`/api/v1/browser-sessions/${panel.id}`)).status()).toBe(404);

  // Remove the expired one (no question: it is no longer usable), then revoke the others: the empty box.
  await expiredRow.getByTestId("browser-session-remove").click();
  await expect(page.getByText(`${SHOP} sign-in removed`)).toBeVisible();
  await expect(expiredRow).toHaveCount(0);
  if (mobile) return;

  // Browser off for Sam: the section stays while he has sign-ins (he can still revoke them), and goes once he has none.
  const rules: string[] = [];
  try {
    for (const permission of MODULE_CATALOG.browser.patterns) {
      const res = await admin.post("/api/v1/permission-rules", {
        data: { scopeUnitId: null, subjectKind: "user", subjectId: samId, permission, effect: "deny" },
      });
      expect(res.ok(), `deny ${permission} for Sam: ${res.status()}`).toBe(true);
      rules.push(((await res.json()) as { id: string }).id);
    }
    await page.reload();
    await expect(page.getByTestId("browser-sessions")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(/^browser-session-row-/u)).toHaveCount(2);
    await clearSessions(samApi);
    await page.reload();
    await expect(page.getByTestId("keychain-personal").or(page.getByTestId("keychain-empty"))).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("browser-sessions")).toHaveCount(0);
  } finally {
    for (const ruleId of rules) await admin.delete(`/api/v1/permission-rules/${ruleId}`);
  }
  await page.reload();
  const empty = (await openKeychain(page)).getByTestId("browser-sessions-empty");
  await expect(empty).toHaveText(
    "No saved sign-ins. When a bot asks you to sign in to a site, the sign-in is kept here so you can revoke it.",
  );
});
