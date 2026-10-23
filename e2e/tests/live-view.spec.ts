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
import { ALEX, freshChannel, messageRow, postAs } from "../support/chat";
import { FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import { captureReview, unnamedControls } from "../support/layout";
import {
  contextOf,
  fakePage,
  replyRow,
  type ScriptedState,
  type SocketTap,
  scriptLiveView,
  tapSockets,
  watchFrom,
} from "../support/live-view";
import { enableBotSandbox, enableSandboxOrg, resume } from "../support/sandbox";
import { ADMIN, API_URL } from "./env";

/**
 * 07.8-22 (BRW-02, BRW-03; D-06, D-07, D-11 F-5, D-12 U-2; UI-SPEC §1.1–1.4; C-03): the desktop live view of a bot's
 * browser against the real API, the fake cell (driven by hand, no model) and the fake sandboxd's JPEG frames. Sam asks
 * Scout in #ops; Scout opens the panel; Sam clicks Watch on the browser step and watches it live in the small window,
 * across navigation; he expands it, takes control, types, gets the idle-lease warning and hands back. Alex reads #ops
 * too: he watches, cannot take control, and while Sam is in control sees "Private sign-in in progress" and receives no
 * frame. What Sam types reaches the live-view socket and nothing else. Performance, axe and the reviewed screenshots.
 *
 * The phone dock, the live chip and the sign-in card are 07.8-26's (`live-view-phone.spec.ts`): desktop only here.
 */

test.describe.configure({ mode: "serial" });

const BOT = "Scout";
const HOST = "panel.fake.test";
const SENTINEL = "OCW-SENTINEL-TYPED-8842";

let admin: APIRequestContext;
let samApi: APIRequestContext;
let alexApi: APIRequestContext;
let botId: string;
let ops: { id: string; name: string };
let lobby: { id: string; name: string };
let cell: FakeCellPlugin;
const open: BrowserContext[] = [];

const DESKTOP_ONLY = "the phone live view (dock and full sheet) is 07.8-26's";

test.beforeAll(async () => {
  if (test.info().project.name !== "desktop") return;
  admin = await apiAs(ADMIN);
  await ensureMember(admin, SAM, "developer");
  await ensureMember(admin, ALEX, "developer");
  samApi = await apiAs(SAM);
  alexApi = await apiAs(ALEX);
  await enableSandboxOrg(admin);
  await resume(admin);
  botId = await freshTeamBot(admin, BOT);
  await enableBotSandbox(admin, botId, { sandbox: true, browser: true });
  cell = new FakeCellPlugin({ apiUrl: API_URL, token: cellToken(), autoAck: true, autoReply: false });
  await cell.start();
  ops = await freshChannel(admin, [samApi, alexApi], "ops");
  lobby = await freshChannel(admin, [samApi, alexApi], "lobby");
  const added = await admin.post(`/api/v1/channels/${ops.id}/members`, {
    data: { kind: "agent", id: botId },
  });
  expect(added.ok(), `add ${BOT} to #${ops.name}`).toBe(true);
});

// Each test signs its people in afresh: the previous test's pages (and their live views) are closed first.
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

async function signIn(browser: Parameters<typeof openAs>[0], who: typeof SAM): Promise<Page> {
  const s = await openAs(browser, who, "desktop");
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

/** Sam asks Scout in #ops; Scout opens the panel (the same page every time: one per bot, conversation and member). */
async function scoutOpensPanel(ask: string): Promise<{ m: MentionPayload; rootId: string; reply: string }> {
  const asked = await postAs(samApi, ops.id, `@${BOT} ${ask}`, { mentions: [{ kind: "agent", id: botId }] });
  const m = await mentionOf(asked.id);
  expect(await cell.browser(m, "ocw_browser_open", { url: `https://${HOST}/app` })).toMatch(
    /^opened panel\.fake\.test/,
  );
  const reply = `The panel is open (${ask}).`;
  await cell.reply(m, reply);
  return { m, rootId: asked.id, reply };
}

/** Opens the turn's thread in #ops and returns the reply row there. */
async function threadReply(page: Page, rootId: string, reply: string): Promise<Locator> {
  if (!page.url().endsWith(`/chat/${ops.id}`)) await page.goto(`${BASE_URL}/chat/${ops.id}`);
  const summary = messageRow(page, rootId).getByTestId("thread-summary");
  // A page that loaded just before the turn was posted shows it live; under a fake clock that can lag, so the list is
  // read again once rather than waiting out the realtime reconnect.
  try {
    await expect(summary).toBeVisible({ timeout: 8_000 });
  } catch {
    await page.reload();
  }
  await expect(summary).toBeVisible({ timeout: 20_000 });
  await summary.click();
  return replyRow(page.getByTestId("thread-panel"), reply);
}

async function srcsOver(page: Page, ms: number): Promise<Set<string>> {
  const img = page.getByAltText(`${BOT}'s browser on ${HOST}`);
  const seen = new Set<string>();
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const src = await img.getAttribute("src");
    if (src) seen.add(src);
    await page.waitForTimeout(100);
  }
  return seen;
}

const stateOf = (page: Page) => page.getByTestId("live-view");

test("Sam clicks Watch and sees Scout's browser live in the small window; it survives navigation and closes cleanly", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", DESKTOP_ONLY);
  const page = await signIn(browser, SAM);
  await page.goto(`${BASE_URL}/chat/${ops.id}`);
  const { rootId, reply } = await scoutOpensPanel("open the panel");
  const row = await threadReply(page, rootId, reply);
  // Every state the live view goes through, in order.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __liveStates: string[] }).__liveStates = seen;
    new MutationObserver(() => {
      const s = document.querySelector('[data-testid="live-view"]')?.getAttribute("data-state");
      if (s && seen[seen.length - 1] !== s) seen.push(s);
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
  });

  const live = await watchFrom(row);
  const win = page.getByTestId("live-window");
  await expect(live).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  const states = await page.evaluate(() => (window as unknown as { __liveStates: string[] }).__liveStates);
  expect(states[0]).toBe("connecting");
  expect(states).toContain("live");
  await expect(win).toHaveAttribute("data-corner", "bottom-right");
  await expect
    .poll(async () => {
      const b = await win.boundingBox();
      return b
        ? [Math.round(1440 - (b.x + b.width)), Math.round(900 - (b.y + b.height)), Math.round(b.width)]
        : null;
    })
    .toEqual([16, 96, 320]);
  await expect(live.getByTestId("live-host-host")).toHaveText(HOST);
  await expect(live.getByTestId("live-state")).toHaveText("Live");
  expect((await srcsOver(page, 3_000)).size, "new frames in 3 s").toBeGreaterThanOrEqual(3);
  const contextId = await contextOf(live);
  await expect.poll(async () => (await fakePage(contextId))?.viewers).toBe(1);

  // Never steals focus; announced; F6 reaches it and goes back.
  await expect(win).not.toBeFocused();
  await expect(page.getByTestId("live-announce")).toContainText(
    `Live view of ${BOT}'s browser opened. Press F6 to reach it.`,
  );
  await page.keyboard.press("F6");
  await expect(win).toBeFocused();
  await page.keyboard.press("F6");
  await expect(win).not.toBeFocused();

  // In-app navigation keeps it, still live.
  await page.locator(`[data-testid="channel-link"][data-channel-name="${lobby.name}"]`).first().click();
  await expect(page).toHaveURL(new RegExp(`/chat/${lobby.id}`));
  await expect(win).toBeVisible();
  expect((await srcsOver(page, 1_500)).size).toBeGreaterThanOrEqual(2);

  // Close ends watching only: the upstream stream closes, the bot's page stays open.
  await win.getByTestId("live-close").click();
  await expect(win).toHaveCount(0);
  await expect.poll(async () => (await fakePage(contextId))?.viewers, { timeout: 10_000 }).toBe(0);
  expect(await fakePage(contextId), "the page itself stays open").toBeTruthy();
});

