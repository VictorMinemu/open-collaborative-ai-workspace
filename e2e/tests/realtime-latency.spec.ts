import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  request,
  test,
} from "@playwright/test";
import { BASE_URL, createChannel, ensureMember, joinChannel, openAs, SAM, userIdOf } from "../support/actors";
import { ADMIN, API_URL } from "./env";

/**
 * RT-03 (SC1, 03-01 D-07): two real web clients on one channel; the admin sends, Sam receives. Measures how long a
 * message, a typing signal and a presence change take to reach the other screen and fails when the p50 or p95 of
 * any kind reaches the budget. Both ends are timestamped inside the pages (`performance.timeOrigin +
 * performance.now()`, same host clock), so no Playwright round trip sits inside the measured interval. Samples are
 * taken strictly one at a time; warm-up messages are discarded. Report: `<outputDir>/realtime-latency.json`.
 */

const LATENCY_BUDGET_MS = 500;
const WARMUP = 3;
const MESSAGE_SAMPLES = 30;
const TYPING_SAMPLES = 6;
const PRESENCE_SAMPLES = 20;
/** The composer sends `user.typing` at most once per 3 s (composer.tsx). */
const TYPING_GAP_MS = 3_500;
/** Above the 500 ms client presence throttle, so every toggle is sent on the leading edge. */
const PRESENCE_GAP_MS = 600;
const RECEIVE_TIMEOUT_MS = 5_000;

type Kind = "message" | "typing" | "presence";

interface SendRecords {
  input: Record<string, number>;
  enter: Record<string, number>;
}

interface RecvRecords {
  messages: Record<string, number>;
  typing: number[];
  presence: Array<{ state: string | null; t: number }>;
}

declare global {
  interface Window {
    __latSend?: SendRecords;
    __latRecv?: RecvRecords;
  }
}

test.describe.configure({ mode: "serial" });

const header = (page: Page) => page.getByTestId("channel-view").locator("header").first();

/** An API context that reuses a signed-in browser's session cookie (no extra sign-in). */
async function apiFrom(context: BrowserContext): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { origin: BASE_URL },
    storageState: await context.storageState(),
  });
}

/**
 * Headless tabs are always visible: fake the Page Visibility API and announce the change like a real switch.
 * Showing the tab also dispatches a `pointerdown` so it counts as active. Returns the in-page time of the dispatch.
 */
async function setTabHidden(page: Page, hidden: boolean): Promise<number> {
  return page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (h ? "hidden" : "visible"),
    });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    const t = performance.timeOrigin + performance.now();
    document.dispatchEvent(new Event("visibilitychange"));
    if (!h) window.dispatchEvent(new PointerEvent("pointerdown"));
    return t;
  }, hidden);
}

/** Sender side: capture-phase listeners stamp the first `input` and the Enter `keydown` per `lat-<n>` token. */
async function installSenderProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const rec: SendRecords = { input: {}, enter: {} };
    window.__latSend = rec;
    const tokenOf = (el: EventTarget | null) =>
      el instanceof HTMLTextAreaElement && el.dataset.testid === "composer"
        ? el.value.match(/lat-\d+/)?.[0]
        : undefined;
    window.addEventListener(
      "input",
      (e) => {
        const t = performance.timeOrigin + performance.now();
        const tok = tokenOf(e.target);
        if (tok && !(tok in rec.input)) rec.input[tok] = t;
      },
      true,
    );
    window.addEventListener(
      "keydown",
      (e) => {
        const t = performance.timeOrigin + performance.now();
        if (e.key !== "Enter" || e.shiftKey) return;
        const tok = tokenOf(e.target);
        if (tok && !(tok in rec.enter)) rec.enter[tok] = t;
      },
      true,
    );
  });
}

/**
 * Receiver side: one MutationObserver stamps the first appearance of each `lat-<n>` token in a message, each
 * empty → non-empty transition of the typing indicator and each `data-state` change of the sender's avatar in the
 * channel header.
 */
