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
import { clearPendingApprovals } from "../support/approvals";
import { freshTeamBot } from "../support/bot-tools";
import { cellToken } from "../support/cell-token";
import { ALEX, freshChannel, postAs } from "../support/chat";
import { type CardActionPayload, FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { enableBotSandbox, enableSandboxOrg, organizationOf, resume } from "../support/sandbox";
import { asSuperuser } from "../support/superuser";
import { ADMIN, API_URL } from "./env";

/**
 * 07.8-20 (R8, UI-SPEC Surface 6, D-11, C-03): the 07.5 approval card for a bot's action on a page where the member's
 * saved session is loaded, end to end with the fake cell (driven by hand, no model) and the fake sandboxd. The member
 * session is seeded through the superuser helper (a `browser_sessions` row, its sealed secret and the context's
 * `session_id`; 07.8-21 builds the real sign-in path). Sam reads exactly what Scout will do on his signed-in site, approves
 * it in the card, Scout acts once and the card reads Used. In a channel every other reader gets the summary (no element,
 * no value); an expired request and a page that changed read the browser lines. Phone, dark, axe and the reviewed
 * screenshots (`approval-browser-card-*`).
 *
 * The fake site's sign-in form names its fields Email, Password and Sign in (infra/fake-model/fake-sandboxd.mjs), so the
 * typed field is “Email” (the UI-SPEC example says “Address”).
 */

test.describe.configure({ mode: "serial" });

const BOT = "Scout";
const SITE = "shop.fake.test";
const TYPED = "sam.lee@shop.example";

let admin: APIRequestContext;
let samApi: APIRequestContext;
let alexApi: APIRequestContext;
let orgId: string;
let samId: string;
let botId: string;
let dmId: string;
let sessionId: string | null = null;
let cell: FakeCellPlugin;
const open: BrowserContext[] = [];

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");
const toast = (page: Page, text: string) => page.locator("[data-sonner-toast]").filter({ hasText: text });

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  samId = await ensureMember(admin, SAM, "developer");
  await ensureMember(admin, ALEX, "developer");
  samApi = await apiAs(SAM);
  alexApi = await apiAs(ALEX);
  orgId = await organizationOf(admin);
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

test.beforeEach(async () => {
  await clearPendingApprovals(samApi, "tool.call");
});

test.afterAll(async () => {
  for (const c of open.splice(0)) await c.close();
  await cell?.stop();
  await samApi?.dispose();
  await alexApi?.dispose();
  await admin?.dispose();
});

async function signIn(browser: Parameters<typeof openAs>[0], who: typeof SAM, project: string) {
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

/** Sam's saved session for Scout on the site (sealed secret + row), once per run; 07.8-21 builds the real path. */
async function samSession(): Promise<string> {
  if (sessionId) return sessionId;
  const { rows: existing } = await asSuperuser<{ id: string }>(
    "select id from app.browser_sessions where organization_id = $1 and user_id = $2 and agent_id = $3 and site_key = $4",
    [orgId, samId, botId, SITE],
  );
  if (existing[0]) {
    sessionId = existing[0].id;
    return sessionId;
  }
  const { rows: secret } = await asSuperuser<{ id: string }>(
    `insert into app.secrets (organization_id, name, kind, ciphertext, iv, tag)
       values ($1, $2, 'browser_session', 'x', 'x', 'x') returning id`,
    [orgId, `browser-session-e2e-${Date.now().toString(36)}`],
  );
  const { rows } = await asSuperuser<{ id: string }>(
    `insert into app.browser_sessions (organization_id, user_id, agent_id, site_key, secret_id, expires_at)
       values ($1, $2, $3, $4, $5, now() + interval '30 days') returning id`,
    [orgId, samId, botId, SITE, secret[0]?.id],
  );
  sessionId = rows[0]?.id ?? null;
  if (!sessionId) throw new Error("seed browser session");
  return sessionId;
}

/** Scout opens the shop in the turn's conversation, with Sam's session loaded into that page. */
async function openSignedIn(m: MentionPayload): Promise<void> {
  // The DM's page may still be open from an earlier test, with the session already loaded.
  expect(await cell.browser(m, "ocw_browser_open", { url: `https://${SITE}/checkout` })).toMatch(
    /^opened shop\.fake\.test( \(signed in\))?$/,
  );
  const session = await samSession();
  const { rowCount } = await asSuperuser(
    `update app.browser_contexts set session_id = $1
       where organization_id = $2 and agent_id = $3 and conversation_id = $4 and closed_at is null`,
    [session, orgId, botId, m.conversation.id],
  );
  expect(rowCount, "the turn's open page").toBeGreaterThan(0);
  expect(await cell.browser(m, "ocw_browser_snapshot", {})).toContain(`snapshot ${SITE}`);
}

/** The newest approval card on the page whose text contains `text`. */
function cardWith(page: Page, text: string): Locator {
  return page.locator('[data-testid="agent-card"][data-kind="approval"]').filter({ hasText: text }).last();
}

async function selectorOf(card: Locator): Promise<string> {
  const id = await card.locator("xpath=ancestor::*[@data-message-id][1]").getAttribute("data-message-id");
  expect(id, "the card's message id").toBeTruthy();
  return `[data-message-id="${id}"] [data-testid="agent-card"]`;
}

async function invariants(page: Page, label: string, card: Locator) {
  const selector = await selectorOf(card);
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    expect.soft(await unnamedControls(page), `${label} (${theme}): unnamed controls`).toEqual([]);
    await expectNoSidewaysScroll(page, `${label} (${theme})`);
    await expectNoSeriousA11y(page, selector);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await expectTouchTargets(page, card);
}

async function reveal(card: Locator) {
  await card.evaluate((el) => {
    (document.activeElement as HTMLElement | null)?.blur();
    el.scrollIntoView({ block: "end" });
  });
}

/** The newest pending tool-call approval Sam decides (the requester decides a signed-in action, D-11). */
async function newestApproval(): Promise<{ id: string; actionHash: string }> {
  const res = await samApi.get("/api/v1/approvals?role=decider&status=pending&kinds=tool.call");
  expect(res.ok()).toBe(true);
  const item = ((await res.json()) as { items: Array<{ id: string; actionHash: string }> }).items[0];
  expect(item, "a pending browser approval").toBeTruthy();
  return item as { id: string; actionHash: string };
}

test("Sam reads exactly what Scout will type on his signed-in site, approves it in the card, and Scout types once", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const page = await signIn(browser, SAM, project);
  await page.goto(`${BASE_URL}/chat/dm/${dmId}`);
  await expect(page.getByTestId("composer")).toBeVisible();

  const asked = await postAs(samApi, dmId, `Fill in my email at checkout ${w}`);
  const m = await mentionOf(asked.id);
  await openSignedIn(m);
  const act = { action: "type", ref: "r2", text: TYPED };
  expect(await cell.browser(m, "ocw_browser_act", act)).toBe("refused (approval_required)");

  const card = cardWith(page, `Type into “Email” on ${SITE}`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByTestId("agent-card-status")).toHaveText("Pending");
  await expect(card.getByTestId("agent-card-action-field-action")).toHaveText("Type");
  await expect(card.getByTestId("agent-card-action-field-element")).toHaveText("textbox “Email”");
  const page_ = card.getByTestId("agent-card-action-field-page");
  await expect(page_.getByTestId("host-chip")).toHaveAttribute("data-secure", "true");
  await expect(page_.getByTestId("host-chip-host")).toHaveText(SITE);
  await expect(card.getByTestId("agent-card-action-field-session")).toHaveText("Signed in as you");
  await expect(card.getByRole("heading", { level: 4, name: `What ${BOT} will type` })).toBeVisible();
  await expect(card.getByTestId("agent-card-value-field-value")).toHaveText(TYPED);
  await expect(card.getByTestId("agent-card-browser-why")).toHaveText(
    `${BOT} is signed in to ${SITE} with your account, so it asks before acting.`,
  );
  await expect(card.getByTestId("agent-card-timer")).toHaveText(
    /^Runs once, while the page is open · Expires in 1[45] min$/,
  );

  await invariants(page, `browser card ${w}`, card);
  await reveal(card);
  await captureReview(page, `approval-browser-card-${w}`);

  // ---- Sam approves in the card; Scout's re-run types once; the card follows it to Used
  const { id } = await newestApproval();
  await card.getByTestId("agent-card-approve").click();
  const dialog = page.getByTestId("agent-card-confirm");
  await expect(dialog).toContainText(
    `${BOT} does it once, while the page is open, signed in to ${SITE} as you.`,
  );
  await dialog.getByTestId("agent-card-confirm-submit").click();
  await expect(toast(page, `Approved. ${BOT} runs it once.`)).toBeVisible();
  const rerun = (
    await cell.waitFor(
      (e) =>
        e.type === "agent.card_action.v1" &&
        (e.data as unknown as CardActionPayload).cardAction?.outcome === "approved" &&
        (e.data as unknown as CardActionPayload).cardAction?.grant?.tool === "ocw_browser_act" &&
        !cell.replies.some((r) => r.mention.eventId === (e.data as unknown as CardActionPayload).eventId),
      30_000,
    )
  ).data as unknown as CardActionPayload;
  expect(await cell.browser(rerun, "ocw_browser_act", act)).toBe(`acted on ${SITE}`);
  // Exactly once: the same grant again is refused.
  expect(await cell.browser(rerun, "ocw_browser_act", act)).toBe("refused (approval_used)");
  await cell.reply(rerun, `Typed your email ${w}.`);
  await expect(card.getByTestId("agent-card-status")).toHaveText("Used", { timeout: 20_000 });
  const done = await samApi.get(`/api/v1/approvals/${id}`);
  expect(((await done.json()) as { status: string }).status).toBe("applied");
});

test("in a channel every other reader gets the summary: who wants to click where, for whom, and no element", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const channel = await freshChannel(admin, [samApi, alexApi], "shop");
  const added = await admin.post(`/api/v1/channels/${channel.id}/members`, {
    data: { kind: "agent", id: botId },
  });
  expect(added.ok(), `add ${BOT} to #${channel.name}`).toBe(true);
  const alex = await signIn(browser, ALEX, project);
  await alex.goto(`${BASE_URL}/chat/${channel.id}`);
  await expect(alex.getByTestId("composer")).toBeVisible();

  const asked = await postAs(samApi, channel.id, `@${BOT} sign me in on the shop`, {
    mentions: [{ kind: "agent", id: botId }],
  });
  const m = await mentionOf(asked.id);
  await openSignedIn(m);
  expect(await cell.browser(m, "ocw_browser_act", { action: "click", ref: "r4" })).toBe(
    "refused (approval_required)",
  );

  const card = cardWith(alex, `${BOT} wants to click on ${SITE} for Sam Lee`);
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(card.getByTestId("agent-card-status")).toHaveText("Pending");
  await expect(card.getByTestId("agent-card-action-field-source")).toHaveText("Browser");
  await expect(card.getByTestId("agent-card-privacy")).toHaveText(
    "Only Sam Lee and the approvers can see the details.",
  );
  // No element, no value, no decision for Alex.
  await expect(card).not.toContainText("“Sign in”");
  await expect(card.getByTestId("agent-card-action-field-element")).toHaveCount(0);
  await expect(card.getByTestId("agent-card-approve")).toHaveCount(0);
  await expect(card.getByTestId("agent-card-browser-why")).toHaveCount(0);
  await invariants(alex, `browser summary card ${widthOf(project)}`, card);
});