test("the large view: Sam takes control, types, gets the idle warning, keeps control and hands back; Alex only watches", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", DESKTOP_ONLY);
  const page = await signIn(browser, SAM);
  const tap = tapSockets(page);
  await page.clock.install();
  await page.goto(`${BASE_URL}/chat/${ops.id}`);
  const { rootId, reply } = await scoutOpensPanel("take a look");
  const live = await watchFrom(await threadReply(page, rootId, reply));
  await expect(live).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  const contextId = await contextOf(live);

  await page.getByTestId("live-expand").click();
  const expanded = page.getByTestId("live-expanded");
  await expect(expanded).toBeVisible();
  await expect(page.getByTestId("live-window")).toHaveCount(0);
  await expect(expanded.getByTestId("live-take-control")).toBeFocused();
  await expect.poll(async () => (await fakePage(contextId))?.viewport).toEqual({ width: 1280, height: 800 });
  await expect(expanded.getByText("Frames aren't recorded.")).toBeVisible();

  // Alex reads #ops: he watches the same page but cannot take control.
  const alex = await signIn(browser, ALEX);
  const alexLive = await watchFrom(await threadReply(alex, rootId, reply));
  await expect(alexLive).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  await expect(alexLive.getByTestId("live-take-control")).toHaveCount(0);
  await alex.getByTestId("live-expand").click();
  await expect(alex.getByTestId("live-expanded").getByTestId("live-watch-only").first()).toHaveText(
    "Only Sam Lee can take control here.",
  );
  await expect(alex.getByTestId("live-expanded").getByTestId("live-take-control")).toHaveCount(0);
  await alex.getByTestId("live-minimize").click();
  await expect(alex.getByTestId("live-window")).toBeVisible();

  // Take control: one press, then the takeover bar, the amber ring, the paste footer; the frame has the keyboard.
  const before = (await fakePage(contextId))?.inputs.key ?? 0;
  await expanded.getByTestId("live-take-control").click();
  await expect(stateOf(page)).toHaveAttribute("data-state", "controlling", { timeout: 15_000 });
  await expect(expanded.getByTestId("takeover-bar")).toContainText(`You're in control. ${BOT} is paused.`);
  await expect(expanded).toContainText(
    "Password managers can't fill this page. Copy your password and paste it here.",
  );
  await expect(expanded).toContainText(`${BOT} never sees what you type.`);
  const frame = expanded.getByTestId("live-frame");
  await expect(frame).toHaveAttribute("role", "application");
  await expect(frame).toHaveAttribute("aria-roledescription", "remote browser");
  await expect(frame).toBeFocused();
  await expect(expanded.getByTestId("takeover-bar")).toContainText(
    "Typing goes to the page · Shift+Esc gives your keyboard back",
  );
  await expect(expanded.getByTestId("live-minimize")).toHaveCount(0);
  await expect.poll(async () => (await fakePage(contextId))?.takeover).toBe(true);

  await page.keyboard.type("abc");
  await page.keyboard.press("Tab");
  await expect
    .poll(async () => ((await fakePage(contextId))?.inputs.key ?? 0) - before)
    .toBeGreaterThanOrEqual(8);
  // Escape belongs to the page: the large view stays open.
  await page.keyboard.press("Escape");
  await expect(expanded).toBeVisible();
  // Shift+Esc gives the keyboard back: focus on Hand back; the page never gets that Escape, and the Shift that went
  // down with it is released there.
  const sentBefore = tap.sent().length;
  await page.keyboard.press("Shift+Escape");
  await expect(expanded.getByTestId("live-hand-back")).toBeFocused();
  await page.waitForTimeout(500);
  const chord = tap.sent().slice(sentBefore);
  expect(chord.filter((f) => f.key === "Escape")).toEqual([]);
  expect(chord.filter((f) => f.key === "Shift").map((f) => f.event)).toEqual(["down", "up"]);

  // Nine minutes without input: "Still there?" with Keep control; keeping renews the lease.
  await page.clock.fastForward("09:01");
  const bar = expanded.getByTestId("takeover-bar");
  await expect(bar).toContainText(`Still there? Control goes back to ${BOT} in`);
  await expect(bar.getByTestId("live-keep-control")).toBeVisible();
  await bar.getByTestId("live-keep-control").click();
  await expect(bar).toContainText(`You're in control. ${BOT} is paused.`);

  // Hand back: the toast, then watching again.
  await expanded.getByTestId("live-hand-back").click();
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: `${BOT} continues.` })).toBeVisible();
  await expect(stateOf(page)).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  await expect.poll(async () => (await fakePage(contextId))?.takeover).toBe(false);
  await expect(alexLive).toHaveAttribute("data-state", "live");
  await expanded.getByTestId("live-close").click();
  await expect(page.getByTestId("live-view")).toHaveCount(0);
});