async function installReceiverProbe(page: Page, senderId: string): Promise<void> {
  await page.evaluate((sender) => {
    const rec: RecvRecords = { messages: {}, typing: [], presence: [] };
    window.__latRecv = rec;
    const avatar = () =>
      document
        .querySelector('[data-testid="channel-view"] header')
        ?.querySelector(`[data-testid="presence-avatar"][data-user-id="${sender}"]`);
    const typingOn = () =>
      (document.querySelector('[data-testid="typing-indicator"]')?.textContent ?? "").trim() !== "";
    let typing = typingOn();
    let presence = avatar()?.getAttribute("data-state") ?? null;
    const scan = () => {
      const t = performance.timeOrigin + performance.now();
      for (const m of document.querySelectorAll('[data-testid="message"]')) {
        for (const tok of m.textContent?.match(/lat-\d+/g) ?? []) {
          if (!(tok in rec.messages)) rec.messages[tok] = t;
        }
      }
      const on = typingOn();
      if (on && !typing) rec.typing.push(t);
      typing = on;
      const state = avatar()?.getAttribute("data-state") ?? null;
      if (state !== presence) {
        rec.presence.push({ state, t });
        presence = state;
      }
    };
    new MutationObserver(scan).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-state"],
    });
  }, senderId);
}

const sent = (page: Page) => page.evaluate(() => window.__latSend as SendRecords);
const received = (page: Page) => page.evaluate(() => window.__latRecv as RecvRecords);

/** Runs a receiver wait (outside the measured interval) with the receive timeout; fails with the sample label. */
async function waitReceived(label: string, wait: (timeout: number) => Promise<unknown>): Promise<void> {
  try {
    await wait(RECEIVE_TIMEOUT_MS);
  } catch {
    throw new Error(`${label}: not received within ${RECEIVE_TIMEOUT_MS} ms`);
  }
}

