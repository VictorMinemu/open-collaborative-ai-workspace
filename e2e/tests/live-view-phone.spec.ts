import {
  type APIRequestContext,
  type BrowserContext,
  type ConsoleMessage,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";
import { expectNoSeriousA11y } from "../support/a11y";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { freshTeamBot } from "../support/bot-tools";
import { cellToken } from "../support/cell-token";
import { ALEX, freshChannel, postAs } from "../support/chat";
import { FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { contextOf, fakePage, replyRow, scriptLiveView, tapSockets, watchFrom } from "../support/live-view";
import { enableBotSandbox, enableSandboxOrg, fakeSandboxd, organizationOf, resume } from "../support/sandbox";
import { ADMIN, API_URL } from "./env";

/**
 * 07.8-26 (BRW-02, BRW-03; D-06, D-07, D-11 F-5, D-12 U-2; R10, U-4, U-7, Pitfall 12; UI-SPEC §1.5, Surface 1b; C-03):
 * the live view on a phone, and the conversation header's live chip, against the real API, the fake cell (driven by
 * hand) and the fake sandboxd. Watch opens a non-modal dock in peek over Sam's DM with the composer still usable; the
 * handle shrinks it to mini; Expand opens the full sheet; the system Back returns to the dock. In control from the
 * sheet: the takeover bar, the keyboard input (typed characters reach the page, the input stays empty, a sensitive field
 * turns it into a password field), taps as touches, a phone viewport for the page and 960×600 again after Hand back;
 * Back in control asks "Hand back to Scout?". The live chip ("Live browser" / "Live", "{n} live browsers" with a menu,
 * the thread's own chip) on both widths. Privacy on a phone: Alex sees "Private sign-in in progress" and receives no
 * frame while Sam is in control. axe, named controls, 44 px targets, no sideways scroll and the reviewed screenshots.
 */

test.describe.configure({ mode: "serial" });

const BOT = "Scout";
const HOST = "panel.fake.test";
const PHONE_ONLY = "the phone dock and full sheet (desktop: live-view.spec.ts)";

let admin: APIRequestContext;
let samApi: APIRequestContext;
let alexApi: APIRequestContext;
let botId: string;
let orgId: string;
let dmId: string;
let ops: { id: string; name: string };
let cell: FakeCellPlugin;
const open: BrowserContext[] = [];

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
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
  ops = await freshChannel(admin, [samApi, alexApi], "ops");
  const added = await admin.post(`/api/v1/channels/${ops.id}/members`, {
    data: { kind: "agent", id: botId },
  });
  expect(added.ok(), `add ${BOT} to #${ops.name}`).toBe(true);
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

async function signInAs(
  browser: Parameters<typeof openAs>[0],
  who: typeof SAM,
  project: string,
): Promise<Page> {
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

/** `who` asks Scout in `conversationId`; Scout opens a fresh page on `host` and replies; returns the turn and reply. */
async function scoutOpens(
  api: APIRequestContext,
  conversationId: string,
  ask: string,
  /** `close: false`: the conversation has no page of Sam's yet (no refused close in the activity). */
  opts: { host?: string; threadRootId?: string; mention?: boolean; close?: boolean } = {},
): Promise<{ m: MentionPayload; reply: string }> {
  const asked = await postAs(api, conversationId, opts.mention ? `@${BOT} ${ask}` : ask, {
    ...(opts.mention ? { mentions: [{ kind: "agent", id: botId }] } : {}),
    ...(opts.threadRootId ? { threadRootId: opts.threadRootId } : {}),
  });
  const m = await mentionOf(asked.id);
  if (opts.close !== false) await cell.browser(m, "ocw_browser_close", {});
  const host = opts.host ?? HOST;
  expect(await cell.browser(m, "ocw_browser_open", { url: `https://${host}/app` })).toBe(`opened ${host}`);
  const reply = `The page is open (${ask}).`;
  await cell.reply(m, reply);
  return { m, reply };
}

/** A new turn of `who` in `conversationId` closes Scout's page there (one page per bot, conversation and member). */
async function scoutCloses(api: APIRequestContext, conversationId: string, threadRootId?: string) {
  const asked = await postAs(api, conversationId, `@${BOT} close the page`, {
    mentions: [{ kind: "agent", id: botId }],
    ...(threadRootId ? { threadRootId } : {}),
  });
  const m = await mentionOf(asked.id);
  expect(await cell.browser(m, "ocw_browser_close", {})).not.toMatch(/^(refused|failed)/);
  await cell.reply(m, "Closed.");
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

/** Drags the dock's handle by `dy` CSS px with a pointer (a finger's swipe). */
async function swipeHandle(page: Page, dy: number) {
  const box = await page.getByTestId("live-dock-handle").boundingBox();
  if (!box) throw new Error("no handle");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + dy / 2, { steps: 4 });
  await page.mouse.move(x, y + dy, { steps: 4 });
  await page.mouse.up();
}

test("Watch on a phone: the dock in peek with the composer usable; mini; the full sheet; Back returns to the dock", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "mobile", PHONE_ONLY);
  const page = await signInAs(browser, SAM, "mobile");
  await page.goto(`${BASE_URL}/chat/dm/${dmId}`);
  const { reply } = await scoutOpens(samApi, dmId, "open the panel on my phone", { close: false });
  const live = await watchFrom(replyRow(page, reply));
  const dock = page.getByTestId("live-dock");
  await expect(dock).toHaveAttribute("data-dock", "peek");
  await expect(live).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  await expect(dock.getByTestId("live-host-host")).toHaveText(HOST);
  // A region over the chat, never a dialog; the window of 22 is not used on phones.
  await expect(dock).toHaveAttribute("aria-label", `Live view of ${BOT}'s browser`);
  await expect(page.getByTestId("live-window")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // UI-SPEC sizes: full width, ≈ 332 + safe area (8) tall in peek.
  const peek = await dock.boundingBox();
  expect(peek && Math.round(peek.width)).toBe(390);
  expect(peek && Math.round(peek.height)).toBeGreaterThanOrEqual(330);
  expect(peek && Math.round(peek.height)).toBeLessThanOrEqual(350);

  // The composer stays above the dock and usable: <main> is padded by the dock's height.
  const composer = page.getByTestId("composer");
  await expect(composer).toBeVisible();
  const cb = await composer.boundingBox();
  expect(cb && peek && cb.y + cb.height).toBeLessThanOrEqual((peek?.y ?? 0) + 1);
  const pad = await page.locator("main").evaluate((el) => getComputedStyle(el).paddingBottom);
  expect(Math.round(Number.parseFloat(pad))).toBe(Math.round(peek?.height ?? 0));
  await composer.click();
  await composer.fill("Thanks, I'm watching it");
  await composer.press("Enter");
  await expect(page.getByText("Thanks, I'm watching it")).toBeVisible({ timeout: 10_000 });
  await expect(dock).toBeVisible();

  await invariants(page, "dock peek 390", dock, '[data-testid="live-dock"]');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await captureReview(page, "live-dock-peek-390");

  // Swipe down on the handle: mini (one row), persisted.
  await swipeHandle(page, 80);
  await expect(dock).toHaveAttribute("data-dock", "mini");
  expect(await page.evaluate(() => localStorage.getItem("ocw:live-dock"))).toBe("mini");
  const mini = await dock.boundingBox();
  expect(mini && Math.round(mini.height)).toBeLessThanOrEqual(56 + 20 + 8 + 2);
  await expect(dock.getByTestId("live-activity")).toBeVisible();
  await invariants(page, "dock mini 390", dock, '[data-testid="live-dock"]');
  await captureReview(page, "live-dock-mini-390");
  await dock.getByTestId("live-dock-show").click();
  await expect(dock).toHaveAttribute("data-dock", "peek");

  // Expand → the full sheet (modal); the system Back returns to the dock and keeps the page.
  const url = page.url();
  await dock.getByTestId("live-expand").click();
  const full = page.getByTestId("live-full");
  await expect(full).toBeVisible();
  await expect(full.getByTestId("live-view")).toHaveAttribute("data-state", "live");
  await expect(full.getByTestId("live-take-control")).toBeVisible();
  await invariants(page, "full sheet 390", full, '[data-testid="live-full"]');
  // Focus stays in the sheet (modal): Tab never leaves it.
  const seen: string[] = [];
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    // Base UI's trap passes through its own focus guards on the way round (they hand focus back inside).
    await expect
      .poll(
        () =>
          full.evaluate((el) => {
            const a = document.activeElement;
            return el.contains(a) || a?.hasAttribute("data-base-ui-focus-guard")
              ? "inside"
              : (a?.outerHTML.slice(0, 160) ?? "none");
          }),
        { message: `Tab ${i + 1} stays in the sheet`, timeout: 2_000 },
      )
      .toBe("inside");
    seen.push(await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? ""));
  }
  // Round and round: the first control comes back.
  expect(seen.filter((t) => t === "live-minimize").length).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await captureReview(page, "live-full-390");
  await page.goBack();
  await expect(full).toHaveCount(0);
  await expect(dock).toBeVisible();
  expect(page.url()).toBe(url);
  await dock.getByTestId("live-close").click();
  await expect(dock).toHaveCount(0);
  const padAfter = await page.locator("main").evaluate((el) => getComputedStyle(el).paddingBottom);
  expect(padAfter).toBe("0px");
});