test("the small window drags to a corner and snaps; the corner persists after a reload; arrows move it too", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", DESKTOP_ONLY);
  const page = await signIn(browser, SAM);
  await page.goto(`${BASE_URL}/chat/${ops.id}`);
  const { rootId, reply } = await scoutOpensPanel("watch it move");
  const live = await watchFrom(await threadReply(page, rootId, reply));
  await expect(live).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  const win = page.getByTestId("live-window");
  await expect(win).toHaveAttribute("data-corner", "bottom-right");
  await expect(win.getByTestId("live-host")).toBeVisible();

  const grip = await win.getByTestId("live-host").boundingBox();
  if (!grip) throw new Error("no header");
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(500, 650, { steps: 12 });
  await page.mouse.up();
  await expect(win).toHaveAttribute("data-corner", "bottom-left");
  await expect.poll(async () => Math.round((await win.boundingBox())?.x ?? 0)).toBe(256);

  await page.reload();
  await watchFrom(await threadReply(page, rootId, reply));
  await expect(page.getByTestId("live-window")).toHaveAttribute("data-corner", "bottom-left");

  const move = page.getByTestId("live-move");
  await move.focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByTestId("live-window")).toHaveAttribute("data-corner", "top-left");
  await expect(page.getByTestId("live-announce")).toContainText("Moved to top left");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("live-window")).toHaveAttribute("data-corner", "bottom-right");
  await page.getByTestId("live-close").click();
});

