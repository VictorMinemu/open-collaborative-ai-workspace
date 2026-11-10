import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIRequestContext, expect, type Locator, type Page, request, test } from "@playwright/test";
import type { BotWorkZoneProfileInput } from "../../packages/contracts/src/bot-work-zone.ts";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM, userIdOf } from "../support/actors";
import { clearPendingApprovals, proposeWorkZoneFromDm } from "../support/approvals";
import { addBot, waitBotReady } from "../support/automations";
import {
  allowBot,
  type BotWorkZonePolicy,
  botProfile,
  expectProfileActive,
  saveBotProfile,
  setWorkZonePolicy,
} from "../support/bot-work-zone";
import { cellToken } from "../support/cell-token";
import { freshChannel, messageRow, postAs } from "../support/chat";
import { FakeCellPlugin, type MentionPayload } from "../support/fake-cell-plugin";
import { captureReview, expectNoSidewaysScroll, expectTouchTargets } from "../support/layout";
import { type FakeDeviceHandle, startFakeDevice, startIsolatedServer } from "../support/work-zone-device";
import {
  createTeamProject,
  linkRepo,
  removeTeamProject,
  shareDevice,
  type TeamProject,
} from "../support/work-zone-projects";
import { ADMIN, API_URL } from "./env";

/**
 * 07.16-21 (BWZ-01 … BWZ-06, D-01 … D-18, PD-26; ROADMAP success criteria 1–5): a team bot runs its own Work Zone
 * sessions, end to end in the browser with the fake cell (e2e/support/fake-cell-plugin.ts: no model, no provider) and a
 * REAL local-runtime daemon in fake-runtime mode (no real runtime). The device is the admin's build server: a headless
 * service with the isolated-server mark (`ocw-runtime isolated-server on`) and its own Full access opt-in, two
 * repositories, linked to a team project Ana belongs to (so she is in each session's audience) and shared with her (so
 * a proposal can start in her name).
 *
 *   1. Desktop: the admin saves Atlas's Work Zone profile in its sheet (the device, two projects, Claude Code, a model,
 *      highest mode Full access) and allows Atlas with Full access in Settings › Devices. The phone run seeds the same
 *      profile and consent through the API (e2e/support/bot-work-zone.ts), so it stays on the chat and session screens,
 *      and checks both settings blocks at 390 (44 px targets, no sideways scroll, axe, screenshots) on their own.
 *   2. Ana asks @Atlas in the channel; the fake cell calls `ocw_work_session_start`; the live card is in her thread
 *      without anyone pressing Start. The daemon holds the turn (`OCW_RUNTIME_FAKE_HOLD_FILE`) so "Working" is seen
 *      deterministically; Open session shows "Back to #<channel>", which returns to the thread with the card
 *      highlighted; the file releases the turn; the card turns "Turn 1 done"; the bot is woken, reads the output and
 *      replies mentioning @Ana; her Mentions count rises.
 *   3. A second session in Supervised mode asks for an approval; the card shows "Approval"; the bot names the sponsor as
 *      the approver and never approves (the session still waits).
 *   4. A turn that read an attachment (outside content) asks to start: a proposal card with the outside-content notice;
 *      Ana presses Start; the session's first prompt carries "After outside content".
 *   5. Sam's personal bot, which has no profile, still proposes with `ocw_start_work_zone` exactly as
 *      work-zone-proposals.spec.ts expects.
 * Every screen passes axe and never scrolls sideways (44 px targets on phones); review screenshots `0716-*` in light and
 * dark when OCW_E2E_SCREENSHOT_DIR is set. The spec restores the organization's Work Zone policy and removes its bots,
 * devices and team project.
 */

test.describe.configure({ mode: "serial" });

const ANA: Actor = { name: "Ana Gil", email: "ana-0716@ocw.test", password: "ana-e2e-password-123" };
/** `userHandle()` of each person (the email's local part). */
const ANA_HANDLE = "ana-0716";
const ADMIN_HANDLE = ADMIN.email.split("@")[0] as string;

const PROMPT = "Fix the failing invoice test";
const LEDGER_PROMPT = "Add a test for the ledger totals";
const TAINTED_PROMPT = "Ship the invoice fix the notes ask for";
const START = "ocw_work_session_start";
const TAINTED_NOTICE = "Proposed after reading outside content. Read the prompt before you start it.";
const THREAD = '[data-testid="thread-panel"]';