test("in control from the sheet: keyboard, touches, a password field, the phone viewport; Back asks; Hand back restores 960×600", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "mobile", PHONE_ONLY);
  const page = await signInAs(browser, SAM, "mobile");
  const tap = tapSockets(page);
  const consoles: string[] = [];
  page.on("console", (msg: ConsoleMessage) => consoles.push(msg.text()));
  await page.goto(`${BASE_URL}/chat/dm/${dmId}`);
  const { reply } = await scoutOpens(samApi, dmId, "let me sign in on my phone");
  const live = await watchFrom(replyRow(page, reply));
  await expect(live).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  const contextId = await contextOf(live);
  await page.getByTestId("live-dock").getByTestId("live-expand").click();
  const full = page.getByTestId("live-full");
  await full.getByTestId("live-take-control").click();
  const state = full.getByTestId("live-view");
  await expect(state).toHaveAttribute("data-state", "controlling", { timeout: 15_000 });
  await expect(full.getByTestId("takeover-bar")).toContainText(`You're in control. ${BOT} is paused.`);
  await expect(full).toContainText("Tap to click. Pinch to zoom. Paste works.");
  await expect(full.getByTestId("live-control-ring")).toBeVisible();

  // R10: the page now has a phone viewport the size of the frame area.
  await expect.poll(async () => (await fakePage(contextId))?.viewportMode).toBe("phone");
  const area = await full.getByTestId("live-full-area").boundingBox();
  const vp = (await fakePage(contextId))?.viewport;
  expect(vp?.width).toBe(Math.round(area?.width ?? 0));
  expect(vp?.height).toBe(Math.round(area?.height ?? 0));

  // Show keyboard focuses the hidden input; typed characters reach the page as text, keys as key presses.
  await full.getByTestId("live-keyboard").click();
  const soft = full.getByTestId("live-soft-input");
  await expect(soft).toBeFocused();
  await expect(soft).toHaveAttribute("type", "text");
  await expect(soft).toHaveAttribute("autocomplete", "off");
  await expect(soft).toHaveAttribute("spellcheck", "false");
  const before = (await fakePage(contextId))?.inputs ?? {};
  await page.keyboard.type("sam@ocw.test");
  await page.keyboard.press("Backspace");
  await expect
    .poll(async () => ((await fakePage(contextId))?.inputs.text ?? 0) - (before.text ?? 0))
    .toBe("sam@ocw.test".length);
  await expect.poll(async () => ((await fakePage(contextId))?.inputs.key ?? 0) - (before.key ?? 0)).toBe(2);
  await expect(soft).toHaveValue("");

  // The page's focused field is a password: the input turns into a password field (the keyboard learns nothing).
  await fakeSandboxd().browserEvent({ orgId, agentId: botId }, contextId, "focus_sensitive");
  await expect(soft).toHaveAttribute("type", "password");
  await page.keyboard.type("hunter2");
  await expect(soft).toHaveValue("");

  // A tap on the page is a touch (start and end).
  await page.keyboard.press("Tab"); // the keyboard goes away; the tap below lands on the page
  const touches = (await fakePage(contextId))?.inputs.touch ?? 0;
  await full.getByTestId("live-frame").tap({ position: { x: 120, y: 160 } });
  await expect.poll(async () => ((await fakePage(contextId))?.inputs.touch ?? 0) - touches).toBe(2);
  const touch = tap.sent().filter((f) => f.type === "touch");
  expect(touch.at(-2)).toMatchObject({ type: "touch", event: "start" });
  expect(touch.at(-1)).toMatchObject({ type: "touch", event: "end" });

  await invariants(page, "in control 390", full, '[data-testid="live-full"]');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await captureReview(page, "live-control-390");

  // The system Back while in control asks first; Keep control keeps it.
  await page.goBack();
  const question = page.getByTestId("live-back-question");
  await expect(question).toBeVisible();
  await expect(question).toContainText(`Hand back to ${BOT}?`);
  await expect(question.getByTestId("live-back-keep")).toBeFocused();
  await question.getByTestId("live-back-keep").click();
  await expect(question).toHaveCount(0);
  await expect(state).toHaveAttribute("data-state", "controlling");
  await expect(full).toBeVisible();
  // Back again, Hand back: watching, and the page goes back to 960×600.
  await page.goBack();
  await expect(question).toBeVisible();
  await question.getByTestId("live-back-hand-back").click();
  await expect(state).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: `${BOT} continues.` })).toBeVisible();
  await expect.poll(async () => (await fakePage(contextId))?.takeover).toBe(false);
  await expect.poll(async () => (await fakePage(contextId))?.viewport).toEqual({ width: 960, height: 600 });

  // Nothing typed anywhere but the live-view socket: no other frame, no console line, no DOM text.
  for (const secret of ["sam@ocw.test", "hunter2"]) {
    expect(
      tap
        .all()
        .filter((f) => !f.live)
        .some((f) => f.payload.includes(secret)),
    ).toBe(false);
    expect(consoles.some((c) => c.includes(secret))).toBe(false);
    expect(await page.evaluate((s) => document.body.innerText.includes(s), secret)).toBe(false);
  }
  const typedText = tap
    .sent()
    .filter((f) => f.type === "text")
    .map((f) => f.text)
    .join("");
  expect(typedText).toContain("sam@ocw.test");
});

