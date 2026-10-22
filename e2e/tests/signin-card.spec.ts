import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { freshTeamBot } from "../support/bot-tools";
import { cellToken } from "../support/cell-token";
import { postAs } from "../support/chat";
import { FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { contextOf, fakePage } from "../support/live-view";
import { enableBotSandbox, enableSandboxOrg, fakeSandboxd, resume } from "../support/sandbox";
import { ADMIN, API_URL } from "./env";

/**
 * 07.8-26 (BRW-03, BRW-04; D-07, D-08, R1; UI-SPEC Surface 2; C-03): the platform's "Sign in needed" card against the
 * real API, the fake cell (driven by hand) and the fake sandboxd. Scout asks Sam to sign in to a site in Sam's DM; the
 * card shows the site from the page, the reason quoted, the assurance and the countdown. Open and sign in takes control
 * in one step (the large view on desktop, the full sheet on phones); the test makes the fake page signed in; Hand back
 * seals the session, the card reads Signed in with the Keychain link and the toast says so. Not now, an expired card,
 * a refused open, and the view of someone who is not the requester (a rewritten list, as a shared view would show it).
 * axe, named controls, 44 px targets and the reviewed screenshots (`signin-card-*`).
 */

test.describe.configure({ mode: "serial" });

const BOT = "Scout";
const REASON = "I need the orders dashboard, which needs your account.";

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
  botId = await freshTeamBot(admin, BOT);
  await enableBotSandbox(admin, botId, { sandbox: true, browser: true });
  cell = new FakeCellPlugin({ apiUrl: API_URL, token: cellToken(), autoAck: true, autoReply: false });
  await cell.start();
  const dm = await samApi.post(`/api/v1/agents/${botId}/dm`);
  expect(dm.ok(), `Sam's DM with ${BOT}`).toBe(true);
  dmId = ((await dm.json()) as { dmId: string }).dmId;
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

async function signInAs(browser: Parameters<typeof openAs>[0], project: string): Promise<Page> {
  const s = await openAs(browser, SAM, project);
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

/** Sam asks; Scout opens `host` in a fresh page and asks him to sign in there; returns the card. */
async function scoutAsks(page: Page, host: string, ask: string): Promise<Locator> {
  const asked = await postAs(samApi, dmId, ask);
  const m = await mentionOf(asked.id);
  await cell.browser(m, "ocw_browser_close", {});
  expect(await cell.browser(m, "ocw_browser_open", { url: `https://${host}/orders?id=7` })).toBe(
    `opened ${host}`,
  );
  expect(await cell.browser(m, "ocw_browser_signin", { reason: REASON })).toBe(
    `sign-in requested for ${host}`,
  );
  await cell.reply(m, `Please sign in to ${host} in the card (${ask}).`);
  const card = page
    .getByTestId("agent-card")
    .filter({ has: page.getByTestId("agent-card-title").getByText(`Sign in to ${host}`, { exact: true }) })
    .last();
  await expect(card).toBeVisible({ timeout: 20_000 });
  return card;
}

/** axe (light and dark), named controls, no sideways scroll, 44 px targets below 1024. */
async function invariants(page: Page, label: string, root: Locator, selector: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    expect.soft(await unnamedControls(page), `${label} (${theme}): unnamed controls`).toEqual([]);
    await expectNoSidewaysScroll(page, `${label} (${theme})`);
    await expectNoSeriousA11y(page, selector);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await expectTouchTargets(page, root);
}

async function cardSelector(card: Locator): Promise<string> {
  const id = await card.evaluate((el) => el.closest("[data-message-id]")?.getAttribute("data-message-id"));
  expect(id, "the card's message").toBeTruthy();
  return `[data-message-id="${id}"] [data-testid="agent-card"]`;
}

test("Sam signs in from the card: Open and sign in → in control → signed in on the page → Hand back → Signed in", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const host = project === "mobile" ? "panel-m.fake.test" : "panel.fake.test";
  const page = await signInAs(browser, project);
  await page.goto(`${BASE_URL}/chat/dm/${dmId}`);
  await expect(page.getByTestId("composer")).toBeVisible();
  const card = await scoutAsks(page, host, `Check my orders ${widthOf(project)}`);

  // The waiting card: platform-made, the page's host, the reason quoted, the assurance and the countdown.
  await expect(card.getByTestId("agent-card-kind")).toHaveText("Sign-in");
  await expect(card.getByTestId("agent-card-workspace")).toContainText("Created by the workspace");
  await expect(card.getByTestId("agent-card-status")).toHaveText("Sign-in needed");
  await expect(card.getByTestId("signin-host-host")).toHaveText(host);
  await expect(card.getByTestId("signin-why")).toHaveText(`“${REASON}”`);
  await expect(card.getByTestId("signin-assurance")).toHaveText(
    `You type in the page yourself. ${BOT} never sees what you type, and password fields are hidden from it.`,
  );
  await expect(card.getByTestId("signin-timer")).toHaveText(/^Expires in 1[45] min$/);
  await expect(card).not.toContainText("orders?id=7");
  await expect(card.getByTestId("signin-only")).toHaveCount(0);

  await invariants(page, `sign-in card ${widthOf(project)}`, card, await cardSelector(card));
  await card.evaluate((el) => {
    (document.activeElement as HTMLElement | null)?.blur();
    el.scrollIntoView({ block: "end" });
  });
  await captureReview(page, `signin-card-${widthOf(project)}`);

  // Open and sign in: the live view opens and takes control in one step.
  await card.getByTestId("signin-open").click();
  const surface = page.getByTestId(project === "mobile" ? "live-full" : "live-expanded");
  await expect(surface).toBeVisible();
  const live = surface.getByTestId("live-view");
  await expect(live).toHaveAttribute("data-state", "controlling", { timeout: 15_000 });
  await expect(page.getByTestId("takeover-bar")).toContainText(`You're in control. ${BOT} is paused.`);
  const contextId = await contextOf(live);
  await expect.poll(async () => (await fakePage(contextId))?.takeover).toBe(true);
  // Every reader's card now says someone is signing in (realtime); Sam reads it as himself.
  await expect(card.getByTestId("agent-card-status")).toHaveText("Signing in…");

  // Sam signs in on the page (the fake's page is now signed in), then hands back.
  await fakeSandboxd().signedIn(contextId);
  await page.getByTestId("live-hand-back").click();
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: `Signed in to ${host}. ${BOT} continues.` }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(live).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  await expect.poll(async () => (await fakePage(contextId))?.takeover).toBe(false);
  // The viewport follows the view again (R10): 960×600 once nobody controls it from a phone.
  if (project === "mobile") {
    await expect.poll(async () => (await fakePage(contextId))?.viewport).toEqual({ width: 960, height: 600 });
  }

  await page.getByTestId("live-close").click();
  await expect(page.getByTestId("live-view")).toHaveCount(0);
  await expect(card.getByTestId("agent-card-status")).toHaveText("Signed in");
  await expect(card.getByTestId("signin-state-line")).toContainText(
    /^Signed in until [A-Z][a-z]{2} \d{1,2}\. Scout continues\./,
  );
  await expect(card.getByTestId("signin-keychain")).toHaveAttribute(
    "href",
    "/settings/keychain#browser-sessions",
  );
  await expect(card.getByTestId("agent-card-decision")).toContainText("Signed in by Sam Lee");
});