let w = "1440";
let mobile = false;
let admin: APIRequestContext;
let anaApi: APIRequestContext;
let anaId: string;
let adminId: string;
let cell: FakeCellPlugin;
let device: FakeDeviceHandle | null = null;
let team: TeamProject | null = null;
let policyBefore: BotWorkZonePolicy | null = null;
let holdDir = "";
let holdFile = "";
let billingId = "";
let ledgerId = "";
let deviceName = "";
let atlas: { id: string; name: string; username: string };
let eng: { id: string; name: string };
const createdBots: string[] = [];

/** `[[call <tool> <json>]]`: what the fake cell runs for the bot (the same grammar as infra/fake-model). */
const call = (tool: string, args: Record<string, unknown>) => `[[call ${tool} ${JSON.stringify(args)}]]`;

/** Atlas's profile as the desktop run saves it in the sheet (the phone run saves it through the API). */
const profileInput = (): BotWorkZoneProfileInput => ({
  deviceId: device?.deviceId as string,
  runtime: "claude-code",
  projectIds: [billingId, ledgerId],
  defaultModel: "opus",
  allowedModels: [],
  defaultEffort: null,
  allowedEfforts: [],
  defaultContextWindow: null,
  allowedContextWindows: [],
  fastMode: "off",
  defaultMode: "default",
  maxMode: "fullAccess",
  worktree: true,
  maxConcurrent: 2,
  promptsPerHour: 30,
  wakesPerSessionDay: 20,
  actOnOutsideContent: false,
});