test("the live chip: one page ('Live browser' / 'Live'), several ('{n} live browsers' with a menu), the thread's own; gone once closed", async ({
  browser,
}, info) => {
  const project = info.project.name;
  const page = await signInAs(browser, SAM, project);

  // Sam's DM: one page → the chip opens the live view (the small window on desktop, the dock on a phone).
  await scoutOpens(samApi, dmId, `chip in the DM ${widthOf(project)}`);
  await page.goto(`${BASE_URL}/chat/dm/${dmId}`);
  const chip = page.getByTestId("live-chip");
  await expect(chip).toBeVisible({ timeout: 25_000 });
  await expect(chip).toHaveAttribute("data-count", "1");
  await expect(chip).toHaveAccessibleName(`Live browser, ${BOT}`);
  await expect(chip).toHaveText(project === "mobile" ? "Live" : "Live browser", { useInnerText: true });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await captureReview(page, `live-chip-one-${widthOf(project)}`);
  await chip.click();
  await expect(page.getByTestId(project === "mobile" ? "live-dock" : "live-window")).toBeVisible();
  await page.getByTestId("live-close").click();

  // #ops: Sam's and Alex's pages → "2 live browsers" with a menu of "{bot} · {host}".
  await scoutOpens(samApi, ops.id, `chip for Sam ${widthOf(project)}`, { mention: true, host: HOST });
  await scoutOpens(alexApi, ops.id, `chip for Alex ${widthOf(project)}`, {
    mention: true,
    host: "crm.fake.test",
  });
  await page.goto(`${BASE_URL}/chat/${ops.id}`);
  await expect(chip).toHaveAttribute("data-count", "2", { timeout: 25_000 });
  await expect(chip).toHaveAccessibleName("2 live browsers");
  await invariants(page, `live chip ${widthOf(project)}`, chip, '[data-testid="live-chip"]');
  // The chip itself is a 44 px target on a phone (the helper checks a root's descendants).
  if (project === "mobile") {
    const b = await chip.boundingBox();
    expect(b && Math.min(b.width, b.height)).toBeGreaterThanOrEqual(43.5);
  }
  await chip.click();
  const items = page.getByTestId("live-chip-item");
  await expect(items).toHaveCount(2);
  await expect(items.filter({ hasText: `${BOT} · ${HOST}` })).toHaveCount(1);
  await expect(items.filter({ hasText: `${BOT} · crm.fake.test` })).toHaveCount(1);
  await expectNoSeriousA11y(page, '[data-testid="live-chip-menu"]');
  await expectTouchTargets(page, page.getByTestId("live-chip-menu"));
  await captureReview(page, `live-chip-${widthOf(project)}`);
  await items.filter({ hasText: "crm.fake.test" }).click();
  const view = page.getByTestId("live-view");
  await expect(view).toBeVisible();
  await expect(page.getByTestId("live-host-host").first()).toHaveText("crm.fake.test", { timeout: 15_000 });
  await page.getByTestId("live-close").first().click();

  // A thread: the page opened there shows in the thread panel's header too.
  const root = await postAs(samApi, ops.id, `thread for the chip ${widthOf(project)}`);
  await scoutOpens(samApi, ops.id, `look in the thread ${widthOf(project)}`, {
    mention: true,
    threadRootId: root.id,
    host: "docs.fake.test",
  });
  await page.goto(`${BASE_URL}/chat/${ops.id}?thread=${root.id}`);
  const panel = page.getByTestId("thread-panel");
  await expect(panel.getByTestId("live-chip")).toBeVisible({ timeout: 25_000 });
  await expect(panel.getByTestId("live-chip")).toHaveAttribute("data-count", "1");

  // The page closes: the thread's chip goes.
  await scoutCloses(samApi, ops.id, root.id);
  await expect(panel.getByTestId("live-chip")).toHaveCount(0, { timeout: 30_000 });
});