test("takeover privacy and input that never leaves the page: Alex sees Private and gets no frame; the sentinel goes only to the live view", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", DESKTOP_ONLY);
  const sam = await signIn(browser, SAM);
  const alex = await signIn(browser, ALEX);
  const taps = new Map<Page, SocketTap>();
  const consoles: string[] = [];
  const bodies: string[] = [];
  for (const p of [sam, alex]) {
    taps.set(p, tapSockets(p));
    p.on("console", (msg: ConsoleMessage) => consoles.push(msg.text()));
    p.on("request", (r) => {
      const body = r.postData();
      if (body) bodies.push(body);
    });
  }
  await sam.goto(`${BASE_URL}/chat/${ops.id}`);
  await alex.goto(`${BASE_URL}/chat/${ops.id}`);
  const { rootId, reply } = await scoutOpensPanel("sign in for me");
  const samLive = await watchFrom(await threadReply(sam, rootId, reply));
  const alexLive = await watchFrom(await threadReply(alex, rootId, reply));
  await expect(samLive).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  await expect(alexLive).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  const contextId = await contextOf(samLive);
  const samTap = taps.get(sam) as SocketTap;
  const alexTap = taps.get(alex) as SocketTap;
  await expect.poll(() => alexTap.binary()).toBeGreaterThan(3);

  // Sam takes control from the small window: the large view opens and asks in one step.
  await sam.getByTestId("live-window").getByTestId("live-take-control").click();
  await expect(stateOf(sam)).toHaveAttribute("data-state", "controlling", { timeout: 15_000 });

  // Alex: Private, no image, and not one binary frame while Sam is in control.
  await expect(alexLive).toHaveAttribute("data-state", "private");
  await expect(alexLive).toContainText("Private sign-in in progress");
  await expect(alexLive).toContainText(
    "Sam Lee is signing in. The view comes back when they hand control back.",
  );
  await expect(alex.getByAltText(`${BOT}'s browser on ${HOST}`)).toHaveCount(0);
  const alexFrames = alexTap.binary();
  const samFrames = samTap.binary();

  // Sam types the sentinel and pastes it.
  await expect(sam.getByTestId("live-expanded").getByTestId("live-frame")).toBeFocused();
  await sam.keyboard.type(SENTINEL);
  await sam
    .getByTestId("live-expanded")
    .getByTestId("live-frame")
    .evaluate((el, text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, SENTINEL);
  await expect.poll(async () => (await fakePage(contextId))?.inputs.text ?? 0).toBeGreaterThanOrEqual(1);
  await sam.waitForTimeout(2_500);
  expect(alexTap.binary(), "Alex received no frame during Sam's control").toBe(alexFrames);
  expect(samTap.binary(), "Sam kept receiving frames").toBeGreaterThan(samFrames);

  // Hand back: Alex's view comes back.
  await sam.getByTestId("live-hand-back").click();
  await expect(alexLive).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  await expect.poll(() => alexTap.binary()).toBeGreaterThan(alexFrames);

  // The sentinel reached the live-view socket of Sam's page, as his input, and nothing else anywhere.
  const typed = samTap
    .sent()
    .filter((f) => f.type === "key" && f.event === "down")
    .map((f) => f.key)
    .join("");
  expect(typed).toContain(SENTINEL);
  // The pasted text frame, literally: the one place the whole sentinel may travel.
  expect(samTap.sent()).toContainEqual({ type: "text", text: "OCW-SENTINEL-TYPED-8842" });
  for (const [p, tap] of taps) {
    const leaks = tap
      .all()
      .filter((f) => f.payload.includes(SENTINEL))
      .filter(
        (f) =>
          !(
            p === sam &&
            f.live &&
            f.dir === "sent" &&
            f.payload === JSON.stringify({ type: "text", text: SENTINEL })
          ),
      );
    expect(leaks, "no other socket frame carries the sentinel").toEqual([]);
    expect(await p.content(), "DOM").not.toContain(SENTINEL);
    expect(await p.evaluate(() => document.body.innerText), "text").not.toContain(SENTINEL);
    const stored = await p.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(stored, "storage").not.toContain(SENTINEL);
  }
  expect(
    consoles.filter((c) => c.includes(SENTINEL)),
    "console",
  ).toEqual([]);
  expect(
    bodies.filter((b) => b.includes(SENTINEL)),
    "requests",
  ).toEqual([]);
  await sam.getByTestId("live-close").click();
  await alex.getByTestId("live-close").click();
});