/** A fresh organization bot named `name` (an older one of that name is deleted first), removed after the spec. */
async function freshTeamBot(name: string): Promise<{ id: string; name: string; username: string }> {
  const listed = (await (await admin.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  for (const a of listed.agents.filter((x) => x.name === name)) {
    expect((await admin.delete(`/api/v1/agents/${a.id}`)).ok(), `delete ${name}`).toBe(true);
  }
  const res = await admin.post("/api/v1/agents", {
    data: {
      name,
      description: "Fixes things in the billing repositories.",
      instructions: "Answer briefly.",
      modelProvider: "mock",
      modelId: "mock-1",
    },
  });
  expect(res.ok(), `create team bot ${name}: ${res.status()}`).toBe(true);
  const bot = (await res.json()) as { id: string; name: string; username: string };
  createdBots.push(bot.id);
  return bot;
}

/** Uploads one file to the conversation as the user of `api` (presign, PUT, complete) and returns its id. */
async function upload(
  api: APIRequestContext,
  conversationId: string,
  f: { name: string; type: string; bytes: Buffer },
): Promise<string> {
  const presign = await api.post(`/api/v1/conversations/${conversationId}/attachments`, {
    data: { filename: f.name, contentType: f.type, size: f.bytes.length },
  });
  expect(presign.ok(), `presign ${f.name}: ${presign.status()}`).toBe(true);
  const { attachment, upload: put } = (await presign.json()) as {
    attachment: { id: string };
    upload: { url: string; headers: Record<string, string> };
  };
  const plain = await request.newContext();
  const stored = await plain.put(put.url, { headers: put.headers, data: f.bytes });
  expect(stored.ok(), `store ${f.name}: ${stored.status()}`).toBe(true);
  await plain.dispose();
  const done = await api.post(`/api/v1/attachments/${attachment.id}/complete`);
  expect(done.ok(), `complete ${f.name}: ${done.status()}`).toBe(true);
  return attachment.id;
}

/** The next `ocw_work_session_start` the fake cell made after `from`, and the thread of the turn that made it. */
async function nextStart(from: number) {
  await cell.waitUntil(() => cell.workSessionRequests.slice(from).some((r) => r.tool === START), 30_000);
  const req = cell.workSessionRequests.slice(from).find((r) => r.tool === START);
  if (!req) throw new Error("no ocw_work_session_start");
  const turn = cell.events.find((e) => e.type === "agent.mention.v1" && e.data.eventId === req.eventId)
    ?.data as unknown as MentionPayload | undefined;
  expect(turn, "the turn that called the tool").toBeTruthy();
  return { req, body: req.body ?? {}, rootId: turn?.thread.rootMessageId as string };
}

/** Opens the thread of `rootId` in the channel (a full screen on phones). */
async function openThread(page: Page, rootId: string): Promise<Locator> {
  await page.goto(`${BASE_URL}/chat/${eng.id}?thread=${rootId}`);
  const panel = page.locator(THREAD);
  await expect(panel).toBeVisible({ timeout: 15_000 });
  return panel;
}

/** The bot's latest message in `scope` containing every `expected` text. */
function botReply(scope: Page | Locator, ...expected: Array<string | RegExp>): Locator {
  let reply = scope.locator('[data-testid="message"][data-author-kind="agent"]');
  for (const e of expected) reply = reply.filter({ hasText: e });
  return reply.last();
}

/** Bots page → the bot's card → its sheet. */
async function openBotSheet(page: Page, name: string): Promise<Locator> {
  await page.goto(`${BASE_URL}/bots`);
  const card = page.getByTestId("bot-card").filter({ hasText: name }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name }).first().click();
  const sheet = page.getByTestId("bot-detail-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name, exact: true })).toBeVisible();
  return sheet;
}

/** Picks the option showing `text` in the Select behind `trigger`. */
async function pick(page: Page, trigger: Locator, text: string | RegExp) {
  await expect(trigger).toBeEnabled({ timeout: 15_000 });
  await trigger.click();
  const option = page.getByRole("option").filter({ hasText: text }).first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(trigger).toContainText(text);
}

/** The device's card in Settings › Devices and its Bots block. */
async function openDeviceBots(page: Page): Promise<{ card: Locator; block: Locator }> {
  await page.goto(`${BASE_URL}/settings/devices`);
  const card = page.getByTestId("device-card").filter({ hasText: deviceName }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  const block = card.getByTestId("device-bot-consents");
  await expect(block).toBeVisible({ timeout: 15_000 });
  return { card, block };
}

/** A finger-sized target on phones (44 × 44); `expectTouchTargets` checks a root's descendants, this the element. */
async function expectFingerSized(target: Locator) {
  if (!mobile) return;
  const box = await target.boundingBox();
  expect(box?.width ?? 0, "44 px wide").toBeGreaterThanOrEqual(43.5);
  expect(box?.height ?? 0, "44 px tall").toBeGreaterThanOrEqual(43.5);
}

/**
 * The invariants of one screen of the journey (PD-20): axe in light and dark on `selector`, no sideways scroll in
 * either theme, 44 px targets under each of `touch` on phones. The screen's `0716-<screen>-<width>` capture (light and
 * dark, `captureReview`) follows each call.
 */
async function checkScreen(page: Page, name: string, selector: string, touch: Array<string | Locator> = []) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expectNoSeriousA11y(page, selector);
    await expectNoSidewaysScroll(page, `${name} ${w} (${theme})`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  for (const root of touch) await expectTouchTargets(page, root);
}

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixtures argument before testInfo
test.beforeAll(async ({}, info) => {
  test.setTimeout(180_000);
  mobile = info.project.name === "mobile";
  w = mobile ? "390" : "1440";
  const token = cellToken();
  expect(token, "OCW_CELL_TOKEN is configured").not.toBe("");
  admin = await apiAs(ADMIN);
  adminId = await userIdOf(admin);
  anaId = await ensureMember(admin, ANA, "developer");
  anaApi = await apiAs(ANA);
  // ADR-0012 and D-15: the organization allows Full access and bot sessions (put back in afterAll).
  policyBefore = await setWorkZonePolicy(admin, { allowFullAccess: true, botSessionsMax: 10 });

  cell = new FakeCellPlugin({
    apiUrl: API_URL,
    token,
    autoAck: true,
    autoReply: true,
    userHandles: { [anaId]: ANA_HANDLE, [adminId]: ADMIN_HANDLE },
  });
  await cell.start();

  // The admin's build server: a service with the isolated-server mark and the device's own Full access opt-in. Its
  // turns that would ask for approval wait (still "running") until the hold file exists.
  holdDir = mkdtempSync(join(tmpdir(), "ocw-e2e-hold-"));
  holdFile = join(holdDir, "release");
  deviceName = `Atlas server ${w}`;
  const listed = (await (await admin.get("/api/v1/devices")).json()) as {
    devices: Array<{ id: string; name: string }>;
  };
  for (const d of listed.devices.filter((x) => x.name === deviceName)) {
    await admin.delete(`/api/v1/devices/${d.id}`);
  }
  device = await startIsolatedServer(admin, {
    name: deviceName,
    projectName: `billing-${w}`,
    extraProjects: [`ledger-${w}`],
    env: { OCW_ALLOW_FULL_ACCESS: "1", OCW_RUNTIME_FAKE_HOLD_FILE: holdFile },
  });
  billingId = device.projectId;
  ledgerId = device.extraProjectIds[`ledger-${w}`] as string;
  expect(ledgerId, "the second repository").toBeTruthy();

  // Ana sees the bot's sessions through the team project (PD-11) and may use the server (a proposal starts as her).
  team = await createTeamProject(admin, { name: `Billing bots ${w}`, members: [{ userId: anaId }] });
  await linkRepo(admin, team.unitId, billingId);
  await linkRepo(admin, team.unitId, ledgerId);
  await shareDevice(admin, device.deviceId, anaId, "default");

  atlas = await freshTeamBot(mobile ? "Atlas m" : "Atlas");
  await waitBotReady(admin, atlas.id);
  eng = await freshChannel(admin, [anaApi], "eng");
  await addBot(admin, eng.id, atlas.id);
  expect((await anaApi.post("/api/v1/notifications/read", { data: { all: true } })).ok()).toBe(true);
});

test.afterAll(async () => {
  await cell?.stop();
  if (admin) {
    if (team) await removeTeamProject(admin, team).catch(() => undefined);
    for (const id of createdBots.splice(0)) await admin.delete(`/api/v1/agents/${id}`).catch(() => undefined);
    if (policyBefore) await setWorkZonePolicy(admin, policyBefore).catch(() => undefined);
  }
  await device?.stop();
  device = null;
  if (holdDir) rmSync(holdDir, { recursive: true, force: true });
  await anaApi?.dispose();
  await admin?.dispose();
});

// ---------------------------------------------------------------- the settings (D-01, D-03, D-04)

test("desktop: the admin saves Atlas's Work Zone profile in its sheet and allows Atlas with Full access on the server", async ({
  browser,
}) => {
  test.skip(mobile, "the phone run seeds the profile and the consent through the API (next test)");
  test.setTimeout(150_000);
  const s = await openAs(browser, ADMIN, "desktop");
  try {
    const sheet = await openBotSheet(s.page, atlas.name);
    const section = sheet.getByTestId("work-zone-profile");
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByTestId("work-zone-status")).toContainText("No Work Zone profile yet", {
      timeout: 15_000,
    });

    // Where: the server, Claude Code, both repositories.
    await pick(s.page, section.getByTestId("work-zone-device"), deviceName);
    await section.getByTestId("work-zone-runtime-claude-code").click();
    await expect(section.getByTestId("work-zone-runtime-claude-code")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    for (const id of [billingId, ledgerId]) {
      const row = section.locator(`[data-project-id="${id}"]`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.click();
      await expect(row).toHaveAttribute("aria-checked", "true");
    }
    // A model, and up to Full access (the org allows it and the server opted in).
    await pick(s.page, section.getByTestId("work-zone-default-model"), "Claude Opus 5.5");
    await pick(s.page, section.getByTestId("work-zone-max-mode"), "Full access");
    await expect(section).toContainText(
      "Full access also needs the device's own opt-in and its owner's consent for this bot.",
    );
    await section.getByTestId("work-zone-save").click();

    // Saved, sponsored by the admin, inactive until the device allows the bot.
    const status = section.getByTestId("work-zone-status");
    await expect(status).toContainText("Inactive", { timeout: 15_000 });
    await expect(status).toContainText(`Runs as ${ADMIN.name}`);
    const saved = (await botProfile(admin, atlas.id)).profile;
    expect(saved).toMatchObject({
      deviceId: device?.deviceId,
      runtime: "claude-code",
      defaultModel: "opus",
      maxMode: "fullAccess",
      sponsor: { id: adminId },
    });
    expect(saved?.projects.map((p) => p.id).sort()).toEqual([billingId, ledgerId].sort());
    await section.scrollIntoViewIfNeeded();
    await checkScreen(s.page, "0716-profile", '[data-testid="work-zone-profile"]');
    await captureReview(s.page, `0716-profile-${w}`);

    // Settings › Devices: the server is isolated; Atlas asks first; allow it, then its Full access checkbox.
    const { card, block } = await openDeviceBots(s.page);
    await expect(card.getByTestId("device-isolated-server")).toHaveAttribute("data-enabled", "true");
    const asking = block.locator(`[data-testid="bot-consent-request"][data-agent-id="${atlas.id}"]`);
    await expect(asking).toContainText(`asked by ${ADMIN.name}`);
    await asking.getByTestId("bot-consent-allow").click();
    const allowed = block.locator(`[data-testid="bot-consent-row"][data-agent-id="${atlas.id}"]`);
    await expect(allowed).toBeVisible({ timeout: 15_000 });
    const full = allowed.getByTestId("bot-consent-full-access");
    await expect(full).toBeEnabled();
    // A controlled checkbox: it shows the API's answer, so wait for that rather than for the click itself.
    await full.click();
    await expect(full).toBeChecked({ timeout: 15_000 });
    await expectProfileActive(admin, atlas.id);
    await block.scrollIntoViewIfNeeded();
    await checkScreen(s.page, "0716-consent", '[data-testid="device-bot-consents"]');
    await captureReview(s.page, `0716-consent-${w}`);

    // The sheet now says Active.
    const again = await openBotSheet(s.page, atlas.name);
    await expect(again.getByTestId("work-zone-status")).toContainText("Active", { timeout: 15_000 });
  } finally {
    await s.context.close();
  }
});

test("phone: the bot's Work Zone section and the device's bot block are 44 px targets and never scroll sideways", async ({
  browser,
}) => {
  test.skip(!mobile, "the desktop run saves them in the browser (previous test)");
  test.setTimeout(150_000);
  // Seeded through the API (plan-checker W2): this test is about how the two blocks look and behave at 390.
  await saveBotProfile(admin, atlas.id, profileInput());
  await allowBot(admin, device?.deviceId as string, atlas.id, { allowFullAccess: true });
  await expectProfileActive(admin, atlas.id);
  const s = await openAs(browser, ADMIN, "mobile");
  try {
    const sheet = await openBotSheet(s.page, atlas.name);
    const section = sheet.getByTestId("work-zone-profile");
    await section.scrollIntoViewIfNeeded();
    await expect(section.getByTestId("work-zone-status")).toContainText("Active", { timeout: 15_000 });
    await expect(section.getByTestId("work-zone-device")).toContainText(deviceName);
    await expectFingerSized(section.getByTestId("work-zone-save"));
    await checkScreen(s.page, "0716-profile", '[data-testid="work-zone-profile"]', [
      '[data-testid="work-zone-profile"]',
    ]);
    await captureReview(s.page, `0716-profile-${w}`);

    const { block } = await openDeviceBots(s.page);
    const allowed = block.locator(`[data-testid="bot-consent-row"][data-agent-id="${atlas.id}"]`);
    await expect(allowed.getByTestId("bot-consent-full-access")).toBeChecked();
    await block.scrollIntoViewIfNeeded();
    await checkScreen(s.page, "0716-consent", '[data-testid="device-bot-consents"]', [
      '[data-testid="device-bot-consents"]',
    ]);
    await captureReview(s.page, `0716-consent-${w}`);
  } finally {
    await s.context.close();
  }
});

// ---------------------------------------------------------------- the journey (success criteria 1, 2, 3)

test("Ana asks @Atlas in the channel: the live card, Open session and back, the wake and the reply that mentions her", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const project = mobile ? "mobile" : "desktop";
  const ana = await openAs(browser, ANA, project);
  const { page } = ana;
  try {
    // ---- Ana asks in the channel; the bot starts the session itself
    await page.goto(`${BASE_URL}/chat/${eng.id}`);
    const from = cell.workSessionRequests.length;
    const box = page.getByTestId("composer");
    await box.click();
    await box.fill(
      `@${atlas.username} please fix the invoice test ${call(START, { projectId: billingId, prompt: PROMPT, permissionMode: "fullAccess" })}`,
    );
    await page.getByTestId("composer-send").click();
    const { req, body, rootId } = await nextStart(from);
    expect(req.sent).toEqual({
      eventId: req.eventId,
      agentId: atlas.id,
      projectId: billingId,
      prompt: PROMPT,
      permissionMode: "fullAccess",
    });
    expect(body, JSON.stringify(body)).toMatchObject({
      kind: "started",
      mode: "fullAccess",
      projectName: `billing-${w}`,
    });
    const sessionId = String(body.workSessionId);
    const cardId = String(body.cardMessageId);

    // ---- the live card in her thread, nobody pressed Start; the daemon holds the turn on "Working"
    const panel = await openThread(page, rootId);
    await expect(
      botReply(panel, `Tool ${START}: started billing-${w} (fullAccess)`),
      "the bot's answer to the turn",
    ).toBeVisible({ timeout: 20_000 });
    const card = messageRow(panel, cardId).getByTestId("agent-card");
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.locator(`[data-live-session="${sessionId}"]`)).toBeVisible();
    await expect(card.getByTestId("agent-card-status")).toHaveAttribute("data-status", "running", {
      timeout: 30_000,
    });
    await expect(card.getByTestId("wz-live-step")).toContainText("Working", { timeout: 30_000 });
    await expect(card.getByTestId("wz-live-device")).toContainText(deviceName);
    await expect(card.getByTestId("wz-live-sub")).toContainText("Claude Code");
    await checkScreen(page, "0716-card", THREAD, [card]);
    await captureReview(page, `0716-card-${w}`);

    // ---- Open session: the session page says where it came from
    await card.getByTestId("agent-card-open").click();
    await expect(page).toHaveURL(new RegExp(`/work-zone/${sessionId}$`), { timeout: 15_000 });
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 15_000 });
    const back = page.getByTestId("session-back");
    await expect(back).toContainText(`Back to #${eng.name}`, { timeout: 15_000 });
    await expect(back).toHaveAttribute("href", `/chat/${eng.id}?thread=${rootId}&m=${cardId}`);
    await expect(page.getByTestId("prompt-bubble").first()).toContainText(PROMPT, { timeout: 30_000 });
    await expectFingerSized(back);
    await checkScreen(page, "0716-session-back", '[data-testid="session-header"]');
    await captureReview(page, `0716-session-back-${w}`);

    // ---- back to the thread, the card highlighted
    await back.click();
    await expect(page).toHaveURL(new RegExp(`/chat/${eng.id}\\?thread=${rootId}&m=${cardId}`), {
      timeout: 15_000,
    });
    const row = messageRow(page.locator(THREAD), cardId);
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toHaveAttribute("data-highlighted", "true");

    // ---- the runtime finishes the turn; the card says so; the bot is woken, reads the output and mentions Ana
    writeFileSync(holdFile, "release");
    const live = row.getByTestId("agent-card");
    await expect(live.getByTestId("wz-live-step")).toContainText("Turn 1 done", { timeout: 60_000 });
    await expect(live.getByTestId("agent-card-status")).toContainText("Idle");
    const reply = botReply(page.locator(THREAD), "Done: Mode: fullAccess", `@${ANA_HANDLE}`);
    await expect(reply).toBeVisible({ timeout: 60_000 });
    await expect(reply.getByTestId("mention").first()).toContainText(`@${ANA_HANDLE}`);
    expect(
      cell.workSessionRequests.some(
        (r) => r.tool === "ocw_work_session_read" && r.sent.workSessionId === sessionId && r.status === 200,
      ),
      "the wake read the session before replying",
    ).toBe(true);
    expect(cell.workSessionWakes.find((x) => x.workSessionId === sessionId)?.transition).toBe("turn_done");

    await reply.scrollIntoViewIfNeeded();
    await checkScreen(page, "0716-reply", THREAD, [row.getByTestId("agent-card")]);
    await captureReview(page, `0716-reply-${w}`);

    // ---- the reply reaches her Mentions. She was looking at the thread when it landed, so it may already be read
    // (no unread count, CI p242); the row is the proof that the bot's mention notified her.
    await page.goto("/chat/mentions");
    const inbox = page.getByTestId("inbox");
    await expect(inbox).toBeVisible();
    // A retry of this test adds a second "Done: Mode: fullAccess" row (the earlier attempt's reply): either proves it.
    const mentionRow = inbox.getByTestId("inbox-item").filter({ hasText: "Done: Mode: fullAccess" }).first();
    await expect(mentionRow).toBeVisible({ timeout: 15_000 });
    await expect(mentionRow).toContainText("mentioned you");
  } finally {
    await ana.context.close();
  }
});