test("Not now: the card reads Skipped and the bot is told", async ({ browser }, info) => {
  const project = info.project.name;
  const page = await signInAs(browser, project);
  await page.goto(`${BASE_URL}/chat/dm/${dmId}`);
  const card = await scoutAsks(page, `crm-${widthOf(project)}.fake.test`, `Read my CRM ${widthOf(project)}`);
  await card.getByTestId("signin-skip").click();
  await expect(card.getByTestId("agent-card-status")).toHaveText("Skipped");
  await expect(card.getByTestId("signin-state-line")).toHaveText(`Sam Lee didn't sign in. ${BOT} was told.`);
  await expect(card.getByTestId("signin-open")).toHaveCount(0);
  // The bot hears it as a card-action turn (21's sentence).
  await cell.waitFor((e) => e.type === "agent.card_action.v1", 20_000);
});

test("an expired card: 'No one signed in within 15 minutes.' and no action", async ({ browser }, info) => {
  const project = info.project.name;
  const page = await signInAs(browser, project);
  await page.clock.install();
  await page.goto(`${BASE_URL}/chat/dm/${dmId}`);
  const card = await scoutAsks(
    page,
    `billing-${widthOf(project)}.fake.test`,
    `Pay a bill ${widthOf(project)}`,
  );
  await expect(card.getByTestId("signin-open")).toBeVisible();
  await page.clock.fastForward("15:01");
  await expect(card.getByTestId("agent-card-status")).toHaveText("Expired");
  await expect(card.getByTestId("signin-state-line")).toHaveText(
    `No one signed in within 15 minutes. Ask ${BOT} again.`,
  );
  await expect(card.getByTestId("signin-open")).toHaveCount(0);
  await expect(card.getByTestId("signin-skip")).toHaveCount(0);
});