test("at 8 fps the window updates without long tasks over 50 ms and keeps at most two blob URLs", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", DESKTOP_ONLY);
  const page = await signIn(browser, SAM);
  await page.addInitScript(() => {
    const live = new Set<string>();
    const w = window as unknown as {
      __blobMax: number;
      __longTasks: Array<{ start: number; duration: number }>;
    };
    w.__blobMax = 0;
    w.__longTasks = [];
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      const url = create(obj);
      live.add(url);
      w.__blobMax = Math.max(w.__blobMax, live.size);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      live.delete(url);
      revoke(url);
    };
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push({ start: e.startTime, duration: e.duration });
    }).observe({ type: "longtask", buffered: true });
  });
  await page.goto(`${BASE_URL}/chat/${ops.id}`);
  const { rootId, reply } = await scoutOpensPanel("keep it smooth");
  const live = await watchFrom(await threadReply(page, rootId, reply));
  await expect(live).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  await page.waitForTimeout(1_000);
  const start = await page.evaluate(() => performance.now());
  const frames = await srcsOver(page, 10_000);
  expect(frames.size, "about 8 frames a second").toBeGreaterThanOrEqual(40);
  const { max, long } = await page.evaluate((from) => {
    const w = window as unknown as {
      __blobMax: number;
      __longTasks: Array<{ start: number; duration: number }>;
    };
    return { max: w.__blobMax, long: w.__longTasks.filter((t) => t.start >= from && t.duration > 50) };
  }, start);
  expect(max, "live blob URLs").toBeLessThanOrEqual(2);
  expect(long, "long tasks while watching").toEqual([]);
  await page.getByTestId("live-close").click();
});