/** Nearest-rank percentile over ascending-sorted values. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    n: samples.length,
    p50: round1(percentile(sorted, 50)),
    p95: round1(percentile(sorted, 95)),
    max: round1(sorted.at(-1) ?? Number.NaN),
    samples: samples.map(round1),
  };
}

test("realtime latency: message, typing and presence reach the other client in under 500 ms (p50 and p95)", async ({
  browser,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "latency is measured once, in the desktop project: the viewport does not affect propagation",
  );
  test.setTimeout(240_000);

  // ------------------------------------------------------------ setup: two signed-in clients on one new channel
  const a = await openAs(browser, ADMIN, "desktop");
  const admin = await apiFrom(a.context);
  const samId = await ensureMember(admin, SAM, "developer");
  const adminId = await userIdOf(admin);
  const channelId = await createChannel(admin, `latency-${Date.now().toString(36)}`);
  const s = await openAs(browser, SAM, "desktop");
  const samApi = await apiFrom(s.context);
  await joinChannel(samApi, channelId);
  await a.page.goto(`${BASE_URL}/chat/${channelId}`);
  await expect(a.page.getByTestId("channel-title")).toBeVisible();
  await s.page.goto(`${BASE_URL}/chat/${channelId}`);
  await expect(s.page.getByTestId("channel-title")).toBeVisible();

  // Both sockets subscribed: each header shows the other one online.
  const samOnA = header(a.page).locator(`[data-testid="presence-avatar"][data-user-id="${samId}"]`);
  const adminOnS = header(s.page).locator(`[data-testid="presence-avatar"][data-user-id="${adminId}"]`);
  await expect(samOnA).toHaveAttribute("data-state", "online", { timeout: 5000 });
  await expect(adminOnS).toHaveAttribute("data-state", "online", { timeout: 5000 });

  await installSenderProbe(a.page);
  await installReceiverProbe(s.page, adminId);

  const composer = a.page.getByTestId("composer");
  const indicator = s.page.getByTestId("typing-indicator");
  const samples: Record<Kind, number[]> = { message: [], typing: [], presence: [] };
  let n = 0;
  let lastFillAt = 0;

  /** Sends `lat-<n>` with Enter and returns the message latency (receiver first sight − sender Enter keydown). */
  const sendAndMeasure = async (tok: string, label: string) => {
    await composer.press("Enter");
    await waitReceived(label, (timeout) =>
      s.page.waitForFunction((t) => t in (window.__latRecv?.messages ?? {}), tok, { timeout }),
    );
    const enterAt = (await sent(a.page)).enter[tok];
    const seenAt = (await received(s.page)).messages[tok];
    expect(enterAt, `${label}: sender Enter timestamp`).toBeDefined();
    return (seenAt as number) - (enterAt as number);
  };

  // ------------------------------------------------------------ warm-up (discarded)
  for (let i = 0; i < WARMUP; i++) {
    const tok = `lat-${++n}`;
    await composer.fill(tok);
    lastFillAt = Date.now();
    await sendAndMeasure(tok, `warm-up ${i + 1}`);
  }

  // ------------------------------------------------------------ typing + message pairs
  for (let i = 0; i < TYPING_SAMPLES; i++) {
    const label = `typing sample ${i + 1}`;
    const wait = lastFillAt + TYPING_GAP_MS - Date.now();
    if (wait > 0) await a.page.waitForTimeout(wait);
    await expect(indicator, `${label}: indicator idle before the sample`).toHaveText("", { timeout: 10_000 });
    const before = (await received(s.page)).typing.length;
    const tok = `lat-${++n}`;
    await composer.fill(tok);
    lastFillAt = Date.now();
    await waitReceived(label, (timeout) =>
      s.page.waitForFunction((k) => (window.__latRecv?.typing.length ?? 0) > k, before, { timeout }),
    );
    const inputAt = (await sent(a.page)).input[tok];
    const shownAt = (await received(s.page)).typing[before];
    expect(inputAt, `${label}: sender input timestamp`).toBeDefined();
    samples.typing.push((shownAt as number) - (inputAt as number));
    samples.message.push(await sendAndMeasure(tok, `message sample ${samples.message.length + 1}`));
  }

  // ------------------------------------------------------------ further messages
  while (samples.message.length < MESSAGE_SAMPLES) {
    const tok = `lat-${++n}`;
    await composer.fill(tok);
    samples.message.push(await sendAndMeasure(tok, `message sample ${samples.message.length + 1}`));
  }

  // ------------------------------------------------------------ presence: alternately hide and show the admin's tab
  for (let i = 0; i < PRESENCE_SAMPLES; i++) {
    const hide = i % 2 === 0;
    const want = hide ? "away" : "online";
    const label = `presence sample ${i + 1} (${want})`;
    const before = (await received(s.page)).presence.length;
    const changedAt = await setTabHidden(a.page, hide);
    await waitReceived(label, (timeout) =>
      s.page.waitForFunction(
        ([k, st]) => (window.__latRecv?.presence ?? []).slice(k).some((r) => r.state === st),
        [before, want] as const,
        { timeout },
      ),
    );
    const seen = (await received(s.page)).presence.slice(before).find((r) => r.state === want);
    samples.presence.push((seen?.t as number) - changedAt);
    await a.page.waitForTimeout(PRESENCE_GAP_MS);
  }

  // ------------------------------------------------------------ report (written before asserting)
  const report = {
    budgetMs: LATENCY_BUDGET_MS,
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    apiUrl: API_URL,
    kinds: {
      message: stats(samples.message),
      typing: stats(samples.typing),
      presence: stats(samples.presence),
    },
  };
  const body = JSON.stringify(report, null, 2);
  mkdirSync(info.project.outputDir, { recursive: true });
  writeFileSync(join(info.project.outputDir, "realtime-latency.json"), body);
  await info.attach("realtime-latency", { body, contentType: "application/json" });
  for (const [kind, k] of Object.entries(report.kinds)) {
    console.log(
      `[realtime-latency] ${kind.padEnd(8)} n=${k.n} p50=${k.p50} ms p95=${k.p95} ms max=${k.max} ms (budget ${LATENCY_BUDGET_MS} ms)`,
    );
  }

  await s.context.close();
  await a.context.close();
  await samApi.dispose();
  await admin.dispose();

  // ------------------------------------------------------------ assertions
  const planned: Record<Kind, number> = {
    message: MESSAGE_SAMPLES,
    typing: TYPING_SAMPLES,
    presence: PRESENCE_SAMPLES,
  };
  for (const kind of ["message", "typing", "presence"] as const) {
    const k = report.kinds[kind];
    expect(k.n, `${kind}: sample count`).toBe(planned[kind]);
    expect(k.p50, `${kind}: p50 under ${LATENCY_BUDGET_MS} ms`).toBeLessThan(LATENCY_BUDGET_MS);
    expect(k.p95, `${kind}: p95 under ${LATENCY_BUDGET_MS} ms`).toBeLessThan(LATENCY_BUDGET_MS);
  }
});