// ---------------------------------------------------------------- approvals go to people (D-10)

test("a Supervised session asks for an approval: the card says Approval and the bot names the sponsor, never approving", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  // The hold file exists since the previous test, so this turn asks for its approval at once (OCW_RUNTIME_FAKE_HOLD_FILE
  // holds only turns that start before the file exists).
  const from = cell.workSessionRequests.length;
  await postAs(
    anaApi,
    eng.id,
    `@${atlas.username} now the ledger ${call(START, { projectId: ledgerId, prompt: LEDGER_PROMPT })}`,
  );
  const { body, rootId } = await nextStart(from);
  expect(body, JSON.stringify(body)).toMatchObject({ kind: "started", mode: "default" });
  const sessionId = String(body.workSessionId);
  const cardId = String(body.cardMessageId);

  const ana = await openAs(browser, ANA, mobile ? "mobile" : "desktop");
  const { page } = ana;
  try {
    const panel = await openThread(page, rootId);
    const card = messageRow(panel, cardId).getByTestId("agent-card");
    await expect(card.getByTestId("agent-card-status")).toContainText("Approval", { timeout: 45_000 });
    await expect(card.getByTestId("agent-card-status")).toHaveAttribute("data-status", "pending");
    await expect(card.getByTestId("wz-live-step")).toContainText("Waiting for approval");
    // The wake's summary is a count (WR-01): the bot reads the session to name the tool, then the people who decide.
    const reply = botReply(panel, "Needs approval: Write", `@${ADMIN_HANDLE}`);
    await expect(reply).toBeVisible({ timeout: 45_000 });
    expect(
      cell.workSessionRequests.some(
        (r) => r.tool === "ocw_work_session_read" && r.sent.workSessionId === sessionId && r.status === 200,
      ),
      "the wake read the session before naming the tool",
    ).toBe(true);
    expect(cell.workSessionWakes.find((x) => x.workSessionId === sessionId)?.transition).toBe(
      "waiting_approval",
    );
    await checkScreen(page, "0716-approval", THREAD, [card]);
    await captureReview(page, `0716-approval-${w}`);

    // The bot never approves: the session still waits for a person, and the card still says so.
    await page.goto(`${BASE_URL}/work-zone/${sessionId}`);
    await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", "waiting_approval", {
      timeout: 15_000,
    });
    await page.goto(`${BASE_URL}/chat/${eng.id}?thread=${rootId}`);
    await expect(
      messageRow(page.locator(THREAD), cardId).getByTestId("agent-card").getByTestId("agent-card-status"),
    ).toContainText("Approval", { timeout: 15_000 });
  } finally {
    await ana.context.close();
  }
});