test("privacy on a phone: Alex sees 'Private sign-in in progress' and receives no frame while Sam is in control", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "mobile", PHONE_ONLY);
  const sam = await signInAs(browser, SAM, "desktop");
  const alex = await signInAs(browser, ALEX, "mobile");
  const alexTap = tapSockets(alex);
  await scoutOpens(samApi, ops.id, "privacy on a phone", { mention: true });
  // Both watch from the header chip (Alex on his phone: the dock).
  await sam.goto(`${BASE_URL}/chat/${ops.id}`);
  await alex.goto(`${BASE_URL}/chat/${ops.id}`);
  const samChip = sam.getByTestId("live-chip");
  await expect(samChip).toBeVisible({ timeout: 25_000 });
  if ((await samChip.getAttribute("data-count")) === "1") await samChip.click();
  else {
    await samChip.click();
    await sam.getByTestId("live-chip-item").filter({ hasText: HOST }).first().click();
  }
  const alexChip = alex.getByTestId("live-chip");
  await expect(alexChip).toBeVisible({ timeout: 25_000 });
  if ((await alexChip.getAttribute("data-count")) === "1") await alexChip.click();
  else {
    await alexChip.click();
    await alex.getByTestId("live-chip-item").filter({ hasText: HOST }).first().click();
  }
  const alexDock = alex.getByTestId("live-dock");
  await expect(alexDock.getByTestId("live-view")).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  await expect.poll(() => alexTap.binary()).toBeGreaterThan(3);

  await sam.getByTestId("live-window").getByTestId("live-take-control").click();
  await expect(sam.getByTestId("live-view")).toHaveAttribute("data-state", "controlling", {
    timeout: 15_000,
  });
  await expect(alexDock.getByTestId("live-view")).toHaveAttribute("data-state", "private", {
    timeout: 15_000,
  });
  await expect(alexDock).toContainText("Private sign-in in progress");
  await expect(alexDock).toContainText(
    "Sam Lee is signing in. The view comes back when they hand control back.",
  );
  await expect(alexDock.locator("img")).toHaveCount(0);
  const frames = alexTap.binary();
  await alex.waitForTimeout(2_500);
  expect(alexTap.binary(), "Alex received no frame during Sam's control").toBe(frames);
  await invariants(alex, "private 390", alexDock, '[data-testid="live-dock"]');
  await alex.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await captureReview(alex, "live-private-390");

  await sam.getByTestId("live-hand-back").click();
  await expect(alexDock.getByTestId("live-view")).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  await expect.poll(() => alexTap.binary()).toBeGreaterThan(frames);
});

