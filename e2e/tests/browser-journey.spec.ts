import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { freshTeamBot } from "../support/bot-tools";
import { cellToken } from "../support/cell-token";
import { postAs } from "../support/chat";
import { FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import { captureReview } from "../support/layout";
import { contextOf } from "../support/live-view";
import {
  connectFakeSites,
  enableBotSandbox,
  enableSandboxOrg,
  fakeSiteStats,
  resume,
  useFakeSites,
} from "../support/sandbox";
import { ADMIN, API_URL } from "./env";

/**
 * 07.8-28 Task 2 (BRW-02, BRW-03, BRW-04; D-05, D-06, D-07, D-08; UI-SPEC journey-signin-*): the owner's original
 * problem solved end to end in the web UI, against the REAL sandboxd and a real Chromium (`brw`) on the fake sites
 * `scripts/e2e-isolated.sh --sandbox` starts. The bot (the fake cell, driven by hand through the real Agent Channel
 * routes) opens the panel's sign-in page and cannot read past it; it asks Sam to sign in; Sam presses Open and sign in,
 * types his username, password, one-time code and, after the show-password toggle, more into the real page through the
 * live view's frames; hands back; the card reads Signed in and the bot reads the dashboard. Frames are real JPEGs from
 * Chromium's screencast. Desktop (mouse and keyboard on the large view) and mobile (taps and the keyboard input on the
 * full sheet), light and dark screenshots of each step.
 *
 * Runs only with the real broker: `OCW_E2E_SANDBOX=real bash scripts/e2e-isolated.sh --sandbox --rebuild-web
 * browser-journey`; skipped with that reason otherwise.
 */

test.describe.configure({ mode: "serial" });
test.skip(
  process.env.OCW_E2E_SANDBOX !== "real",
  "needs the real sandboxd and brw: scripts/e2e-isolated.sh --sandbox (OCW_E2E_SANDBOX=real)",
);

const BOT = "Scout";
const SITE = "panel.fake.test:8080";
const REASON = "I need the orders dashboard, which needs your account.";
const E1 = {
  username: "ana@example.test",
  password: "S3cr3t-Hunter2-OCW",
  otp: "735190",
  revealed: "Visible-Secret-99",
};
/** Centers of the fake sign-in page's fixed boxes, in page CSS pixels (infra/sandbox/test/fake-site.mjs LOGIN_LAYOUT). */
const AT = {
  email: { x: 200, y: 138 },
  password: { x: 170, y: 198 },
  toggle: { x: 370, y: 198 },
  otp: { x: 120, y: 258 },
  submit: { x: 100, y: 320 },
};
const REAL = 120_000;

let admin: APIRequestContext;
let samApi: APIRequestContext;
let botId: string;
let dmId: string;
let cell: FakeCellPlugin;
const open: BrowserContext[] = [];
const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  samApi = await apiAs(SAM);
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
  await admin?.dispose();
});

async function mentionOf(messageId: string): Promise<MentionPayload> {
  const ev = await cell.waitFor(
    (e) => e.type === "agent.mention.v1" && (e.data as unknown as MentionPayload).message?.id === messageId,
    30_000,
  );
  return ev.data as unknown as MentionPayload;
}