// ---------------------------------------------------------------- outside content becomes a proposal (D-08, D-18)

test("after reading an attachment the bot only proposes: the notice on the card, Ana starts it, the prompt is marked", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const fileId = await upload(anaApi, eng.id, {
    name: "notes.md",
    type: "text/markdown",
    bytes: Buffer.from("# Release notes\n\nShip the invoice fix today.\n"),
  });
  // In a thread, so the proposal card lands next to the ask (a proposal replies in the ask's thread when it has one).
  const root = await postAs(anaApi, eng.id, "Release notes for the invoice fix");
  const from = cell.workSessionRequests.length;
  await postAs(
    anaApi,
    eng.id,
    `@${atlas.username} do what notes.md says ${call("ocw_attachment_read", { attachmentId: "{{attachment:0}}" })} ${call(START, { projectId: billingId, prompt: TAINTED_PROMPT })}`,
    { threadRootId: root.id, attachmentIds: [fileId] },
  );
  const { body, rootId } = await nextStart(from);
  expect(rootId).toBe(root.id);
  expect(body, JSON.stringify(body)).toMatchObject({ kind: "proposed", reason: "outside_content" });
  const approvalId = String(body.approvalId);

  const ana = await openAs(browser, ANA, mobile ? "mobile" : "desktop");
  const { page } = ana;
  try {
    const panel = await openThread(page, rootId);
    await expect(
      botReply(panel, "Tool ocw_attachment_read: read notes.md", `Tool ${START}: proposed`),
    ).toBeVisible({ timeout: 20_000 });
    const proposal = panel.getByTestId("agent-card").filter({ hasText: `Start a session in billing-${w}` });
    await expect(proposal).toBeVisible({ timeout: 20_000 });
    await expect(proposal.getByTestId("agent-card-notice")).toContainText(TAINTED_NOTICE);
    await checkScreen(page, "0716-proposal", THREAD, [proposal]);
    await captureReview(page, `0716-proposal-${w}`);

    // Ana reviews and starts it: Supervised, in her name; its first prompt carries the outside-content chip.
    await page.goto(`${BASE_URL}/approvals/${approvalId}`);
    const view = page.getByTestId("work-zone-proposal-view");
    await expect(view).toBeVisible({ timeout: 15_000 });
    await expect(view.getByTestId("work-zone-prompt")).toHaveText(TAINTED_PROMPT);
    await expect(view.getByTestId("work-zone-fact-mode")).toContainText("Supervised");
    await expect(view.getByTestId("work-zone-start")).not.toHaveAttribute("aria-disabled", "true", {
      timeout: 15_000,
    });
    await view.getByTestId("work-zone-start").click();
    await page.getByTestId("approval-confirm-submit").click();
    await expect(view.getByTestId("approval-status")).toHaveText("Started", { timeout: 30_000 });
    await view.getByTestId("work-zone-open-session").click();
    await expect(page).toHaveURL(/\/work-zone\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    const first = page.getByTestId("prompt-bubble").first();
    await expect(first).toContainText(TAINTED_PROMPT, { timeout: 30_000 });
    await expect(first).toContainText("After outside content");
  } finally {
    await ana.context.close();
  }
});