test("a refused open (someone else holds the page) toasts and leaves the card as it was", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const host = `shop-${widthOf(project)}.fake.test`;
  const first = await signInAs(browser, project);
  await first.goto(`${BASE_URL}/chat/dm/${dmId}`);
  const firstCard = await scoutAsks(first, host, `Order more ${widthOf(project)}`);
  await firstCard.getByTestId("signin-open").click();
  await expect(first.getByTestId("live-view")).toHaveAttribute("data-state", "controlling", {
    timeout: 15_000,
  });

  // Sam's second device: the card says he is signing in; Return to sign-in is refused (the other socket holds it).
  const second = await signInAs(browser, project);
  await second.goto(`${BASE_URL}/chat/dm/${dmId}`);
  const card = second
    .getByTestId("agent-card")
    .filter({ has: second.getByTestId("agent-card-title").getByText(`Sign in to ${host}`, { exact: true }) })
    .last();
  await expect(card.getByTestId("agent-card-status")).toHaveText("Signing in…", { timeout: 20_000 });
  await expect(card.getByTestId("signin-state-line")).toHaveText("You're signing in.");
  await card.getByTestId("signin-return").click();
  await expect(
    second.locator("[data-sonner-toast]").filter({ hasText: "Someone else is in control right now." }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(second.getByTestId("live-view")).toHaveCount(0);
  await expect(card.getByTestId("agent-card-status")).toHaveText("Signing in…");

  // The states page (desktop): Signing in (this card), Signed in and Skipped (earlier tests), and an Expired one.
  if (project === "desktop") {
    await second.close();
    const states = await signInAs(browser, project);
    await states.setViewportSize({ width: 1440, height: 1500 });
    // The billing card cannot expire on the server within a test (15 minutes; a later page of the DM stopped it):
    // shown as the server sends an expired sign-in.
    await states.route(/\/api\/v1\/conversations\/[^/]+\/messages\?/u, async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { messages?: Array<{ card?: Record<string, unknown> | null }> };
      for (const m of body.messages ?? []) {
        const c = m.card as { title?: string; browserSignIn?: Record<string, unknown> } | null;
        if (c?.browserSignIn && c.title?.startsWith("Sign in to billing-")) {
          c.browserSignIn = {
            ...c.browserSignIn,
            status: "expired",
            stopReason: null,
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
          };
        }
      }
      await route.fulfill({ response: res, json: body });
    });
    await states.goto(`${BASE_URL}/chat/dm/${dmId}`);
    const all = states.getByTestId("signin-card");
    await expect(all.first()).toBeVisible({ timeout: 20_000 });
    await expect(
      states.locator('[data-testid="signin-card"][data-status="signing_in"]').last(),
    ).toBeVisible();
    await expect(states.locator('[data-testid="signin-card"][data-status="signed_in"]').last()).toBeVisible();
    await expect(states.locator('[data-testid="signin-card"][data-status="skipped"]').last()).toBeVisible();
    await expect(states.locator('[data-testid="signin-card"][data-status="expired"]').last()).toBeVisible();
    // The oldest of the four (Signed in) at the top of the list, whole.
    await states
      .locator('[data-testid="signin-card"][data-status="signed_in"]')
      .last()
      .evaluate((el) => el.closest('[data-testid="message"]')?.scrollIntoView({ block: "start" }));
    await states.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await captureReview(states, "signin-card-states-1440");
  }
  // First device hands back (nothing signed in: the card waits again).
  await first.getByTestId("live-hand-back").click();
  await expect(first.getByTestId("live-view")).toHaveAttribute("data-state", /live|idle|paused/, {
    timeout: 15_000,
  });
});

test("someone who is not the requester reads 'Only Sam Lee can sign in here.' (a shared view of the DM)", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const page = await signInAs(browser, project);
  // A reader other than the requester: the list as such a reader gets it (no sign_in, another requester id).
  await page.route(/\/api\/v1\/conversations\/[^/]+\/messages\?/u, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { messages?: Array<{ card?: Record<string, unknown> | null }> };
    for (const m of body.messages ?? []) {
      const c = m.card as {
        kind?: string;
        viewerCan?: string[];
        browserSignIn?: Record<string, unknown>;
      } | null;
      if (c?.kind === "browser" && c.browserSignIn) {
        c.viewerCan = ["follow"];
        c.browserSignIn = { ...c.browserSignIn, requesterId: "0199f1c2-7a4b-7c3d-9e8f-0000000a11ce" };
      }
    }
    await route.fulfill({ response: res, json: body });
  });
  await page.goto(`${BASE_URL}/chat/dm/${dmId}`);
  const card = await scoutAsks(
    page,
    `docs-${widthOf(project)}.fake.test`,
    `Read the docs ${widthOf(project)}`,
  );
  // The live card arrived without viewer fields: read again so the rewritten list holds it.
  await page.reload();
  const shown = page
    .getByTestId("agent-card")
    .filter({
      has: page.getByTestId("agent-card-title").getByText(`Sign in to docs-${widthOf(project)}.fake.test`, {
        exact: true,
      }),
    })
    .last();
  await expect(shown.getByTestId("signin-only")).toHaveText("Only Sam Lee can sign in here.", {
    timeout: 20_000,
  });
  await expect(shown.getByTestId("signin-open")).toHaveCount(0);
  await expect(shown.getByTestId("signin-skip")).toHaveCount(0);
  void card;
  await invariants(page, `sign-in card (other) ${widthOf(project)}`, shown, await cardSelector(shown));
  if (project === "desktop") {
    await shown.evaluate((el) => {
      (document.activeElement as HTMLElement | null)?.blur();
      el.scrollIntoView({ block: "end" });
    });
    await captureReview(page, "signin-card-other-1440");
  }
});