test("a member's signed-in page on a phone reads 'Private browsing for Sam Lee' and shows no image (scripted)", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "mobile", PHONE_ONLY);
  // The resolver's member-session privacy is proven on the API (07.8-16) and in conversation-browsers.int; this is how
  // a phone renders it.
  const page = await signInAs(browser, ALEX, "mobile");
  const script = await scriptLiveView(page);
  script({
    state: {
      state: "private",
      privateReason: "member_session",
      memberName: "Sam Lee",
      host: null,
      secure: null,
    },
  });
  const { reply } = await scoutOpens(alexApi, ops.id, "scripted private", { mention: true });
  await page.goto(`${BASE_URL}/chat/${ops.id}`);
  const chip = page.getByTestId("live-chip");
  await expect(chip).toBeVisible({ timeout: 25_000 });
  if ((await chip.getAttribute("data-count")) === "1") await chip.click();
  else {
    await chip.click();
    await page.getByTestId("live-chip-item").first().click();
  }
  const dock = page.getByTestId("live-dock");
  await expect(dock.getByTestId("live-view")).toHaveAttribute("data-state", "private", { timeout: 15_000 });
  await expect(dock).toContainText("Private browsing for Sam Lee");
  await expect(dock.locator("img")).toHaveCount(0);
  void reply;
});