/** The point on screen where the live frame draws page CSS pixel (x, y): the image's box over its natural size. */
async function onFrame(frame: Locator, p: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const img = frame.locator("img").first();
  await expect
    .poll(async () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  return img.evaluate(
    (el, at) => {
      const i = el as HTMLImageElement;
      const r = i.getBoundingClientRect();
      return {
        x: r.left + (at.x * r.width) / i.naturalWidth,
        y: r.top + (at.y * r.height) / i.naturalHeight,
      };
    },
    { x: p.x, y: p.y },
  );
}

/** A tap (phone) or a click (desktop) on the page at page CSS pixel `p`. */
async function press(page: Page, frame: Locator, mobile: boolean, p: { x: number; y: number }) {
  const at = await onFrame(frame, p);
  if (mobile) await page.touchscreen.tap(at.x, at.y);
  else await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(250);
}

/** Types into the page: the frame has the keyboard on desktop; on a phone the keyboard input does. */
async function typeText(page: Page, surface: Locator, mobile: boolean, text: string) {
  if (mobile) {
    await surface.getByTestId("live-keyboard").click();
    await page.keyboard.type(text, { delay: 20 });
    // The keyboard goes away, so the next tap lands on the page.
    await page.keyboard.press("Tab");
  } else {
    await page.keyboard.type(text, { delay: 20 });
  }
  await page.waitForTimeout(250);
}

test("the bot can't read the page → it asks → Open and sign in → Sam types on the real page → Hand back → Signed in → the bot answers", async ({
  browser,
}, info) => {
  test.setTimeout(4 * REAL);
  const project = info.project.name;
  const mobile = project === "mobile";
  const w = widthOf(project);

  // A fresh Scout and Sam's DM with it (a DM where a session was loaded keeps member data, #292).
  botId = await freshTeamBot(admin, BOT);
  await enableBotSandbox(admin, botId, { sandbox: true, browser: true });
  const dm = await samApi.post(`/api/v1/agents/${botId}/dm`);
  expect(dm.ok(), `Sam's DM with ${BOT}`).toBe(true);
  dmId = ((await dm.json()) as { dmId: string }).dmId;
  await useFakeSites(admin).catch(() => undefined);

  const s = await openAs(browser, SAM, project);
  open.push(s.context);
  const page = s.page;
  await page.goto(`${BASE_URL}/chat/dm/${dmId}`);
  await expect(page.getByTestId("composer")).toBeVisible();

  // 1. Sam asks; the bot's browser opens the panel and reads only a sign-in form.
  const asked = await postAs(samApi, dmId, `Check my orders on the panel ${w}`);
  const m = await mentionOf(asked.id);
  // A first sandbox call starts the namespace's egress proxy, which then joins the fake sites' network.
  await cell.sandbox(m, "ocw_sandbox_exec", { argv: ["true"] });
  connectFakeSites();
  await cell.browser(m, "ocw_browser_close", {});
  // A fresh brw's first open answers at once (07.8 hardening: sandboxd's attach no longer sends a body the Engine could
  // pass on to the agent's stdin, which once left the first request unanswered). No retry: a regression fails here.
  const first = await cell.browser(m, "ocw_browser_open", { url: `http://${SITE}/login` });
  expect(first).toBe(`opened ${SITE}`);
  const read = await cell.browser(m, "ocw_browser_snapshot", {});
  expect(read).toContain("Sign in to Panel");
  expect(read).toContain("Password");
  expect(read).not.toContain(E1.password);
  expect(await cell.browser(m, "ocw_browser_signin", { reason: REASON })).toBe(
    `sign-in requested for ${SITE}`,
  );
  await cell.reply(
    m,
    `I can't read the panel without your account. Please sign in to ${SITE} in the card (${w}).`,
  );

  const card = page
    .getByTestId("agent-card")
    .filter({ has: page.getByTestId("agent-card-title").getByText(`Sign in to ${SITE}`, { exact: true }) })
    .last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByTestId("signin-why")).toHaveText(`“${REASON}”`);
  await card.evaluate((el) => {
    (document.activeElement as HTMLElement | null)?.blur();
    el.scrollIntoView({ block: "end" });
  });
  await captureReview(page, `journey-signin-1-card-${w}`);

  // 2. Open and sign in: the live view takes control in one step; the frame is the real page.
  await card.getByTestId("signin-open").click();
  const surface = page.getByTestId(mobile ? "live-full" : "live-expanded");
  await expect(surface).toBeVisible();
  const live = surface.getByTestId("live-view");
  await expect(live).toHaveAttribute("data-state", "controlling", { timeout: 20_000 });
  const contextId = await contextOf(live);
  expect(contextId).toBeTruthy();
  const frame = surface.getByTestId("live-frame");
  await expect(frame.locator("img").first()).toBeVisible({ timeout: 20_000 });
  await captureReview(page, `journey-signin-2-takeover-${w}`);

  // 3. Sam types in the real page: username, password, the show-password toggle and more, the one-time code; submit.
  const loginsBefore = fakeSiteStats().logins ?? 0;
  await press(page, frame, mobile, AT.email);
  await typeText(page, surface, mobile, E1.username);
  await press(page, frame, mobile, AT.password);
  await typeText(page, surface, mobile, E1.password);
  await press(page, frame, mobile, AT.toggle);
  await press(page, frame, mobile, AT.password);
  await typeText(page, surface, mobile, E1.revealed);
  await press(page, frame, mobile, AT.otp);
  await typeText(page, surface, mobile, E1.otp);
  await captureReview(page, `journey-signin-3-typing-${w}`);
  await press(page, frame, mobile, AT.submit);
  await expect.poll(() => fakeSiteStats().logins ?? 0, { timeout: 20_000 }).toBeGreaterThan(loginsBefore);

  // 4. Hand back: the API seals Sam's session; the card reads Signed in.
  await page.getByTestId("live-hand-back").click();
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: `Signed in to ${SITE}. ${BOT} continues.` }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("live-close").click();
  await expect(page.getByTestId("live-view")).toHaveCount(0);
  await expect(card.getByTestId("agent-card-status")).toHaveText("Signed in", { timeout: 20_000 });

  // 5. The bot continues signed in and answers from the dashboard.
  const next = await postAs(samApi, dmId, `What does the panel say now? ${w}`);
  const n = await mentionOf(next.id);
  const dashboard = await cell.browser(n, "ocw_browser_snapshot", {});
  expect(dashboard).toContain("(signed in)");
  expect(dashboard).toContain("Welcome");
  for (const v of Object.values(E1)) expect(dashboard).not.toContain(v);
  const answer = `Signed in: the panel says Welcome, your dashboard is ready (${w}).`;
  await cell.reply(n, answer);
  await expect(page.getByText(answer)).toBeVisible({ timeout: 20_000 });
  await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
  // The pointer of the last tap (the live view's close, top right) rests over the toast on a phone, which keeps it
  // open: the pointer moves to the composer's edge so the toast can go before the capture.
  if (mobile) {
    const vp = page.viewportSize();
    await page.mouse.move(4, (vp?.height ?? 800) - 4);
  }
  await captureReview(page, `journey-signin-4-signed-in-${w}`);
  // Nothing Sam typed is on the page Sam reads (the chat), only on the site.
  const html = await page.content();
  for (const v of Object.values(E1)) expect(html).not.toContain(v);
  await cell.browser(n, "ocw_browser_close", {});
});