test("axe in light and dark, named controls, and the reviewed desktop screenshots", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", DESKTOP_ONLY);
  test.setTimeout(240_000);
  const sam = await signIn(browser, SAM);
  await sam.clock.install();
  await sam.goto(`${BASE_URL}/chat/${ops.id}`);
  const { rootId, reply } = await scoutOpensPanel("show me the orders");
  const samLive = await watchFrom(await threadReply(sam, rootId, reply));
  await expect(samLive).toHaveAttribute("data-state", "live", { timeout: 15_000 });

  // Scout works on the page in a new turn (not replied yet): the activity line names what it does.
  const asked = await postAs(samApi, ops.id, `@${BOT} read it`, { mentions: [{ kind: "agent", id: botId }] });
  const m = await mentionOf(asked.id);
  expect(await cell.browser(m, "ocw_browser_open", { url: `https://${HOST}/app` })).toMatch(
    /^opened panel\.fake\.test/,
  );
  expect(await cell.browser(m, "ocw_browser_snapshot", {})).toContain(`snapshot ${HOST}`);
  await expect(samLive.getByTestId("live-activity")).toContainText(`${BOT} is`, { timeout: 15_000 });

  const checks = async (page: Page, selector: string, label: string) => {
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      expect.soft(await unnamedControls(page), `${label} (${theme}): unnamed controls`).toEqual([]);
      await expectNoSeriousA11y(page, selector);
    }
    await page.emulateMedia({ colorScheme: "light" });
  };
  // Icon buttons are named as their tooltips.
  for (const [id, name] of [
    ["live-take-control", "Take control"],
    ["live-expand", "Expand"],
    ["live-close", "Close"],
    ["live-move", "Move live view"],
  ] as const) {
    await expect(samLive.getByTestId(id)).toHaveAttribute("aria-label", name);
  }
  await checks(sam, '[data-testid="live-window"]', "live window");
  await captureReview(sam, "live-window-1440");

  // Alex: the large view, watch-only.
  const alex = await signIn(browser, ALEX);
  const alexLive = await watchFrom(await threadReply(alex, rootId, reply));
  await expect(alexLive).toHaveAttribute("data-state", "live", { timeout: 15_000 });
  await alex.getByTestId("live-expand").click();
  await expect(alex.getByTestId("live-expanded")).toBeVisible();
  await checks(alex, '[data-testid="live-expanded"]', "large view, watching");
  await captureReview(alex, "live-expanded-1440");
  await alex.getByTestId("live-close").click();

  // Sam in control, then the idle-lease warning.
  await sam.getByTestId("live-take-control").click();
  await expect(stateOf(sam)).toHaveAttribute("data-state", "controlling", { timeout: 15_000 });
  await checks(sam, '[data-testid="live-expanded"]', "large view, in control");
  await captureReview(sam, "live-control-1440");
  await sam.clock.fastForward("09:01");
  await expect(sam.getByTestId("live-keep-control")).toBeVisible();
  await checks(sam, '[data-testid="live-expanded"]', "large view, idle warning");
  await captureReview(sam, "live-control-idle-1440");
  await sam.getByTestId("live-close").click();
  await expect(sam.getByTestId("live-view")).toHaveCount(0);
  await cell.reply(m, "Read it.");

  // Every other state, from a scripted live-view server, gathered on one review page.
  const harness = await signIn(browser, SAM);
  const setScript = await scriptLiveView(harness);
  const row = await threadReply(harness, rootId, reply);
  const scripted: Array<{ label: string; state: ScriptedState | "connecting" | "error"; expect: string }> = [
    { label: "Connecting", state: "connecting", expect: "connecting" },
    {
      label: "Idle",
      state: { state: "idle", host: HOST, secure: true, requesterName: "Sam Lee" },
      expect: "idle",
    },
    {
      label: "Paused (approval)",
      state: {
        state: "paused",
        pausedFor: "approval",
        activity: "clicking “Pay now”",
        host: HOST,
        secure: true,
        requesterName: "Sam Lee",
        approvalRoute: `/chat/${ops.id}`,
      },
      expect: "paused",
    },
    {
      label: "Private",
      state: { state: "private", privateReason: "takeover", controller: "other", memberName: "Sam Lee" },
      expect: "private",
    },
    {
      label: "Ended",
      state: { state: "ended", endReason: "closed_by_bot", host: HOST, secure: true },
      expect: "ended",
    },
    { label: "Error", state: "error", expect: "error" },
    { label: "No permission", state: { state: "no_permission" }, expect: "no_permission" },
  ];
  const tiles: string[] = [];
  for (const s of scripted) {
    setScript({ state: s.state });
    await watchFrom(row);
    const view = harness.getByTestId("live-view");
    await expect(view).toHaveAttribute("data-state", s.expect, { timeout: 15_000 });
    if (s.expect === "idle" || s.expect === "paused")
      await expect(harness.getByAltText(/browser on/)).toBeVisible();
    await expectNoSeriousA11y(harness, '[data-testid="live-window"]');
    tiles.push(
      await harness.getByTestId("live-window").evaluate(async (el, label) => {
        const clone = el.cloneNode(true) as HTMLElement;
        const img = el.querySelector("img");
        const copy = clone.querySelector("img");
        if (img && copy && img.complete && img.naturalWidth) {
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext("2d")?.drawImage(img, 0, 0);
          copy.src = canvas.toDataURL("image/jpeg", 0.8);
        }
        clone.removeAttribute("data-testid");
        for (const n of clone.querySelectorAll("[data-testid]")) n.removeAttribute("data-testid");
        for (const n of clone.querySelectorAll("[id]")) n.removeAttribute("id");
        clone.style.cssText = "position: relative; left: auto; top: auto;";
        return `<figure style="display:grid;gap:8px;margin:0"><figcaption style="font:600 12px var(--font-sans)">${label}</figcaption>${clone.outerHTML}</figure>`;
      }, s.label),
    );
    await harness.getByTestId("live-close").click();
    await expect(harness.getByTestId("live-view")).toHaveCount(0);
  }
  await harness.evaluate((html) => {
    const board = document.createElement("div");
    board.id = "live-states-review";
    board.setAttribute("aria-hidden", "true");
    board.className = "bg-background text-foreground";
    board.style.cssText =
      "position:fixed;inset:0;z-index:60;display:grid;grid-template-columns:repeat(4,320px);gap:28px 24px;padding:32px;align-content:start;justify-content:center;overflow:hidden";
    board.innerHTML = html.join("");
    document.body.appendChild(board);
  }, tiles);
  await captureReview(harness, "live-window-states-1440");
  await harness.evaluate(() => document.getElementById("live-states-review")?.remove());
});