test("an expired request and a page that changed read the browser lines", async ({ browser }, info) => {
  const project = info.project.name;
  const w = widthOf(project);
  const page = await signIn(browser, SAM, project);
  await page.goto(`${BASE_URL}/chat/dm/${dmId}`);
  await expect(page.getByTestId("composer")).toBeVisible();

  // ---- Expired: no one decided within 15 minutes (produced for real on the isolated database)
  const first = await postAs(samApi, dmId, `Type my email again ${w}`);
  const m1 = await mentionOf(first.id);
  await openSignedIn(m1);
  // Another value than the first test's: the same action again would be that grant, already used.
  expect(
    await cell.browser(m1, "ocw_browser_act", { action: "type", ref: "r2", text: `later.${TYPED}` }),
  ).toBe("refused (approval_required)");
  const expiredId = (await newestApproval()).id;
  await asSuperuser(
    "update app.approval_requests set expires_at = now() - interval '1 second' where id = $1",
    [expiredId],
  );
  await cell.reply(m1, `Waiting for you ${w}.`);

  // ---- Not used: approved, but the page changed before the bot could act
  const second = await postAs(samApi, dmId, `Click sign in ${w}`);
  const m2 = await mentionOf(second.id);
  await openSignedIn(m2);
  expect(await cell.browser(m2, "ocw_browser_act", { action: "click", ref: "r4" })).toBe(
    "refused (approval_required)",
  );
  const pending = await newestApproval();
  const decided = await samApi.post(`/api/v1/approvals/${pending.id}/decision`, {
    data: { outcome: "approved", actionHash: pending.actionHash },
  });
  expect(decided.ok(), `approve ${pending.id}`).toBe(true);
  await asSuperuser(
    "update app.approval_requests set decided_at = now() - interval '16 minutes' where id = $1",
    [pending.id],
  );
  await cell.reply(m2, `On it ${w}.`);

  await page.reload();
  const expired = cardWith(page, `Type into “Email” on ${SITE}`);
  await expect(expired.getByTestId("agent-card-status")).toHaveText("Expired", { timeout: 20_000 });
  await expect(expired.getByTestId("agent-card-state-line")).toHaveText(
    "No one decided within 15 minutes. Nothing was typed.",
  );
  const unused = cardWith(page, `Click “Sign in” on ${SITE}`);
  await expect(unused.getByTestId("agent-card-status")).toHaveText("Not used");
  await expect(unused.getByTestId("agent-card-state-line")).toHaveText(
    `The page closed or changed before ${BOT} could do it. Ask again if you still need it.`,
  );
});