// ---------------------------------------------------------------- bots without a profile are unchanged (BWZ-06)

test("a bot without a profile still proposes with ocw_start_work_zone, reviewed and started as before", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const samId = await ensureMember(admin, SAM, "developer");
  const samApi = await apiAs(SAM);
  let laptop: FakeDeviceHandle | null = null;
  let sam: Awaited<ReturnType<typeof openAs>> | null = null;
  try {
    const name = `Sam laptop ${w}`;
    const listed = (await (await samApi.get("/api/v1/devices")).json()) as {
      devices: Array<{ id: string; name: string; ownerUserId: string }>;
    };
    for (const d of listed.devices.filter((x) => x.name === name && x.ownerUserId === samId)) {
      await samApi.delete(`/api/v1/devices/${d.id}`);
    }
    laptop = await startFakeDevice(samApi, { name, projectName: `scout-${w}` });
    const scout = await freshPersonalBot(samApi, samId);
    await clearPendingApprovals(samApi);
    sam = await openAs(browser, SAM, mobile ? "mobile" : "desktop");
    const id = await proposeWorkZoneFromDm(sam.page, cell, {
      dmId: scout.dmId,
      projectId: laptop.projectId,
      deviceId: laptop.deviceId,
      prompt: PROMPT,
    });
    // Its turn offered the proposal tool and none of the session tools, and no Work Zone block (P7).
    const turn = [...cell.events]
      .reverse()
      .find(
        (e) => e.type === "agent.mention.v1" && (e.data as unknown as MentionPayload).agent.id === scout.id,
      )?.data as unknown as (MentionPayload & { turn?: { workZone?: unknown } }) | undefined;
    expect(turn?.turn?.tools).toContain("ocw_start_work_zone");
    expect(turn?.turn?.tools).not.toContain(START);
    expect(turn?.turn?.workZone).toBeUndefined();

    await sam.page.goto(`${BASE_URL}/approvals/${id}`);
    const view = sam.page.getByTestId("work-zone-proposal-view");
    await expect(view).toBeVisible({ timeout: 15_000 });
    await expect(view.getByTestId("approval-title")).toHaveText(`Start a session in scout-${w}`);
    await expect(view.getByTestId("approval-status")).toHaveText("Proposed");
    await expect(view.getByTestId("work-zone-fact-mode")).toContainText("Supervised");
    await expect(view.getByTestId("work-zone-prompt")).toHaveText(PROMPT);
    await expect(view).toContainText(
      "Bots never choose Full access. You can change the mode after the session starts.",
    );
    await view.getByTestId("work-zone-start").click();
    await sam.page.getByTestId("approval-confirm-submit").click();
    await expect(view.getByTestId("approval-status")).toHaveText("Started", { timeout: 30_000 });
    await view.getByTestId("work-zone-open-session").click();
    await expect(sam.page.getByTestId("prompt-bubble").first()).toContainText(PROMPT, { timeout: 30_000 });
    // A person's own session from a proposal: no outside-content mark on its prompt.
    await expect(sam.page.getByTestId("prompt-bubble").first()).not.toContainText("After outside content");
  } finally {
    await sam?.context.close();
    await laptop?.stop();
    await clearPendingApprovals(samApi).catch(() => undefined);
    await samApi.dispose();
  }
});

/** The member's only personal bot, recreated (deleting the old ones closes their proposals), and its private chat. */
async function freshPersonalBot(
  api: APIRequestContext,
  userId: string,
): Promise<{ id: string; dmId: string }> {
  const listed = (await (await api.get("/api/v1/agents")).json()) as {
    agents: Array<{ id: string; scope: string; ownerUserId: string | null }>;
  };
  for (const a of listed.agents.filter((x) => x.scope === "personal" && x.ownerUserId === userId)) {
    expect((await api.delete(`/api/v1/agents/${a.id}`)).ok()).toBe(true);
  }
  const res = await api.post("/api/v1/agents/personal", {
    data: { instructions: "Answer briefly.", modelProvider: "mock", modelId: "mock-1" },
  });
  expect(res.ok(), "create the personal bot").toBe(true);
  const body = (await res.json()) as { agent: { id: string }; dmId: string };
  return { id: body.agent.id, dmId: body.dmId };
}
